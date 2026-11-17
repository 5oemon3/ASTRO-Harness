/**
 * Benchmark de providers (F5-4): mede success rate, latência, tokens/sec e
 * custo/1k tokens por modelo, com a mesma suite de prompts. TTFT requer
 * streaming, que o contrato Provider ainda não expõe — o campo vai como null
 * (follow-up). Custo só é calculado para modelos com `price.verificado: true`.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelEntry } from "../registry";
import type { CompletionRequest, CompletionResponse, Provider } from "../provider/types";

/** Suite padrão de prompts: mesma para todos os modelos. */
const PROMPTS: readonly string[] = [
  "Explique em uma frase o que é uma função pura.",
  "Escreva uma função TypeScript que devolve o maior de dois números.",
  "Liste três vantagens de testes automatizados.",
  "Reescreva: 'o código dele era muito longo' em tom técnico.",
  "Dê um exemplo de erro off-by-one e como evitá-lo.",
];

export interface BenchLatency {
  min: number;
  p50: number;
  p95: number;
  max: number;
}

export interface BenchModelResult {
  model: string;
  provider: string;
  tags: string[];
  runs: number;
  /** Chamadas concluídas sem erro / chamadas tentadas (0..1). */
  successRate: number;
  /** Chamadas que devolveram resposta. */
  completed: number;
  /** Chamadas tentadas: `runs` × prompts da suíte. */
  total: number;
  latencyMs: BenchLatency;
  tokensInAvg: number;
  tokensOutAvg: number;
  tokensPerSec: number;
  /** Custo estimado por 1k tokens de saída; null sem preço verificado. */
  costPer1kOutUsd: number | null;
  /** TTFT exige streaming no contrato Provider; null até existir. */
  ttftMs: number | null;
}

export interface BenchSummary {
  /** Modelo com menor p50; null sem resultados. */
  fastest: string | null;
  /** Modelo com menor custo/1k out entre os precificados; null sem preço. */
  cheapest: string | null;
  /** Modelo com maior successRate; empate mantém o primeiro resultado. */
  highestSuccessRate: string | null;
}

/** Campos que o renderer/sumário precisam; v2 acrescenta as métricas de sucesso. */
export type BenchModelResultLike = Omit<BenchModelResult, "successRate" | "completed" | "total"> & {
  successRate?: number;
  completed?: number;
  total?: number;
};

export interface BenchReport {
  schema: number;
  date: string;
  prompts: number;
  summary: BenchSummary;
  results: BenchModelResult[];
}

/** Relatório v1 ou v2 aceito pelo Markdown; `summary` só existe a partir do v2. */
export type BenchReportLike = Omit<BenchReport, "summary" | "results"> & {
  summary?: BenchSummary;
  results: readonly BenchModelResultLike[];
};

export interface BenchOptions {
  models: ModelEntry[];
  /** Fábrica de provider por modelo (real via config; mock nos testes). */
  providerFor: (model: ModelEntry) => Provider;
  runs?: number;
  outDir?: string;
}

/** Termos do filtro, sem espaços nas pontas nem entradas vazias. */
function filterTerms(filter: string | undefined): string[] {
  return (filter ?? "")
    .split(",")
    .map((term) => term.trim())
    .filter((term) => term !== "");
}

/**
 * Filtra modelos com a mesma sintaxe do `astro bench --models`: termos
 * separados por vírgula. Termo sem `/` casa o provider exato; termo com `/`
 * é substring de `provider/model`. Filtro vazio ou ausente devolve todos;
 * sem correspondência devolve lista vazia.
 */
export function filterModels(
  models: readonly ModelEntry[],
  filter: string | undefined,
): ModelEntry[] {
  const terms = filterTerms(filter);
  if (terms.length === 0) return [...models];
  return models.filter((m) =>
    terms.some((term) =>
      term.includes("/") ? `${m.provider}/${m.id}`.includes(term) : m.provider === term,
    ),
  );
}

export type BenchModelSelection =
  | { ok: true; models: ModelEntry[] }
  | { ok: false; error: string };

export interface BenchSelectionOptions {
  /** Falha quando o filtro não recorta o registro (usado no nightly). */
  requireFilter?: boolean;
}

/**
 * Seleção de modelos do CLI: aplica o filtro compartilhado e recusa seleção
 * vazia com a mensagem que o `astro bench` imprime. Mantém a regra fora do
 * CLI para ser testada sem processo filho.
 *
 * Com `requireFilter`, exige um termo alfanumérico e uma seleção que não
 * cubra todos os modelos ativos: sem recorte, o nightly gastaria quota real
 * em todo o registro.
 */
