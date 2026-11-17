#!/usr/bin/env bun
/**
 * Gate de cobertura total (#59): soma LF/LH e FNF/FNH do lcov e falha quando
 * linhas ou funções ficam abaixo do threshold. O threshold do Bun é por
 * arquivo, então arquivos de UI parcialmente cobertos derrubariam o total.
 */
import { readFileSync } from "node:fs";

export interface CoverageMetric {
  hit: number;
  found: number;
  rate: number;
}

export interface CoverageTotals {
  lines: CoverageMetric;
  functions: CoverageMetric;
  ok: boolean;
}

function metric(hit: number, found: number): CoverageMetric {
  return { hit, found, rate: found === 0 ? 0 : hit / found };
}

/** Soma os registros lcov; lcov vazio ou sem métricas falha fechado. */
export function parseLcov(text: string, threshold = 0.8): CoverageTotals {
  let lineHit = 0;
  let lineFound = 0;
  let fnHit = 0;
  let fnFound = 0;

  for (const raw of text.split(/\r?\n/)) {
    const separator = raw.indexOf(":");
    if (separator <= 0) continue;
    const key = raw.slice(0, separator);
    const value = Number(raw.slice(separator + 1).trim());
    if (!Number.isFinite(value)) continue;
    if (key === "LH") lineHit += value;
    else if (key === "LF") lineFound += value;
    else if (key === "FNH") fnHit += value;
    else if (key === "FNF") fnFound += value;
  }

  const lines = metric(lineHit, lineFound);
  const functions = metric(fnHit, fnFound);
  const ok = lines.found > 0
    && functions.found > 0
    && lines.rate >= threshold
    && functions.rate >= threshold;
  return { lines, functions, ok };
}

function percent(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

if (import.meta.main) {
  const path = process.argv[2] ?? "coverage/lcov.info";
  const threshold = Number(process.argv[3] ?? "0.8");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    console.error(`coverage: lcov não encontrado em ${path}`);
    process.exit(1);
  }
  const totals = parseLcov(text, threshold);
  console.log(
    `coverage: ${percent(totals.lines.rate)} linhas (${totals.lines.hit}/${totals.lines.found}) · ` +
    `${percent(totals.functions.rate)} funções (${totals.functions.hit}/${totals.functions.found}) · ` +
    `threshold ${percent(threshold)}`,
  );
  if (!totals.ok) {
    console.error("coverage: abaixo do threshold");
    process.exit(1);
  }
}
