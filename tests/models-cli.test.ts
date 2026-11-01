import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "src", "cli.ts");

const cfg = {
  providers: {
    proj: { kind: "openai-compat", baseUrl: "https://proj.example/v1", credentialRef: "SENTINEL_KEY" },
  },
  models: [{ provider: "proj", id: "p1", tags: ["writing-code"], context: 8192 }],
  agent: { model: "proj/p1", maxSteps: 2, tools: ["read_file"] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "astro-models-cli-"));
  const cfgPath = join(dir, "astro.config.json");
  writeFileSync(cfgPath, JSON.stringify(cfg), "utf8");
  return { dir, cfgPath };
}

async function run(args: string[], env: NodeJS.ProcessEnv) {
  const proc = Bun.spawn([process.execPath, entry, ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { out, err, code };
}

test("models list imprime modelos e não ecoa segredo", async () => {
  const { dir, cfgPath } = setup();
  const { out, code } = await run(["models", "list", "--config", cfgPath], {
    ASTRO_HOME: dir,
    SENTINEL_KEY: "sentinel-xyz",
  });
  expect(code).toBe(0);
  expect(out).toContain("proj/p1");
  expect(out).toContain("project");
  expect(out).not.toContain("sentinel-xyz");
});

test("models list --seeds lista as quatro sementes", async () => {
  const { dir, cfgPath } = setup();
  const { out, code } = await run(["models", "list", "--config", cfgPath, "--seeds"], { ASTRO_HOME: dir });
  expect(code).toBe(0);
  for (const key of ["nvidia", "codex", "openrouter", "openai-compatible"]) {
    expect(out).toContain(key);
  }
  expect(out).not.toContain("ollama");
});

test("models list --json imprime JSON dos modelos", async () => {
  const { dir, cfgPath } = setup();
  const { out, code } = await run(["models", "list", "--config", cfgPath, "--json"], { ASTRO_HOME: dir });
  expect(code).toBe(0);
  const parsed = JSON.parse(out) as { models: Array<{ ref: string }> };
  expect(parsed.models.map((model) => model.ref)).toContain("proj/p1");
});

test("models list --json --seeds emite JSON válido com models e seeds", async () => {
  const { dir, cfgPath } = setup();
  const { out, code } = await run(["models", "list", "--config", cfgPath, "--json", "--seeds"], {
    ASTRO_HOME: dir,
    SENTINEL_KEY: "sentinel-xyz",
  });
  expect(code).toBe(0);
  const parsed = JSON.parse(out) as { models: Array<{ ref: string }>; seeds: Array<{ key: string }> };
  expect(parsed.models.map((model) => model.ref)).toContain("proj/p1");
  expect(parsed.seeds.map((seed) => seed.key)).toEqual(["nvidia", "codex", "openrouter", "openai-compatible"]);
  expect(out).not.toContain("sentinel-xyz");
});
