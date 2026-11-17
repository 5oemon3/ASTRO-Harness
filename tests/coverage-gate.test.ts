import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SLICE_MAPPING,
  formatSliceReport,
  parseLcov,
  sliceCoverage,
  sliceThresholdGaps,
} from "../scripts/coverage-gate";

const lcov = [
  "TN:",
  "SF:src/a.ts",
  "FNF:2",
  "FNH:2",
  "LF:10",
  "LH:10",
  "end_of_record",
  "SF:src/b.ts",
  "FNF:2",
  "FNH:1",
  "LF:10",
  "LH:5",
  "end_of_record",
].join("\n");

function record(file: string, lh: number, lf: number, fnh = 0, fnf = 0): string[] {
  return [
    `SF:${file}`,
    `FNF:${fnf}`,
    `FNH:${fnh}`,
    `LF:${lf}`,
    `LH:${lh}`,
    "end_of_record",
  ];
}

function withLcov<T>(content: string, fn: (file: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "astro-cov-"));
  try {
    const file = join(dir, "lcov.info");
    writeFileSync(file, content);
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("coverage gate (#59)", () => {
  test("soma linhas e funções e aprova no threshold", () => {
    const totals = parseLcov(lcov, 0.75);
    expect(totals.lines).toEqual({ hit: 15, found: 20, rate: 0.75 });
    expect(totals.functions).toEqual({ hit: 3, found: 4, rate: 0.75 });
    expect(totals.ok).toBe(true);
  });

  test("reprova quando linhas ou funções ficam abaixo", () => {
    expect(parseLcov(lcov, 0.8).ok).toBe(false);
    expect(parseLcov(lcov, 0.76).ok).toBe(false);
  });

  test("limiar exato aprova e um passo abaixo reprova", () => {
    const exact = record("src/a.ts", 8, 10, 4, 5).join("\n");
    expect(parseLcov(exact, 0.8).ok).toBe(true);
    expect(parseLcov(record("src/a.ts", 79, 100, 4, 5).join("\n"), 0.8).ok).toBe(false);
  });

  test("lcov vazio falha fechado", () => {
    const totals = parseLcov("", 0.8);
    expect(totals.ok).toBe(false);
    expect(totals.lines.rate).toBe(0);
    expect(totals.functions.rate).toBe(0);
  });

  test("ignora linhas malformadas", () => {
    const totals = parseLcov("LF:abc\nLH:1\nFNF:2\nFNH:1\nSF:x\nend_of_record", 0.5);
    expect(totals.lines.hit).toBe(1);
    expect(totals.lines.found).toBe(0);
    expect(totals.ok).toBe(false);
  });
});

describe("sliceCoverage (#59)", () => {
  const text = [
    ...record("src/skills/loader.ts", 9, 10, 1, 2),
    ...record("src/skill-registry.ts", 1, 2),
    ...record("src/mcp/client.ts", 4, 4, 1, 1),
    ...record("src/tools/web-fetch.ts", 0, 5),
    ...record("src/core/session.ts", 7, 8, 3, 4),
    ...record("src/handoff/plan.ts", 2, 2),
    ...record("src/ledger.ts", 10, 10),
  ].join("\n");

  test("soma por slice e separa o bucket unmapped", () => {
    const slices = sliceCoverage(text, SLICE_MAPPING);
    const byName = Object.fromEntries(slices.map((slice) => [slice.slice, slice]));
    expect(byName["C1 skills"]?.files).toBe(2);
    expect(byName["C1 skills"]?.lines).toEqual({ hit: 10, found: 12, rate: 10 / 12 });
    expect(byName["C2 mcp"]?.lines).toEqual({ hit: 4, found: 4, rate: 1 });
    expect(byName["C3 web"]?.functions.found).toBe(0);
    expect(byName["C4 multi-agent"]?.files).toBe(2);
    expect(byName["C4 multi-agent"]?.functions).toEqual({ hit: 3, found: 4, rate: 0.75 });
    expect(byName.unmapped?.files).toBe(1);
    expect(byName.unmapped?.lines.hit).toBe(10);
    expect(slices.map((slice) => slice.slice)).toEqual([
      "C1 skills",
      "C2 mcp",
      "C3 web",
      "C4 multi-agent",
      "unmapped",
    ]);
  });

  test("C4 cobre spawn, agentes, task, handoff, model-choice e pool", () => {
    const paths = [
      "src/spawn.ts",
      "src/agent-manager.ts",
      "src/agent-lock.ts",
      "src/tools/task.ts",
      "src/tools/handoff.ts",
      "src/model-choice.ts",
      "src/pool.ts",
    ];
    for (const path of paths) {
      const slices = sliceCoverage(record(path, 1, 1).join("\n"), SLICE_MAPPING);
      expect(slices.find((slice) => slice.slice === "C4 multi-agent")?.files).toBe(1);
      expect(slices.find((slice) => slice.slice === "unmapped")?.files).toBe(0);
    }
  });

  test("task sem cobertura aparece como 0.00% em C4, não some", () => {
    const slices = sliceCoverage(record("src/tools/task.ts", 0, 74, 0, 4).join("\n"), SLICE_MAPPING);
    const row = formatSliceReport(slices).find((line) => line.startsWith("C4 multi-agent"));
    expect(row).toContain("0.00%");
    expect(row).toContain("0/74");
    expect(slices.find((slice) => slice.slice === "unmapped")?.files).toBe(0);
  });

  test("team e registry ficam fora de C4 (exclusão documentada)", () => {
    for (const path of ["src/team.ts", "src/core/registry.ts"]) {
      const slices = sliceCoverage(record(path, 1, 1).join("\n"), SLICE_MAPPING);
      expect(slices.find((slice) => slice.slice === "C4 multi-agent")?.files).toBe(0);
      expect(slices.find((slice) => slice.slice === "unmapped")?.files).toBe(1);
    }
  });

  test("slice sem registros não quebra e imprime n/a", () => {
    const slices = sliceCoverage(record("src/ledger.ts", 1, 1).join("\n"), SLICE_MAPPING);
    const web = slices.find((slice) => slice.slice === "C3 web");
    expect(web).toEqual({ slice: "C3 web", files: 0, lines: { hit: 0, found: 0, rate: 0 }, functions: { hit: 0, found: 0, rate: 0 } });
    const report = formatSliceReport(slices).join("\n");
    expect(report).toContain("n/a");
    expect(report).toContain("informativo");
  });

  test("lcov vazio e LF malformado não quebram o relatório", () => {
    const empty = sliceCoverage("", SLICE_MAPPING);
    expect(empty.every((slice) => slice.files === 0 && slice.lines.found === 0)).toBe(true);
    expect(formatSliceReport(empty).join("\n")).toContain("n/a");
    const malformed = sliceCoverage("SF:src/mcp/client.ts\nLF:abc\nLH:1\nend_of_record", SLICE_MAPPING);
    expect(malformed.find((slice) => slice.slice === "C2 mcp")?.lines)
      .toEqual({ hit: 1, found: 0, rate: 0 });
  });

  test("normaliza separadores e não reescreve caminho com /src/ aninhado", () => {
    const slices = sliceCoverage([
      ...record("src\\mcp\\client.ts", 1, 2),
      ...record("tests/fixtures/src/mcp/fake.ts", 0, 1),
      ...record("D:/src/repo/tests/a.ts", 0, 1),
    ].join("\n"), { "C2 mcp": ["src/mcp"] });
    expect(slices[0]?.files).toBe(1);
    expect(slices[0]?.lines).toEqual({ hit: 1, found: 2, rate: 0.5 });
    expect(slices[1]?.files).toBe(2);
  });

  test("deduplica SF repetido pelo caminho normalizado", () => {
    const slices = sliceCoverage([
      ...record("src/spawn.ts", 1, 1),
      ...record("src\\spawn.ts", 0, 5),
    ].join("\n"), SLICE_MAPPING);
    const c4 = slices.find((slice) => slice.slice === "C4 multi-agent");
    expect(c4?.files).toBe(1);
    expect(c4?.lines).toEqual({ hit: 1, found: 1, rate: 1 });
  });
});

describe("sliceThresholdGaps (#59)", () => {
  test("aprova quando todo slice C1–C4 fica no limiar", () => {
    const text = [
      ...record("src/skills/loader.ts", 8, 10, 4, 5),
      ...record("src/mcp/client.ts", 10, 10, 4, 4),
    ].join("\n");
    expect(sliceThresholdGaps(sliceCoverage(text, SLICE_MAPPING), 0.8)).toEqual([]);
  });

  test("reprova linhas e funções abaixo e nomeia a métrica", () => {
    const text = [
      ...record("src/skills/loader.ts", 8, 10, 4, 5),
      ...record("src/mcp/client.ts", 7, 10, 4, 4),
      ...record("src/tools/web-fetch.ts", 10, 10, 1, 4),
    ].join("\n");
    expect(sliceThresholdGaps(sliceCoverage(text, SLICE_MAPPING), 0.8)).toEqual([
      { slice: "C2 mcp", metric: "lines", hit: 7, found: 10, rate: 0.7 },
      { slice: "C3 web", metric: "functions", hit: 1, found: 4, rate: 0.25 },
    ]);
  });

  test("slice vazio (n/a) e unmapped nunca entram no gate", () => {
    const text = [...record("src/ledger.ts", 0, 10, 0, 2)].join("\n");
    const slices = sliceCoverage(text, SLICE_MAPPING);
    expect(slices.find((slice) => slice.slice === "unmapped")?.files).toBe(1);
    expect(sliceThresholdGaps(slices, 0.99)).toEqual([]);
  });

  test("métrica sem registros é n/a e não reprova", () => {
    const slices = sliceCoverage(record("src/tools/web-fetch.ts", 5, 5, 0, 0).join("\n"), SLICE_MAPPING);
    expect(sliceThresholdGaps(slices, 0.8)).toEqual([]);
  });

  test("usa 0.8 quando o limiar é omitido", () => {
    const slice = sliceCoverage(record("src/mcp/client.ts", 7, 10, 1, 1).join("\n"), SLICE_MAPPING);
    expect(sliceThresholdGaps(slice).map((gap) => gap.metric)).toEqual(["lines"]);
  });

  test("regressão: slice sem registros imprime n/a e não reprova", () => {
    const slices = sliceCoverage(record("src/mcp/client.ts", 4, 4, 1, 1).join("\n"), SLICE_MAPPING);
    const report = formatSliceReport(slices, 0.8).join("\n");
    expect(report).toContain("n/a");
    expect(report).not.toContain("informativo");
    expect(sliceThresholdGaps(slices, 0.8)).toEqual([]);
  });
});

describe("coverage gate CLI (#59)", () => {
  const root = join(import.meta.dir, "..");
  const script = join(root, "scripts", "coverage-gate.ts");
  const passing = [...record("src/skills/loader.ts", 10, 10, 2, 2)].join("\n");
  const failing = [...record("src/mcp/client.ts", 1, 10, 0, 2)].join("\n");

  function run(args: string[]) {
    const result = Bun.spawnSync([process.execPath, script, ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  }

  test("imprime a tabela por slice e sai 0 acima do limiar", () => {
    const result = withLcov(passing, (file) => run(["--file", file]));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("C1 skills");
    expect(result.stdout).toContain("100.00%");
    expect(result.stdout).toContain("coverage: ok");
    expect(result.stdout.indexOf("slice")).toBeLessThan(result.stdout.indexOf("coverage: ok"));
  });

  test("sai 1 abaixo do limiar, com tabela e veredito no stdout", () => {
    const result = withLcov(failing, (file) => run(["--file", file, "--threshold", "0.8"]));
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("C2 mcp");
    expect(result.stdout).toContain("abaixo do threshold");
    expect(result.stdout.indexOf("slice")).toBeLessThan(result.stdout.indexOf("abaixo do threshold"));
    expect(result.stderr).toBe("");
  });

  test("forma posicional antiga continua válida", () => {
    const result = withLcov(passing, (file) => run([file, "0.8"]));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("100.00%");
  });

  test("threshold inválido falha com uso, sem virar caminho", () => {
    const cases = [["--threshold"], ["--threshold", "abc"], ["--threshold", "1.5"], ["--threshold", "0"]];
    for (const args of cases) {
      const result = withLcov(passing, (file) => run(["--file", file, ...args]));
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("uso:");
      expect(result.stdout).toBe("");
    }
  });

  test("misturar flag e posicional é rejeitado", () => {
    const result = withLcov(passing, (file) => run(["--file", file, "0.8"]));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("uso:");
  });

  // Total ≥80% (17/20 linhas, 5/6 funções) com C1 em 70% de linhas.
  const totalOkSliceLow = [
    ...record("src/skills/loader.ts", 7, 10, 1, 2),
    ...record("src/ledger.ts", 10, 10, 4, 4),
  ].join("\n");
  // Total 50% (unmapped), mas C1 em 100%: só o total reprova.
  const totalLowSliceOk = [
    ...record("src/skills/loader.ts", 10, 10, 2, 2),
    ...record("src/ledger.ts", 0, 10, 0, 10),
  ].join("\n");

  test("--slice-threshold reprova slice C1–C4 abaixo mesmo com total ok", () => {
    const result = withLcov(totalOkSliceLow, (file) =>
      run(["--file", file, "--threshold", "0.8", "--slice-threshold", "0.8"]));
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("coverage: ok");
    expect(result.stdout).toContain("C1 skills lines 70.00% (7/10)");
    expect(result.stdout).toContain("coverage por slice: abaixo do threshold");
    expect(result.stderr).toBe("");
  });

  test("--slice-threshold aprova fatia no limiar exato", () => {
    const exact = [...record("src/skills/loader.ts", 8, 10, 4, 5)].join("\n");
    const result = withLcov(exact, (file) =>
      run(["--file", file, "--threshold", "0.8", "--slice-threshold", "0.8"]));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("coverage por slice: ok");
    expect(result.stdout).toContain("coverage: ok");
  });

  test("total reprovado mantém exit 1 mesmo com slices ok", () => {
    const result = withLcov(totalLowSliceOk, (file) =>
      run(["--file", file, "--threshold", "0.8", "--slice-threshold", "0.8"]));
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("coverage por slice: ok");
    expect(result.stdout).toContain("coverage: abaixo do threshold");
  });

  test("ambos reprovados sai 1 e reporta as duas causas", () => {
    const text = [
      ...record("src/skills/loader.ts", 3, 10, 1, 2),
      ...record("src/ledger.ts", 0, 10, 0, 10),
    ].join("\n");
    const result = withLcov(text, (file) =>
      run(["--file", file, "--slice-threshold", "0.8"]));
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("C1 skills lines 30.00%");
    expect(result.stdout).toContain("coverage: abaixo do threshold");
  });

  test("sem a flag o slice abaixo do limiar continua informativo", () => {
    const result = withLcov(totalOkSliceLow, (file) => run(["--file", file]));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("informativo");
    expect(result.stdout).toContain("70.00%");
    expect(result.stdout).not.toContain("coverage por slice: abaixo");
  });

  test("--slice-threshold inválido falha com uso", () => {
    const cases = [
      ["--slice-threshold"],
      ["--slice-threshold", "abc"],
      ["--slice-threshold", "1.5"],
      ["--slice-threshold", "0"],
    ];
    for (const args of cases) {
      const result = withLcov(passing, (file) => run(["--file", file, ...args]));
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("uso:");
      expect(result.stdout).toBe("");
    }
  });
});
