/**
 * Trust por pasta (#267, I-11): 1º open de cwd não confiável pergunta (TTY) e
 * persiste em `$ASTRO_HOME/trusted.json` / `~/.astro/trusted.json`; sem canal
 * interativo (eval/CI) prossegue sem gravar. Store sem segredo.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { statePath } from "./astro-home";
import { loadHomeState, saveHomeState } from "./home-state";
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
/** Caminho do estado global de trust: `$ASTRO_HOME/state.json` ou `~/.astro/state.json`. */
export function trustStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return statePath(env);
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
function loadTrustedFile(path: string): TrustedStore {
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

/**
 * `path` é o arquivo de estado global quando omitido ou quando o basename é `state.json`;
 * qualquer outro caminho é tratado como store legado (`trusted.json`). A heurística é
 * intencional: permite injetar um diretório temporário nos testes sem perder a migração.
 */
function isStatePath(path: string | undefined): boolean {
  return path === undefined || basename(path) === "state.json";
}

export function loadTrustedStore(path?: string): TrustedStore {
  if (!isStatePath(path)) return loadTrustedFile(path!);
  const statePathValue = path ?? trustStatePath();
  const state = loadHomeState(statePathValue);
  if (!state.migrations.trust) {
    const legacyPath = join(dirname(statePathValue), "trusted.json");
    if (existsSync(legacyPath)) {
      const legacy = loadTrustedFile(legacyPath);
      const folders = [...new Set([...state.trust.folders, ...legacy.folders])];
      saveHomeState({
        ...state,
        trust: { folders },
        migrations: { ...state.migrations, trust: true },
      }, statePathValue);
      return { version: 1, folders };
    }
  }
  return { version: 1, folders: state.trust.folders };
}

/** Valida antes de gravar; escrita atômica (tmp + rename) com modo 0600 no POSIX. */
export function saveTrustedStore(store: TrustedStore, path?: string): void {
  const valid = validateTrustedStore(store);
  if (isStatePath(path)) {
    const statePathValue = path ?? trustStatePath();
    const state = loadHomeState(statePathValue);
    saveHomeState({ ...state, trust: { folders: valid.folders } }, statePathValue);
    return;
  }
  const targetPath = path!;
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(valid, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(tmp, targetPath);
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
  readonly #storePath: string;
  #store: TrustedStore;
  constructor(path?: string) {
    this.#storePath = path ?? trustStatePath();
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
    saveTrustedStore(this.#store, this.#storePath);
  }
  /** Remove a pasta exata da lista; retorna false se ela não estava lá. */
  revoke(dir: string): boolean {
    const folder = canonicalFolder(dir);
    const next = this.#store.folders.filter((entry) => entry !== folder);
    if (next.length === this.#store.folders.length) return false;
    this.#store = { version: 1, folders: next };
    saveTrustedStore(this.#store, this.#storePath);
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
  /** Caminho do store (teste); default `trustStatePath()`. Ausente em `ask` = não-TTY (prossegue sem persistir). */
  path?: string;
  ask?: TrustAsk;
  /** Audit hook da decisão tomada (`trust.decision`). */
  onDecision?: (folder: string, decision: "allow" | "deny") => void;
}
/**
 * Garante trust do cwd antes do run: já confiável → `true`; sem canal
 * interativo (eval/CI) → `false` sem persistir; senão pergunta — aprovar
 * persiste + audita `allow` e devolve `true`; negar audita `deny` e joga
 * `TrustDeniedError`. O retorno é o gate para carregar plugins locais (#255).
 */
export async function ensureTrustedCwd(cwd: string, opts: EnsureTrustedOptions = {}): Promise<boolean> {
  const folders = new TrustedFolders(opts.path);
  if (folders.isTrusted(cwd)) return true;
  if (opts.ask === undefined) return false;
  const folder = canonicalFolder(cwd);
  const allow = await opts.ask(folder);
  if (allow) {
    folders.trust(folder);
    opts.onDecision?.(folder, "allow");
    return true;
  }
  opts.onDecision?.(folder, "deny");
  throw new TrustDeniedError(folder);
}
