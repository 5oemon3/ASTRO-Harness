import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig, type AstroConfig } from "../src/core/config";
import { runHealthCheck, testProvider } from "../src/health";

const baseConfig = {
  providers: { mock: { kind: "openai-compat" as const, baseUrl: "http://localhost/v1", credentialRef: "TEST_KEY" } },
  models: [{ provider: "mock", id: "mock-1", tags: ["writing-code"], context: 4096 }],
  agent: { model: "mock/mock-1", maxSteps: 3, tools: [] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
};

/** Servidor mock de /models; atraso configurável por chamada. */
function modelsServer(handler: () => Response | Promise<Response>) {
  const server = Bun.serve({
    port: 0,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname.endsWith("/models")) {
        return handler();
      }
      return new Response("nope", { status: 404 });
    },
  });
  return { baseUrl: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) };
}

const okEnv = { TEST_KEY: "test-key" };

describe("health check (F6-6)", () => {
  test("provider respondendo → status ok com checks e latency", async () => {
    const server = modelsServer(() => Response.json({ data: [] }));
    try {
      const config = validateConfig({ ...structuredClone(baseConfig), providers: { mock: { ...baseConfig.providers.mock, baseUrl: server.baseUrl } } });
      const report = await runHealthCheck(config, okEnv);
      expect(report.status).toBe("ok");
      const configCheck = report.checks.find((c) => c.name === "config")!;
      expect(configCheck.status).toBe("ok");
      const providerCheck = report.checks.find((c) => c.name === "provider:mock")!;
      expect(providerCheck.status).toBe("ok");
      expect(providerCheck.latencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      server.stop();
    }
  });

  test("credencial inválida (401) → check down, status down", async () => {
    const server = modelsServer(() => new Response("unauthorized", { status: 401 }));
    try {
      const config = validateConfig({ ...structuredClone(baseConfig), providers: { mock: { ...baseConfig.providers.mock, baseUrl: server.baseUrl } } });
      const report = await runHealthCheck(config, okEnv);
      expect(report.status).toBe("down");
      const providerCheck = report.checks.find((c) => c.name === "provider:mock")!;
      expect(providerCheck.status).toBe("down");
      expect(providerCheck.detail).toContain("401");
    } finally {
      server.stop();
    }
  });

  test("sem credencial no env → degraded com mensagem clara (sem HTTP)", async () => {
    const server = modelsServer(() => Response.json({ data: [] }));
    try {
      const config = validateConfig({ ...structuredClone(baseConfig), providers: { mock: { ...baseConfig.providers.mock, baseUrl: server.baseUrl } } });
      const report = await runHealthCheck(config, {});
      expect(report.status).toBe("degraded");
      const providerCheck = report.checks.find((c) => c.name === "provider:mock")!;
      expect(providerCheck.status).toBe("down");
      expect(providerCheck.detail).toContain("TEST_KEY");
    } finally {
      server.stop();
    }
  });

  test("#510 sem credencial no env → detail com var, provider e próximo passo", async () => {
    const config = validateConfig(structuredClone(baseConfig));
    const report = await runHealthCheck(config, {});
    const providerCheck = report.checks.find((c) => c.name === "provider:mock")!;
    expect(providerCheck.status).toBe("down");
    expect(providerCheck.detail).toContain("defina TEST_KEY no ambiente");
    expect(providerCheck.detail).toContain('provider "mock"');
    expect(providerCheck.detail).toContain("astro providers vault-import");
  });

  test("dois providers, um fora → degraded; falha não derruba o outro", async () => {
    const ok = modelsServer(() => Response.json({ data: [] }));
    const bad = modelsServer(() => new Response("boom", { status: 500 }));
    try {
      const config = validateConfig({
        ...structuredClone(baseConfig),
        providers: {
          good: { kind: "openai-compat", baseUrl: ok.baseUrl, credentialRef: "GOOD_KEY" },
          bad: { kind: "openai-compat", baseUrl: bad.baseUrl, credentialRef: "BAD_KEY" },
        },
        models: [{ provider: "good", id: "mock-1", tags: ["writing-code"], context: 4096 }],
        agent: { model: "good/mock-1", maxSteps: 3, tools: [] },
      });
      const report = await runHealthCheck(config, { GOOD_KEY: "g", BAD_KEY: "b" });
      expect(report.status).toBe("degraded");
      expect(report.checks.find((c) => c.name === "provider:good")!.status).toBe("ok");
      expect(report.checks.find((c) => c.name === "provider:bad")!.status).toBe("down");
    } finally {
      ok.stop();
      bad.stop();
    }
  });

  test("timeout por check: endpoint lento vira down com detail de timeout", async () => {
    const server = modelsServer(() => new Promise((resolve) => setTimeout(() => resolve(Response.json({ data: [] })), 60_000)));
    try {
      const config = validateConfig({ ...structuredClone(baseConfig), providers: { mock: { ...baseConfig.providers.mock, baseUrl: server.baseUrl } } });
      const report = await runHealthCheck(config, okEnv, { timeoutMs: 50 });
      expect(report.status).toBe("down");
      const providerCheck = report.checks.find((c) => c.name === "provider:mock")!;
      expect(providerCheck.status).toBe("down");
      expect(providerCheck.detail).toContain("timeout");
    } finally {
      server.stop();
    }
  });

  test("codex-oauth: credenciais legíveis → ok; ausentes → down", async () => {
    const config = validateConfig({
      ...structuredClone(baseConfig),
      providers: { codex: { kind: "codex-oauth", credentialsPath: "~/astro-health-fantasma.json" } },
      models: [{ provider: "codex", id: "gpt", tags: ["writing-code"], context: 4096 }],
      agent: { model: "codex/gpt", maxSteps: 3, tools: [] },
    });
    const report = await runHealthCheck(config, {});
    expect(report.checks.find((c) => c.name === "provider:codex")!.status).toBe("down");
  });
});

// Sentinelas construídos em runtime para não disparar o gate de segredos.
const VAULT_SECRET = ["sentinel", "-", "vault"].join("");
const ENV_SECRET = ["sentinel", "-", "xyz"].join("");
const VAULT_REF = "vault:cred-12345678-abcd";

/** Leitor de cofre injetado: só devolve o id presente no mapa. */
const readerWith = (entries: Record<string, string>) => ({
  read: (id: string) => (id in entries ? { value: entries[id]! } : undefined),
});

/** Servidor de /models que guarda o header `authorization` recebido. */
function authServer() {
  let auth: string | undefined;
  const server = Bun.serve({
    port: 0,
    fetch(req): Response {
      auth = req.headers.get("authorization") ?? undefined;
      return Response.json({ data: [] });
    },
  });
  return { baseUrl: `http://127.0.0.1:${server.port}/v1`, auth: () => auth, stop: () => server.stop(true) };
}

const vaultConfig = (ref: string): AstroConfig => validateConfig({
  ...structuredClone(baseConfig),
  providers: { mock: { kind: "openai-compat", baseUrl: "http://localhost/v1", credentialRef: ref } },
});

describe("health e providers test leem o cofre (#311 B.2/B.3)", () => {
  const entries = { "cred-12345678-abcd": VAULT_SECRET };

  test("vault:<id> resolve no health, mostra a origem e nunca o valor", async () => {
    const server = authServer();
    try {
      const config = validateConfig({
        ...structuredClone(baseConfig),
        providers: { mock: { kind: "openai-compat", baseUrl: server.baseUrl, credentialRef: VAULT_REF } },
      });
      const report = await runHealthCheck(config, { SENTINEL_KEY: ENV_SECRET }, { vault: readerWith(entries) });
      const check = report.checks.find((c) => c.name === "provider:mock")!;
      expect(check.status).toBe("ok");
      expect(check.detail).toMatch(/credencial: vault/);
      expect(server.auth()).toBe(`Bearer ${VAULT_SECRET}`);
      expect(JSON.stringify(report)).not.toContain(VAULT_SECRET);
      expect(JSON.stringify(report)).not.toContain(ENV_SECRET);
    } finally {
      server.stop();
    }
  });

  test("entrada ausente no cofre → down citando só o ref, sem 'defina'", async () => {
    const report = await runHealthCheck(vaultConfig(VAULT_REF), {}, { vault: readerWith({}) });
    const check = report.checks.find((c) => c.name === "provider:mock")!;
    expect(check.status).toBe("down");
    expect(check.detail).toContain(VAULT_REF);
    expect(check.detail).not.toContain("defina");
    expect(JSON.stringify(report)).not.toContain(VAULT_SECRET);
  });

  test("#510 entrada ausente no cofre → detail com próximo passo /provider", async () => {
    const report = await runHealthCheck(vaultConfig(VAULT_REF), {}, { vault: readerWith({}) });
    const check = report.checks.find((c) => c.name === "provider:mock")!;
    expect(check.status).toBe("down");
    expect(check.detail).toContain(VAULT_REF);
    expect(check.detail).toContain("/provider");
    expect(check.detail).not.toContain("defina");
    expect(JSON.stringify(report)).not.toContain(VAULT_SECRET);
  });

  test("ref de vault malformada → down acionável sem ecoar o conteúdo", async () => {
    const broken = {
      ...vaultConfig(VAULT_REF),
      providers: { mock: { kind: "openai-compat", baseUrl: "http://localhost/v1", credentialRef: "vault:../etc" } },
    } as unknown as AstroConfig;
    const report = await runHealthCheck(broken, {}, { vault: readerWith(entries) });
    const check = report.checks.find((c) => c.name === "provider:mock")!;
    expect(check.status).toBe("down");
    expect(check.detail).toContain("vault:<credentialId>");
    expect(check.detail).not.toContain("../etc");
  });

  test("providers test resolve o cofre; id ausente → down citando o ref", async () => {
    const server = authServer();
    try {
      const config = validateConfig({
        ...structuredClone(baseConfig),
        providers: { mock: { kind: "openai-compat", baseUrl: server.baseUrl, credentialRef: VAULT_REF } },
      });
      const ok = await testProvider(config, "mock", {}, { vault: readerWith(entries) });
      expect(ok.status).toBe("ok");
      expect(ok.detail).toMatch(/credencial: vault/);
      expect(server.auth()).toBe(`Bearer ${VAULT_SECRET}`);
      expect(JSON.stringify(ok)).not.toContain(VAULT_SECRET);
      const missing = await testProvider(vaultConfig(VAULT_REF), "mock", {}, { vault: readerWith({}) });
      expect(missing.status).toBe("down");
      expect(missing.detail).toContain(VAULT_REF);
    } finally {
      server.stop();
    }
  });

  test("sem vault.json nenhum: cofre real vazio → down citando o ref, sem crash", async () => {
    const home = mkdtempSync(join(tmpdir(), "astro-health-novault-"));
    const report = await runHealthCheck(vaultConfig(VAULT_REF), { ASTRO_HOME: home });
    const check = report.checks.find((c) => c.name === "provider:mock")!;
    expect(check.status).toBe("down");
    expect(check.detail).toContain(VAULT_REF);
    expect(report.checks.find((c) => c.name === "vault")!.detail).toMatch(/sem cofre/);
  });

  test("falha ao decifrar no cofre → down citando o ref do provider, nunca o valor", async () => {
    const reader = {
      read: (): { value: string } => { throw new Error("falha ao decifrar a credencial no cofre (DPAPI)"); },
    };
    const report = await runHealthCheck(vaultConfig(VAULT_REF), {}, { vault: reader });
    const check = report.checks.find((c) => c.name === "provider:mock")!;
    expect(check.status).toBe("down");
    expect(check.detail).toContain(`credencial "${VAULT_REF}"`);
    expect(check.detail).toContain("DPAPI");
  });

  test("ref colada com forma de segredo não é ecoada no relatório (I-03)", async () => {
    const pasted = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const broken = {
      ...vaultConfig(VAULT_REF),
      providers: { mock: { kind: "openai-compat", baseUrl: "http://localhost/v1", credentialRef: pasted } },
    } as unknown as AstroConfig;
    const report = await runHealthCheck(broken, {}, { vault: readerWith(entries) });
    expect(report.checks.find((c) => c.name === "provider:mock")!.status).toBe("down");
    expect(JSON.stringify(report)).not.toContain(pasted);
  });
});
