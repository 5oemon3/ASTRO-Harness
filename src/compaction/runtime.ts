/**
 * Runtime da compactação (S-17, CMP-6/CMP-7): decide quando compactar antes da
 * chamada, retenta UMA vez quando o provider rejeita por tamanho e respeita a
 * pausa do breaker.
 */
import { throwIfAborted, isAbortError } from "../abort";
import type { Auditor } from "../audit";
import type { Ledger } from "../ledger";
import { ProviderError, type ChatMessage, type CompletionResponse } from "../providers/types";
import {
  applyBackgroundCompaction,
  PREWARM_MARGIN,
  type BackgroundCompaction,
  type BackgroundCompactor,
  type CompactionIdentity,
} from "./background";
import {
  CompactionPausedError,
  compactionState,
  recordCompactionFailure,
  recordCompactionSuccess,
} from "./breaker";
import {
  RECENT_TOKENS,
  compactSession,
  effectiveRecentBudget,
  recentSliceStart,
  reserveTokens,
  shouldCompact,
  type CompactionConfig,
} from "./engine";
import { countMessageTokens } from "../tokens";

export interface CompactionRuntimeOptions {
  ledger: Ledger;
  audit: Auditor;
  run: string;
  agent: () => string;
  window: () => number;
  provider: () => string;
  model: () => string;
  compaction: CompactionConfig;
  signal?: AbortSignal;
  /** Completion real sobre as mensagens correntes. */
  complete: (messages: readonly ChatMessage[]) => Promise<CompletionResponse>;
  /** Resumo sem tools. */
  summarize: (messages: ChatMessage[], signal?: AbortSignal) => Promise<string>;
  /** Chamado após uma compactação aplicada (ex.: atualizar histórico do agente). */
  onCompacted?: (messages: readonly ChatMessage[]) => void;
  /** Fila de compactação em background (CMP-9); ausente = sempre inline. */
  background?: BackgroundCompactor;
}

/** Vocabulário de tamanho/estouro; "context caching" não é overflow. */
const OVERFLOW_PATTERN = /context\s*(length|window)|maximum.{0,24}(token|context)|prompt is too (large|long)|(input|request|message)s?.{0,16}too (long|large)|too many tokens|token.{0,24}(limit|maximum)|exceeds?.{0,12}context/i;

/** O provider rejeitou por tamanho de contexto? */
export function isContextOverflow(error: unknown): boolean {
  if (!(error instanceof ProviderError) || error.errClass !== "invalid_request") return false;
  return OVERFLOW_PATTERN.test(error.message);
}

type CompactReason = "trigger" | "overflow";

/** Identidade do job de background: invalida resumo de outro modelo/janela. */
function identityOf(opts: CompactionRuntimeOptions): CompactionIdentity {
  return {
    provider: opts.provider(),
    model: opts.model(),
    window: opts.window(),
    buffer: opts.compaction.buffer,
  };
}

/** Overhead estimado do artefato no contexto compactado (tokens). */
const ARTIFACT_OVERHEAD = 2_000;

/** A compactação consegue projetar o contexto abaixo do gatilho? */
function projectionCanClear(messages: readonly ChatMessage[], opts: CompactionRuntimeOptions): boolean {
  const window = opts.window();
  const tokenOpts = { provider: opts.provider() };
  const systemTokens = messages[0]?.role === "system"
    ? countMessageTokens([messages[0]!], tokenOpts).tokens
    : 0;
  const start = recentSliceStart(
    messages,
    effectiveRecentBudget(window, opts.compaction.buffer, undefined, systemTokens),
  );
  const older = start - (messages[0]?.role === "system" ? 1 : 0);
  if (older <= 0) return false;
  // Já acima da janela: compactar é estritamente benéfico, mesmo que o corte
  // não volte abaixo do gatilho (o provider recusaria a request atual).
  if (countMessageTokens(messages, tokenOpts).tokens > window) return true;
  const recentTokens = countMessageTokens(messages.slice(start), tokenOpts).tokens;
  return systemTokens + recentTokens + ARTIFACT_OVERHEAD < window - reserveTokens(window, opts.compaction.buffer);
}

