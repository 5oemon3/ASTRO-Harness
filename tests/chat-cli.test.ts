import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Auditor } from "../src/audit";
import { SessionApi } from "../src/chat/session-api";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("bun src/cli.ts chat roda um turno e encerra com /exit", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-chat-cli-"));
  const server = Bun.serve({ port: 0, async fetch() {
    return Response.json({ choices: [{ message: { content: "ok do mock" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  } });
  try {
    const configPath = join(cwd, "astro.config.json");
    writeFileSync(configPath, JSON.stringify({
      providers: { p: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" } },
      models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192,
        price: { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false } }],
      agent: { model: "p/m1", maxSteps: 2, tools: [] },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    }));
    const proc = Bun.spawn(["bun", "src/cli.ts", "chat", "--config", configPath, "--cwd", cwd], {
      cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, KEY: "k" } as Record<string, string>,
    });
    proc.stdin.write("olá\n/providers\n/help\n/exit\n");
    proc.stdin.end();
    const exit = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toBe("");
    expect(exit).toBe(0);
    expect(stdout).toContain("astro chat");
    expect(stdout).toContain("ok do mock");
    expect(stdout).toContain("Comandos:"); // a linha /help depois do turno não foi perdida
    expect(stdout).toContain("p (openai-compat)");
    expect(stdout).toContain("1 step(s)");
    expect(existsSync(join(cwd, ".astro", "sessions.db"))).toBe(true);
    expect(existsSync(join(cwd, ".astro", "sessions"))).toBe(false); // o runtime não grava JSON (#366)
    const api = new SessionApi(join(cwd, ".astro"));
    try {
      const sessions = api.list();
      expect(sessions).toHaveLength(1);
      expect(api.load(sessions[0]!.id).messages).toContainEqual({ role: "assistant", content: "ok do mock" });
    } finally {
      api.close();
    }
    const audit = new Auditor(join(cwd, ".astro", "audit.jsonl")).readAll();
    expect(audit.some((e) => e.tipo === "chat.prompt")).toBe(true);
    expect(JSON.stringify(audit)).not.toContain("olá");
  } finally {
    server.stop(true);
  }
}, 20_000);

test("chat continua com /exit quando o banco de sessões está corrompido", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-chat-cli-corrupt-sessions-"));
  const astroDir = join(cwd, ".astro");
  mkdirSync(astroDir, { recursive: true });
  writeFileSync(join(astroDir, "sessions.db"), "not a SQLite database", "utf8");
  const configPath = join(cwd, "astro.config.json");
  writeFileSync(configPath, JSON.stringify({
    providers: { p: { kind: "openai-compat", baseUrl: "http://127.0.0.1:1/v1", credentialRef: "KEY" } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "p/m1", maxSteps: 2, tools: [] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  const proc = Bun.spawn(["bun", "src/cli.ts", "chat", "--config", configPath, "--cwd", cwd], {
    cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, KEY: "k" } as Record<string, string>,
  });
  proc.stdin.write("/exit\n");
  proc.stdin.end();

  const exit = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  expect(exit).toBe(0);
  expect(stdout).toContain("astro chat");
  expect(stderr).toContain("aviso: sessões SQLite indisponíveis");
  expect(stderr).toContain("/sessions, /resume, auto-save e /save desativados");
  expect(stderr).toContain("/export");
  expect(stderr).not.toContain("erro:");
}, 20_000);

test("erro de provider não encerra o REPL e aceita /exit", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-chat-cli-err-"));
  const server = Bun.serve({ port: 0, async fetch() { return new Response("boom", { status: 500 }); } });
  try {
    const configPath = join(cwd, "astro.config.json");
    writeFileSync(configPath, JSON.stringify({
      providers: { p: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" } },
      models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
      agent: { model: "p/m1", maxSteps: 2, tools: [] },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    }));
    const proc = Bun.spawn(["bun", "src/cli.ts", "chat", "--config", configPath, "--cwd", cwd], {
      cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, KEY: "k" } as Record<string, string>,
    });
    proc.stdin.write("a\n/exit\n");
    proc.stdin.end();
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toContain("erro:");
  } finally {
    server.stop(true);
  }
}, 20_000);

test("chat sem --config inválido falha claro", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-chat-cli-bad-"));
  const proc = Bun.spawn(["bun", "src/cli.ts", "chat", "--config", join(cwd, "nope.json"), "--cwd", cwd], {
    cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  proc.stdin.end();
  expect(await proc.exited).toBe(1);
  expect(await new Response(proc.stderr).text()).toContain("erro:");
}, 20_000);

/** `chat` sem TTY com mock que pede uma tool na 1ª chamada e responde texto na 2ª (#262). */
async function chatToolTurn(opts: { prefix: string; tools: string[]; name: string; args: Record<string, unknown> }) {
  const cwd = mkdtempSync(join(tmpdir(), opts.prefix));
  let calls = 0;
  const server = Bun.serve({ port: 0, async fetch() {
    calls++;
    return Response.json(calls === 1
      ? { choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: opts.name, arguments: JSON.stringify(opts.args) } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
      : { choices: [{ message: { content: "pronto" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  } });
  try {
    const configPath = join(cwd, "astro.config.json");
    writeFileSync(configPath, JSON.stringify({
      providers: { mock: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" } },
      models: [{ provider: "mock", id: "m1", tags: ["writing-code", "tools"], context: 8192 }],
      agent: { model: "mock/m1", maxSteps: 4, tools: opts.tools },
      permissions: { mode: "ask" },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    }));
    const proc = Bun.spawn(["bun", "src/cli.ts", "chat", "--config", configPath, "--cwd", cwd], {
      cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, KEY: "k" } as Record<string, string>,
    });
    proc.stdin.write("escreva\n/exit\n");
    proc.stdin.end();
    const exit = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    await new Response(proc.stderr).text();
    return { cwd, exit, stdout, audit: new Auditor(join(cwd, ".astro", "audit.jsonl")).readAll() };
  } finally {
    server.stop(true);
  }
}

test("chat sem TTY em ask nega escrita com permission.pending e para o turno (#262)", async () => {
  const result = await chatToolTurn({
    prefix: "astro-chat-cli-pending-write-", tools: ["write_file"], name: "write_file",
    args: { path: "saida.txt", content: "ok" },
  });
  expect(result.exit).toBe(0);
  expect(result.stdout).toContain('permissão pendente para a tool "write_file"');
  expect(result.stdout).not.toContain("pronto"); // o turno parou antes da resposta final
  expect(existsSync(join(result.cwd, "saida.txt"))).toBe(false);
  const pending = result.audit.filter((e) => e.tipo === "permission.pending");
  expect(pending).toHaveLength(1);
  expect(pending[0]!.payload).toMatchObject({ name: "write_file", action: "edit", mode: "ask" });
}, 20_000);

test("chat sem TTY em ask nega execução com permission.pending e não roda o comando (#262)", async () => {
  const command = `bun -e "require('node:fs').writeFileSync('saida.txt','ok')"`;
  const result = await chatToolTurn({
    prefix: "astro-chat-cli-pending-exec-", tools: ["run_command"], name: "run_command", args: { command },
  });
  expect(result.exit).toBe(0);
  expect(result.stdout).toContain('permissão pendente para a tool "run_command"');
  expect(result.stdout).not.toContain("pronto");
  expect(existsSync(join(result.cwd, "saida.txt"))).toBe(false);
  const pending = result.audit.filter((e) => e.tipo === "permission.pending");
  expect(pending).toHaveLength(1);
  expect(pending[0]!.payload).toMatchObject({ name: "run_command", action: "shell", mode: "ask" });
}, 20_000);

test("chat aceita --artifact-root e rejeita valor vazio (#392)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-chat-cli-root-"));
  const accepted = Bun.spawn(
    ["bun", "src/cli.ts", "chat", "--config", join(cwd, "nope.json"), "--cwd", cwd, "--artifact-root", join(cwd, "..", "artifacts")],
    { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  accepted.stdin.end();
  expect(await accepted.exited).toBe(1); // falha na config ausente, não na flag
  const stderr = await new Response(accepted.stderr).text();
  expect(stderr).not.toContain("opção desconhecida");
  expect(stderr).toContain("erro:");

  const empty = Bun.spawn(
    ["bun", "src/cli.ts", "chat", "--artifact-root", "", "--cwd", cwd],
    { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  empty.stdin.end();
  expect(await empty.exited).toBe(1);
  expect(await new Response(empty.stderr).text()).toContain("falta o valor de --artifact-root");
}, 20_000);
