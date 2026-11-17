import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { benchModel, filterModels, formatBenchTable, formatMarkdown, runBenchmark, selectBenchModels, summarizeBench, type BenchModelResult, type BenchModelResultLike, type BenchReport, type BenchReportLike } from "../src/eval/bench";
import type { ModelEntry } from "../src/core/registry";
import type { CompletionResponse, Provider } from "../src/providers/types";

const root = join(import.meta.dir, "..");
const entry = join(root, "src", "cli.ts");

const model = (over: Partial<ModelEntry> = {}): ModelEntry => ({
  provider: "mock",
  id: "bench-model",
  tags: ["writing-code", "fast"],
  context: 128000,
  status: "active",
  ...over,
});

/** Resultado de bench para testar sumário e formatação sem chamar provider. */
const benchResult = (over: Partial<BenchModelResult> = {}): BenchModelResult => ({
  model: "mock/bench-model",
  provider: "mock",
  tags: [],
  runs: 1,
  successRate: 1,
  completed: 5,
  total: 5,
  latencyMs: { min: 1, p50: 2, p95: 3, max: 4 },
  tokensInAvg: 10,
  tokensOutAvg: 20,
  tokensPerSec: 100,
  costPer1kOutUsd: null,
  ttftMs: null,
  ...over,
});

/** Referências `provider/model`, na ordem da lista. */
const refs = (list: readonly ModelEntry[]): string[] => list.map((m) => `${m.provider}/${m.id}`);

/** Config mínima do CLI de bench; a seleção falha antes de criar provider. */
function cliBenchConfig(): { dir: string; cfgPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "astro-bench-cli-"));
  const cfgPath = join(dir, "astro.config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      providers: {
        nvidia: { kind: "openai-compat", baseUrl: "https://nvidia.example/v1" },
        openrouter: { kind: "openai-compat", baseUrl: "https://openrouter.example/v1" },
        openai: { kind: "openai-compat", baseUrl: "https://openai.example/v1" },
      },
      models: [
        { provider: "nvidia", id: "n1", tags: ["writing-code"], context: 8192 },
        { provider: "openrouter", id: "o1", tags: ["writing-code"], context: 8192 },
        { provider: "openai", id: "g1", tags: ["writing-code"], context: 8192 },
      ],
      agent: { model: "nvidia/n1", maxSteps: 1, tools: ["read_file"] },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    }),
    "utf8",
  );
  return { dir, cfgPath };
}

/** Provider mock com delay determinístico para medir latência. */
function delayedProvider(delayMs: number, out = 50): Provider {
  return {
    async complete(): Promise<CompletionResponse> {
      await new Promise((r) => setTimeout(r, delayMs));
      return { content: "x".repeat(out), toolCalls: [], usage: { inputTokens: 100, outputTokens: out } };
    },
  };
}

/** Provider mock que falha em uma chamada específica (1-based). */
function flakyProvider(failOnCall: number, out = 40, message = "falha simulada"): Provider {
  let calls = 0;
  return {
    async complete(): Promise<CompletionResponse> {
      calls++;
      if (calls === failOnCall) throw new Error(message);
      return { content: "x".repeat(out), toolCalls: [], usage: { inputTokens: 100, outputTokens: out } };
    },
  };
}

