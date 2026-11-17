import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "src", "cli.ts");
const SENTINEL = "sentinel-doctor-value";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "astro-doctor-cli-"));
  dirs.push(dir);
  return dir;
}

function configWithCredential(): string {
  return JSON.stringify({
    providers: {
      proj: { kind: "openai-compat", baseUrl: "https://proj.example/v1", credentialRef: "SENTINEL_KEY" },
    },
    models: [{ provider: "proj", id: "p1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "proj/p1", maxSteps: 2, tools: ["read_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  });
}

async function run(args: string[], cwd: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, entry, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SENTINEL_KEY: SENTINEL, ...env },
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  return { out, err, code: await proc.exited };
}

describe("astro doctor CLI (#61)", () => {
  test("--help anuncia o comando doctor", async () => {
    const { out, code } = await run(["--help"], root);
    expect(code).toBe(0);
    expect(out).toContain("astro doctor [--json] [--fix]");
  });

  test("--json emite payload estável, sem valor de credencial", async () => {
    const dir = sandbox();
    const home = join(sandbox(), "home");
    writeFileSync(join(dir, "astro.config.json"), configWithCredential(), "utf8");
    const { out, code } = await run(["doctor", "--json"], dir, { ASTRO_HOME: home });
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as {
      schema: string;
      checks: Array<{ level: string; label: string; detail?: string }>;
      summary: { ok: number; warn: number; fail: number };
      fixes?: unknown;
    };
    expect(parsed.schema).toBe("doctor/v1");
    expect(Object.keys(parsed).sort()).toEqual(["checks", "schema", "summary"]);
    expect(Array.isArray(parsed.checks)).toBe(true);
    for (const check of parsed.checks) {
      expect(["ok", "warn", "fail"]).toContain(check.level);
      expect(check.label.length).toBeGreaterThan(0);
    }
    expect(parsed.summary.ok + parsed.summary.warn + parsed.summary.fail).toBe(parsed.checks.length);
    expect(parsed.checks.some((check) => check.label === "astro home" && check.level === "warn")).toBe(true);
    expect(out).toContain("SENTINEL_KEY");
    expect(out).not.toContain(SENTINEL);
    expect(parsed.fixes).toBeUndefined();
  });

  test("--help anuncia --online", async () => {
    const { out, code } = await run(["--help"], root);
    expect(code).toBe(0);
    expect(out).toContain("astro doctor [--json] [--fix] [--online]");
  });

  test("--online sem credencial agrega degraded como error e exit 1, sem rede", async () => {
    const dir = sandbox();
    writeFileSync(join(dir, "astro.config.json"), JSON.stringify({
      providers: {
        proj: { kind: "openai-compat", baseUrl: "https://proj.example/v1", credentialRef: "ASTRO_DOCTOR_MISSING_KEY_61" },
      },
      models: [{ provider: "proj", id: "p1", tags: ["writing-code"], context: 8192 }],
      agent: { model: "proj/p1", maxSteps: 2, tools: ["read_file"] },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    }), "utf8");

    const { out, code } = await run(["doctor", "--json", "--online"], dir, { ASTRO_HOME: join(sandbox(), "home") });
    expect(code).toBe(1);
    const parsed = JSON.parse(out) as {
      checks: Array<{ name: string; status: string; message: string; level: string }>;
    };
    const provider = parsed.checks.find((check) => check.name === "provider:proj");
    expect(provider?.status).toBe("error");
    expect(provider?.level).toBe("fail");
    expect(provider?.message).toContain("ASTRO_DOCTOR_MISSING_KEY_61");
    expect(parsed.checks.find((check) => check.name === "online")?.status).toBe("error");
  });

  test("saída humana lista checks e resumo", async () => {
    const dir = sandbox();
    const { out, code } = await run(["doctor"], dir, { ASTRO_HOME: join(sandbox(), "home") });
    expect(code).toBe(0);
    expect(out).toContain("[ok] bun");
    expect(out).toContain("Resumo:");
    expect(out.trimStart().startsWith("{")).toBe(false);
  });

  test("--fix cria ASTRO_HOME, é idempotente e nunca cria a raiz de artefatos", async () => {
    const dir = sandbox();
    const state = sandbox();
    const home = join(state, "nested", "home");
    const artifacts = join(state, "artifacts-untouched");
    const env = { ASTRO_HOME: home, ASTRO_ARTIFACT_ROOT: artifacts };

    const first = await run(["doctor", "--json", "--fix"], dir, env);
    expect(first.code).toBe(0);
    const firstJson = JSON.parse(first.out) as { fixes: { applied: string[]; errors: string[] } };
    expect(firstJson.fixes.applied).toHaveLength(1);
    expect(firstJson.fixes.errors).toEqual([]);
    expect(existsSync(home)).toBe(true);
    expect(existsSync(join(home, "attachments"))).toBe(false);
    expect(existsSync(artifacts)).toBe(false);

    const second = await run(["doctor", "--json", "--fix"], dir, env);
    expect(second.code).toBe(0);
    const secondJson = JSON.parse(second.out) as { fixes: { applied: string[]; errors: string[] } };
    expect(secondJson.fixes.applied).toEqual([]);
    expect(secondJson.fixes.errors).toEqual([]);
  });

  test("--fix recusa ASTRO_HOME relativo e não cria o diretório no cwd", async () => {
    const dir = sandbox();
    const { out, code } = await run(["doctor", "--json", "--fix"], dir, { ASTRO_HOME: ".astro" });
    expect(code).toBe(1);
    const parsed = JSON.parse(out) as {
      checks: Array<{ label: string; level: string; detail?: string }>;
      fixes: { applied: string[]; errors: string[] };
    };
    expect(parsed.fixes.applied).toEqual([]);
    expect(parsed.fixes.errors.length).toBeGreaterThan(0);
    expect(existsSync(join(dir, ".astro"))).toBe(false);
    const home = parsed.checks.find((check) => check.label === "astro home");
    expect(home?.level).toBe("fail");
    expect(home?.detail).toContain("absoluto");
  });

  test("--fix recusa ASTRO_HOME com .. e não cria o destino fora do cwd", async () => {
    const dir = sandbox();
    const escapeName = `astro-doctor-escape-${process.pid}-${Date.now()}`;
    const escape = join(dir, "..", escapeName);
    dirs.push(escape);
    const { out, code } = await run(["doctor", "--json", "--fix"], dir, {
      ASTRO_HOME: join("..", escapeName),
    });
    expect(code).toBe(1);
    const parsed = JSON.parse(out) as { fixes: { applied: string[]; errors: string[] } };
    expect(parsed.fixes.applied).toEqual([]);
    expect(parsed.fixes.errors.length).toBeGreaterThan(0);
    expect(existsSync(escape)).toBe(false);
  });

  test("--fix aceita ASTRO_HOME absoluto dentro do cwd, uma vez e idempotente", async () => {
    const dir = sandbox();
    const home = join(dir, "home");
    const env = { ASTRO_HOME: home };

    const first = await run(["doctor", "--json", "--fix"], dir, env);
    const firstJson = JSON.parse(first.out) as {
      fixes: { applied: string[]; errors: string[] };
    };
    expect(Object.keys(firstJson).sort()).toEqual(["checks", "fixes", "schema", "summary"]);
    expect(firstJson.fixes.errors).toEqual([]);
    expect(firstJson.fixes.applied).toHaveLength(1);
    expect(existsSync(home)).toBe(true);

    const second = await run(["doctor", "--json", "--fix"], dir, env);
    const secondJson = JSON.parse(second.out) as { fixes: { applied: string[]; errors: string[] } };
    expect(secondJson.fixes.errors).toEqual([]);
    expect(secondJson.fixes.applied).toEqual([]);
  });

  test("--fix falha fechado quando ASTRO_HOME é arquivo, sem vazar o caminho-sentinela", async () => {
    const dir = sandbox();
    const secretPath = ["sk", "-", "live", "-", "SECRET", "123456789"].join("");
    const home = join(sandbox(), secretPath);
    writeFileSync(home, "x", "utf8");
    const { out, code } = await run(["doctor", "--json", "--fix"], dir, { ASTRO_HOME: home });
    expect(code).toBe(1);
    const parsed = JSON.parse(out) as { fixes: { applied: string[]; errors: string[] } };
    expect(parsed.fixes.applied).toEqual([]);
    expect(parsed.fixes.errors.length).toBeGreaterThan(0);
    expect(out).not.toContain(secretPath);
  });

  test("--json redige caminho com padrão de segredo", async () => {
    const dir = sandbox();
    const secretPath = ["sk", "-", "live", "-", "SECRET", "123456789"].join("");
    const home = join(sandbox(), secretPath);
    const { out, code } = await run(["doctor", "--json"], dir, { ASTRO_HOME: home });
    expect(code).toBe(0);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain(secretPath);
  });

  test("leitura aceita ASTRO_HOME em link simbólico sem exit 1", async () => {
    const dir = sandbox();
    const real = join(sandbox(), "real-home");
    mkdirSync(real, { recursive: true });
    const link = join(sandbox(), "linked-home");
    symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");

    const { out, code } = await run(["doctor", "--json"], dir, { ASTRO_HOME: link });
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as { checks: Array<{ label: string; level: string }> };
    expect(parsed.checks.find((check) => check.label === "astro home")?.level).toBe("ok");
  });

  test("exit 1 quando a config global é malformada", async () => {
    const dir = sandbox();
    const home = sandbox();
    writeFileSync(join(dir, "astro.config.json"), configWithCredential(), "utf8");
    writeFileSync(join(home, "config.json"), "{not json", "utf8");

    const { out, code } = await run(["doctor", "--json"], dir, { ASTRO_HOME: home });
    expect(code).toBe(1);
    const parsed = JSON.parse(out) as { checks: Array<{ label: string; level: string }> };
    expect(parsed.checks.find((check) => check.label === "config global")?.level).toBe("fail");
    expect(out).not.toContain(SENTINEL);
  });

  test("flag desconhecida falha com erro de uso", async () => {
    const dir = sandbox();
    const { err, code } = await run(["doctor", "--nope"], dir, { ASTRO_HOME: join(dir, "home") });
    expect(code).toBe(1);
    expect(err).toContain("opção desconhecida");
  });
});
