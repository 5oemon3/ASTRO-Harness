/**
 * Budget (F-05, B1–B10): status derivado do ledger — sem segundo contador.
 * Escopos day/month/project integram quota/team pelo limite mais restritivo;
 * use-as-you-go só registra/exibe (B2) e preço ausente é "n/d", nunca zero (B6).
 */
import type { BudgetConfig } from "./config";
import type { Auditor } from "./audit";
import type { Ledger } from "./ledger";
import { redactSecrets } from "./sanitize-external";

export interface BudgetStatus {
  scope: BudgetConfig["scope"];
  limitUsd: number | null;
  /** Teto físico absoluto (B10, I-17); null/ausente quando não configurado. */
  hardCeilingUsd?: number | null;
  /** null quando alguma entrada de uso não tem preço (B6). */
  spentUsd: number | null;
  ratio: number | null;
  warnAt: number;
  warning: boolean;
  exhausted: boolean;
  ceilingHit: boolean;
  remainingUsd: number | null;
  /** Reservas ainda sem `released` (B9); já somadas em `spentUsd`. */
  reservedUsd: number;
  /** Estimativa pronta para exibição; "n/d" quando o preço é desconhecido. */
  estimate: string;
}

/** Formata custo sem transformar desconhecido em zero (B6). */
export function formatBudgetEstimate(spentUsd: number | null): string {
  return spentUsd === null ? "n/d" : `US$ ${spentUsd.toFixed(6)}`;
}

/** Aplica o limite mais restritivo entre budget e quota/team (ADR-0013). */
export function restrictBudget(budget: BudgetConfig, extraLimits: Array<number | null | undefined>): BudgetConfig {
  const candidates = extraLimits.filter((value): value is number => value !== null && value !== undefined);
  if (budget.limitUsd === null) {
    return candidates.length === 0 ? budget : { ...budget, limitUsd: Math.min(...candidates) };
  }
  return { ...budget, limitUsd: Math.min(budget.limitUsd, ...candidates) };
}

/** Entrada pertence à janela do escopo (UTC, determinístico). */
function inScope(ts: string, scope: BudgetConfig["scope"], now: Date): boolean {
  // `project` usa a mesma janela mensal do `team.projectBudgetUsd` (ADR-0013).
  if (scope === "use-as-you-go") return true;
  const at = new Date(ts);
  if (Number.isNaN(at.getTime())) return false;
  const sameMonth = at.getUTCFullYear() === now.getUTCFullYear() && at.getUTCMonth() === now.getUTCMonth();
  return scope === "day" ? sameMonth && at.getUTCDate() === now.getUTCDate() : sameMonth;
}

/** Reservas ainda sem `released` (B9), casadas por run em FIFO; filtro opcional pela janela do escopo. */
export function outstandingReservations(ledger: Ledger, inWindow: (ts: string) => boolean = () => true): number {
  const pending: Array<{ run: string; amount: number }> = [];
  for (const entry of ledger.readAllEntries()) {
    if (entry.kind !== "budget" || !inWindow(entry.ts)) continue;
    if (entry.event === "reserved" && typeof entry.reserved === "number") {
      pending.push({ run: entry.run, amount: entry.reserved });
    } else if (entry.event === "released") {
      const index = pending.findIndex((item) => item.run === entry.run);
      if (index >= 0) pending.splice(index, 1);
    }
  }
  return pending.reduce((total, item) => total + item.amount, 0);
}

/**
 * Budget efetivo do run após aumentos aprovados (D-30): aplica o último
 * `budget.raised` do próprio run. Sem evento, devolve o budget original; nunca muta.
 */
export function effectiveBudget(budget: BudgetConfig, ledger: Ledger, run: string): BudgetConfig {
  const target = redactSecrets(run);
  let limitUsd = budget.limitUsd;
  let hardCeilingUsd = budget.hardCeilingUsd;
  for (const entry of ledger.readAllEntries()) {
    if (entry.kind !== "budget" || entry.event !== "raised" || entry.run !== target) continue;
    if (typeof entry.new_limit_usd === "number") limitUsd = entry.new_limit_usd;
    if (typeof entry.new_ceiling_usd === "number") hardCeilingUsd = entry.new_ceiling_usd;
  }
  return { ...budget, limitUsd, ...(hardCeilingUsd === undefined ? {} : { hardCeilingUsd }) };
}

