/**
 * Rate-limit e quota enforcement (F6-3): limites por quotaDomain checados
 * contra o ledger ANTES de cada chamada ao provider. Estouro lança
 * QuotaExceededError (errClass "hard_quota", taxonomia D-18) — bloqueando
 * o gasto antes que aconteça. O retry de 429/Retry-After vive no provider.
 */
import type { Ledger } from "./ledger";
import { ProviderError } from "./provider/types";

/** Limite de quota por domínio; pelo menos um campo deve existir. */
export interface QuotaLimit {
  dailyTokens?: number;
  monthlyCostUsd?: number;
}

/** Fração de uso a partir da qual o domínio entra em aviso (toast da TUI). */
export const QUOTA_WARN_RATIO = 0.8;

/** Uso de uma dimensão da quota (tokens do dia ou custo do mês). */
export interface QuotaDimensionStatus {
  used: number;
  limit: number;
  ratio: number;
}

/** Status derivado do ledger para um quotaDomain (F6-3); sem limite não há status. */
export interface QuotaStatus {
  quotaDomain: string;
  warnAt: number;
  dailyTokens?: QuotaDimensionStatus;
  monthlyCostUsd?: QuotaDimensionStatus;
  /** Qualquer dimensão a partir do warnAt (esgotado também avisa). */
  warning: boolean;
  exhausted: boolean;
}

/** Erro de quota excedida; classificado como hard_quota (não retriable). */
export class QuotaExceededError extends ProviderError {
  constructor(message: string) {
    super("hard_quota", message);
    this.name = "QuotaExceededError";
  }
}

interface Usage {
  todayTokens: number;
  monthCostUsd: number;
}

/** Soma uso do domínio: tokens de hoje e custo do mês corrente. */
function usageFor(ledger: Ledger, quotaDomain: string, now: Date): Usage {
  const today = now.toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const usage: Usage = { todayTokens: 0, monthCostUsd: 0 };

  for (const entry of ledger.readAll()) {
    if (entry.quotaDomain !== quotaDomain) continue;
    if (entry.ts.slice(0, 10) === today) {
      usage.todayTokens += entry.tokensIn + entry.tokensOut;
    }
    if (entry.ts.slice(0, 7) === month) {
      usage.monthCostUsd += entry.costUsd ?? 0;
    }
  }
  return usage;
}

/** Uso de uma dimensão; limite zero conta como esgotado (razão 1). */
function dimension(used: number, limit: number): QuotaDimensionStatus {
  return { used, limit, ratio: limit > 0 ? used / limit : 1 };
}

/**
 * Deriva o status do domínio para o toast da TUI (#64). `undefined` quando
 * o domínio não declara limite; aviso/esgotado seguem o uso atual do ledger.
 */
export function quotaStatus(
  ledger: Ledger,
  limits: Record<string, QuotaLimit>,
  quotaDomain: string,
  now: Date = new Date(),
): QuotaStatus | undefined {
  const limit = limits[quotaDomain];
  if (limit === undefined) return undefined;
  const usage = usageFor(ledger, quotaDomain, now);
  const dailyTokens = limit.dailyTokens === undefined ? undefined : dimension(usage.todayTokens, limit.dailyTokens);
  const monthlyCostUsd = limit.monthlyCostUsd === undefined ? undefined : dimension(usage.monthCostUsd, limit.monthlyCostUsd);
  const ratios = [dailyTokens?.ratio, monthlyCostUsd?.ratio]
    .filter((ratio): ratio is number => ratio !== undefined);
  const exhausted = ratios.some((ratio) => ratio >= 1);
  return {
    quotaDomain,
    warnAt: QUOTA_WARN_RATIO,
    ...(dailyTokens === undefined ? {} : { dailyTokens }),
    ...(monthlyCostUsd === undefined ? {} : { monthlyCostUsd }),
    warning: exhausted || ratios.some((ratio) => ratio >= QUOTA_WARN_RATIO),
    exhausted,
  };
}

/**
 * Verifica se o domínio ainda tem quota, sem lançar; usado pelo filtro de
 * candidatos (S-09). Domínio sem limite declarado está disponível.
 */
export function quotaAvailable(
  ledger: Ledger,
  limits: Record<string, QuotaLimit>,
  quotaDomain: string,
  now: Date = new Date(),
): boolean {
  return quotaStatus(ledger, limits, quotaDomain, now)?.exhausted !== true;
}

/**
 * Verifica se o domínio ainda tem quota; lança QuotaExceededError quando o
 * uso atual já atingiu o limite (chamadas novas são bloqueadas antes de gastar).
 * Domínio sem limite declarado passa direto.
 */
export function assertWithinQuota(
  ledger: Ledger,
  limits: Record<string, QuotaLimit>,
  quotaDomain: string,
  now: Date = new Date(),
): void {
  const limit = limits[quotaDomain];
  if (limit === undefined) return;

  const usage = usageFor(ledger, quotaDomain, now);
  const reasons: string[] = [];

  if (limit.dailyTokens !== undefined && usage.todayTokens >= limit.dailyTokens) {
    reasons.push(
      `tokens de hoje (${usage.todayTokens}) atingiram o limite diário (${limit.dailyTokens})`,
    );
  }
  if (limit.monthlyCostUsd !== undefined && usage.monthCostUsd >= limit.monthlyCostUsd) {
    reasons.push(
      `custo do mês (US$ ${usage.monthCostUsd.toFixed(4)}) atingiu o limite mensal (US$ ${limit.monthlyCostUsd})`,
    );
  }

  if (reasons.length > 0) {
    throw new QuotaExceededError(
      `quota excedida no domínio "${quotaDomain}": ${reasons.join("; ")}`,
    );
  }
}