/** Compacta, grava sucesso/falha e abre o breaker quando necessário. */
async function applyCompaction(
  messages: ChatMessage[],
  opts: CompactionRuntimeOptions,
  reason: CompactReason,
): Promise<boolean> {
  // Sem histórico anterior ou sem projeção para sair do gatilho, repetir a cada
  // step só gastaria tokens de resumo sem reduzir o contexto.
  if (reason === "trigger" && !projectionCanClear(messages, opts)) return false;
  const state = compactionState(opts.ledger, opts.run);
  if (state.paused) throw new CompactionPausedError(state.remainingMs);

  const agent = opts.agent();
  try {
    const result = await compactSession({
      run: opts.run,
      messages,
      window: opts.window(),
      buffer: opts.compaction.buffer,
      provider: opts.provider(),
      summarize: opts.summarize,
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });
    if (result.olderCount === 0) {
      // Nada anterior para substituir (ex.: primeira tarefa já grande): não há
      // compactação possível e repetir a cada step só gastaria tokens.
      return false;
    }
    messages.length = 0;
    messages.push(...result.messages);
    recordCompactionSuccess(opts.ledger, opts.run, agent);
    opts.onCompacted?.(messages);
    opts.audit.append({
      run: opts.run,
      agent,
      tipo: "compaction.applied",
      payload: {
        reason,
        reduction: result.reduction,
        originalTokens: result.originalTokens,
        returnedTokens: result.returnedTokens,
      },
    });
    return true;
  } catch (error) {
    if (error instanceof CompactionPausedError) throw error;
    if (isAbortError(error, opts.signal)) throw error;
    const after = recordCompactionFailure(opts.ledger, opts.run, agent);
    opts.audit.append({
      run: opts.run,
      agent,
      tipo: "compaction.failed",
      payload: { reason, error: error instanceof Error ? error.name : "unknown" },
    });
    if (after.paused) throw new CompactionPausedError(after.remainingMs);
    if (reason === "overflow") throw error;
    return false;
  }
}

/**
 * Aplica um artefato pronto (já resumido): sem chamada ao provider e sem
 * reescrever o schema do ledger/auditoria.
 */
function applyReadyCompaction(
  messages: ChatMessage[],
  job: BackgroundCompaction,
  opts: CompactionRuntimeOptions,
  reason: CompactReason,
): void {
  const state = compactionState(opts.ledger, opts.run);
  if (state.paused) throw new CompactionPausedError(state.remainingMs);
  const agent = opts.agent();
  applyBackgroundCompaction(messages, job);
  recordCompactionSuccess(opts.ledger, opts.run, agent);
  opts.onCompacted?.(messages);
  opts.audit.append({
    run: opts.run,
    agent,
    tipo: "compaction.applied",
    payload: {
      reason,
      background: true,
      reduction: job.reduction,
      originalTokens: job.originalTokens,
      returnedTokens: job.returnedTokens,
    },
  });
}

/**
 * Pré-aquece a compactação depois de um step que ainda vai chamar o provider.
 * O snapshot é do prefixo atual; a cauda nova é preservada na aplicação.
 */
function scheduleCompaction(
  messages: readonly ChatMessage[],
  opts: CompactionRuntimeOptions,
  response: CompletionResponse,
): void {
  const background = opts.background;
  if (background === undefined || response.toolCalls.length === 0) return;
  const window = opts.window();
  const trigger = window - reserveTokens(window, opts.compaction.buffer);
  if (trigger < PREWARM_MARGIN * 2) return; // janela pequena: inline é previsível
  const tokens = countMessageTokens(messages, { provider: opts.provider() }).tokens;
  if (tokens >= trigger || tokens < trigger - PREWARM_MARGIN) return;
  if (compactionState(opts.ledger, opts.run).paused) return;
  // Sem histórico antigo ou sem projeção para sair do gatilho, resumir de novo
  // não reduziria o contexto: deixa o inline decidir.
  if (!projectionCanClear(messages, opts)) return;
  const identity = identityOf(opts);
  const summarize = opts.summarize;
  try {
    background.schedule(opts.agent(), messages, tokens, identity, (snapshot, signal) => compactSession({
      run: opts.run,
      messages: snapshot,
      window,
      buffer: opts.compaction.buffer,
      provider: identity.provider,
      summarize,
      signal,
    }), opts.signal);
  } catch { /* pré-aquecimento nunca quebra o turno */ }
}

/** Compacta antes da chamada quando o gatilho dispara e retenta uma vez por overflow. */
export async function completeWithCompaction(
  messages: ChatMessage[],
  opts: CompactionRuntimeOptions,
): Promise<CompletionResponse> {
  throwIfAborted(opts.signal);

  if (shouldCompact(messages, opts.window(), opts.compaction.buffer, { provider: opts.provider() })) {
    const ready = opts.background?.take(opts.agent(), messages, identityOf(opts));
    if (ready !== undefined) applyReadyCompaction(messages, ready, opts, "trigger");
    else await applyCompaction(messages, opts, "trigger");
    throwIfAborted(opts.signal);
  }

  try {
    const response = await opts.complete(messages);
    scheduleCompaction(messages, opts, response);
    return response;
  } catch (error) {
    if (!isContextOverflow(error)) throw error;
    const ready = opts.background?.take(opts.agent(), messages, identityOf(opts));
    let compacted = true;
    if (ready !== undefined) applyReadyCompaction(messages, ready, opts, "overflow");
    else compacted = await applyCompaction(messages, opts, "overflow");
    throwIfAborted(opts.signal);
    // Sem nada para compactar, repetir a mesma request só gastaria uma chamada.
    if (!compacted) throw error;
    // Segunda rejeição é terminal (CMP-7): o erro sobe para a sessão.
    return await opts.complete(messages);
  }
}
