import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProfileStore } from "../src/providers/profiles";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function projectConfig(cwd: string): string {
  const path = join(cwd, "astro.config.json");
  writeFileSync(path, JSON.stringify({
    providers: {
      p: { kind: "openai-compat", baseUrl: "http://127.0.0.1:1/v1", credentialRef: "KEY" },
      q: { kind: "openai-compat", baseUrl: "http://127.0.0.1:2/v1", credentialRef: "KEY" },
    },
    models: [
      { provider: "p", id: "m1", tags: ["writing-code"], context: 8192 },
      { provider: "q", id: "m2", tags: ["writing-code"], context: 8192 },
    ],
    agent: { model: "p/m1", maxSteps: 2, tools: ["read_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  return path;
}

async function chat(cwd: string, cfg: string, home: string, stdin: string, extraEnv: Record<string, string> = {}) {
  const baseEnv: Record<string, string | undefined> = { ...process.env };
  for (const key of ["ASTRO_PROVIDER", "ASTRO_MODEL", "OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_BASE_URL"]) {
    delete baseEnv[key];
  }
  const proc = Bun.spawn(["bun", "src/cli.ts", "chat", "--cwd", cwd, "--config", cfg], {
    cwd: root,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...baseEnv, ASTRO_HOME: home, ...extraEnv } as Record<string, string>,
  });
  proc.stdin.write(stdin);
  proc.stdin.end();
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exit: await proc.exited, stdout, stderr };
}

test("/provider add grava, ativa e aparece na lista", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-provider-repl-"));
  const home = mkdtempSync(join(tmpdir(), "astro-provider-repl-home-"));
  const cfg = projectConfig(cwd);
  const add = await chat(
    cwd, cfg, home,
    "/provider add\ncustom\nLocal\nhttp://localhost:11434/v1\n\nllama3.1\nS\nS\n/exit\n",
  );
  expect(add.exit).toBe(0);
  expect(add.stdout).toContain("salvo: local");
  expect(add.stdout).toContain("provider ativo: local");
  const store = loadProfileStore(join(home, "providers.json"));
  expect(store.profiles.map((item) => item.id)).toEqual(["local"]);
  expect(store.activeProfileId).toBe("local");

  const list = await chat(cwd, cfg, home, "/provider\n/exit\n");
  expect(list.exit).toBe(0);
  // Depois da migração o perfil vem de `config.json`, sem nome de exibição.
  expect(list.stdout).toContain("local (local)");
});

test("/provider remove de perfil migrado é recusado e preserva o legado", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-provider-rm-"));
  const home = mkdtempSync(join(tmpdir(), "astro-provider-rm-home-"));
  const cfg = projectConfig(cwd);
  await chat(cwd, cfg, home, "/provider add\ncustom\nLocal\nhttp://localhost:1/v1\n\nm1\nS\nn\n/exit\n");
  const legacy = join(home, "providers.json");
  const bytes = readFileSync(legacy, "utf8");
  const removed = await chat(cwd, cfg, home, "/provider remove local\n/exit\n");
  expect(removed.exit).toBe(0);
  expect(removed.stdout).toContain('erro: provider "local"');
  expect(removed.stdout).toMatch(/config\.json/);
  expect(removed.stdout).not.toContain("removido: local");
  expect(readFileSync(legacy, "utf8")).toBe(bytes);
});

test("/provider <nome> troca para provider do projeto sem persistir", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-provider-switch-"));
  const home = mkdtempSync(join(tmpdir(), "astro-provider-switch-home-"));
  const cfg = projectConfig(cwd);
  const result = await chat(cwd, cfg, home, "/provider q\n/exit\n");
  expect(result.exit).toBe(0);
  expect(result.stdout).toContain("provider: q/m2");
  expect(result.stdout).toContain("definido no projeto; não persistido");
});

test("ativar um add em projeto com agent.profile avisa e não derruba o REPL", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-provider-pool-"));
  const home = mkdtempSync(join(tmpdir(), "astro-provider-pool-home-"));
  const cfg = join(cwd, "astro.config.json");
  writeFileSync(cfg, JSON.stringify({
    providers: { p: { kind: "openai-compat", baseUrl: "http://127.0.0.1:1/v1", credentialRef: "KEY" } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
    modelPool: { fast: { model: "p/m1" } },
    agent: { profile: "fast", maxSteps: 2, tools: ["read_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  const result = await chat(
    cwd, cfg, home,
    "/provider add\ncustom\nLocal\nhttp://localhost:1/v1\n\nm1\nS\nS\n/exit\n",
  );
  expect(result.exit).toBe(0);
  expect(result.stdout).toContain("salvo: local");
  expect(result.stdout).toContain("agent.profile tem precedência");
  expect(loadProfileStore(join(home, "providers.json")).profiles.map((item) => item.id)).toEqual(["local"]);
});

test("add sem ativar não troca o modelo da sessão", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-provider-model-"));
  const home = mkdtempSync(join(tmpdir(), "astro-provider-model-home-"));
  const cfg = projectConfig(cwd);
  const result = await chat(
    cwd, cfg, home,
    "/model q/m2\n/provider add\ncustom\nLocal\nhttp://localhost:1/v1\n\nm1\nS\nn\n/details\n/exit\n",
  );
  expect(result.exit).toBe(0);
  expect(result.stdout).toContain("modelo q/m2");
});

test("/provider remove de provider do projeto é recusado", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-provider-guard-"));
  const home = mkdtempSync(join(tmpdir(), "astro-provider-guard-home-"));
  const cfg = projectConfig(cwd);
  const result = await chat(cwd, cfg, home, "/provider remove p\n/exit\n");
  expect(result.exit).toBe(0);
  expect(result.stdout).toContain("astro.config.json");
});

test("/provider add é recusado com --no-global-config e não grava arquivo", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-provider-noglobal-"));
  const home = mkdtempSync(join(tmpdir(), "astro-provider-noglobal-home-"));
  const cfg = projectConfig(cwd);

  const result = await chat(
    cwd, cfg, home,
    "/provider add\ncustom\nLocal\nhttp://localhost:1/v1\n\nm1\nS\nn\n/exit\n",
    { ASTRO_NO_GLOBAL_CONFIG: "1" },
  );

  expect(result.exit).toBe(0);
  expect(result.stdout).toContain("camada global desligada");
  expect(result.stdout).not.toContain("salvo: local");
  expect(existsSync(join(home, "providers.json"))).toBe(false);

  const list = await chat(cwd, cfg, home, "/provider\n/exit\n", { ASTRO_NO_GLOBAL_CONFIG: "1" });
  expect(list.stdout).not.toContain("local (local)");
});