export function selectBenchModels(
  models: readonly ModelEntry[],
  filter: string | undefined,
  opts: BenchSelectionOptions = {},
): BenchModelSelection {
  const terms = filterTerms(filter);
  const selected = filterModels(models, filter);
  if (selected.length === 0) {
    return {
      ok: false,
      error: terms.length > 0
        ? "nenhum modelo ativo corresponde ao filtro"
        : "nenhum modelo ativo na configuração",
    };
  }
  if (opts.requireFilter === true) {
    if (terms.length === 0) {
      return { ok: false, error: "--require-filter exige um filtro de modelos (filtro ausente)" };
    }
    if (!terms.some((term) => /[\p{L}\p{N}]/u.test(term))) {
      return { ok: false, error: "--require-filter recusa filtro de modelos sem termo alfanumérico" };
    }
    if (selected.length === models.length) {
      return {
        ok: false,
        error: "--require-filter recusa um filtro que seleciona todos os modelos ativos",
      };
    }
  }
  return { ok: true, models: selected };
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(Math.ceil((p / 100) * sorted.length) - 1, sorted.length - 1);
  return sorted[index]!;
}

/** Valida `runs` para chamadas de biblioteca; o CLI já valida o flag. */
function assertRuns(runs: number): void {
  if (!Number.isInteger(runs) || runs < 1) {
    throw new RangeError(`runs deve ser inteiro >= 1 (recebido: ${runs})`);
  }
}

/** Executa a suite para um modelo e devolve as métricas agregadas. */
export async function benchModel(
  model: ModelEntry,
  providerFor: BenchOptions["providerFor"],
  runs: number,
): Promise<BenchModelResult> {
  assertRuns(runs);
  const provider = providerFor(model);
  const latencies: number[] = [];
  let tokensInTotal = 0;
  let tokensOutTotal = 0;
  let firstError: unknown;

  for (let run = 0; run < runs; run++) {
    for (const prompt of PROMPTS) {
      const req: CompletionRequest = {
        model: model.id,
        messages: [{ role: "user", content: prompt }],
      };
      const started = Date.now();
      try {
        const response: CompletionResponse = await provider.complete(req);
        latencies.push(Date.now() - started);
        tokensInTotal += response.usage.inputTokens;
        tokensOutTotal += response.usage.outputTokens;
      } catch (error) {
        // Prompt que falha conta na success rate e não interrompe a suíte. O
        // texto do erro não entra no relatório: pode carregar conteúdo do
        // provider para JSON/Markdown (I-03).
        if (firstError === undefined) firstError = error;
      }
    }
  }

  const total = runs * PROMPTS.length;
  const completed = latencies.length;
  // Provider inteiro fora do ar: não há métrica para reportar, falha alto.
  if (completed === 0 && total > 0) throw firstError;

  const sorted = [...latencies].sort((a, b) => a - b);
  const tokensInAvg = completed === 0 ? 0 : tokensInTotal / completed;
  const tokensOutAvg = completed === 0 ? 0 : tokensOutTotal / completed;
  const latencyAvg = completed === 0 ? 0 : latencies.reduce((a, b) => a + b, 0) / completed;
  const tokensPerSec = latencyAvg === 0 ? 0 : tokensOutAvg / (latencyAvg / 1000);
  const successRate = total === 0 ? 0 : completed / total;

  const costPer1kOutUsd =
    model.price !== undefined && model.price.verificado ? model.price.outputPerM : null;

  return {
    model: `${model.provider}/${model.id}`,
    provider: model.provider,
    tags: [...model.tags],
    runs,
    successRate,
    completed,
    total,
    latencyMs: {
      min: sorted[0] ?? 0,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      max: sorted[sorted.length - 1] ?? 0,
    },
    tokensInAvg: Math.round(tokensInAvg),
    tokensOutAvg: Math.round(tokensOutAvg),
    tokensPerSec: Math.round(tokensPerSec * 10) / 10,
    costPer1kOutUsd,
    ttftMs: null,
  };
}

/**
 * Sumário do relatório: menor p50, menor custo/1k out (só precificados) e
 * maior successRate. Empate mantém o primeiro resultado; lista vazia → null.
 */
export function summarizeBench(results: readonly BenchModelResultLike[]): BenchSummary {
  if (results.length === 0) {
    return { fastest: null, cheapest: null, highestSuccessRate: null };
  }
  let fastest = results[0]!;
  let cheapest: BenchModelResultLike | undefined;
  let best: BenchModelResultLike | undefined;
  for (const r of results) {
    if (r.latencyMs.p50 < fastest.latencyMs.p50) fastest = r;
    const cost = r.costPer1kOutUsd;
    const cheapestCost = cheapest?.costPer1kOutUsd ?? Infinity;
    if (typeof cost === "number" && cost < cheapestCost) cheapest = r;
    if (typeof r.successRate === "number" && Number.isFinite(r.successRate)) {
      if (r.successRate > (best?.successRate ?? -Infinity)) best = r;
    }
  }
  return {
    fastest: fastest.model,
    cheapest: cheapest?.model ?? null,
    highestSuccessRate: best?.model ?? null,
  };
}

