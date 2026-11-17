import { describe, expect, test } from "bun:test";
import { parseLcov } from "../scripts/coverage-gate";

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