describe("benchmark de providers (F5-4)", () => {
  test("benchModel mede latência, tokens/s e custo/1k (verificado)", async () => {
    const m = model({
      price: { inputPerM: 1, outputPerM: 2, fonte: "tabela", verificado: true },
    });
    const result = await benchModel(m, () => delayedProvider(5, 40), 1);
    expect(result.model).toBe("mock/bench-model");
    expect(result.runs).toBe(1);
    expect(result.latencyMs.min).toBeGreaterThanOrEqual(5);
    expect(result.latencyMs.p50).toBeGreaterThanOrEqual(result.latencyMs.min);
    expect(result.latencyMs.p95).toBeGreaterThanOrEqual(result.latencyMs.p50);
    expect(result.tokensInAvg).toBe(100);
    expect(result.tokensOutAvg).toBe(40);
    // ~40 tokens por ~5ms+ → tokensPerSec > 0
    expect(result.tokensPerSec).toBeGreaterThan(0);
    // custo/1k out = outputPerM = US$ 2
    expect(result.costPer1kOutUsd).toBe(2);
    // TTFT exige streaming: campo pendente
    expect(result.ttftMs).toBeNull();
  });

  test("custo null quando price não verificado", async () => {
    const m = model({
      price: { inputPerM: 1, outputPerM: 2, fonte: "tabela", verificado: false },
    });
    const result = await benchModel(m, () => delayedProvider(1), 1);
    expect(result.costPer1kOutUsd).toBeNull();
  });

  test("custo null sem price", async () => {
    const result = await benchModel(model(), () => delayedProvider(1), 1);
    expect(result.costPer1kOutUsd).toBeNull();
  });

  test("success rate é 100% quando todos os prompts completam", async () => {
    const result = await benchModel(model(), () => delayedProvider(1), 2);
    expect(result.total).toBe(10);
    expect(result.completed).toBe(10);
    expect(result.successRate).toBe(1);
  });

  test("falha de prompt entra na success rate sem derrubar a suíte", async () => {
    const result = await benchModel(model(), () => flakyProvider(2), 1);
    expect(result.total).toBe(5);
    expect(result.completed).toBe(4);
    expect(result.successRate).toBe(0.8);
    // Média de tokens só sobre as chamadas concluídas.
    expect(result.tokensInAvg).toBe(100);
    expect(result.tokensOutAvg).toBe(40);
  });

  test("falha em todos os prompts propaga o erro do provider", async () => {
    const down: Provider = {
      async complete(): Promise<CompletionResponse> {
        throw new Error("provider fora do ar");
      },
    };
    await expect(benchModel(model(), () => down, 1)).rejects.toThrow("provider fora do ar");
  });

  test("benchModel e runBenchmark recusam runs < 1", async () => {
    await expect(benchModel(model(), () => delayedProvider(1), 0)).rejects.toThrow(RangeError);
    await expect(benchModel(model(), () => delayedProvider(1), 1.5)).rejects.toThrow(
      "runs deve ser inteiro >= 1",
    );
    await expect(
      runBenchmark({ models: [model()], runs: 0, providerFor: () => delayedProvider(1) }),
    ).rejects.toThrow(RangeError);
    await expect(
      runBenchmark({ models: [], runs: 0, providerFor: () => delayedProvider(1) }),
    ).rejects.toThrow(RangeError);
  });

  test("filtro de provider/modelo segue a sintaxe do --models", () => {
    const models = [
      model({ provider: "nvidia", id: "n1" }),
      model({ provider: "openrouter", id: "nvidia/nemotron-4-340b" }),
      model({ provider: "openrouter", id: "o2" }),
    ];
    const all = refs(models);
    // Termo sem `/` casa o provider exato: não pega id de outro provider.
    expect(refs(filterModels(models, "nvidia"))).toEqual(["nvidia/n1"]);
    // Termo com `/` é substring de `provider/model`.
    expect(refs(filterModels(models, "/nemotron"))).toEqual(["openrouter/nvidia/nemotron-4-340b"]);
    expect(refs(filterModels(models, "openrouter/nvidia"))).toEqual(["openrouter/nvidia/nemotron-4-340b"]);
    expect(refs(filterModels(models, "openrouter/o2"))).toEqual(["openrouter/o2"]);
    expect(refs(filterModels(models, " nvidia , openrouter/o2 "))).toEqual(["nvidia/n1", "openrouter/o2"]);
    expect(refs(filterModels(models, ""))).toEqual(all);
    expect(refs(filterModels(models, undefined))).toEqual(all);
    expect(filterModels(models, "sem-match")).toEqual([]);
  });

  test("selectBenchModels aplica o filtro e recusa seleção vazia", () => {
    const models = [
      model({ provider: "nvidia", id: "n1" }),
      model({ provider: "openrouter", id: "o1" }),
    ];
    const selected = selectBenchModels(models, "nvidia");
    expect(selected.ok).toBe(true);
    if (selected.ok) expect(refs(selected.models)).toEqual(["nvidia/n1"]);
    const unfiltered = selectBenchModels(models, undefined);
    expect(unfiltered.ok).toBe(true);
    if (unfiltered.ok) expect(refs(unfiltered.models)).toEqual(["nvidia/n1", "openrouter/o1"]);
    const none = selectBenchModels(models, "sem-match");
    expect(none.ok).toBe(false);
    expect(none.ok ? "" : none.error).toBe("nenhum modelo ativo corresponde ao filtro");
  });

  test("selectBenchModels distingue registro vazio de filtro sem correspondência", () => {
    const emptyConfig = selectBenchModels([], undefined);
    expect(emptyConfig.ok).toBe(false);
    expect(emptyConfig.ok ? "" : emptyConfig.error).toBe("nenhum modelo ativo na configuração");
    const onlyEmptyTerms = selectBenchModels([], " ,, ");
    expect(onlyEmptyTerms.ok ? "" : onlyEmptyTerms.error).toBe("nenhum modelo ativo na configuração");
    const emptyFilter = selectBenchModels([], "nvidia");
    expect(emptyFilter.ok ? "" : emptyFilter.error).toBe("nenhum modelo ativo corresponde ao filtro");
    const noMatch = selectBenchModels([model()], "sem-match");
    expect(noMatch.ok ? "" : noMatch.error).toBe("nenhum modelo ativo corresponde ao filtro");
  });

  test("selectBenchModels com requireFilter recusa filtros que não recortam", () => {
    const models = [
      model({ provider: "nvidia", id: "n1" }),
      model({ provider: "openrouter", id: "o1" }),
      model({ provider: "openai", id: "g1" }),
    ];
    const require = (filter: string) => selectBenchModels(models, filter, { requireFilter: true });
    const noTerms = require(" ,, ");
    expect(noTerms.ok).toBe(false);
    expect(noTerms.ok ? "" : noTerms.error).toContain("filtro ausente");
    const slash = require("/");
    expect(slash.ok).toBe(false);
    expect(slash.ok ? "" : slash.error).toContain("sem termo alfanumérico");
    for (const filter of ["/,nvidia", "nvidia,openrouter,openai"]) {
      const selected = require(filter);
      expect(selected.ok).toBe(false);
      expect(selected.ok ? "" : selected.error).toContain("seleciona todos os modelos");
    }
    expect(require("nvidia").ok).toBe(true);
    expect(require("nvidia,openrouter").ok).toBe(true);
    // Registro de dois providers: a união dos dois também é "todos".
    const two = models.slice(0, 2);
    const allTwo = selectBenchModels(two, "nvidia,openrouter", { requireFilter: true });
    expect(allTwo.ok).toBe(false);
    expect(allTwo.ok ? "" : allTwo.error).toContain("seleciona todos os modelos");
    // Sem a flag, o dispatch manual segue podendo rodar tudo.
    const manual = selectBenchModels(models, "/");
    expect(manual.ok).toBe(true);
    if (manual.ok) expect(manual.models).toHaveLength(3);
  });

  test("CLI bench --require-filter falha fechado sem recorte", async () => {
    const { dir, cfgPath } = cliBenchConfig();
    const cases: Array<[string | undefined, string]> = [
      [undefined, "filtro ausente"],
      ["/", "sem termo alfanumérico"],
      [" ,, ", "filtro ausente"],
      ["/,nvidia", "seleciona todos os modelos"],
      ["sem-match", "nenhum modelo ativo corresponde ao filtro"],
    ];
    for (const [filter, message] of cases) {
      const args = [process.execPath, entry, "bench", "--config", cfgPath];
      if (filter !== undefined) args.push("--models", filter);
      args.push("--require-filter");
      const proc = Bun.spawn(args, {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ASTRO_HOME: dir },
      });
      const err = await new Response(proc.stderr).text();
      expect(await proc.exited).toBe(1);
      expect(err).toContain(message);
    }
  });

  // Duas pernas da matriz de CI (`.github/workflows/ci.yml`): sem depender de
  // env ambiente, para que qualquer valor externo não altere o resultado.
  for (const filter of ["nvidia", "openrouter"] as const) {
    test(`filtro do CI matrix restringe o bench com mocks: ${filter}`, async () => {
      const models = [
        model({ provider: "nvidia", id: "bench" }),
        model({ provider: "openrouter", id: "bench" }),
      ];
      const selected = filterModels(models, filter);
      expect(refs(selected)).toEqual([`${filter}/bench`]);
      const report = await runBenchmark({
        models: selected,
        runs: 1,
        providerFor: () => delayedProvider(1),
      });
      expect(report.results.length).toBe(1);
      expect(report.results[0]?.model).toBe(`${filter}/bench`);
      expect(report.results[0]?.successRate).toBe(1);
    });
  }

  test("runBenchmark grava JSON e Markdown com data", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "astro-bench-"));
    const report = await runBenchmark({
      models: [model()],
      runs: 1,
      outDir,
      providerFor: () => delayedProvider(2),
    });
    const date = report.date;
    expect(existsSync(join(outDir, `bench-${date}.json`))).toBe(true);
    const md = readFileSync(join(outDir, `bench-${date}.md`), "utf8");
    expect(md).toContain("# Benchmark de providers");
    expect(md).toContain("| mock/bench-model");
    expect(md).toContain("n/d"); // custo null → n/d
    const json = JSON.parse(readFileSync(join(outDir, `bench-${date}.json`), "utf8")) as BenchReport;
    expect(json.schema).toBe(2);
    expect(json.summary).toEqual({
      fastest: "mock/bench-model",
      cheapest: null,
      highestSuccessRate: "mock/bench-model",
    });
    expect(json.results).toHaveLength(1);
    expect(json.prompts).toBeGreaterThan(0);
    expect(json.results[0]?.successRate).toBe(1);
  });

  test("erro do provider não vaza para JSON nem Markdown (I-03)", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "astro-bench-leak-"));
    const sentinel = "sentinel-bench-erro-42";
    const report = await runBenchmark({
      models: [model()],
      runs: 1,
      outDir,
      providerFor: () => flakyProvider(1, 40, `provider recusou: ${sentinel}`),
    });
    const json = readFileSync(join(outDir, `bench-${report.date}.json`), "utf8");
    const md = readFileSync(join(outDir, `bench-${report.date}.md`), "utf8");
    expect(json).not.toContain(sentinel);
    expect(md).not.toContain(sentinel);
    // Só contagem e taxa: a falha continua mensurável sem o texto do erro.
    expect(json).toContain('"successRate": 0.8');
    expect(json).toContain('"completed": 4');
    expect(json).toContain('"total": 5');
  });

  test("summarizeBench escolhe rápido, barato e maior sucesso com empate estável", () => {
    const slow = benchResult({
      model: "a/slow",
      latencyMs: { min: 1, p50: 30, p95: 31, max: 32 },
      costPer1kOutUsd: 2,
      successRate: 1,
    });
    const fast = benchResult({
      model: "b/fast",
      latencyMs: { min: 1, p50: 10, p95: 11, max: 12 },
      costPer1kOutUsd: 3,
      successRate: 0.8,
      completed: 4,
      total: 5,
    });
    const cheap = benchResult({
      model: "c/cheap",
      latencyMs: { min: 1, p50: 20, p95: 21, max: 22 },
      costPer1kOutUsd: 1,
      successRate: 0.8,
      completed: 4,
      total: 5,
    });
    const summary = summarizeBench([slow, fast, cheap]);
    expect(summary).toEqual({ fastest: "b/fast", cheapest: "c/cheap", highestSuccessRate: "a/slow" });
    // Empate mantém o primeiro resultado da lista.
    const tie = summarizeBench([slow, benchResult({ ...slow, model: "d/tie" })]);
    expect(tie).toEqual({ fastest: "a/slow", cheapest: "a/slow", highestSuccessRate: "a/slow" });
  });

  test("summarizeBench devolve null sem resultados e ignora custo não verificado", () => {
    expect(summarizeBench([])).toEqual({ fastest: null, cheapest: null, highestSuccessRate: null });
    const unpriced = benchResult({ model: "a/unpriced", costPer1kOutUsd: null });
    const priced = benchResult({ model: "b/priced", costPer1kOutUsd: 5 });
    expect(summarizeBench([unpriced, priced]).cheapest).toBe("b/priced");
    expect(summarizeBench([unpriced]).cheapest).toBeNull();
  });

  test("summarizeBench não elege maior success rate sem métrica v2", () => {
    const v1Result: BenchModelResultLike = {
      model: "a/1", provider: "a", tags: [], runs: 1,
      latencyMs: { min: 1, p50: 2, p95: 3, max: 4 },
      tokensInAvg: 10, tokensOutAvg: 20, tokensPerSec: 100,
      costPer1kOutUsd: 1, ttftMs: null,
    };
    const summary = summarizeBench([v1Result]);
    expect(summary.fastest).toBe("a/1");
    expect(summary.cheapest).toBe("a/1");
    expect(summary.highestSuccessRate).toBeNull();
  });

  test("formatMarkdown inclui todos os modelos e tags", () => {
    const report: BenchReport = {
      schema: 2, date: "2026-10-23", prompts: 5,
      summary: { fastest: "a/1", cheapest: "a/1", highestSuccessRate: "b/2" },
      results: [
        {
          model: "a/1", provider: "a", tags: ["fast"], runs: 1,
          latencyMs: { min: 1, p50: 2, p95: 3, max: 3 },
          tokensInAvg: 10, tokensOutAvg: 20, tokensPerSec: 100,
          costPer1kOutUsd: 1.5, ttftMs: null,
          successRate: 0.8, completed: 4, total: 5,
        },
        {
          model: "b/2", provider: "b", tags: ["reasoning"], runs: 1,
          latencyMs: { min: 1, p50: 2, p95: 3, max: 3 },
          tokensInAvg: 10, tokensOutAvg: 20, tokensPerSec: 50,
          costPer1kOutUsd: null, ttftMs: null,
          successRate: 1, completed: 5, total: 5,
        },
      ],
    };
    const md = formatMarkdown(report);
    expect(md).toContain("| a/1 | fast |");
    expect(md).toContain("| b/2 | reasoning |");
    expect(md).toContain("US$ 1.5000");
    expect(md).toContain("n/d");
    // Success rate por modelo e agregada (completed / total).
    expect(md).toContain("| Modelo | Tags | Sucesso |");
    expect(md).toContain("80% (4/5)");
    expect(md).toContain("100% (5/5)");
    expect(md).toContain("Sucesso agregado: 90% (9/10)");
    expect(md).toContain("## Sumário");
    expect(md).toContain("- Mais rápido: `a/1` (p50 2ms)");
    expect(md).toContain("- Mais barato: `a/1` (US$ 1.5000/1k out)");
    expect(md).toContain("- Maior success rate: `b/2` (100% (5/5))");
  });

  test("formatMarkdown com relatório vazio mostra sumário n/d", () => {
    const report: BenchReport = {
      schema: 2, date: "2026-10-23", prompts: 5,
      summary: { fastest: null, cheapest: null, highestSuccessRate: null },
      results: [],
    };
    const md = formatMarkdown(report);
    expect(md).toContain("- Mais rápido: n/d");
    expect(md).toContain("- Mais barato: n/d");
    expect(md).toContain("- Maior success rate: n/d");
    expect(md).toContain("Sucesso agregado: n/d.");
  });

  test("formatMarkdown renderiza relatório v1 sem inventar métricas", () => {
    // Shape real do schema 1: sem successRate/completed/total e sem summary.
    const v1: BenchReportLike = {
      schema: 1,
      date: "2026-10-23",
      prompts: 5,
      results: [
        {
          model: "a/1", provider: "a", tags: ["fast"], runs: 1,
          latencyMs: { min: 1, p50: 2, p95: 3, max: 4 },
          tokensInAvg: 10, tokensOutAvg: 20, tokensPerSec: 100,
          costPer1kOutUsd: 1.5, ttftMs: null,
        },
        {
          model: "b/2", provider: "b", tags: ["reasoning"], runs: 1,
          latencyMs: { min: 1, p50: 3, p95: 4, max: 5 },
          tokensInAvg: 10, tokensOutAvg: 20, tokensPerSec: 50,
          costPer1kOutUsd: null, ttftMs: null,
        },
      ],
    };
    const md = formatMarkdown(v1);
    expect(md).toContain("Sucesso agregado: n/d.");
    expect(md).toContain("| a/1 | fast | n/d |");
    expect(md).toContain("- Mais rápido: `a/1` (p50 2ms)");
    expect(md).toContain("- Mais barato: `a/1` (US$ 1.5000/1k out)");
    expect(md).toContain("- Maior success rate: n/d");
    expect(md).not.toContain("NaN");
    expect(md).not.toContain("undefined");
  });

  test("formatBenchTable mostra a taxa de sucesso por modelo", () => {
    const report: BenchReport = {
      schema: 2, date: "2026-10-23", prompts: 5,
      summary: { fastest: "a/1", cheapest: "a/1", highestSuccessRate: "a/1" },
      results: [
        {
          model: "a/1", provider: "a", tags: ["fast"], runs: 1,
          latencyMs: { min: 1, p50: 2, p95: 3, max: 3 },
          tokensInAvg: 10, tokensOutAvg: 20, tokensPerSec: 100,
          costPer1kOutUsd: 1.5, ttftMs: null,
          successRate: 0.8, completed: 4, total: 5,
        },
      ],
    };
    const table = formatBenchTable(report);
    expect(table).toContain("sucesso 80% (4/5)");
    expect(table).toContain("p50 2ms");
  });
});