import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCheckpoint, budgetCheckpointDue, ProgressTracker, turnCheckpointDue } from "../src/loop-guard";

describe("turnCheckpointDue (L5, #135)", () => {
  test("80% de 100 turnos: due no turno 80, não no 79", () => {
    expect(turnCheckpointDue(80, 100, 0.8)).toBe(true);
    expect(turnCheckpointDue(79, 100, 0.8)).toBe(false);
  });

  test("limite fracionário arredonda para cima (9 turnos × 0.8 = 7.2 → due no 8)", () => {
    expect(turnCheckpointDue(8, 9, 0.8)).toBe(true);
    expect(turnCheckpointDue(7, 9, 0.8)).toBe(false);
  });
});

describe("budgetCheckpointDue (L5, #135)", () => {
  test("80% de $100: due a partir de $80 gastos", () => {
    expect(budgetCheckpointDue(80, 100, 0.8)).toBe(true);
    expect(budgetCheckpointDue(79.99, 100, 0.8)).toBe(false);
  });
});

describe("buildCheckpoint (L5, I-03/I-11, #135)", () => {
  test("sanitiza segredo no resumo e filtra arquivos fora do cwd", () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-checkpoint-"));
    const fakeKey = ["s", "k", "-"].join("") + "live-abcdef123456";
    const cp = buildCheckpoint(
      {
        summary: `usei a chave ${fakeKey} no teste`,
        changedFiles: ["src/a.ts", "../fora.ts", join(cwd, "..", "..", "etc", "passwd")],
        nextStep: "rodar bun test",
      },
      cwd,
      new Date("2026-11-01T12:00:00Z"),
    );
    expect(cp.schema).toBe("checkpoint/v1");
    expect(cp.summary).not.toContain(fakeKey); // I-03: segredo nunca no checkpoint
    expect(cp.summary).toContain("[REDACTED]");
    expect(cp.changedFiles).toEqual([join("src", "a.ts")]); // I-11: só caminhos dentro do cwd
    expect(cp.nextStep).toBe("rodar bun test");
    expect(cp.createdAt).toBe("2026-11-01T12:00:00.000Z");
  });

  test("arquivo dentro do cwd via caminho absoluto é mantido como relativo", () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-checkpoint-"));
    const cp = buildCheckpoint(
      { summary: "s", changedFiles: [join(cwd, "src", "b.ts")], nextStep: "n" },
      cwd,
      new Date("2026-11-01T12:00:00Z"),
    );
    expect(cp.changedFiles).toEqual([join("src", "b.ts")]);
  });
});

describe("ProgressTracker (L6, #135)", () => {
  test("3 segmentos seguidos com o mesmo hash → sem progresso (pausa)", () => {
    const tracker = new ProgressTracker(3);
    expect(tracker.record("aaa")).toBe(false);
    expect(tracker.record("aaa")).toBe(false);
    expect(tracker.record("aaa")).toBe(true);
  });

  test("hash diferente reseta a contagem", () => {
    const tracker = new ProgressTracker(3);
    tracker.record("aaa");
    tracker.record("aaa");
    expect(tracker.record("bbb")).toBe(false);
    expect(tracker.record("bbb")).toBe(false);
    expect(tracker.record("bbb")).toBe(true);
  });
});
