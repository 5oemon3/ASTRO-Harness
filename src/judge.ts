/**
 * Juiz do objetivo (L4, ADR-0014, #450): avalia a conclusão depois de uma
 * completion e devolve veredito tipado. Uma chamada única, sem retry; qualquer
 * falha do juiz devolve o caminho normal de sucesso (fail-safe).
 */
import { createHash } from "node:crypto";
import { isAbortError } from "./abort";
import type { ChatMessage, CompletionResponse, Provider } from "./providers/types";
import { redactSecrets } from "./sanitize-external";

/** Modos de `run.judge`; `off` é o default (L4). */
export const JUDGE_MODES = ["off", "on", "auto"] as const;
export type JudgeMode = (typeof JUDGE_MODES)[number];

export function isJudgeMode(value: unknown): value is JudgeMode {
  return typeof value === "string" && (JUDGE_MODES as readonly string[]).includes(value);
}

export type JudgeVerdictKind = "done" | "continue" | "stop";

/** Veredito tipado: o motivo fica só em memória/prompt, nunca em audit/ledger. */
export interface JudgeVerdict {
  verdict: JudgeVerdictKind;
  reason: string;
}

/** Falha do juiz (vocabulário fechado): nunca vira retry nem loop. */
export type JudgeFailure = "malformed" | "provider_error";

/** Tetos do prompt: só o objetivo e a última saída entram, sempre limitados. */
export const MAX_JUDGE_GOAL_CHARS = 2000;
export const MAX_JUDGE_OUTPUT_CHARS = 4000;
const MAX_JUDGE_REASON_CHARS = 300;

export const JUDGE_SYSTEM_PROMPT = [
  "Você é o juiz de conclusão de um harness de código.",
  'Responda SOMENTE com um objeto JSON: {"verdict":"done|continue|stop","reason":"..."}',
  "- done: o objetivo foi cumprido;",
  "- continue: falta trabalho que o agente pode fazer agora;",
  "- stop: o objetivo não pode ser cumprido nem deve continuar.",
  "reason: uma frase curta, sem segredos e sem repetir o texto do agente.",
].join("\n");

/** Redige (I-03), remove controles e limita o tamanho do texto que entra no prompt. */
function bounded(text: string, max: number): string {
  const clean = redactSecrets(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

/** Escapa `<`/`>` de todo texto não confiável: nenhuma tag fecha o quadro do prompt. */
function framed(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Prompt do juiz: objetivo + última saída apenas, nunca o histórico completo. */
export function buildJudgeMessages(goal: string, output: string): ChatMessage[] {
  const goalBlock = framed(bounded(goal, MAX_JUDGE_GOAL_CHARS));
  const outputBlock = framed(bounded(output, MAX_JUDGE_OUTPUT_CHARS));
  return [
    { role: "system", content: JUDGE_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Avalie se o objetivo foi cumprido.\n\n<goal>\n${goalBlock}\n</goal>\n\n<output>\n${outputBlock}\n</output>`,
    },
  ];
}

/** Remove uma cerca de código externa; o schema abaixo continua estrito. */
function unwrapFence(raw: string): string {
  const match = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(raw.trim());
  return match?.[1]?.trim() ?? raw.trim();
}

/** Schema estrito: objeto JSON com exatamente `verdict` e `reason` não vazio. */
export function parseJudgeVerdict(raw: string): JudgeVerdict | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapFence(raw));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "reason" || keys[1] !== "verdict") return undefined;
  const { verdict, reason } = record;
  if (verdict !== "done" && verdict !== "continue" && verdict !== "stop") return undefined;
  if (typeof reason !== "string" || reason.trim().length === 0) return undefined;
  return { verdict, reason: reason.trim().slice(0, MAX_JUDGE_REASON_CHARS) };
}

/** Motivo sanitizado (I-03) e limitado: o mesmo texto que o loop recebe e que o hash cobre. */
function safeReason(reason: string): string {
  return bounded(reason, MAX_JUDGE_REASON_CHARS).replace(/\s+/g, " ").trim();
}

/** Hash estável do motivo já sanitizado para o audit (I-03/I-04): o texto nunca é persistido. */
export function reasonHash(reason: string): string {
  return createHash("sha256").update(safeReason(reason)).digest("hex").slice(0, 16);
}

/** Retomada injetada depois de `continue`: motivo redigido e limitado. */
export function continuePrompt(reason: string): string {
  return [
    "O juiz do harness considerou o objetivo ainda não cumprido.",
    `Motivo: ${safeReason(reason)}`,
    "Continue a tarefa pelos próximos passos, sem repetir o que já está pronto.",
  ].join("\n");
}

export interface EvaluateGoalOptions {
  provider: Provider;
  /** Só o id do modelo entra na chamada (o juiz usa o caminho normal do provider). */
  model: { id: string };
  goal: string;
  /** Última saída do assistente; o histórico completo nunca é enviado. */
  output: string;
  profile?: string;
  signal?: AbortSignal;
}

export type JudgeResult =
  | { ok: true; verdict: JudgeVerdict; response: CompletionResponse }
  | { ok: false; failure: JudgeFailure; response?: CompletionResponse };

/**
 * Executa o juiz: uma única chamada no caminho existente do provider
 * (`purpose: "cheap"`, sem tools). Não lança por falha do juiz; abort do run
 * continua sendo cancelamento (F-06).
 */
export async function evaluateGoal(opts: EvaluateGoalOptions): Promise<JudgeResult> {
  let response: CompletionResponse;
  try {
    response = await opts.provider.complete({
      model: opts.model.id,
      messages: buildJudgeMessages(opts.goal, opts.output),
      tools: undefined,
      purpose: "cheap",
      ...(opts.profile === undefined ? {} : { profile: opts.profile }),
    }, opts.signal);
  } catch (error) {
    if (isAbortError(error, opts.signal)) throw error;
    return { ok: false, failure: "provider_error" };
  }
  const verdict = parseJudgeVerdict(response.content);
  return verdict === undefined
    ? { ok: false, failure: "malformed", response }
    : { ok: true, verdict, response };
}

/** Parada decidida pelo juiz: ponto seguro, nunca sucesso (I-19). */
export class JudgeStopError extends Error {
  readonly code = "judge_stop";
  constructor() {
    super("o juiz encerrou o run em ponto seguro; o objetivo não deve continuar");
    this.name = "JudgeStopError";
  }
}

/** Juiz pediu continuar sem turno disponível: parada segura com razão estável (I-19). */
export class JudgeContinueError extends Error {
  readonly code = "judge_continue_exhausted";
  constructor() {
    super("o juiz pediu continuar, mas o limite de turnos acabou; run parado em ponto seguro");
    this.name = "JudgeContinueError";
  }
}
