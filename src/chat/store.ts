/** Persistência sanitizada da sessão de chat (T1): schema 1, escrita atômica. */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { ChatMessage } from "../provider/types";
import { redactSecrets } from "../sanitize-external";

export interface SessionRecord {
  schemaVersion: 1;
  id: string;
  startedAt: string;
  model: string;
  messages: ChatMessage[];
  turns: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
  /** Nome dado pelo usuário no picker (`/sessions`, #64). */
  name?: string;
  /** Origem quando a sessão foi retomada de outra. */
  resumedFrom?: { id: string; startedAt: string };
}

const SECRET_KEY = /(token(?!s)|secret|password|api[-_]?key|access[-_]?key)/i;

export interface SessionSummary {
  path: string;
  id: string;
  startedAt: string;
  model: string;
  turns: number;
  costUsd: number | null;
  name?: string;
}

/** Tamanho máximo de um nome de sessão (caracteres). */
export const MAX_SESSION_NAME = 60;

/** C0/C1/DEL, separadores de linha e formatadores invisíveis (bidi, zero-width…). */
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Cf}/u;

/** Normaliza um nome; inválido vira `undefined` (leitura tolerante, #64). */
function normalizeName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim();
  // ZWJ/ZWNJ são legítimos (emoji composto, persa/indic); o resto da classe continua barrado
  const visible = clean.replace(/[\u200c\u200d]/g, "");
  if (clean === "" || [...clean].length > MAX_SESSION_NAME || visible === "" || INVISIBLE.test(visible)) return undefined;
  return clean;
}

/** Nome vindo do usuário: inválido é erro (escrita estrita, #64). */
function requireName(value: string): string {
  const clean = normalizeName(value);
  if (clean === undefined) throw new Error("nome da sessão inválido");
  return clean;
}

const ROLES = new Set(["system", "user", "assistant", "tool"]);

/** Teto de uma sessão em disco, na leitura e na escrita. */
export const MAX_SESSION_BYTES = 5 * 1024 * 1024;

