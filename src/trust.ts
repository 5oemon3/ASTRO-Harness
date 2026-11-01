/**
 * Trust por pasta (#267, I-11): 1º open de cwd não confiável pergunta (TTY) e
 * persiste em `$ASTRO_HOME/trusted.json` / `~/.astro/trusted.json`; sem canal
 * interativo (eval/CI) prossegue sem gravar. Store sem segredo.
 */
import { mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { looksLikeSecret } from "./secrets";
export interface TrustedStore {
  version: 1;
  /** Caminhos canônicos (realpath) confiáveis; subpastas herdam a confiança. */
  folders: string[];
}
const ROOT_KEYS = new Set(["version", "folders"]);
function fail(message: string): never {
  throw new Error(message);
}
/** Caminho do store: `$ASTRO_HOME/trusted.json` ou `~/.astro/trusted.json`. */
export function trustedPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.ASTRO_HOME?.trim();
  const base = home === undefined || home === "" ? join(homedir(), ".astro") : home;
  return join(base, "trusted.json");
}
/** Valida o store inteiro; campo desconhecido é erro, nunca ignorado. */
export function validateTrustedStore(raw: unknown): TrustedStore {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail(`"store" deve ser um objeto`);
  const root = raw as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    // I-03: nunca interpolar a chave — ela é conteúdo do arquivo e pode ser um segredo colado.
    if (!ROOT_KEYS.has(key)) fail("store de trust contém campo desconhecido");
  }
  if (root.version !== 1) fail(`"version" deve ser 1`);
  if (!Array.isArray(root.folders)) fail(`"folders" deve ser uma lista`);
  const folders: string[] = [];
  for (const entry of root.folders) {
    if (typeof entry !== "string" || entry.trim() === "") fail(`"folders" deve conter só caminhos não vazios`);
    // I-03: recusar caminho com cara de segredo, sem ecoar o valor.
    if (looksLikeSecret(entry)) fail(`"folders" contém entrada inválida`);
    if (!folders.includes(entry)) folders.push(entry);
  }
  return { version: 1, folders };
}
/** Store ausente é vazio; corrompido/inválido é erro só com o caminho (I-03). */
export function loadTrustedStore(path: string = trustedPath()): TrustedStore {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { version: 1, folders: [] };
    throw new Error(`store de trust inválido em "${path}": ${error instanceof Error ? error.message : String(error)}`);
  }
  if (text.trim() === "") return { version: 1, folders: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Nunca ecoar o detalhe do parser: ele cita o início do conteúdo, que pode ser segredo (I-03).
    throw new Error(`store de trust inválido em "${path}": JSON inválido`);
  }
  try {
    return validateTrustedStore(parsed);
  } catch (error) {
    throw new Error(`store de trust inválido em "${path}": ${error instanceof Error ? error.message : String(error)}`);
  }
}
/** Valida antes de gravar; escrita atômica (tmp + rename) com modo 0600 no POSIX. */
export function saveTrustedStore(store: TrustedStore, path: string = trustedPath()): void {
  const valid = validateTrustedStore(store);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(valid, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* tmp já não existe */ }
    throw error;
  }
}
/** Caminho canônico da pasta: realpath quando existe (symlink/junction não engana), senão resolve. */
export function canonicalFolder(dir: string): string {
  const resolved = resolve(dir);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}
function withinFolder(folder: string, target: string): boolean {
  const a = process.platform === "win32" ? folder.toLowerCase() : folder;
  const b = process.platform === "win32" ? target.toLowerCase() : target;
  const rel = relative(a, b);
  if (rel === "") return true;
  return !isAbsolute(rel) && rel.split(/[\\/]/)[0] !== "..";
}
export class TrustedFolders {
  readonly #path: string;
  #store: TrustedStore;
  constructor(path: string = trustedPath()) {
    this.#path = path;
    this.#store = loadTrustedStore(path);
  }
  list(): string[] {
    return [...this.#store.folders];
  }
  /** A pasta é confiável se ela própria ou uma ancestral dela está na lista. */
  isTrusted(dir: string): boolean {
    const target = canonicalFolder(dir);
    return this.#store.folders.some((folder) => withinFolder(folder, target));
  }
  trust(dir: string): void {
    const folder = canonicalFolder(dir);
    if (this.#store.folders.includes(folder)) return;
    this.#store = { version: 1, folders: [...this.#store.folders, folder] };
    saveTrustedStore(this.#store, this.#path);
  }
  /** Remove a pasta exata da lista; retorna false se ela não estava lá. */
  revoke(dir: string): boolean {
    const folder = canonicalFolder(dir);
    const next = this.#store.folders.filter((entry) => entry !== folder);
    if (next.length === this.#store.folders.length) return false;
    this.#store = { version: 1, folders: next };
    saveTrustedStore(this.#store, this.#path);
    return true;
  }
}
/** Negação de trust jogada para parar o run em ponto seguro (I-19). */
export class TrustDeniedError extends Error {
  readonly code = "trust_denied";
  constructor(readonly folder: string) {
    super(`pasta não confiável: "${folder}" (negada pelo usuário)`);
    this.name = "TrustDeniedError";
  }
}
/** Pergunta interativa de trust; ausente = modo não interativo (não persiste). */
export type TrustAsk = (cwd: string) => boolean | Promise<boolean>;
export function trustPrompt(cwd: string): string {
  return `a pasta "${cwd}" ainda não é confiável. confiar nesta pasta? [s/N] `;
}
/** `s/sim/y/yes` confia; qualquer outra coisa (inclusive EOF) não confia. */
export function trustChoice(answer: string | null | undefined): boolean {
  return answer != null && /^(s|sim|y|yes)$/i.test(answer.trim());
}
export interface EnsureTrustedOptions {
  /** Caminho do store (teste); default `trustedPath()`. Ausente em `ask` = não-TTY (prossegue sem persistir). */
  path?: string;
  ask?: TrustAsk;
  /** Audit hook da decisão tomada (`trust.decision`). */
  onDecision?: (folder: string, decision: "allow" | "deny") => void;
}
/**
 * Garante trust do cwd antes do run: já confiável → segue; sem canal
 * interativo (eval/CI) → prossegue sem persistir; senão pergunta — aprovar
 * persiste + audita `allow`, negar audita `deny` e joga `TrustDeniedError`.
 */
export async function ensureTrustedCwd(cwd: string, opts: EnsureTrustedOptions = {}): Promise<void> {
  const folders = new TrustedFolders(opts.path);
  if (folders.isTrusted(cwd)) return;
  if (opts.ask === undefined) return;
  const folder = canonicalFolder(cwd);
  const allow = await opts.ask(folder);
  if (allow) {
    folders.trust(folder);
    opts.onDecision?.(folder, "allow");
    return;
  }
  opts.onDecision?.(folder, "deny");
  throw new TrustDeniedError(folder);
}
