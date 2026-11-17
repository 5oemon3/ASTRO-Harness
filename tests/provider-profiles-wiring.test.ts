import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { saveProfileStore } from "../src/providers/profiles";
import { runTask } from "../src/core/app";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface RunResult {
  exit: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], opts: { cwd: string; env: Record<string, string | undefined>; stdin?: string }): Promise<RunResult> {
  const baseEnv: Record<string, string | undefined> = { ...process.env };
  for (const key of ["ASTRO_PROVIDER", "ASTRO_MODEL", "OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_BASE_URL"]) {
    delete baseEnv[key];
  }
  const home = opts.env.ASTRO_HOME ?? mkdtempSync(join(tmpdir(), "astro-wire-home-"));
  // O spawn roda no diretório do teste: o `astro.config.json` da raiz não entra.
  const proc = Bun.spawn(["bun", join(root, "src", "cli.ts"), ...args], {
    cwd: opts.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...baseEnv, ...opts.env, ASTRO_HOME: home } as Record<string, string>,
  });
  proc.stdin.write(opts.stdin ?? "");
  proc.stdin.end();
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exit: await proc.exited, stdout, stderr };
}

const profile = {
  id: "openai-work",
  name: "OpenAI Work",
  kind: "openai-compat",
  baseUrl: "https://api.openai.com/v1",
  credentialRef: "OPENAI_API_KEY",
  models: [{ id: "gpt-4o", tags: ["writing-code"], context: 128000 }],
};

function auditStarted(cwd: string): Record<string, unknown> {
  const text = readFileSync(join(cwd, ".astro", "audit.jsonl"), "utf8");
  const line = text.split("\n").find((item) => item.includes('"run.started"'));
  if (line === undefined) throw new Error("run.started ausente");
  return JSON.parse(line) as Record<string, unknown>;
}

test("chat sem config usa o perfil global e audita a origem", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-wire-"));
  const home = mkdtempSync(join(tmpdir(), "astro-wire-home-"));
  saveProfileStore({ version: 1, activeProfileId: "openai-work", profiles: [profile] }, join(home, "providers.json"));
  const result = await runCli(["chat", "--cwd", cwd], {
    cwd,
    env: { ASTRO_HOME: home, OPENAI_API_KEY: "" },
    stdin: "/exit\n",
  });
  expect(result.exit).toBe(0);
  const started = auditStarted(cwd);
  expect((started.payload as Record<string, unknown>).providerSource).toBe("global");
  expect((started.payload as Record<string, unknown>).providerSelection).toBe("store");
});

test("primeiro turno sem config expõe tools padrão com aprovação", async () => {
  let sentTools: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as { tools?: Array<{ function: { name: string } }> };
      sentTools = (body.tools ?? []).map((tool) => tool.function.name);
      return Response.json({
        choices: [{ message: { content: "ok da baseline" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    },
  });
  try {
    const cwd = mkdtempSync(join(tmpdir(), "astro-wire-baseline-"));
    const home = mkdtempSync(join(tmpdir(), "astro-wire-baseline-home-"));
    const result = await runCli(["chat", "--cwd", cwd], {
      cwd,
      env: {
        ASTRO_HOME: home,
        OPENAI_API_KEY: "k",
        OPENAI_MODEL: "gpt-4o",
        OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
      },
      stdin: "oi\n/exit\n",
    });
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain("ok da baseline");
    expect(result.stderr).toContain("escrita e shell pedem aprovação");
    expect(sentTools).toEqual([
      "read_file",
      "write_file",
      "edit",
      "grep",
      "list_dir",
      "run_command",
    ]);
  } finally {
    server.stop(true);
  }
});

test("sem config, write_file pede aprovação antes de gravar", async () => {
  let call = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      call++;
      return Response.json(call === 1
        ? {
            choices: [{
              message: {
                content: "",
                tool_calls: [{
                  id: "c1",
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: JSON.stringify({ path: "hello.txt", content: "oi" }),
                  },
                }],
              },
            }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }
        : { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    },
  });
  try {
    const cwd = mkdtempSync(join(tmpdir(), "astro-wire-approval-"));
    const home = mkdtempSync(join(tmpdir(), "astro-wire-approval-home-"));
    const approvals: string[] = [];
    await runTask({
      configPath: join(cwd, "astro.config.json"),
      cwd,
      allowMissingConfig: true,
      task: "crie hello.txt",
      env: {
        ASTRO_HOME: home,
        OPENAI_API_KEY: "k",
        OPENAI_MODEL: "gpt-4o",
        OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
      },
      approveTool: (request) => {
        approvals.push(`${request.name}:${request.action}:${request.mode}`);
        return true;
      },
    });
    expect(approvals).toContain("write_file:edit:ask");
    expect(readFileSync(join(cwd, "hello.txt"), "utf8")).toBe("oi");
  } finally {
    server.stop(true);
  }
});

test("chat com OPENAI_* usa perfil efêmero sem criar store", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-wire-env-"));
  const home = mkdtempSync(join(tmpdir(), "astro-wire-env-home-"));
  const result = await runCli(["chat", "--cwd", cwd], {
    cwd,
    env: { ASTRO_HOME: home, OPENAI_API_KEY: "k", OPENAI_MODEL: "gpt-4o" },
    stdin: "/exit\n",
  });
  expect(result.exit).toBe(0);
  const started = auditStarted(cwd);
  expect((started.payload as Record<string, unknown>).providerSource).toBe("env");
  expect((started.payload as Record<string, unknown>).providerSelection).toBe("env");
});

