/**
 * Cofre local de credenciais (ADR-0019, #311, I-03): `~/.astro/vault.json`
 * (`ASTRO_HOME` sobrescreve), dir 0700, arquivo 0600, escrita atômica.
 * Windows: DPAPI via PowerShell (segredo só por env do filho); fora: "plain"
 * 0600 com aviso. O segredo nunca vai para log/audit/erro/prompt.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { looksLikeSecret } from "./secrets";

export type VaultScheme = "dpapi" | "plain";

export interface VaultCredential {
  /** `cred-<uuid>`; nunca vai para path de arquivo. */
  id: string;
  providerId: string;
  /** Metadado em claro; com cara de segredo é recusado (I-03). */
  label: string;
  scheme: VaultScheme;
  /** dpapi: blob base64; plain: valor em claro. Nunca logado (I-03). */
  secret: string;
  createdAt: string;
  lastUsedAt: string;
  active: boolean;
}

// Visão sem o campo secreto (listagem/TUI); o valor só existe em memória (I-03).
export type VaultPublic = Omit<VaultCredential, "secret">;

export interface VaultStore {
  version: 1;
  credentials: VaultCredential[];
}

export function vaultPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.ASTRO_HOME?.trim();
  const base = home === undefined || home === "" ? join(homedir(), ".astro") : home;
  return join(base, "vault.json");
}

export function defaultScheme(platform: NodeJS.Platform = process.platform): VaultScheme {
  return platform === "win32" ? "dpapi" : "plain";
}

export interface VaultBackend {
  scheme: VaultScheme;
  protect(secret: string): string;
  unprotect(stored: string): string;
}

function dpapiEntropy(): string {
  const user = process.env.USERNAME ?? process.env.USER ?? "unknown";
  return `astro:${user}`;
}

// Segredo só por env (ASTRO_VAULT_*); PS 5.1 usa assembly System.Security, pwsh 7 o próprio.
const DPAPI_LOAD =
  "try { Add-Type -AssemblyName System.Security.Cryptography.ProtectedData -ErrorAction Stop } " +
  "catch { Add-Type -AssemblyName System.Security };";
const DPAPI_PROTECT_SCRIPT =
  DPAPI_LOAD +
  "[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect(" +
  "[System.Text.Encoding]::UTF8.GetBytes($env:ASTRO_VAULT_SECRET), " +
  "[System.Text.Encoding]::UTF8.GetBytes($env:ASTRO_VAULT_ENTROPY), " +
  "[System.Security.Cryptography.DataProtectionScope]::CurrentUser))";
const DPAPI_UNPROTECT_SCRIPT =
  DPAPI_LOAD +
  "[System.Text.Encoding]::UTF8.GetString([System.Security.Cryptography.ProtectedData]::Unprotect(" +
  "[Convert]::FromBase64String($env:ASTRO_VAULT_BLOB), " +
  "[System.Text.Encoding]::UTF8.GetBytes($env:ASTRO_VAULT_ENTROPY), " +
  "[System.Security.Cryptography.DataProtectionScope]::CurrentUser))";

function runDpapi(script: string, envExtra: Record<string, string>): string {
  if (process.platform !== "win32") throw new Error("DPAPI só existe no Windows (cofre usa modo plain fora dele)");
  return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    maxBuffer: 1 << 20,
    stdio: ["ignore", "pipe", "ignore"], // stderr pode conter o segredo (I-03)
    env: { ...process.env, ASTRO_VAULT_ENTROPY: dpapiEntropy(), ...envExtra },
  });
}

/** Cifra com DPAPI (Windows) via PowerShell; devolve blob base64. */
export function dpapiProtect(secret: string): string {
  const blob = runDpapi(DPAPI_PROTECT_SCRIPT, { ASTRO_VAULT_SECRET: secret }).trim();
  if (blob === "") throw new Error("DPAPI devolveu blob vazio ao cifrar");
  return blob;
}

/** Decifra blob DPAPI. Falha → erro genérico: nunca incluir saída (pode conter o segredo). */
export function dpapiUnprotect(blob: string): string {
  try {
    return runDpapi(DPAPI_UNPROTECT_SCRIPT, { ASTRO_VAULT_BLOB: blob }).replace(/\r?\n$/, "");
  } catch {
    throw new Error("falha ao decifrar a credencial no cofre (DPAPI)");
  }
}

