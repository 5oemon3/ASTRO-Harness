import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, validateConfig } from "../src/core/config";
import { formatProvidersList, runHealthCheck, testProvider } from "../src/health";
import { saveVault } from "../src/vault";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "src", "cli.ts");

const baseConfig = {
  providers: {
    a: { kind: "openai-compat", baseUrl: "http://a/v1", credentialRef: "KEY_A", priority: 1, fallback: ["b"], quotaDomain: "dom-a" },
    b: { kind: "openai-compat", baseUrl: "http://b/v1", credentialRef: "KEY_B" },
  },
  models: [{ provider: "a", id: "m1", tags: ["writing-code"], context: 4096 }],
  agent: { model: "a/m1", maxSteps: 2, tools: [] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
};
const cfg = () => validateConfig(structuredClone(baseConfig));
const fetchOk = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

describe("providers avançados (C6b)", () => {
  test("formatProvidersList mostra prioridade, cadeia de fallback e defaults", () => {
    const out = formatProvidersList(cfg());
    expect(out).toContain("a");
    expect(out).toContain("openai-compat");
    expect(out).toContain("prioridade 1");
    expect(out).toContain("b");       // cadeia de fallback de a
    expect(out).toContain("dom-a");
    expect(out).toContain("prioridade 100"); // default de b
    expect(out).toContain("default");        // quotaDomain default de b
    expect(formatProvidersList({ ...cfg(), providers: {} } as ReturnType<typeof cfg>)).toContain("nenhum provider");
  });

  test("health report carrega a prioridade de cada provider (visão por prioridade)", async () => {
    const report = await runHealthCheck(cfg(), { KEY_A: "k", KEY_B: "k" }, { fetchLike: fetchOk });
    expect(report.checks.find((c) => c.name === "provider:a")!.priority).toBe(1);
    expect(report.checks.find((c) => c.name === "provider:b")!.priority).toBe(100);
  });

  test("testProvider faz 1 chamada real mínima e reporta latência com prioridade", async () => {
    const check = await testProvider(cfg(), "a", { KEY_A: "k" }, { fetchLike: fetchOk });
    expect(check.name).toBe("provider:a");
    expect(check.status).toBe("ok");
    expect(check.priority).toBe(1);
    expect(check.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("testProvider: provider fora → ConfigError; endpoint fora → down; credencial ausente → down citando o nome", async () => {
    await expect(testProvider(cfg(), "ghost", {})).rejects.toThrow(/ghost/);
    const down = await testProvider(cfg(), "a", { KEY_A: "k" }, { fetchLike: (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch });
    expect(down.status).toBe("down");
    const noKey = await testProvider(cfg(), "a", {}, { fetchLike: fetchOk });
    expect(noKey.status).toBe("down");
    expect(noKey.detail).toContain("KEY_A"); // nome da variável, nunca o valor (I-03)
  });

  test("testProvider com codex-oauth valida o arquivo de credenciais", async () => {
    const credPath = join(mkdtempSync(join(tmpdir(), "astro-c6b-")), "auth.json");
    writeFileSync(credPath, "{}");
    const config = validateConfig(structuredClone({ ...baseConfig, providers: { ...baseConfig.providers, codex: { kind: "codex-oauth", credentialsPath: credPath } } }));
    const ok = await testProvider(config, "codex", {});
    expect(ok.status).toBe("ok");
    const missing = await testProvider(config, "codexx", {}).then(() => null, (e) => e as ConfigError);
    expect(missing?.message).toContain("codexx");
  });

  test("providers health/test: cofre plain vira warn e ref ausente vira down, sem segredo na saída (#311)", async () => {
    const SENTINEL = ["sentinel", "-", "vault"].join("");
    const ENV_SENTINEL = ["sentinel", "-", "xyz"].join("");
    const dir = mkdtempSync(join(tmpdir(), "astro-providers-cli-"));
    const home = mkdtempSync(join(tmpdir(), "astro-providers-home-"));
    // Cofre plain: o valor existe no arquivo, mas nunca pode sair no relatório (I-03).
    saveVault({
      version: 1,
      credentials: [{
        id: "cred-12345678-abcd", providerId: "mock", label: "api", scheme: "plain", secret: SENTINEL,
        createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: "2026-01-01T00:00:00.000Z", active: true,
      }],
    }, join(home, "vault.json"));
    const configPath = join(dir, "astro.config.json");
    writeFileSync(configPath, JSON.stringify({
      ...baseConfig,
      providers: { a: { kind: "openai-compat", baseUrl: "http://a/v1", credentialRef: "vault:cred-missing-0000" } },
    }), "utf8");
    const proc = Bun.spawn([process.execPath, entry, "providers", "health", "--config", configPath], {
      cwd: dir, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, ASTRO_HOME: home, SENTINEL_KEY: ENV_SENTINEL },
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(1); // credencial local ausente → degraded
    const report = JSON.parse(out) as { status: string; checks: Array<{ name: string; status: string; detail?: string }> };
    expect(report.status).toBe("degraded");
    expect(report.checks.find((c) => c.name === "vault")!.status).toBe("warn");
    const provider = report.checks.find((c) => c.name === "provider:a")!;
    expect(provider.status).toBe("down");
    expect(provider.detail).toContain("vault:cred-missing-0000");
    expect(out).not.toContain(SENTINEL);
    expect(err).not.toContain(SENTINEL);
    expect(out).not.toContain(ENV_SENTINEL);
    // `providers test` segue o mesmo contrato de saída (I-03)
    const probe = Bun.spawn([process.execPath, entry, "providers", "test", "a", "--config", configPath], {
      cwd: dir, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, ASTRO_HOME: home, SENTINEL_KEY: ENV_SENTINEL },
    });
    const probeOut = await new Response(probe.stdout).text();
    const probeErr = await new Response(probe.stderr).text();
    expect(await probe.exited).toBe(1);
    expect((JSON.parse(probeOut) as { detail?: string }).detail).toContain("vault:cred-missing-0000");
    expect(probeOut).not.toContain(SENTINEL);
    expect(probeErr).not.toContain(SENTINEL);
  }, 20_000);
});