/** Roda o benchmark para todos os modelos informados. */
export async function runBenchmark(opts: BenchOptions): Promise<BenchReport> {
  const runs = opts.runs ?? 1;
  assertRuns(runs);
  const results: BenchModelResult[] = [];
  for (const model of opts.models) {
    results.push(await benchModel(model, opts.providerFor, runs));
  }
  const report: BenchReport = {
    // v2 acrescenta successRate/completed/total e summary (v1 não tinha).
    schema: 2,
    date: new Date().toISOString().slice(0, 10),
    prompts: PROMPTS.length,
    summary: summarizeBench(results),
    results,
  };
  if (opts.outDir !== undefined) {
    writeFileSync(
      join(opts.outDir, `bench-${report.date}.json`),
      JSON.stringify(report, null, 2) + "\n",
      "utf8",
    );
    writeFileSync(join(opts.outDir, `bench-${report.date}.md`), formatMarkdown(report), "utf8");
  }
  return report;
}

function fmtCost(v: number | null): string {
  return v === null ? "n/d" : `US$ ${v.toFixed(4)}`;
}

/** Success rate no formato `80% (4/5)`; `n/d` quando o relatório é v1. */
function fmtRate(r: BenchModelResultLike): string {
  if (
    typeof r.successRate !== "number" || !Number.isFinite(r.successRate) ||
    typeof r.completed !== "number" || !Number.isFinite(r.completed) ||
    typeof r.total !== "number" || !Number.isFinite(r.total)
  ) {
    return "n/d";
  }
  return `${Math.round(r.successRate * 100)}% (${r.completed}/${r.total})`;
}

/**
 * Tabela do CLI: latência, tokens, custo e taxa de sucesso por modelo.
 * A taxa vem de `completed / total` (chamadas concluídas, não acertos).
 */
export function formatBenchTable(report: BenchReport): string {
  const lines = report.results.map(
    (r) =>
      `${r.model} · p50 ${r.latencyMs.p50}ms · ${r.tokensPerSec} tok/s · custo/1k out ` +
      `${r.costPer1kOutUsd === null ? "n/d" : `US$ ${r.costPer1kOutUsd.toFixed(4)}`} · ` +
      `sucesso ${fmtRate(r)}`,
  );
  return [`bench: ${report.results.length} modelos · ${report.prompts} prompts`, ...lines].join("\n");
}

/** Tabela Markdown do relatório; aceita v1 (sem métricas de sucesso). */
export function formatMarkdown(report: BenchReportLike): string {
  const withTotals = report.results.filter(
    (r) => typeof r.completed === "number" && typeof r.total === "number",
  );
  const completed = withTotals.reduce((sum, r) => sum + (r.completed ?? 0), 0);
  const total = withTotals.reduce((sum, r) => sum + (r.total ?? 0), 0);
  const successLine = withTotals.length === 0
    ? "Sucesso agregado: n/d."
    : `Sucesso agregado: ${total === 0 ? 0 : Math.round((completed / total) * 100)}% (${completed}/${total}).`;
  // Relatório v1 (antes do schema 2) não tem summary: calcula o que existe.
  const summary = report.summary ?? summarizeBench(report.results);
  const fastest = report.results.find((r) => r.model === summary.fastest);
  const cheapest = report.results.find((r) => r.model === summary.cheapest);
  // Só elege maior success rate entre resultados com a métrica v2 presente.
  const best = report.results.reduce<BenchModelResultLike | undefined>((acc, r) => {
    if (typeof r.successRate !== "number" || !Number.isFinite(r.successRate)) return acc;
    return acc === undefined || r.successRate > (acc.successRate ?? -Infinity) ? r : acc;
  }, undefined);
  const lines = [
    `# Benchmark de providers - ${report.date}`,
    "",
    `Prompts por execução: ${report.prompts}. TTFT requer streaming no contrato Provider (pendente).`,
    successLine,
    "",
    "## Sumário",
    "",
    `- Mais rápido: ${fastest === undefined ? "n/d" : `\`${fastest.model}\` (p50 ${fastest.latencyMs.p50}ms)`}`,
    `- Mais barato: ${cheapest === undefined ? "n/d" : `\`${cheapest.model}\` (${fmtCost(cheapest.costPer1kOutUsd)}/1k out)`}`,
    `- Maior success rate: ${best === undefined ? "n/d" : `\`${best.model}\` (${fmtRate(best)})`}`,
    "",
    "| Modelo | Tags | Sucesso | p50 (ms) | p95 (ms) | tokens out/call | tokens/s | custo/1k out |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const r of report.results) {
    lines.push(
      `| ${r.model} | ${r.tags.join(", ")} | ${fmtRate(r)} | ${r.latencyMs.p50} | ${r.latencyMs.p95} | ` +
        `${r.tokensOutAvg} | ${r.tokensPerSec} | ${fmtCost(r.costPer1kOutUsd)} |`,
    );
  }
  return lines.join("\n") + "\n";
}