/** Valida um registro vindo do disco (pode ter sido editado à mão). */
function parseRecord(raw: unknown): SessionRecord {
  if (raw === null || typeof raw !== "object") throw new Error("registro de sessão inválido");
  const record = raw as Partial<SessionRecord>;
  if (record.schemaVersion !== 1) throw new Error("schema de sessão não suportado");
  if (typeof record.id !== "string" || !/^[A-Za-z0-9-]+$/.test(record.id)) throw new Error("id de sessão inválido");
  if (typeof record.startedAt !== "string" || Number.isNaN(Date.parse(record.startedAt))) throw new Error("início de sessão inválido");
  if (typeof record.model !== "string" || record.model === "") throw new Error("modelo da sessão inválido");
  if (!Array.isArray(record.messages)) throw new Error("mensagens da sessão inválidas");
  const messages = record.messages.map((message) => {
    if (message === null || typeof message !== "object") throw new Error("mensagem de sessão inválida");
    const item = message as Partial<ChatMessage>;
    if (typeof item.role !== "string" || !ROLES.has(item.role) || typeof item.content !== "string") {
      throw new Error("mensagem de sessão inválida");
    }
    if (item.toolCallId !== undefined && typeof item.toolCallId !== "string") {
      throw new Error("toolCallId de sessão inválido");
    }
    if (item.role === "tool" && typeof item.toolCallId !== "string") {
      throw new Error("mensagem de tool sem toolCallId");
    }
    if (item.toolCalls !== undefined) {
      if (!Array.isArray(item.toolCalls)) throw new Error("toolCalls de sessão inválido");
      for (const call of item.toolCalls) {
        if (call === null || typeof call !== "object") throw new Error("toolCall de sessão inválido");
        if (typeof call.id !== "string" || typeof call.name !== "string" || typeof call.arguments !== "string") {
          throw new Error("toolCall de sessão inválido");
        }
      }
    }
    return item as ChatMessage;
  });
  const number = (value: unknown, name: string): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${name} da sessão inválido`);
    return value;
  };
  const costUsd = record.costUsd === null || record.costUsd === undefined
    ? null
    : number(record.costUsd, "custo");
  const name = normalizeName(record.name);
  return {
    schemaVersion: 1,
    id: record.id,
    startedAt: record.startedAt,
    model: record.model,
    messages,
    turns: number(record.turns, "turnos"),
    tokensIn: number(record.tokensIn, "tokens"),
    tokensOut: number(record.tokensOut, "tokens"),
    costUsd,
    ...(name === undefined ? {} : { name }),
    ...parseResumedFrom(record.resumedFrom),
  };
}

function parseResumedFrom(value: unknown): { resumedFrom?: { id: string; startedAt: string } } {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object") throw new Error("origem da sessão inválida");
  const origin = value as { id?: unknown; startedAt?: unknown };
  if (typeof origin.id !== "string" || !/^[A-Za-z0-9-]+$/.test(origin.id)) {
    throw new Error("origem da sessão inválida");
  }
  if (typeof origin.startedAt !== "string" || Number.isNaN(Date.parse(origin.startedAt))) {
    throw new Error("origem da sessão inválida");
  }
  return { resumedFrom: { id: origin.id, startedAt: origin.startedAt } };
}

/** Sanitiza strings JSON estruturalmente (inclusive `toolCalls.arguments`). */
function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, SECRET_KEY.test(key) ? "[REDACTED]" : sanitizeValue(item),
    ]));
  }
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      return JSON.stringify(sanitizeValue(JSON.parse(text)));
    } catch {
      // não era JSON: cai na redação textual
    }
  }
  return redactSecrets(value);
}

export class SessionStore {
  constructor(readonly root: string) {}

  /** Sessões gravadas, mais recentes primeiro; arquivos inválidos são ignorados. */
  list(): SessionSummary[] {
    let names: string[];
    try {
      names = readdirSync(this.root);
    } catch {
      return [];
    }
    const out: SessionSummary[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const path = join(this.root, name);
      try {
        const record = this.#read(path);
        out.push({
          path, id: record.id, startedAt: record.startedAt, model: record.model,
          turns: record.turns, costUsd: record.costUsd,
          ...(record.name === undefined ? {} : { name: record.name }),
        });
      } catch {
        // arquivo corrompido ou de outro schema: não aparece na lista
      }
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Carrega por id, índice não é aceito aqui; aceita também um nome `.json` relativo. */
  load(ref: string): { record: SessionRecord; path: string } {
    const found = this.list().find((item) => item.id === ref);
    const path = found?.path ?? (ref.endsWith(".json") ? this.#inside(ref) : undefined);
    if (path === undefined) throw new Error(`sessão "${ref}" não encontrada`);
    return { record: this.#read(path), path };
  }

  /** Renomeia a sessão no próprio arquivo (atômico, sem duplicar) e devolve o resumo (#64). */
  rename(ref: string, name: string): SessionSummary {
    const { record, path } = this.load(ref);
    // aplica a sanitização real antes de validar: redação pode expandir o texto e
    // nomes JSON podem esconder controles/escapes; o que vale é o valor gravado
    const sanitized = sanitizeValue(requireName(name));
    const stored = typeof sanitized === "string" ? normalizeName(sanitized) : undefined;
    if (stored === undefined) throw new Error("nome da sessão inválido");
    const updated: SessionRecord = { ...record, name: stored };
    const json = JSON.stringify(sanitizeValue(updated), null, 2);
    if (Buffer.byteLength(json, "utf8") > MAX_SESSION_BYTES) {
      throw new Error("sessão grande demais para gravar (máx 5 MB)");
    }
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, json, { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(tmp, path);
    } catch (error) {
      try { rmSync(tmp, { force: true }); } catch { /* preserva o erro original */ }
      throw error;
    }
    return {
      path, id: record.id, startedAt: record.startedAt, model: record.model,
      turns: record.turns, costUsd: record.costUsd, name: stored,
    };
  }

  #inside(path: string): string {
    const root = resolve(this.root);
    const candidate = resolve(root, path);
    if (candidate !== root && !candidate.startsWith(root + sep)) {
      throw new Error("caminho de sessão fora do diretório");
    }
    return candidate;
  }

  #read(path: string): SessionRecord {
    const real = realpathSync(path);
    const root = realpathSync(this.root);
    if (real !== root && !real.startsWith(root + sep)) throw new Error("caminho de sessão fora do diretório");
    if (statSync(real).size > MAX_SESSION_BYTES) throw new Error("sessão grande demais");
    const raw: unknown = JSON.parse(readFileSync(real, "utf8"));
    const record = sanitizeValue(parseRecord(raw)) as SessionRecord;
    // a sanitização pode decodificar escapes JSON e soltar controles em campos
    // renderizados: rejeita o arquivo com model/startedAt invisível e revalida o nome
    if (INVISIBLE.test(record.model)) throw new Error("modelo da sessão inválido");
    if (INVISIBLE.test(record.startedAt)) throw new Error("início da sessão inválido");
    const name = normalizeName(record.name);
    if (name === undefined) delete record.name;
    else record.name = name;
    return record;
  }

  /** Grava a sessão sanitizada; nome `<startedAt>-<id>.json`, atômico (tmp+rename). */
  write(snapshot: Omit<SessionRecord, "schemaVersion" | "name">): string {
    const stamp = snapshot.startedAt.replace(/[:.]/g, "-");
    if (!/^[A-Za-z0-9-]+$/.test(snapshot.id) || !/^[A-Za-z0-9-]+$/.test(stamp)) {
      throw new Error("sessão com id/startedAt inválido para o nome do arquivo");
    }
    mkdirSync(this.root, { recursive: true });
    const path = join(this.root, `${stamp}-${snapshot.id}.json`);
    // o snapshot não carrega `name`: preserva o nome dado por rename no auto-save (#64)
    let name: string | undefined;
    try {
      if (existsSync(path)) name = this.#read(path).name;
    } catch {
      name = undefined; // arquivo ilegível não impede o auto-save
    }
    // `name` vindo de chamador JS é descartado: só `rename` muda o nome (runtime)
    const base = { ...snapshot } as Record<string, unknown>;
    delete base.name;
    const record = sanitizeValue({ schemaVersion: 1, ...base, ...(name === undefined ? {} : { name }) }) as SessionRecord;
    // nunca grava um arquivo que o #read recusaria (sessão salva mas invisível)
    if (record.model === "" || INVISIBLE.test(record.model)) throw new Error("modelo da sessão inválido");
    const json = JSON.stringify(record, null, 2);
    if (Buffer.byteLength(json, "utf8") > MAX_SESSION_BYTES) {
      throw new Error("sessão grande demais para gravar (máx 5 MB)");
    }
    // tmp imprevisível + wx: não segue link plantado no irmão do arquivo (I-11)
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, json, { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(tmp, path);
    } catch (error) {
      try { rmSync(tmp, { force: true }); } catch { /* preserva o erro original */ }
      throw error;
    }
    return path;
  }
}

export function sessionSummaryLine(item: SessionSummary, index: number): string {
  const cost = item.costUsd === null ? "n/d" : `US$ ${item.costUsd.toFixed(6)}`;
  const label = item.name === undefined ? item.id : `${item.name} (${item.id})`;
  return `${index + 1}. ${item.startedAt} ${label} ${item.model} turnos=${item.turns} custo=${cost}`;
}