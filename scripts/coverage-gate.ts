#!/usr/bin/env bun
/**
 * Gate de cobertura (#59): totais de linhas/funções do lcov + relatório por
 * slice das funcionalidades C1–C4.
 *
 * O threshold do Bun é por arquivo, então UI parcialmente coberta derrubaria o
 * total; por isso o gate soma LF/LH e FNF/FNH de todos os registros.
 *
 * Exit code: os totais decidem sempre (fail-closed: abaixo do threshold ou lcov
 * vazio/sem métricas). `--slice-threshold <0..1>` liga o gate por slice: todo
 * slice C1–C4 com `files > 0` cujo percentual de linhas ou funções fique abaixo
 * do limiar reprova. Slice sem registros imprime `n/a` e não reprova;
 * `unmapped` nunca é gate. Sem a flag, a tabela é informativa e não altera o
 * exit code; o default do helper `sliceThresholdGaps` é 0.8. O veredito sai no
 * stdout, depois da tabela.
 *
 * Mapa de slices (`SLICE_MAPPING`): cada chave é um slice, cada valor uma lista
 * de padrões de caminho de `SF:` do lcov. Casamento, na ordem da lista:
 * - `dir` casa `dir` e `dir/...`;
 * - `prefixo*` casa qualquer caminho que comece por `prefixo`.
 * O matching é ancorado na raiz do repositório: caminhos são usados como o Bun
 * emite (`src/...`, com `\` normalizado), nunca reescritos a partir de um `/src/`
 * interno. Assim `tests/fixtures/src/mcp/x.ts` não vira `src/mcp/x.ts`. `SF:`
 * duplicado (mesmo caminho normalizado) conta uma vez, primeiro registro vence;
 * logo a soma de um slice pode diferir do total quando o mesmo `SF:` aparece
 * duas vezes. O primeiro match vence; caminho sem match — inclusive absoluto ou
 * fora do repo — cai em `unmapped`.
 *
 * Para adicionar um slice: inclua a chave/lista em `SLICE_MAPPING`, um caso em
 * `tests/coverage-gate.test.ts` e nada mais.
 *
 * Uso (flags e posicionais não se misturam):
 *   bun scripts/coverage-gate.ts [--file coverage/lcov.info] [--threshold 0.8]
 *     [--slice-threshold 0.8]
 *   bun scripts/coverage-gate.ts <lcov> [threshold]
 * `--threshold`/`--slice-threshold` fora de (0, 1] ou não numérico imprime o
 * uso e sai 1. A forma posicional não aceita `--slice-threshold`.
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

export interface SliceCoverage {
  slice: string;
  files: number;
  lines: CoverageMetric;
  functions: CoverageMetric;
}

export type SliceMapping = Readonly<Record<string, readonly string[]>>;

export const UNMAPPED_SLICE = "unmapped";

/** Slices C1–C4; ver cabeçalho para a semântica dos padrões. */
export const SLICE_MAPPING: SliceMapping = {
  "C1 skills": ["src/skill*"],
  "C2 mcp": ["src/mcp"],
  "C3 web": ["src/web-*", "src/tools/web*"],
  "C4 multi-agent": [
    "src/core/session.ts",
    "src/core/app.ts",
    "src/spawn.ts",
    "src/agent-manager.ts",
    "src/agent-lock.ts",
    "src/loop-guard.ts",
    "src/model-choice.ts",
    "src/pool.ts",
    "src/tools/task.ts",
    "src/tools/handoff.ts",
    "src/handoff*",
  ],
};

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