/** Calcula o status do budget a partir do ledger (fonte única de custo). */
export function budgetStatus(budget: BudgetConfig, ledger: Ledger, now: Date = new Date()): BudgetStatus {
  const entries = ledger.readAll().filter((entry) => inScope(entry.ts, budget.scope, now));
  const actualUsd = entries.some((entry) => entry.costUsd === null)
    ? null
    : entries.reduce((total, entry) => total + (entry.costUsd ?? 0), 0);
  // Reserva órfã conta como custo real (B9): crash entre reserve e release, na janela do escopo.
  const reservedUsd = outstandingReservations(ledger, (ts) => inScope(ts, budget.scope, now));
  const spentUsd = actualUsd === null ? null : actualUsd + reservedUsd;
  const limitUsd = budget.limitUsd;
  const ratio = spentUsd !== null && limitUsd !== null && limitUsd > 0 ? spentUsd / limitUsd : null;
  const exhausted = limitUsd !== null && spentUsd !== null && spentUsd >= limitUsd;
  const ceilingHit = budget.hardCeilingUsd !== undefined && spentUsd !== null && spentUsd >= budget.hardCeilingUsd;
  return {
    scope: budget.scope,
    limitUsd,
    hardCeilingUsd: budget.hardCeilingUsd ?? null,
    spentUsd,
    ratio,
    warnAt: budget.warnAt,
    warning: (ratio !== null && ratio >= budget.warnAt) || exhausted,
    exhausted,
    ceilingHit,
    remainingUsd: limitUsd !== null && spentUsd !== null ? Math.max(0, limitUsd - spentUsd) : null,
    reservedUsd,
    estimate: formatBudgetEstimate(spentUsd),
  };
}

/** Escolha no esgotamento (B4). */
export type BudgetChoice = "continue_same" | "lower_effort" | "stop" | BudgetRaise;

/** Aumento aprovado no esgotamento (D-30, I-17): valores absolutos, nunca incremento. */
export interface BudgetRaise {
  choice: "raise";
  limitUsd: number;
  /** Novo teto; só é aceito com `confirmedCeiling: true` (segunda confirmação). */
  hardCeilingUsd?: number;
  /** Segunda confirmação explícita do teto (D-30); o CLI só marca após `CONFIRMAR`. */
  confirmedCeiling?: boolean;
}

/** Motivo de recusa de um aumento (D-30); o run continua esgotado. */
export type BudgetRaiseDenied =
  | "invalid_number"
  | "not_above_spend"
  | "not_above_limit"
  | "ceiling_required"
  | "ceiling_not_raised"
  | "ceiling_not_confirmed";

/**
 * Valida um pedido de aumento (D-30): valor absoluto acima do gasto e do limite
 * antigo; acima do teto exige o novo teto, que só pode subir. Nunca adivinha.
 */
export function validateBudgetRaise(
  status: BudgetStatus,
  committedUsd: number | null,
  raise: BudgetRaise,
): { ok: true; limitUsd: number; hardCeilingUsd?: number } | { ok: false; reason: BudgetRaiseDenied } {
  const limit = raise.limitUsd;
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return { ok: false, reason: "invalid_number" };
  if (committedUsd === null) return { ok: false, reason: "invalid_number" };
  if (limit <= committedUsd) return { ok: false, reason: "not_above_spend" };
  if (status.limitUsd !== null && limit <= status.limitUsd) return { ok: false, reason: "not_above_limit" };
  const oldCeiling = status.hardCeilingUsd ?? null;
  const newCeiling = raise.hardCeilingUsd;
  if (newCeiling !== undefined) {
    if (typeof newCeiling !== "number" || !Number.isFinite(newCeiling) || newCeiling <= 0) {
      return { ok: false, reason: "invalid_number" };
    }
    if (raise.confirmedCeiling !== true) return { ok: false, reason: "ceiling_not_confirmed" };
    if (oldCeiling !== null && newCeiling <= oldCeiling) return { ok: false, reason: "ceiling_not_raised" };
    if (newCeiling <= committedUsd) return { ok: false, reason: "ceiling_not_raised" };
    if (limit > newCeiling) return { ok: false, reason: "ceiling_required" };
    return { ok: true, limitUsd: limit, hardCeilingUsd: newCeiling };
  }
  if (oldCeiling !== null && limit > oldCeiling) return { ok: false, reason: "ceiling_required" };
  return { ok: true, limitUsd: limit };
}
export type BudgetDecider = (status: BudgetStatus, context?: BudgetDecisionContext) => Promise<BudgetChoice> | BudgetChoice;

