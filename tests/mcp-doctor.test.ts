import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectOnlineChecks, doctorJson, exitCode, runDoctor } from "../src/doctor";
import { probeMcpServer, type McpConnector } from "../src/mcp/probe";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "astro-mcp-doctor-"));
  dirs.push(dir);
  return dir;
}

const okFetch = (async () => new Response("{}")) as unknown as typeof fetch;
const SECRET = ["sentinel","not","a","real","token"].join("-");

function env(extra: Record<string, string> = {}): Record<string, string> {
  return { ASTRO_NO_GLOBAL_CONFIG: "1", ASTRO_HOME: join(sandbox(), "home"), MCP_DOCTOR_KEY: "k", MCP_DOCTOR_SECRET: SECRET, ...extra };
}

/** Projeto válido com os servidores MCP pedidos; health fica no stub de fetch. */
function project(mcpServers: Record<string, unknown>, credentialRef = "MCP_DOCTOR_KEY"): string {
  const dir = sandbox();
  writeFileSync(join(dir, "astro.config.json"), JSON.stringify({
    providers: { proj: { kind: "openai-compat", baseUrl: "https://proj.example/v1", credentialRef } },
    models: [{ provider: "proj", id: "p1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "proj/p1", maxSteps: 2, tools: ["read_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    mcpServers,
  }), "utf8");
  return dir;
}

function counter(calls: string[]): McpConnector {
  return async (server) => {
    calls.push(server.transport);
    return { serverInfo: { name: "mock" }, close: () => undefined };
  };
}

const mcpChecks = <T extends { name: string }>(checks: T[]): T[] => checks.filter((check) => check.name.startsWith("mcp:"));

test("doctor offline não disca MCP: zero conexões e nenhum check mcp:<nome>", async () => {
  const dir = project({ alpha: { transport: "http", url: "https://mcp.example/mcp", timeoutMs: 1000, enabled: true } });
  const calls: string[] = [];
  let fetched = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { fetched += 1; return new Response("{}"); }) as unknown as typeof fetch;
  try {
    const report = await runDoctor(process.cwd(), { online: false, onlineCwd: dir, mcpConnect: counter(calls), env: env() });
    expect(calls).toEqual([]);
    expect(fetched).toBe(0);
    expect(mcpChecks(report.checks)).toEqual([]);
  } finally {
    globalThis.fetch = original;
  }
});

test("--online sonda só os habilitados, fecha o cliente e ignora desabilitado", async () => {
  const dir = project({
    alpha: { transport: "http", url: "https://mcp.example/mcp", timeoutMs: 1000, enabled: true },
    bad: { transport: "stdio", command: "bad", timeoutMs: 1000, enabled: true },
    off: { transport: "stdio", command: "unused", timeoutMs: 1000, enabled: false },
  });
  const calls: string[] = [];
  const closes: string[] = [];
  const mcpConnect: McpConnector = async (server) => {
    calls.push(server.transport);
    return {
      serverInfo: { name: "mock" },
      close: () => {
        closes.push(server.transport);
        if (server.transport === "stdio") throw new Error("close explodiu"); // close hostil não derruba o check
      },
    };
  };
  const checks = await collectOnlineChecks(env(), { onlineCwd: dir, fetchLike: okFetch, mcpConnect });

  expect(calls.sort()).toEqual(["http", "stdio"]);
  expect(closes.sort()).toEqual(["http", "stdio"]); // fechado no sucesso, mesmo lançando
  expect(mcpChecks(checks).map((check) => check.name)).toEqual(["mcp:alpha", "mcp:bad"]);
  expect(mcpChecks(checks).every((check) => check.level === "ok")).toBe(true);
  expect(exitCode({ checks })).toBe(0);
  expect(doctorJson({ checks }).checks.find((check) => check.name === "mcp:alpha")?.status).toBe("ok");
});

test("orçamento da sonda limita o handshake real, não só a corrida", async () => {
  const dir = project({ slow: { transport: "stdio", command: "slow", timeoutMs: 60_000, enabled: true } });
  let effective = 0;
  const hung: McpConnector = (server) => new Promise((_done, reject) => {
    effective = server.timeoutMs;
    // `unref`: o RED do orçamento não fica preso aos 60s do cenário.
    setTimeout(() => reject(new Error(`timeout de ${server.timeoutMs}ms`)), server.timeoutMs).unref?.();
  });
  const started = Date.now();
  const checks = await collectOnlineChecks(env(), { onlineCwd: dir, fetchLike: okFetch, mcpConnect: hung, timeoutMs: 100 });

  expect(Date.now() - started).toBeLessThan(2_000);
  expect(effective).toBe(100); // o transporte não herda os 60s da config
  expect(mcpChecks(checks)[0]?.level).toBe("fail");
});

test("config sem provider válido não sonda MCP e não derruba os checks", async () => {
  const calls: string[] = [];
  const missing = await collectOnlineChecks(env(), { onlineCwd: sandbox(), fetchLike: okFetch, mcpConnect: counter(calls) });
  expect(missing.find((item) => item.name === "online")?.level).toBe("ok");

  // Servidores configurados, mas sem provider utilizável: a config reprova na
  // validação e não há lista confiável — `online` reporta, a sonda não roda.
  const invalid = sandbox();
  writeFileSync(join(invalid, "astro.config.json"), JSON.stringify({
    providers: {}, models: [],
    mcpServers: { alpha: { transport: "http", url: "https://mcp.example/mcp", timeoutMs: 1000, enabled: true } },
  }), "utf8");
  const checks = await collectOnlineChecks(env(), { onlineCwd: invalid, fetchLike: okFetch, mcpConnect: counter(calls) });
  expect(checks.find((item) => item.name === "online")?.level).toBe("warn");
  expect(mcpChecks(checks)).toEqual([]);
  expect(calls).toEqual([]);
});

test("recusa e timeout viram check error, sem derrubar o doctor", async () => {
  const dir = project({ dead: { transport: "stdio", command: "dead", timeoutMs: 1000, enabled: true } });
  const refused: McpConnector = async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:9"); };
  const checks = await collectOnlineChecks(env(), { onlineCwd: dir, fetchLike: okFetch, mcpConnect: refused });
  expect(mcpChecks(checks)[0]?.level).toBe("fail");
  expect(mcpChecks(checks)[0]?.detail).toContain("ECONNREFUSED");
  expect(checks.find((item) => item.name === "online")?.level).toBe("ok");
  expect(exitCode({ checks })).toBe(1);

  let closed = 0;
  let release: (() => void) | undefined;
  const late: McpConnector = () => new Promise((done) => {
    release = () => done({ serverInfo: { name: "late" }, close: () => { closed += 1; } });
  });
  const started = Date.now();
  const timed = await collectOnlineChecks(env(), { onlineCwd: dir, fetchLike: okFetch, mcpConnect: late, timeoutMs: 20 });
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(mcpChecks(timed)[0]?.detail).toContain("timeout de 20ms");
  expect(exitCode({ checks: timed })).toBe(1);

  release?.(); // cliente tardio não pode ficar aberto (processo/stream órfão)
  await new Promise((done) => setTimeout(done, 5));
  expect(closed).toBe(1);
});

test("erro do servidor não ecoa segredo de header nem de env (I-03)", async () => {
  const dir = project({
    leak: {
      transport: "stdio", command: "leak", timeoutMs: 1000, enabled: true,
      headers: { Authorization: "env:MCP_DOCTOR_SECRET" },
      env: { MCP_SERVER_TOKEN: SECRET },
    },
  });
  const leaky: McpConnector = async () => {
    // Servidor hostil: ecoa a credencial do header, a do env e a URL com chave.
    throw new Error(`Authorization: ${SECRET} · token=${SECRET} · https://mcp.example/mcp?api_key=${SECRET}`);
  };
  const checks = await collectOnlineChecks(env(), { onlineCwd: dir, fetchLike: okFetch, mcpConnect: leaky });

  const json = doctorJson({ checks });
  const text = JSON.stringify(json);
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain("api_key");
  expect(text).not.toContain("mcp.example");
  expect(text).toContain("[REDACTED]");
  expect(json.summary.fail).toBe(1);
});

test("sonda direta de servidor desabilitado não conecta", async () => {
  let calls = 0;
  const opts = { env: {}, connect: async () => { calls += 1; return { serverInfo: { name: "x" }, close: () => undefined }; } };
  const result = await probeMcpServer("off", { transport: "stdio", command: "off", timeoutMs: 1, enabled: false }, opts);
  expect(result).toBeUndefined();
  expect(calls).toBe(0);
});

test("CLI --json --online expõe mcp:<nome> error, aliases e exit 1", async () => {
  const dir = project({
    dead: { transport: "stdio", command: "missing-mcp-doctor-binary", timeoutMs: 2000, enabled: true },
    off: { transport: "stdio", command: "never-run-mcp", timeoutMs: 2000, enabled: false },
  }, "MCP_CLI_MISSING_KEY");

  const proc = Bun.spawn([process.execPath, join(root, "src", "cli.ts"), "doctor", "--json", "--online"], {
    cwd: dir, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, ASTRO_NO_GLOBAL_CONFIG: "1", ASTRO_HOME: join(sandbox(), "home") },
  });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(1);

  const parsed = JSON.parse(out) as { checks: Array<{ name: string; status: string; message: string; level: string; label: string }> };
  const dead = parsed.checks.find((check) => check.name === "mcp:dead");
  expect(dead?.status).toBe("error");
  expect(dead?.level).toBe("fail");
  expect(dead?.label).toBe("mcp dead");
  expect(dead?.message.length).toBeGreaterThan(0);
  expect(parsed.checks.some((check) => check.name === "mcp:off")).toBe(false);
}, 30_000);
