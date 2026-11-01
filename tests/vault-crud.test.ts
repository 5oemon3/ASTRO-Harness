import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../src/config";
import { runHealthCheck } from "../src/health";
import { resolveEffectiveConfig } from "../src/provider/profiles";
import { redactSecrets } from "../src/sanitize-external";
import { Vault, type VaultBackend } from "../src/vault";

// Sentinelas construídos em runtime para não disparar o gate de segredos.
const SENTINEL = ["sentinel", "-", "xyz"].join("");
const FAKE_SK = ["s", "k", "-"].join("") + "live-abcdef12345";

function tmpVault() {
  const dir = mkdtempSync(join(tmpdir(), "astro-vault-"));
  return { dir, path: join(dir, "vault.json") };
}

// Backend determinístico multiplataforma: cifra reversível (base64), scheme "dpapi".
const fakeBackend: VaultBackend = {
  scheme: "dpapi",
  protect: (s) => Buffer.from(s, "utf8").toString("base64"),
  unprotect: (b) => Buffer.from(b, "base64").toString("utf8"),
};
const plainBackend: VaultBackend = { scheme: "plain", protect: (s) => s, unprotect: (s) => s };

const project = () => validateConfig({
  providers: { p: { kind: "openai-compat", baseUrl: "https://p.example/v1", credentialRef: "KEY" } },
  models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
  agent: { model: "p/m1", maxSteps: 2, tools: ["read_file"] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
});
const okFetch = (() => Promise.resolve(new Response("{}", { status: 200 }))) as unknown as typeof fetch;

describe("Vault CRUD + resolve (#311 B.1b)", () => {
  test("create cifra (nada em claro no arquivo), list não expõe secret, resolve devolve valor só em memória", () => {
    const { path } = tmpVault();
    const v = new Vault(path, fakeBackend);
    const created = v.create({ providerId: "openai", label: "pessoal", secret: SENTINEL });
    expect(created.id).toMatch(/^cred-/);
    expect("secret" in created).toBe(false);
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain(SENTINEL); // cifrado
    expect(raw).toContain(created.id);
    expect(v.list()).toHaveLength(1);
    expect("secret" in v.list()[0]).toBe(false);
    const resolved = v.resolve("openai");
    expect(resolved?.value).toBe(SENTINEL);
    expect(resolved?.id).toBe(created.id);
    expect(v.resolve("outro")).toBeUndefined();
  });

  test("uma ativa por provider; activate troca; rotate re-cifra; remove apaga", () => {
    const { path } = tmpVault();
    const v = new Vault(path, fakeBackend);
    const a = v.create({ providerId: "openai", label: "a", secret: "valor-a" });
    const b = v.create({ providerId: "openai", label: "b", secret: "valor-b" });
    expect(v.resolve("openai")?.id).toBe(b.id); // create deixa a nova ativa
    v.activate(a.id);
    expect(v.resolve("openai")?.id).toBe(a.id);
    expect(v.list().filter((c) => c.active)).toHaveLength(1);
    v.rotate(a.id, "valor-novo");
    expect(v.resolve("openai")?.value).toBe("valor-novo");
    expect(v.remove(a.id)).toBe(true);
    expect(v.remove(a.id)).toBe(false);
    // a ativa foi removida e a b estava inativa desde activate(a): nenhuma ativa sobra
    expect(v.resolve("openai")).toBeUndefined();
    v.activate(b.id);
    expect(v.resolve("openai")?.id).toBe(b.id);
  });

  test("rejeita segredo vazio e label com cara de segredo (I-03)", () => {
    const { path } = tmpVault();
    const v = new Vault(path, fakeBackend);
    expect(() => v.create({ providerId: "p", label: "l", secret: "  " })).toThrow(/vazio/);
    expect(() => v.create({ providerId: "p", label: FAKE_SK, secret: "x" })).toThrow(/label/);
    expect(existsSync(path)).toBe(false); // nada gravado
  });

  test("backend plain grava em claro no arquivo, mas redactSecrets cobre o formato do cofre", () => {
    const { path } = tmpVault();
    const v = new Vault(path, plainBackend);
    v.create({ providerId: "p", label: "l", secret: SENTINEL });
    const raw = readFileSync(path, "utf8");
    expect(raw).toContain(SENTINEL); // plain é explícito (0600)
    expect(redactSecrets(raw)).not.toContain(SENTINEL); // mas nunca sai para log/contexto
    expect(redactSecrets(raw)).toContain("[REDACTED]");
  });
});

describe("fiação: health e profiles (#311 B.1b)", () => {
  test("runHealthCheck traz check vault fora do agregado provider: e avisa plain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-vault-"));
    new Vault(join(dir, "vault.json"), plainBackend).create({ providerId: "openai", label: "l", secret: SENTINEL });
    const report = await runHealthCheck(project(), { ASTRO_HOME: dir, KEY: "x" }, { fetchLike: okFetch });
    const vault = report.checks.find((c) => c.name === "vault");
    expect(vault).toBeDefined();
    expect(vault!.detail).toMatch(/plain/);
    expect(vault!.detail).not.toContain(SENTINEL);
    expect(report.status).toBe("ok"); // check vault não entra no agregado provider:
    expect(JSON.stringify(report)).not.toContain(SENTINEL);
  });

  test("runHealthCheck sem cofre registra vault ausente sem quebrar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-vault-"));
    const report = await runHealthCheck(project(), { ASTRO_HOME: dir, KEY: "x" }, { fetchLike: okFetch });
    const vault = report.checks.find((c) => c.name === "vault");
    expect(vault!.detail).toMatch(/sem cofre/);
  });

  test("resolveEffectiveConfig empurra o aviso de cofre plain (surge em session.warnings)", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-vault-"));
    new Vault(join(dir, "vault.json"), plainBackend).create({ providerId: "openai", label: "l", secret: SENTINEL });
    const result = resolveEffectiveConfig({
      project: project(),
      store: { version: 1, profiles: [] },
      env: { ASTRO_HOME: dir },
    });
    expect(result.warnings.join(" ")).toMatch(/plain/);
    expect(result.warnings.join(" ")).not.toContain(SENTINEL);
  });
});
