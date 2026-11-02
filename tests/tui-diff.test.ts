import { describe, expect, test } from "bun:test";
import { diffLineColor, diffStats, parseDiffLines } from "../src/tui/diff";

const colors = { accent: "cyan", warning: "yellow", error: "red" };

const SAMPLE = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " context",
  "-old",
  "+new",
  "+extra",
  "\\ No newline at end of file",
].join("\n") + "\n";

describe("parseDiffLines (#64 diff viewer)", () => {
  test("classifica meta/hunk/context/remove/add preservando o texto cru", () => {
    const lines = parseDiffLines(SAMPLE);
    expect(lines.map((line) => line.type)).toEqual([
      "meta", "meta", "meta", "meta", "hunk", "context", "remove", "add", "add", "meta",
    ]);
    expect(lines.map((line) => line.text)).toEqual([
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,4 @@",
      " context",
      "-old",
      "+new",
      "+extra",
      "\\ No newline at end of file",
    ]);
  });

  test("aceita CRLF e descarta a linha vazia final do artefato de \\n", () => {
    const crlf = SAMPLE.replace(/\n/g, "\r\n");
    expect(parseDiffLines(crlf)).toEqual(parseDiffLines(SAMPLE));
    expect(parseDiffLines("@@ -1 +1 @@\n-old\n+new")).toHaveLength(3); // sem \\n final não perde linha
  });

  test("linha de contexto vazia vira espaço para não colapsar no render", () => {
    const lines = parseDiffLines("@@ -1,2 +1,2 @@\n \n-old\n+new\n");
    expect(lines[1]).toEqual({ type: "context", text: " " });
  });

  test("linhas antes do primeiro hunk são meta, mesmo vazias", () => {
    const lines = parseDiffLines("diff --git a/x b/x\n\n@@ -1 +1 @@\n-a\n+b\n");
    expect(lines[1]).toEqual({ type: "meta", text: "" });
  });

  test("diff multi-arquivo: 'diff --git' reseta o hunk e não infla as estatísticas", () => {
    const multi = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/y.ts b/y.ts",
      "--- a/y.ts",
      "+++ b/y.ts",
      "@@ -1 +1 @@",
      "-c",
      "+d",
    ].join("\n") + "\n";
    const lines = parseDiffLines(multi);
    expect(lines.map((line) => line.type)).toEqual([
      "meta", "meta", "meta", "hunk", "remove", "add",
      "meta", "meta", "meta", "hunk", "remove", "add",
    ]);
    expect(diffStats(lines)).toEqual({ adds: 2, removes: 2 });
  });
});

describe("diffStats (#64)", () => {
  test("conta adições e remoções", () => {
    expect(diffStats(parseDiffLines(SAMPLE))).toEqual({ adds: 2, removes: 1 });
    expect(diffStats(parseDiffLines("@@ -1 +1 @@\n-a\n+b\n"))).toEqual({ adds: 1, removes: 1 });
  });
});

describe("diffLineColor (#64)", () => {
  test("add verde, remove usa a cor de erro do tema, hunk usa o accent, resto sem cor", () => {
    const lines = parseDiffLines(SAMPLE);
    const byText = new Map(lines.map((line) => [line.text, line]));
    expect(diffLineColor(byText.get("+new")!, colors)).toBe("green");
    expect(diffLineColor(byText.get("-old")!, colors)).toBe(colors.error);
    expect(diffLineColor(byText.get("@@ -1,3 +1,4 @@")!, colors)).toBe(colors.accent);
    expect(diffLineColor(byText.get(" context")!, colors)).toBeUndefined();
    expect(diffLineColor(byText.get("diff --git a/src/a.ts b/src/a.ts")!, colors)).toBeUndefined();
  });
});
