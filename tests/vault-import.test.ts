import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfileStore, saveProfileStore } from "../src/provider/profiles";
import { formatVaultImport, importVaultCredential } from "../src/provider/vault-import";
import { Vault, type VaultBackend } from "../src/vault";

// Sentinelas construídos em runtime para não disparar o gate de segredos.
const SENTINEL = ["sentinel", "-", "xyz"].join("");
const fake: VaultBackend = {
  scheme: "dpapi",
  protect: (s) => Buffer.from(s, "utf8").toString("base64"),
  unprotect: (b) => Buffer.from(b, "base64").toString("utf8"),
};

const projectConfig = (credentialRef = "KEY") => ({
  providers: { p: { kind: "openai-compat", baseUrl: "https://p.example/v1", credentialRef } },
  models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
  agent: { model: "p/m1", maxSteps: 2, tools: [] as string[] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
});
const profile = (id: string, credentialRef = "KEY") => ({
  id,
  name: id.toUpperCase(),
  kind: "openai-compat",
  baseUrl: "https://g.example/v1",
  credentialRef,
  models: [{ id: "m1", tags: ["writing-code"], context: 8192 }],
});

function setup(opts: { project?: boolean; store?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "astro-vault-import-"));
  const configPath = join(dir, "astro.config.json");
  const storePath = join(dir, "providers.json");
  if (opts.project !== false) writeFileSync(configPath, JSON.stringify(projectConfig()));
  if (opts.store === true) saveProfileStore({ version: 1, profiles: [profile("g")] }, storePath);
  return {
    dir,
    configPath,
    storePath,
    env: { ASTRO_HOME: dir, KEY: SENTINEL },
    vault: new Vault(join(dir, "vault.json"), fake),
  };
}

describe("vault-import dry-run (#311 B.3)", () => {
  test("planeja sem tocar em config, store ou cofre", () => {
    const s = setup();
    const before = readFileSync(s.configPath, "utf8");
    const result = importVaultCredential({ provider: "p", env: s.env, configPath: s.configPath, vault: s.vault });
    expect(result).toMatchObject({ status: "planned", provider: "p", envName: "KEY", source: "project" });
    expect(readFileSync(s.configPath, "utf8")).toBe(before);
    expect(existsSync(s.vault.path)).toBe(false);
    expect(formatVaultImport(result)).toContain("--apply");
  });
});

describe("vault-import apply (#311 B.3)", () => {
  test("migra provider do projeto e grava só a referência", () => {
    const s = setup();
    const result = importVaultCredential({
      provider: "p", env: s.env, configPath: s.configPath, vault: s.vault, apply: true, platform: "win32",
    });
    expect(result.status).toBe("imported");
    const ref = result.vaultRef!;
    expect(ref).toMatch(/^vault:cred-/);
    const raw = JSON.parse(readFileSync(s.configPath, "utf8")) as { providers: { p: { credentialRef: string } } };
    expect(raw.providers.p.credentialRef).toBe(ref);
    expect(readFileSync(s.configPath, "utf8")).not.toContain(SENTINEL);
    expect(s.vault.read(ref.slice("vault:".length))?.value).toBe(SENTINEL);
    expect(formatVaultImport(result)).toContain(ref);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(formatVaultImport(result)).not.toContain(SENTINEL);
  });

  test("migra perfil global e mantém a config do projeto intacta", () => {
    const s = setup({ store: true });
    const configBefore = readFileSync(s.configPath, "utf8");
    const result = importVaultCredential({
      provider: "g", env: s.env, configPath: s.configPath, storePath: s.storePath, vault: s.vault, apply: true, platform: "win32",
    });
    expect(result.source).toBe("global");
    const store = loadProfileStore(s.storePath);
    expect(store.profiles[0]!.credentialRef).toBe(result.vaultRef);
    expect(readFileSync(s.storePath, "utf8")).not.toContain(SENTINEL);
    expect(readFileSync(s.configPath, "utf8")).toBe(configBefore);
  });
});

describe("vault-import recusas (#311 B.3)", () => {
  test("env ausente falha sem criar cofre", () => {
    const s = setup();
    expect(() => importVaultCredential({
      provider: "p", env: { ASTRO_HOME: s.dir }, configPath: s.configPath, vault: s.vault, apply: true,
    })).toThrow(/defina KEY no ambiente/);
    expect(existsSync(s.vault.path)).toBe(false);
  });

  test("provider já migrado é recusado", () => {
    const s = setup();
    importVaultCredential({
      provider: "p", env: s.env, configPath: s.configPath, vault: s.vault, apply: true, platform: "win32",
    });
    expect(() => importVaultCredential({
      provider: "p", env: s.env, configPath: s.configPath, vault: s.vault, apply: true, platform: "win32",
    })).toThrow(/já usa o cofre/);
  });

  test("modo plain exige --allow-plain e avisa depois", () => {
    const s = setup();
    expect(() => importVaultCredential({
      provider: "p", env: s.env, configPath: s.configPath, vault: s.vault, apply: true, platform: "linux",
    })).toThrow(/--allow-plain/);
    const result = importVaultCredential({
      provider: "p", env: s.env, configPath: s.configPath, vault: s.vault, apply: true, platform: "linux", allowPlain: true,
    });
    expect(result.warning).toContain("plain");
    expect(formatVaultImport(result)).toContain("aviso:");
  });

  test("perfil de ambiente é efêmero e não migra", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-vault-import-env-"));
    const env = { ASTRO_HOME: dir, OPENAI_API_KEY: SENTINEL, OPENAI_MODEL: "m1" };
    expect(() => importVaultCredential({
      provider: "env", env, configPath: join(dir, "astro.config.json"),
      vault: new Vault(join(dir, "vault.json"), fake), apply: true,
    })).toThrow(/efêmero/);
  });

  test("ref que não é nome de env não é ecoada (I-03)", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-vault-import-ref-"));
    const configPath = join(dir, "astro.config.json");
    writeFileSync(configPath, JSON.stringify(projectConfig(SENTINEL)));
    let message = "";
    try {
      importVaultCredential({
        provider: "p", env: { ASTRO_HOME: dir }, configPath,
        vault: new Vault(join(dir, "vault.json"), fake), apply: true, platform: "win32",
      });
    } catch (error) { message = String(error); }
    expect(message).toContain("não é um nome de variável de ambiente");
    expect(message).not.toContain(SENTINEL);
  });

  test("kind que não lê o cofre é recusado", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-vault-import-codex-"));
    const configPath = join(dir, "astro.config.json");
    writeFileSync(configPath, JSON.stringify({
      providers: { c: { kind: "codex-oauth", credentialsPath: "~/.codex/auth.json" } },
      models: [{ provider: "c", id: "m1", tags: ["writing-code"], context: 8192 }],
      agent: { model: "c/m1", maxSteps: 2, tools: [] },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    }));
    expect(() => importVaultCredential({
      provider: "c", env: { ASTRO_HOME: dir }, configPath,
      vault: new Vault(join(dir, "vault.json"), fake), apply: true, platform: "win32",
    })).toThrow(/não lê o cofre/);
  });
});