/** Normaliza `SF:` (separador win32, `./`); não reescreve caminho aninhado. */
function normalizePath(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

function matchesPath(pattern: string, file: string): boolean {
  if (pattern.endsWith("*")) return file.startsWith(pattern.slice(0, -1));
  return file === pattern || file.startsWith(`${pattern}/`);
}

interface Bucket {
  files: number;
  lineHit: number;
  lineFound: number;
  fnHit: number;
  fnFound: number;
}

function emptyBucket(): Bucket {
  return { files: 0, lineHit: 0, lineFound: 0, fnHit: 0, fnFound: 0 };
}

/** Agrega os registros `SF:` por slice; informações, não decide o gate. */
export function sliceCoverage(text: string, mapping: SliceMapping = SLICE_MAPPING): SliceCoverage[] {
  const names = Object.keys(mapping);
  const buckets = new Map<string, Bucket>(names.map((name) => [name, emptyBucket()]));
  buckets.set(UNMAPPED_SLICE, emptyBucket());
  const seen = new Set<string>();

  let target: Bucket | null = null;

  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === "end_of_record") {
      target = null;
      continue;
    }
    const separator = raw.indexOf(":");
    if (separator <= 0) continue;
    const key = raw.slice(0, separator);
    const rawValue = raw.slice(separator + 1).trim();
    if (key === "SF") {
      if (rawValue.length === 0) {
        target = null;
        continue;
      }
      const path = normalizePath(rawValue);
      if (seen.has(path)) {
        target = null;
        continue;
      }
      seen.add(path);
      const name = names.find((candidate) =>
        (mapping[candidate] ?? []).some((pattern) => matchesPath(pattern, path))) ?? UNMAPPED_SLICE;
      target = buckets.get(name) ?? null;
      if (target !== null) target.files += 1;
      continue;
    }
    if (target === null) continue;
    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;
    if (key === "LH") target.lineHit += value;
    else if (key === "LF") target.lineFound += value;
    else if (key === "FNH") target.fnHit += value;
    else if (key === "FNF") target.fnFound += value;
  }

  return [...buckets].map(([slice, value]) => ({
    slice,
    files: value.files,
    lines: metric(value.lineHit, value.lineFound),
    functions: metric(value.fnHit, value.fnFound),
  }));
}

export interface SliceGap {
  slice: string;
  metric: "lines" | "functions";
  hit: number;
  found: number;
  rate: number;
}

/**
 * Slices C1–C4 abaixo do limiar, na ordem do relatório. `unmapped` e slices com
 * `files === 0` nunca entram; uma métrica sem registros é `n/a` e também não
 * reprova. Com `files > 0`, cada métrica medida precisa alcançar o limiar.
 */
export function sliceThresholdGaps(
  slices: readonly SliceCoverage[],
  threshold = 0.8,
): SliceGap[] {
  const gaps: SliceGap[] = [];
  for (const slice of slices) {
    if (slice.slice === UNMAPPED_SLICE || slice.files === 0) continue;
    for (const metric of ["lines", "functions"] as const) {
      const value = slice[metric];
      if (value.found === 0 || value.rate >= threshold) continue;
      gaps.push({
        slice: slice.slice,
        metric,
        hit: value.hit,
        found: value.found,
        rate: value.rate,
      });
    }
  }
  return gaps;
}

function percent(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

function rateLabel(value: CoverageMetric): string {
  return value.found === 0 ? "n/a" : percent(value.rate);
}

/**
 * Tabela textual do relatório por slice. Sem `sliceThreshold` o cabeçalho
 * declara o relatório informativo; com limiar, declara o gate ativo.
 */
export function formatSliceReport(
  slices: readonly SliceCoverage[],
  sliceThreshold: number | null = null,
): string[] {
  const header = ["slice", "lines", "functions", "lines hit/found", "files"];
  const rows = slices.map((slice) => slice.files === 0
    ? [slice.slice, "n/a", "n/a", "n/a", "0"]
    : [
        slice.slice,
        rateLabel(slice.lines),
        rateLabel(slice.functions),
        `${slice.lines.hit}/${slice.lines.found}`,
        String(slice.files),
      ]);
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => row[index]?.length ?? 0)));
  const render = (cells: readonly string[]) =>
    cells.map((cell, index) => index === 0
      ? cell.padEnd(widths[index] ?? cell.length)
      : cell.padStart(widths[index] ?? cell.length)).join("  ");

  return [
    sliceThreshold === null
      ? "coverage por slice (informativo, não altera o exit code):"
      : `coverage por slice (threshold ${percent(sliceThreshold)}):`,
    render(header),
    ...rows.map(render),
  ];
}

