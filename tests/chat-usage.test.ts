import { describe, expect, test } from "bun:test";
import type { BudgetStatus } from "../src/budget";
import { budgetLine, budgetSegment, usageLines } from "../src/chat/usage";
import type { SessionSnapshot } from "../src/chat/agent-session";

const snapshot: SessionSnapshot = {
  id: "s1",
  startedAt: "2026-11-02T10:00:00.000Z",
  model: "p/m1",
  messages: [],
  turns: 3,
  tokensIn: 100,
  tokensOut: 50,
  costUsd: 0.001,
};

function status(over: Partial<BudgetStatus> = {}): BudgetStatus {
  return {
    scope: "day",
    limitUsd: 5,
    spentUsd: 1,
    ratio: 0.2,
    warnAt: 0.8,
    warning: false,
    exhausted: false,
    ceilingHit: false,
    remainingUsd: 4,
    reservedUsd: 0,
    estimate: "US$ 1.000000",
    ...over,
  };
}

describe("usageLines / budgetLine / budgetSegment (#63)", () => {
  test("sem budget mostra só a linha da sessão; custo null vira n/d (B6)", () => {
    expect(usageLines({ ...snapshot, costUsd: null }, undefined)).toEqual([
      "uso da sessão: 3 turno(s) · in 100 / out 50 tokens · custo n/d",
    ]);
    expect(usageLines(snapshot, undefined)).toEqual([
      "uso da sessão: 3 turno(s) · in 100 / out 50 tokens · custo US$ 0.001000",
    ]);
  });

  test("com budget day mostra gasto/limite/pct/restante/aviso", () => {
    expect(usageLines(snapshot, status())).toEqual([
      "uso da sessão: 3 turno(s) · in 100 / out 50 tokens · custo US$ 0.001000",
      "budget day: gasto US$ 1.000000 / limite US$ 5.000000 (20%) · restante US$ 4.000000 · aviso em 80%",
    ]);
  });

  test("budgetLine sinaliza aviso, esgotado e teto; use-as-you-go não tem limite", () => {
    expect(budgetLine(status({ warning: true, ratio: 0.9 }))).toContain("⚠ aviso");
    expect(budgetLine(status({ exhausted: true, ratio: 1, warning: true }))).toContain("ESGOTADO");
    expect(budgetLine(status({ ceilingHit: true, spentUsd: 6, ratio: 1.2, remainingUsd: 0 }))).toContain("TETO ATINGIDO");
    // ordem combinada das flags
    expect(budgetLine(status({ warning: true, exhausted: true, ceilingHit: true, ratio: 1 })))
      .toContain("⚠ aviso · ESGOTADO · TETO ATINGIDO");
    expect(budgetLine(status({ scope: "use-as-you-go", limitUsd: null, ratio: null, remainingUsd: null })))
      .toBe("budget use-as-you-go: gasto US$ 1.000000 (sem limite)");
    // preço desconhecido nunca vira zero
    expect(budgetLine(status({ spentUsd: null, ratio: null, remainingUsd: null }))).toContain("gasto n/d");
  });

  test("budgetSegment é curto para a status bar e usa n/d quando preço falta", () => {
    expect(budgetSegment(status())).toBe("budget: 20% · US$ 1.000000/US$ 5.000000");
    expect(budgetSegment(status({ scope: "use-as-you-go", limitUsd: null, ratio: null, remainingUsd: null })))
      .toBe("budget: gasto US$ 1.000000");
    expect(budgetSegment(status({ limitUsd: null, ratio: null, spentUsd: null, remainingUsd: null })))
      .toBe("budget: gasto n/d");
  });
});