test("--config explícito ausente falha em vez de usar baseline", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-wire-missing-"));
  const result = await runCli(["chat", "--cwd", cwd, "--config", "nao-existe.json"], {
    cwd,
    env: { OPENAI_API_KEY: "k", OPENAI_MODEL: "gpt-4o" },
    stdin: "/exit\n",
  });
  expect(result.exit).toBe(1);
  expect(result.stderr).toMatch(/configuração não encontrada/);
});

test("run sem config falha", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-wire-run-"));
  const result = await runCli(["run", "oi"], {
    cwd,
    env: { OPENAI_API_KEY: "k", OPENAI_MODEL: "gpt-4o" },
  });
  expect(result.exit).toBe(1);
  expect(result.stderr).toMatch(/configuração não encontrada/);
});

test("--no-global-config é aceita depois de outra flag e desliga a camada global", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-wire-flag-"));
  const home = mkdtempSync(join(tmpdir(), "astro-wire-flag-home-"));
  // A camada global traz o provider e o modelo; o projeto depende dela.
  writeFileSync(join(home, "config.json"), JSON.stringify({
    providers: { g: { kind: "openai-compat", baseUrl: "https://g.example/v1", credentialRef: "G_KEY" } },
    models: [{ provider: "g", id: "gm", tags: [], context: 8192 }],
  }));
  writeFileSync(join(cwd, "astro.config.json"), JSON.stringify({
    agent: { model: "g/gm", maxSteps: 2, tools: ["read_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  // Sem a flag, a camada global entra e o modelo declarado existe.
  const withGlobal = await runCli(["models", "list"], { cwd, env: { ASTRO_HOME: home } });
  expect(withGlobal.exit).toBe(0);
  // A flag depois de outra flag é aceita (e desliga a camada global).
  const isolated = await runCli(["models", "list", "--seeds", "--no-global-config"], { cwd, env: { ASTRO_HOME: home } });
  expect(isolated.stderr).not.toMatch(/opção desconhecida/);
  expect(isolated.exit).toBe(1);
  expect(isolated.stderr).toMatch(/não está declarado em "models"/);
});

test("--provider desconhecido falha", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-wire-provider-"));
  const result = await runCli(["chat", "--cwd", cwd, "--provider", "nao-existe"], {
    cwd,
    env: { OPENAI_API_KEY: "k", OPENAI_MODEL: "gpt-4o" },
    stdin: "/exit\n",
  });
  expect(result.exit).toBe(1);
  expect(result.stderr).toMatch(/provider "nao-existe" não está configurado/);
});
