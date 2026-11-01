import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isCriticalPath } from "../src/permissions";
import { redactSecrets } from "../src/sanitize-external";
import {
  defaultScheme,
  dpapiProtect,
  dpapiUnprotect,
  loadVault,
  saveVault,
  validateVaultStore,
  vaultMeta,
  vaultPath,
  vaultPlainWarning,
  type VaultStore,
} from "../src/vault";

// Sentinelas construídos em runtime para não disparar o gate de segredos.
const SENTINEL = ["sentinel", "-", "xyz"].join("");
const SPACED_SECRET = ["sentinel", "-", "xyz 123"].join("");
const FAKE_SK = ["s", "k", "-"].join("") + "live-abcdef12345";

function tmpVault() {
  const dir = mkdtempSync(join(tmpdir(), "astro-vault-"));
  return { dir, path: join(dir, "vault.json") };
}

const CRED = {
  id: "cred-12345678", providerId: "openai", label: "pessoal", scheme: "dpapi" as const,
  secret: "blob", createdAt: "2026-11-01T00:00:00.000Z", lastUsedAt: "2026-11-01T00:00:00.000Z", active: true,
};

describe("vaultPath/defaultScheme (#311)", () => {
  test("$ASTRO_HOME sobrescreve; default ~/.astro/vault.json; scheme por plataforma", () => {
    expect(vaultPath({ ASTRO_HOME: join("C:", "x") } as NodeJS.ProcessEnv)).toBe(join("C:", "x", "vault.json"));
    const env = { ...process.env } as NodeJS.ProcessEnv;
    delete env.ASTRO_HOME;
    expect(vaultPath(env)).toBe(join(homedir(), ".astro", "vault.json"));
    expect(defaultScheme("win32")).toBe("dpapi");
    expect(defaultScheme("linux")).toBe("plain");
    expect(defaultScheme("darwin")).toBe("plain");
  });
});

describe("store do cofre (#311, I-03)", () => {
  test("roundtrip: arquivo 0600 e diretório 0700 no POSIX; ausente → vazio", () => {
    const { dir, path } = tmpVault();
    const store: VaultStore = { version: 1, credentials: [CRED] };
    saveVault(store, path);
    expect(loadVault(path)).toEqual(store);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    expect(loadVault(join(dir, "nao-existe.json"))).toEqual({ version: 1, credentials: [] });
  });

  test("JSON corrompido → erro cita o caminho e NÃO ecoa conteúdo (I-03)", () => {
    const { path } = tmpVault();
    writeFileSync(path, `{"version":1,"credentials":[{"secret":"${SENTINEL}"`); // inválido + segredo
    let err: Error | undefined;
    try {
      loadVault(path);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain(path);
    expect(err!.message).not.toContain(SENTINEL);
  });

  test("validação estrita: chave desconhecida (sem ecoar valor), scheme/id/campos ruins", () => {
    const { path } = tmpVault();
    writeFileSync(path, JSON.stringify({ version: 1, credentials: [], [FAKE_SK]: 1 }));
    let err: Error | undefined;
    try {
      loadVault(path);
    } catch (e) {
      err = e as Error;
    }
    expect(err!.message).toMatch(/desconhecido/);
    expect(err!.message).not.toContain(FAKE_SK);
    const base = { ...CRED };
    expect(() => validateVaultStore({ version: 2, credentials: [] })).toThrow(/version/);
    expect(() => validateVaultStore({ version: 1, credentials: [{ ...base, scheme: "rot13" as never }] })).toThrow(/scheme/);
    expect(() => validateVaultStore({ version: 1, credentials: [{ ...base, id: "../x" }] })).toThrow(/id/);
    expect(() => validateVaultStore({ version: 1, credentials: [{ ...base, secret: "" }] })).toThrow(/secret/);
    expect(() => validateVaultStore({ version: 1, credentials: [{ ...base, active: "sim" as never }] })).toThrow(/active/);
    expect(() => validateVaultStore({ version: 1, credentials: [{ ...base, label: FAKE_SK }] })).toThrow(/label/);
    expect(validateVaultStore({ version: 1, credentials: [base] }).credentials).toHaveLength(1);
  });
});

describe("redaction do formato vault (ADR-0019, I-03)", () => {
  test('par "secret": "<valor>" do vault é redacted inteiro, mesmo com espacos', () => {
    const payload = JSON.stringify({ version: 1, credentials: [{ id: "cred-1", scheme: "plain", secret: SPACED_SECRET }] });
    const out = redactSecrets(payload);
    expect(out).not.toContain(SPACED_SECRET);
    expect(out).not.toContain("xyz 123");
    expect(out).toContain("[REDACTED]");
  });

  test("valor com aspas escapadas é redacted por completo, sem rabo", () => {
    const quoted = ["pa", '"', "ss", '"', "word"].join(""); // sentinel em runtime
    const out = redactSecrets(JSON.stringify({ secret: quoted }));
    expect(out).not.toContain(quoted);
    expect(out).not.toContain("ss");
    expect(out).toContain("[REDACTED]");
  });

  test("store plain grava o valor em claro no arquivo (0600), mas redactSecrets cobre o formato", () => {
    const { path } = tmpVault();
    saveVault({ version: 1, credentials: [{ ...CRED, scheme: "plain", secret: SENTINEL }] }, path);
    const raw = readFileSync(path, "utf8");
    expect(raw).toContain(SENTINEL); // plain é explícito (0600)
    expect(redactSecrets(raw)).not.toContain(SENTINEL); // mas nunca sai para log/contexto
    expect(redactSecrets(raw)).toContain("[REDACTED]");
  });

  test("vault.json é caminho crítico (PERM-03)", () => {
    expect(isCriticalPath(join("home", "u", ".astro", "vault.json"))).toBe(true);
  });
});

describe("vaultMeta/vaultPlainWarning (#311)", () => {
  test("ausente → exists false; existente → contagens; plain → aviso cita o caminho", () => {
    const { path } = tmpVault();
    const absent = vaultMeta(join(path, "..", "nada.json"), "linux");
    expect(absent.exists).toBe(false);
    expect(vaultPlainWarning(absent)).toBeUndefined();
    saveVault({ version: 1, credentials: [CRED] }, path);
    const meta = vaultMeta(path, "win32");
    expect(meta.exists).toBe(true);
    expect(meta.credentials).toBe(1);
    expect(meta.active).toBe(1);
    expect(meta.plain).toBe(false);
    expect(vaultPlainWarning(meta)).toBeUndefined();
    const linux = vaultMeta(path, "linux");
    expect(linux.plain).toBe(true);
    const warn = vaultPlainWarning(linux);
    expect(warn).toBeDefined();
    expect(warn).toContain(path);
    expect(warn).not.toContain(CRED.secret);
  });
});

describe("DPAPI real (só win32) (#311)", () => {
  test("protect/unprotect roundtrip e blob não contém o segredo", () => {
    if (process.platform !== "win32") return; // fora do Windows o backend é plain
    const blob = dpapiProtect(SENTINEL);
    expect(blob).not.toContain(SENTINEL);
    expect(dpapiUnprotect(blob)).toBe(SENTINEL);
    expect(() => dpapiUnprotect("blob-invalido!!!")).toThrow();
  });
});