/** Veredito do gate por slice, no stdout como o veredito dos totais. */
function formatSliceVerdict(gaps: readonly SliceGap[], threshold: number): string {
  if (gaps.length === 0) return `coverage por slice: ok (threshold ${percent(threshold)})`;
  const detail = gaps
    .map((gap) => `${gap.slice} ${gap.metric} ${percent(gap.rate)} (${gap.hit}/${gap.found})`)
    .join("; ");
  return `coverage por slice: abaixo do threshold ${percent(threshold)}: ${detail}`;
}

interface CliOptions {
  file: string;
  threshold: number;
  sliceThreshold: number | null;
}

type CliParse = { ok: true; options: CliOptions } | { ok: false; message: string };

export const USAGE =
  "uso: bun scripts/coverage-gate.ts [--file <lcov>] [--threshold <0-1>] " +
  "[--slice-threshold <0-1>] | <lcov> [threshold]";

/** Aceita flags ou a forma posicional, nunca as duas. Validação falha fechado. */
function parseArgs(argv: readonly string[]): CliParse {
  let file = "coverage/lcov.info";
  let threshold = 0.8;
  let sliceThreshold: number | null = null;
  const positional: string[] = [];
  let sawFlag = false;

  const readThreshold = (raw: string): number | null => {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 && value <= 1 ? value : null;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg !== "--file" && arg !== "--threshold" && arg !== "--slice-threshold") {
      positional.push(arg);
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      return { ok: false, message: `${arg} exige um valor` };
    }
    sawFlag = true;
    index += 1;
    if (arg === "--file") {
      file = next;
      continue;
    }
    const parsed = readThreshold(next);
    if (parsed === null) {
      return {
        ok: false,
        message: `${arg.slice(2)} inválido: ${next} (esperado número em (0, 1])`,
      };
    }
    if (arg === "--threshold") threshold = parsed;
    else sliceThreshold = parsed;
  }

  if (sawFlag && positional.length > 0) return { ok: false, message: "não misture flags e posicionais" };
  if (positional.length > 2) return { ok: false, message: "posicionais demais" };
  if (positional[0] !== undefined) file = positional[0];
  if (positional[1] !== undefined) {
    const parsed = readThreshold(positional[1]);
    if (parsed === null) {
      return { ok: false, message: `threshold inválido: ${positional[1]} (esperado número em (0, 1])` };
    }
    threshold = parsed;
  }
  return { ok: true, options: { file, threshold, sliceThreshold } };
}

if (import.meta.main) {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`coverage: ${parsed.message}`);
    console.error(USAGE);
    process.exit(1);
  }
  const { file, threshold, sliceThreshold } = parsed.options;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    console.error(`coverage: lcov não encontrado em ${file}`);
    process.exit(1);
  }
  const totals = parseLcov(text, threshold);
  const slices = sliceCoverage(text, SLICE_MAPPING);
  const gaps = sliceThreshold === null ? [] : sliceThresholdGaps(slices, sliceThreshold);
  console.log(
    `coverage: ${percent(totals.lines.rate)} linhas (${totals.lines.hit}/${totals.lines.found}) · ` +
    `${percent(totals.functions.rate)} funções (${totals.functions.hit}/${totals.functions.found}) · ` +
    `threshold ${percent(threshold)}`,
  );
  for (const line of formatSliceReport(slices, sliceThreshold)) console.log(line);
  if (sliceThreshold !== null) console.log(formatSliceVerdict(gaps, sliceThreshold));
  console.log(totals.ok ? "coverage: ok" : "coverage: abaixo do threshold");
  if (!totals.ok || gaps.length > 0) process.exit(1);
}
