import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isKnownTag } from "../src/tags";

const GOLDEN_ROOT = join(import.meta.dir, "..", "eval", "golden");
const EXPECTED_CASES = 65;
const CATEGORIES = ["refactor", "bugfix", "testgen", "doc", "feature", "skills", "mcp", "web", "multi-agent", "providers"] as const;
/** 10 cases legados por categoria de código + 3 cenários novos por categoria (#59). */
const PER_CATEGORY: Record<(typeof CATEGORIES)[number], number> = {
  refactor: 10, bugfix: 10, testgen: 10, doc: 10, feature: 10,
  skills: 3, mcp: 3, web: 3, "multi-agent": 3, providers: 3,
};

interface CaseMeta {
  schema: number;
  id: string;
  category: (typeof CATEGORIES)[number];
  difficulty: number;
  tags: string[];
  files: string[];
}

interface ScenarioFile {
  schema: number;
  kind?: "app" | "health";
  config?: Record<string, unknown>;
  turns?: unknown[];
  expect?: Record<string, unknown>;
}

function loadCases(): Array<{ dir: string; meta: CaseMeta; scenario?: ScenarioFile }> {
  const entries = readdirSync(GOLDEN_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(GOLDEN_ROOT, e.name))
    .sort();
  return entries.map((dir) => {
    const scenarioPath = join(dir, "scenario.json");
    return {
      dir,
      meta: JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as CaseMeta,
      ...(existsSync(scenarioPath)
        ? { scenario: JSON.parse(readFileSync(scenarioPath, "utf8")) as ScenarioFile }
        : {}),
    };
  });
}

describe("golden dataset (F5-1)", () => {
  test("contém exatamente 65 cases", () => {
    const cases = loadCases();
    expect(cases).toHaveLength(EXPECTED_CASES);
  });

  test("cobertura: 10 cases por categoria de código e 3 por categoria de cenário", () => {
    const cases = loadCases();
    const byCategory = new Map<string, number>();
    for (const c of cases) {
      byCategory.set(c.meta.category, (byCategory.get(c.meta.category) ?? 0) + 1);
    }
    for (const category of CATEGORIES) {
      expect(byCategory.get(category)).toBe(PER_CATEGORY[category]);
    }
  });

  test("schema meta.json válido em todos os cases", () => {
    for (const c of loadCases()) {
      expect(c.meta.schema).toBe(1);
      expect(c.meta.id).toBeTruthy();
      expect(CATEGORIES).toContain(c.meta.category);
      expect(c.meta.difficulty).toBeGreaterThanOrEqual(1);
      expect(c.meta.difficulty).toBeLessThanOrEqual(3);
      expect(c.meta.tags.length).toBeGreaterThan(0);
      for (const tag of c.meta.tags) {
        expect(isKnownTag(tag)).toBe(true);
      }
    }
  });

  test("scenario.json (quando presente) segue o schema v1 e tem uma expectativa", () => {
    for (const c of loadCases().filter((entry) => entry.scenario !== undefined)) {
      const scenario = c.scenario!;
      expect(scenario.schema).toBe(1);
      expect(["app", "health"]).toContain(scenario.kind ?? "app");
      if (scenario.kind === "health") {
        expect(scenario.config).toBeDefined();
        expect(scenario.expect?.health).toBeDefined();
      } else {
        expect(Array.isArray(scenario.turns)).toBe(true);
        const assertions = scenario.expect ?? {};
        expect(Object.keys(assertions).length).toBeGreaterThan(0);
      }
    }
  });

  test("task.md existe e não é vazio", () => {
    for (const c of loadCases()) {
      const task = readFileSync(join(c.dir, "task.md"), "utf8");
      expect(task.trim().length).toBeGreaterThan(10);
    }
  });

  test("expected/ contém todos os arquivos declarados em meta.files", () => {
    for (const c of loadCases()) {
      // Cenário pode não produzir arquivo (falha esperada / health); nesse caso
      // a expectativa vive no scenario.json.
      expect(c.meta.files.length > 0 || c.scenario !== undefined).toBe(true);
      for (const file of c.meta.files) {
        expect(existsSync(join(c.dir, "expected", file))).toBe(true);
      }
    }
  });

  test("ids únicos", () => {
    const ids = loadCases().map((c) => c.meta.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
