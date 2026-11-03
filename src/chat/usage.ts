/**
 * `/usage` (#63 residual T2): linhas de uso da sessão e do budget.
 * Puro, sem I/O; preço desconhecido é "n/d", nunca zero (B6).
 */
import { formatBudgetEstimate, type BudgetStatus } from "../budget";
import type { QuotaStatus } from "../quota";
import type { SessionSnapshot } from "./agent-session";

function money(value: number | null): string {
  return value === null ? "n/d" : `US$ ${value.toFixed(6)}`;
}

function pct(ratio: number | null): string {
  return ratio === null ? "n/d" : `${Math.round(ratio * 100)}%`;
}

/** Linha da sessão: turnos, tokens in/out e custo acumulado. */
export function sessionUsageLine(snapshot: SessionSnapshot): string {
  return `uso da sessão: ${snapshot.turns} turno(s) · in ${snapshot.tokensIn} / out ${snapshot.tokensOut} tokens · custo ${money(snapshot.costUsd)}`;
}

/** Linha do budget a partir do status derivado do ledger (flags no fim). */
export function budgetLine(status: BudgetStatus): string {
  const gasto = formatBudgetEstimate(status.spentUsd);
  const flags = [
    status.warning ? "⚠ aviso" : undefined,
    status.exhausted ? "ESGOTADO" : undefined,
    status.ceilingHit ? "TETO ATINGIDO" : undefined,
  ].filter((flag) => flag !== undefined);
  const base = status.limitUsd === null
    ? `budget ${status.scope}: gasto ${gasto} (sem limite)`
    : `budget ${status.scope}: gasto ${gasto} / limite ${money(status.limitUsd)} (${pct(status.ratio)}) · restante ${money(status.remainingUsd)} · aviso em ${pct(status.warnAt)}`;
  return flags.length === 0 ? base : `${base} · ${flags.join(" · ")}`;
}

/** Segmento curto do budget para a status bar da TUI. */
export function budgetSegment(status: BudgetStatus): string {
  const gasto = formatBudgetEstimate(status.spentUsd);
  return status.limitUsd === null
    ? `budget: gasto ${gasto}`
    : `budget: ${pct(status.ratio)} · ${gasto}/${money(status.limitUsd)}`;
}

/** Segmento curto da quota do domínio para o toast da TUI (#64). */
export function quotaSegment(status: QuotaStatus): string {
  const parts: string[] = [];
  if (status.dailyTokens !== undefined) {
    parts.push(`${pct(status.dailyTokens.ratio)} dos tokens do dia (${status.dailyTokens.used}/${status.dailyTokens.limit})`);
  }
  if (status.monthlyCostUsd !== undefined) {
    const used = status.monthlyCostUsd.used.toFixed(2);
    const limit = status.monthlyCostUsd.limit.toFixed(2);
    parts.push(`${pct(status.monthlyCostUsd.ratio)} do custo do mês (US$ ${used}/US$ ${limit})`);
  }
  return `quota ${status.quotaDomain}: ${parts.join(" · ")}`;
}

/** Linhas do `/usage`: sessão sempre; budget só quando a sessão expõe status. */
export function usageLines(snapshot: SessionSnapshot, budget: BudgetStatus | undefined): string[] {
  return [sessionUsageLine(snapshot), ...(budget === undefined ? [] : [budgetLine(budget)])];
}
