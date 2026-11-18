import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProvider } from "../src/core/app";
import { validateConfig } from "../src/core/config";
import { CredentialMissingError, credentialMissingMessage, resolveCredentialValue } from "../src/credential-ref";
import type { ModelEntry } from "../src/core/registry";
import { Vault, type VaultBackend } from "../src/vault";

// Sentinelas construídos em runtime para não disparar o gate de segredos.
const SENTINEL = ["sentinel", "-", "xyz"].join("");
const plain: VaultBackend = { scheme: "plain", protect: (s) => s, unprotect: (s) => s };
const fake: VaultBackend = {
  scheme: "dpapi",
  protect: (s) => Buffer.from(s, "utf8").toString("base64"),
  unprotect: (b) => Buffer.from(b, "base64").toString("utf8"),
};

function tmpVault(): string {
  return join(mkdtempSync(join(tmpdir(), "astro-vault-ref-")), "vault.json");
}

const configWith = (credentialRef: string) => validateConfig({
  providers: { p: { kind: "openai-compat", baseUrl: "https://p.example/v1", credentialRef } },
  models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
  agent: { model: "p/m1", maxSteps: 2, tools: [] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
});
const model: ModelEntry = { provider: "p", id: "m1", tags: [], context: 8192, status: "active" };

describe("resolveCredentialValue (#311 B.2)", () => {
  test("env nomeada continua funcionando", () => {
    expect(resolveCredentialValue("KEY", { KEY: SENTINEL }, { read: () => undefined })).toBe(SENTINEL);
    expect(resolveCredentialValue("MISSING", {}, { read: () => undefined })).toBeUndefined();
  });

  test("vault:<id> devolve o valor só em memória", () => {
    const vault = new Vault(tmpVault(), plain);
    const created = vault.create({ providerId: "p", label: "api", secret: SENTINEL });
    expect(resolveCredentialValue(`vault:${created.id}`, {}, vault)).toBe(SENTINEL);
  });

  test("id ausente vira ConfigError que nomeia o ref, nunca o segredo (I-03)", () => {
    const vault = new Vault(tmpVault(), plain);
    vault.create({ providerId: "p", label: "api", secret: SENTINEL });
    const ref = "vault:cred-missing-0000";
    let message = "";
    try { resolveCredentialValue(ref, {}, vault); } catch (error) { message = String(error); }
    expect(message).toContain(ref);
    expect(message).not.toContain(SENTINEL);
  });

  test("ref de vault malformada não ecoa o valor colado", () => {
    const vault = new Vault(tmpVault(), plain);
    let message = "";
    try { resolveCredentialValue(`vault:${SENTINEL}`, {}, vault); } catch (error) { message = String(error); }
    expect(message).toContain("vault:<credentialId>");
    expect(message).not.toContain(SENTINEL);
  });
});

describe("createProvider lê do vault (#311 B.2)", () => {
  test("resolve o id explícito e mantém o ref na identidade, nunca o valor", () => {
    const vault = new Vault(tmpVault(), fake);
    const created = vault.create({ providerId: "p", label: "api", secret: SENTINEL });
    const ref = `vault:${created.id}`;
    const setup = createProvider(configWith(ref), model, {}, new Map(), vault);
    expect(setup.credentialRef).toBe(ref);
    expect(setup.credentialRef).not.toContain(SENTINEL);
    // a config guarda só a referência, nunca o valor (I-03)
    expect(JSON.stringify(configWith(ref))).not.toContain(SENTINEL);
  });

  test("id ausente no provider real vira erro tipado sem vazar o segredo", () => {
    const vault = new Vault(tmpVault(), plain);
    vault.create({ providerId: "p", label: "api", secret: SENTINEL });
    const ref = "vault:cred-missing-0000";
    let caught: unknown;
    try { createProvider(configWith(ref), model, {}, new Map(), vault); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(CredentialMissingError);
    expect((caught as Error).message).toContain(ref);
    expect((caught as Error).message).not.toContain(SENTINEL);
  });
});

describe("#510 credencial ausente: code + próximo passo, nunca o valor (I-03)", () => {
  test("CredentialMissingError tem code credential_missing e mensagem com var, provider e próximo passo", () => {
    const err = new CredentialMissingError("MY_API_KEY", "openai");
    expect(err.code).toBe("credential_missing");
    expect(err.name).toBe("CredentialMissingError");
    expect(err.credentialRef).toBe("MY_API_KEY");
    expect(err.message).toContain("defina MY_API_KEY no ambiente");
    expect(err.message).toContain('provider "openai"');
    expect(err.message).toContain("astro providers vault-import");
    expect(err.message).toContain("/provider");
  });

  test("mensagem de vault cita só vault:<id> + próximo passo, sem 'defina'", () => {
    const msg = credentialMissingMessage("vault:cred-12345678-abcd");
    expect(msg).toContain("vault:cred-12345678-abcd");
    expect(msg).toContain("ausente ou vazia");
    expect(msg).toContain("/provider");
    expect(msg).not.toContain("defina");
  });

  test("ref com cara de segredo é suprimida no nome, mas traz próximo passo (I-03)", () => {
    const secretLike = ["s", "k", "-"].join("") + "abcdefgh12345678";
    const msg = credentialMissingMessage(secretLike);
    expect(msg).not.toContain(secretLike);
    expect(msg).toContain("nome suprimido");
    expect(msg).toContain("astro providers vault-import");
  });

  test("createProvider sem a variável no ambiente lança CredentialMissingError", () => {
    let caught: unknown;
    try { createProvider(configWith("MY_KEY"), model, {}); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(CredentialMissingError);
    expect((caught as CredentialMissingError).code).toBe("credential_missing");
    expect((caught as Error).message).toMatch(/defina MY_KEY no ambiente/);
    expect((caught as Error).message).toContain('provider "p"');
    expect((caught as Error).message).toContain("astro providers vault-import");
  });

  test("createProvider com vault:<id> ausente lança CredentialMissingError sem vazar o valor", () => {
    const vault = new Vault(tmpVault(), plain);
    vault.create({ providerId: "p", label: "api", secret: SENTINEL });
    let caught: unknown;
    try { createProvider(configWith("vault:cred-missing-0000"), model, {}, new Map(), vault); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(CredentialMissingError);
    expect((caught as CredentialMissingError).code).toBe("credential_missing");
    expect((caught as Error).message).toContain("vault:cred-missing-0000");
    expect((caught as Error).message).not.toContain(SENTINEL);
  });

  test("resolveCredentialValue com id de vault ausente lança CredentialMissingError", () => {
    const vault = new Vault(tmpVault(), plain);
    let caught: unknown;
    try { resolveCredentialValue("vault:cred-missing-0000", {}, vault); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(CredentialMissingError);
    expect((caught as CredentialMissingError).code).toBe("credential_missing");
    expect((caught as Error).message).toContain("vault:cred-missing-0000");
  });
});