/** Números efetivos do corte, incluindo a reserva da próxima chamada (B9). */
export interface BudgetDecisionContext {
  /** `spentUsd + reserveUsd`; null quando o preço é desconhecido. */
  committedUsd: number | null;
  reserveUsd: number;
}

const RAISE_DENIED_LABEL: Record<BudgetRaiseDenied, string> = {
  invalid_number: "valor inválido",
  not_above_spend: "valor não supera o gasto + reserva",
  not_above_limit: "valor não supera o limite atual",
  ceiling_required: "valor excede o teto físico sem elevar o teto",
  ceiling_not_raised: "novo teto não é maior que o atual",
  ceiling_not_confirmed: "teto físico não confirmado",
};

/** Texto em português para o motivo de recusa (D-30), estável para a UI/testes. */
export function raiseDeniedLabel(reason: BudgetRaiseDenied): string {
  return RAISE_DENIED_LABEL[reason] ?? reason;
}

/** Parada por budget (I-17/I-19): esgotado, teto físico ou modo não interativo. */
export class BudgetExceededError extends Error {
  readonly reason: "limit" | "ceiling" | "non_interactive" | "unknown_price";
  readonly status: BudgetStatus;
  /** Motivo da recusa quando o esgotamento veio de um pedido de aumento (D-30). */
  readonly raiseReason?: BudgetRaiseDenied;
  constructor(reason: BudgetExceededError["reason"], status: BudgetStatus, raiseReason?: BudgetRaiseDenied) {
    const suffix = raiseReason === undefined ? "" : `; aumento recusado: ${raiseDeniedLabel(raiseReason)}`;
    super(`budget esgotado (${reason}): ${status.estimate}${status.limitUsd === null ? "" : ` / US$ ${status.limitUsd}`}${suffix}`);
    this.name = "BudgetExceededError";
    this.reason = reason;
    this.status = status;
    this.raiseReason = raiseReason;
  }
}

export interface EnforceBudgetOptions {
  budget: BudgetConfig;
  ledger: Ledger;
  run: string;
  agent: string;
  audit: Auditor;
  /** Só com decisor (TTY) o `ask` pergunta; caso contrário grava checkpoint e para (L5). */
  decide?: BudgetDecider;
  /** Custo máximo reservado para a chamada (B9); conta para o limite/teto. */
  reserveUsd?: number;
}

/**
 * Corte de budget antes da chamada (B4/B10, I-17): teto físico sempre para;
 * esgotado pergunta só com decisor, senão registra não-interativo e para.
 */
