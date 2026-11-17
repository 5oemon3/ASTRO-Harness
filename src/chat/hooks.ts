/**
 * Contrato dos hooks de sessão (#367, T4 slice 4).
 *
 * Opcional e sem consumidor neste slice: um futuro módulo de memória consome
 * `onMessage`/`onToolResult` sem tocar no store. Os hooks são síncronos e
 * disparam ao fim do turno, na ordem do store. O payload é sanitizado na
 * origem (I-03) e o resultado de tool é limitado; erro do observador nunca
 * aborta o turno.
 */
import type { ChatMessage } from "../providers/types";
import { redactSecrets } from "../sanitize-external";

/** Evento de mensagem `user`/`assistant` gravada na sessão. */
export interface SessionMessageEvent {
  sessionId: string;
  /** Cópia sanitizada; imagens (base64) nunca saem do runtime. */
  message: ChatMessage;
  /** ISO-8601 do momento da emissão (fim do turno). */
  at: string;
}

/** Evento de resultado de tool. */
export interface SessionToolResultEvent {
  sessionId: string;
  toolCallId: string;
  name: string;
  /** Resultado redigido e limitado a `MAX_HOOK_TOOL_RESULT_CHARS`. */
  result: string;
  /** ISO-8601 do momento da emissão (fim do turno). */
  at: string;
}

export type SessionMessageHook = (event: SessionMessageEvent) => void;
export type SessionToolResultHook = (event: SessionToolResultEvent) => void;

/** Teto do resultado exposto ao observador; o store mantém o conteúdo completo. */
export const MAX_HOOK_TOOL_RESULT_CHARS = 16_384;

/** Copia a mensagem sem `images` e redige todo texto (I-03). */
export function sanitizeHookMessage(message: ChatMessage): ChatMessage {
  const { images: _images, ...rest } = message;
  return sanitizeValue(rest) as ChatMessage;
}

/** Redige um texto isolado do payload do hook (I-03). */
export function sanitizeHookText(value: string): string {
  return redactSecrets(value);
}

/** Redige e limita o resultado da tool; o teto inclui o marcador `[truncated]`. */
export function boundHookToolResult(result: string): string {
  const redacted = redactSecrets(result);
  const chars = Array.from(redacted);
  if (chars.length <= MAX_HOOK_TOOL_RESULT_CHARS) return redacted;
  const marker = "\n[truncated]";
  // `Array.from` evita cortar um par surrogate no meio.
  return `${chars.slice(0, MAX_HOOK_TOOL_RESULT_CHARS - marker.length).join("")}${marker}`;
}

/** Chama o observador; erro dele nunca aborta o turno (#367). */
export function emitHook<T>(hook: ((event: T) => void) | undefined, event: T): void {
  if (hook === undefined) return;
  try {
    hook(event);
  } catch {
    // Erro do observador é intencionalmente ignorado: sem consumidor neste slice.
  }
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeValue(entry)]));
  }
  return value;
}
