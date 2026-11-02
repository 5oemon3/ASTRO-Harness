import { describe, expect, test } from "bun:test";
import { createApprovalBridge } from "../src/tui/approvals";
import type { SwapRequest } from "../src/approval";
import type { BudgetStatus } from "../src/budget";

const swap: SwapRequest = {
  run: "r1", from: { provider: "a", model: "m1" }, to: { provider: "b", model: "m2" },
  reason: "fallback", costDeltaUsd: 1,
};
const budget = { limitUsd: 1, estimate: "US$ 2.000000" } as BudgetStatus;

describe("ponte de aprovação da TUI (T2, #63)", () => {
  test("swap publica a pergunta e aprova só com s/sim", async () => {
    const bridge = createApprovalBridge();
    const seen: Array<string | undefined> = [];
    bridge.subscribe((question) => seen.push(question?.text));
    const decision = bridge.approveSwap(swap);
    expect(seen.at(-1)).toContain("aprovar? [s/N]");
    expect(bridge.current()?.text).toContain("a/m1 -> b/m2");
    bridge.answer("s");
    expect(await decision).toBe(true);
    expect(bridge.current()).toBeUndefined();
    expect(seen.at(-1)).toBeUndefined();
  });

  test("resposta vazia nega; budget mapeia tokens exatos", async () => {
    const bridge = createApprovalBridge();
    const denied = bridge.approveSwap(swap);
    bridge.answer("");
    expect(await denied).toBe(false);

    const chose = createApprovalBridge();
    const lower = chose.onBudgetExceeded(budget);
    chose.answer("l");
    expect(await lower).toBe("lower_effort");

    const stopping = createApprovalBridge();
    const stop = stopping.onBudgetExceeded(budget);
    stopping.answer("p");
    expect(await stop).toBe("stop");

    const odd = createApprovalBridge();
    const cancelled = odd.onBudgetExceeded(budget);
    odd.answer("cancelar");
    expect(await cancelled).toBe("stop");
  });

  test("approveTool publica a pergunta na TUI e mapeia as 4 opções (#265)", async () => {
    const req = { name: "write_file", action: "edit" as const, mode: "ask" as const };
    const bridge = createApprovalBridge();
    const seen: Array<string | undefined> = [];
    bridge.subscribe((question) => seen.push(question?.text));
    const decision = bridge.approveTool(req);
    expect(seen.at(-1)).toContain("write_file");
    expect(seen.at(-1)).toMatch(/\[s\].*\[n\].*\[S\].*\[o\]/);
    expect(bridge.current()?.text).toBe(seen.at(-1));
    bridge.answer("S");
    expect(await decision).toBe("session");
    expect(bridge.current()).toBeUndefined();

    const once = createApprovalBridge();
    const dOnce = once.approveTool(req);
    once.answer("o");
    expect(await dOnce).toBe("once");

    const yes = createApprovalBridge();
    const dYes = yes.approveTool(req);
    yes.answer("s");
    expect(await dYes).toBe(true);

    const no = createApprovalBridge();
    const dNo = no.approveTool(req);
    no.answer("n");
    expect(await dNo).toBe(false);
  });

  test("approveTool com diff publica a pergunta com o anexo para o overlay (#64 D2)", async () => {
    const bridge = createApprovalBridge();
    const diff = { path: "a.ts", content: "@@ -1 +1 @@\n-x\n+y\n" };
    const decision = bridge.approveTool({ name: "edit", action: "edit", mode: "ask", diff });
    expect(bridge.current()?.text).toContain("edit");
    expect(bridge.current()?.diff).toEqual(diff);
    bridge.answer("s");
    expect(await decision).toBe(true);
    expect(bridge.current()).toBeUndefined();
  });

  test("askText publica a pergunta crua na TUI e resolve com a resposta (#267)", async () => {
    const bridge = createApprovalBridge();
    const seen: Array<string | undefined> = [];
    bridge.subscribe((question) => seen.push(question?.text));
    const answer = bridge.askText("confiar em /tmp/proj? [s/N] ");
    expect(seen.at(-1)).toContain("/tmp/proj");
    bridge.answer("s");
    expect(await answer).toBe("s");
    expect(bridge.current()).toBeUndefined();
  });
});
