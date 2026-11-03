import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretHandlers } from "../src/tui/vault-secret";
import { Vault, type VaultBackend } from "../src/vault";

const plain: VaultBackend = { scheme: "plain", protect: (s) => s, unprotect: (s) => s };

function makeVault(): Vault {
  return new Vault(join(mkdtempSync(join(tmpdir(), "astro-vault-352-")), "vault.json"), plain);
}

describe("createSecretHandlers rollback (#352)", () => {
  test("descartar a credencial nova restaura a ativa anterior", () => {
    const vault = makeVault();
    const previous = vault.create({ providerId: "p", label: "antiga", secret: "a" });
    const handlers = createSecretHandlers(vault);
    const ref = handlers.saveSecret("p", "nova");
    expect(ref).toMatch(/^vault:cred-/);
    expect(vault.resolve("p")?.id).toBe(ref.slice("vault:".length));
    handlers.discardSecret(ref);
    expect(vault.resolve("p")?.id).toBe(previous.id);
    expect(vault.list().map((item) => item.id)).toEqual([previous.id]);
  });

  test("dois saves seguidos: descartar os dois restaura a credencial original", () => {
    const vault = makeVault();
    const original = vault.create({ providerId: "p", label: "original", secret: "o" });
    const handlers = createSecretHandlers(vault);
    const first = handlers.saveSecret("p", "um");
    const second = handlers.saveSecret("p", "dois");
    handlers.discardSecret(second);
    expect(vault.resolve("p")?.id).toBe(first.slice("vault:".length));
    handlers.discardSecret(first);
    expect(vault.resolve("p")?.id).toBe(original.id);
    expect(vault.list().map((item) => item.id)).toEqual([original.id]);
  });

  test("cofre corrompido no rollback não lança", () => {
    const vault = makeVault();
    const handlers = createSecretHandlers(vault);
    const ref = handlers.saveSecret("p", "x");
    writeFileSync(vault.path, "{ inválido");
    expect(() => handlers.discardSecret(ref)).not.toThrow();
  });

  test("ref inválida ou desconhecida é no-op", () => {
    const vault = makeVault();
    const active = vault.create({ providerId: "p", label: "a", secret: "a" });
    const handlers = createSecretHandlers(vault);
    handlers.discardSecret("KEY");
    handlers.discardSecret("vault:cred-nao-existe-0000");
    expect(vault.resolve("p")?.id).toBe(active.id);
    expect(vault.list()).toHaveLength(1);
  });
});