export async function enforceBudget(opts: EnforceBudgetOptions): Promise<BudgetChoice> {
  const status = budgetStatus(opts.budget, opts.ledger);
  const reserveUsd = opts.reserveUsd ?? 0;
  const committedUsd = status.spentUsd === null ? null : status.spentUsd + reserveUsd;
  const ceilingHit = opts.budget.hardCeilingUsd !== undefined && committedUsd !== null && committedUsd >= opts.budget.hardCeilingUsd;
  const exhausted = status.limitUsd !== null && committedUsd !== null && committedUsd >= status.limitUsd;
  const payload = {
    scope: status.scope,
    spentUsd: status.spentUsd,
    limitUsd: status.limitUsd,
    ...(reserveUsd === 0 ? {} : { reserved: reserveUsd }),
    ...(opts.budget.hardCeilingUsd === undefined ? {} : { hardCeilingUsd: opts.budget.hardCeilingUsd }),
  };
  if (ceilingHit) {
    opts.audit.append({ run: opts.run, agent: opts.agent, tipo: "budget.ceiling_hit", payload });
    opts.ledger.recordCeilingHit({ run: opts.run, agent: opts.agent, ceiling_hit: true });
    throw new BudgetExceededError("ceiling", status);
  }
  // Teto físico com preço desconhecido: não dá para provar que está abaixo (B6)
  if (opts.budget.hardCeilingUsd !== undefined && committedUsd === null) {
    opts.audit.append({ run: opts.run, agent: opts.agent, tipo: "budget.exceeded",
      payload: { ...payload, reason: "unknown_price" } });
    opts.ledger.recordBudgetExceeded({ run: opts.run, agent: opts.agent, exceeded_choice: "stop" });
    throw new BudgetExceededError("unknown_price", status);
  }
  if (!exhausted) return "continue_same";

  if (opts.budget.onExceed === "stop" || opts.decide === undefined) {
    const nonInteractive = opts.budget.onExceed !== "stop";
    opts.audit.append({ run: opts.run, agent: opts.agent, tipo: "budget.exceeded",
      payload: { ...payload, ...(nonInteractive ? { reason: "non_interactive" } : { choice: "stop" }) } });
    if (nonInteractive) {
      opts.ledger.recordBudgetExceededNonInteractive({ run: opts.run, agent: opts.agent, budget_exceeded_non_interactive: true });
      throw new BudgetExceededError("non_interactive", status);
    }
    opts.ledger.recordBudgetExceeded({ run: opts.run, agent: opts.agent, exceeded_choice: "stop" });
    throw new BudgetExceededError("limit", status);
  }

  const choice = await opts.decide(status, { committedUsd, reserveUsd });
  if (typeof choice === "object" && choice !== null) {
    const result = validateBudgetRaise(status, committedUsd, choice);
    if (!result.ok) {
      opts.audit.append({ run: opts.run, agent: opts.agent, tipo: "budget.raise_denied", payload: {
        reason: result.reason,
        requestedLimitUsd: choice.limitUsd,
        ...(choice.hardCeilingUsd === undefined ? {} : { requestedHardCeilingUsd: choice.hardCeilingUsd }),
        spentUsd: status.spentUsd,
        limitUsd: status.limitUsd,
        ...(opts.budget.hardCeilingUsd === undefined ? {} : { hardCeilingUsd: opts.budget.hardCeilingUsd }),
      } });
      throw new BudgetExceededError("limit", status, result.reason);
    }
    const oldLimit = opts.budget.limitUsd ?? 0;
    const oldCeiling = opts.budget.hardCeilingUsd;
    opts.budget.limitUsd = result.limitUsd;
    if (result.hardCeilingUsd !== undefined) opts.budget.hardCeilingUsd = result.hardCeilingUsd;
    opts.audit.append({ run: opts.run, agent: opts.agent, tipo: "budget.raised", payload: {
      run: opts.run,
      agent: opts.agent,
      sessionId: opts.run,
      oldLimitUsd: oldLimit,
      newLimitUsd: result.limitUsd,
      ...(oldCeiling === undefined ? {} : { oldHardCeilingUsd: oldCeiling }),
      ...(result.hardCeilingUsd === undefined ? {} : { newHardCeilingUsd: result.hardCeilingUsd, confirmedCeiling: true }),
    } });
    opts.ledger.recordBudgetRaised({
      run: opts.run,
      agent: opts.agent,
      session_id: opts.run,
      old_limit_usd: oldLimit,
      new_limit_usd: result.limitUsd,
      ...(oldCeiling === undefined ? {} : { old_ceiling_usd: oldCeiling }),
      ...(result.hardCeilingUsd === undefined ? {} : { new_ceiling_usd: result.hardCeilingUsd, confirmed_ceiling: true }),
    });
    return choice;
  }
  opts.audit.append({ run: opts.run, agent: opts.agent, tipo: "budget.exceeded", payload: { ...payload, choice } });
  opts.ledger.recordBudgetExceeded({ run: opts.run, agent: opts.agent, exceeded_choice: choice });
  if (choice === "stop") throw new BudgetExceededError("limit", status);
  return choice;
}

/** Payload auditável do aviso (B3), sem preço ausente virar zero. */
export function budgetWarningPayload(status: BudgetStatus): Record<string, unknown> {
  return {
    scope: status.scope,
    spentUsd: status.spentUsd,
    limitUsd: status.limitUsd,
    warnAt: status.warnAt,
  };
}