const ROOT_KEYS = new Set(["version", "credentials"]);
const CRED_KEYS = new Set(["id", "providerId", "label", "scheme", "secret", "createdAt", "lastUsedAt", "active"]);
const ID_RE = /^cred-[A-Za-z0-9-]{8,}$/;

function fail(message: string): never {
  throw new Error(message);
}

/** Validação estrita do cofre; nunca interpola valores na mensagem (I-03). */
export function validateVaultStore(raw: unknown): VaultStore {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail(`"store" deve ser um objeto`);
  const root = raw as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (!ROOT_KEYS.has(key)) fail("store do cofre contém campo desconhecido");
  }
  if (root.version !== 1) fail(`"version" deve ser 1`);
  if (!Array.isArray(root.credentials)) fail(`"credentials" deve ser uma lista`);
  const credentials: VaultCredential[] = [];
  const ids = new Set<string>();
  for (const entry of root.credentials) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) fail("credencial deve ser um objeto");
    const cred = entry as Record<string, unknown>;
    for (const key of Object.keys(cred)) {
      if (!CRED_KEYS.has(key)) fail("credencial contém campo desconhecido");
    }
    if (typeof cred.id !== "string" || !ID_RE.test(cred.id)) fail(`"id" inválido`);
    if (ids.has(cred.id)) fail(`"id" duplicado`);
    if (typeof cred.providerId !== "string" || cred.providerId.trim() === "") fail(`"providerId" inválido`);
    if (typeof cred.label !== "string" || cred.label.trim() === "") fail(`"label" inválido`);
    if (looksLikeSecret(cred.label)) fail(`"label" parece conter segredo`);
    if (cred.scheme !== "dpapi" && cred.scheme !== "plain") fail(`"scheme" deve ser "dpapi" ou "plain"`);
    if (typeof cred.secret !== "string" || cred.secret === "") fail(`"secret" inválido`);
    if (typeof cred.createdAt !== "string" || typeof cred.lastUsedAt !== "string") fail("datas inválidas");
    if (typeof cred.active !== "boolean") fail(`"active" deve ser booleano`);
    ids.add(cred.id);
    credentials.push(cred as unknown as VaultCredential);
  }
  return { version: 1, credentials };
}

/** Cofre ausente é vazio; corrompido/inválido é erro só com o caminho (I-03). */
export function loadVault(path: string = vaultPath()): VaultStore {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { version: 1, credentials: [] };
    throw new Error(`cofre inválido em "${path}": ${error instanceof Error ? error.message : String(error)}`);
  }
  if (text.trim() === "") return { version: 1, credentials: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`cofre inválido em "${path}": JSON inválido`); // detalhe do parser pode ser segredo (I-03)
  }
  try {
    return validateVaultStore(parsed);
  } catch (error) {
    throw new Error(`cofre inválido em "${path}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function saveVault(store: VaultStore, path: string = vaultPath()): void {
  const valid = validateVaultStore(store);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  if (process.platform !== "win32") {
    try { chmodSync(dir, 0o700); } catch { /* melhor esforço */ }
  }
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(valid, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* tmp já não existe */ }
    throw error;
  }
}

export interface VaultMeta {
  path: string;
  exists: boolean;
  /** Backend da plataforma (modo do cofre). */
  scheme: VaultScheme;
  /** true quando o modo é plain (aviso visível obrigatório, ADR-0019). */
  plain: boolean;
  credentials: number;
  active: number;
}

export function vaultMeta(path: string = vaultPath(), platform: NodeJS.Platform = process.platform): VaultMeta {
  const scheme = defaultScheme(platform);
  if (!existsSync(path)) {
    return { path, exists: false, scheme, plain: scheme === "plain", credentials: 0, active: 0 };
  }
  const store = loadVault(path);
  return {
    path,
    exists: true,
    scheme,
    plain: scheme === "plain" || store.credentials.some((c) => c.scheme === "plain"),
    credentials: store.credentials.length,
    active: store.credentials.filter((c) => c.active).length,
  };
}

export function vaultPlainWarning(meta: VaultMeta): string | undefined {
  if (!meta.exists || !meta.plain) return undefined;
  return `aviso: cofre de credenciais em modo "plain" (sem cifra do SO) em ${meta.path} (arquivo 0600); no Windows o segredo é cifrado com DPAPI`;
}

