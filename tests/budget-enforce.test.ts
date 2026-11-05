import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { runTask } from "../src/app";
import { BudgetExceededError, effectiveBudget, enforceBudget } from "../src/budget";
import type { BudgetConfig } from "../src/config";
import { Ledger } from "../src/ledger";

function ledgerWith(costUsd: number | null): Ledger {
  const dir = mkdtempSync(join(tmpdir(), "astro-budget-enf-"));
  const path = join(dir, "ledger.jsonl");
  appendFileSync(path, `${JSON.stringify({
    schemaVersion: 1, ts: new Date().toISOString(), run: "r1", agent: "a", provider: "p", model: "m",
    credentialRef: "K", quotaDomain: "default", tokensIn: 1, tokensOut: 1, costUsd, kind: "usage", seq: 1,
  })}\n`);
  return new Ledger(path);
}

const budget = (extra: Partial<BudgetConfig> = {}): BudgetConfig =>
  ({ scope: "day", limitUsd: 1, warnAt: 0.8, onExceed: "ask", ...extra });

function base(ledger: Ledger, extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "astro-budget-enf-audit-"));
  return {
    budget: budget(), ledger, run: "r1", agent: "coder",
    audit: new Auditor(join(dir, "audit.jsonl")), ...extra,
  };
}

describe("enforcement de budget (F-05, #132 parte 3)", () => {
  test("sem TTY: não bloqueia esperando input, grava non_interactive e para", async () => {
    const ledger = ledgerWith(2);
    const opts = base(ledger);
    await expect(enforceBudget(opts)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(ledger.readAllEntries().some((e) => e.kind === "budget" && e.event === "non_interactive"
      && e.budget_exceeded_non_interactive === true)).toBe(true);
    expect(opts.audit.readAll().some((e) => e.tipo === "budget.exceeded")).toBe(true);
  });

  test("onExceed stop para sem perguntar e registra a escolha", async () => {
    const ledger = ledgerWith(2);
    const error = await enforceBudget(base(ledger, { budget: budget({ onExceed: "stop" }) })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect((error as BudgetExceededError).reason).toBe("limit");
    expect(ledger.readAllEntries().some((e) => e.kind === "budget" && e.event === "exceeded" && e.exceeded_choice === "stop")).toBe(true);
  });

  test("decisor registra continue/lower e para no stop", async () => {
    for (const choice of ["continue_same", "lower_effort"] as const) {
      const ledger = ledgerWith(2);
      await expect(enforceBudget(base(ledger, { decide: () => choice }))).resolves.toBe(choice);
      expect(ledger.readAllEntries().some((e) => e.kind === "budget" && e.exceeded_choice === choice)).toBe(true);
    }
    await expect(enforceBudget(base(ledgerWith(2), { decide: () => "stop" }))).rejects.toBeInstanceOf(BudgetExceededError);
  });

  test("hardCeilingUsd para mesmo com continue e registra ceiling_hit", async () => {
    const ledger = ledgerWith(2);
    const opts = base(ledger, { decide: () => "continue_same", budget: budget({ limitUsd: 10, hardCeilingUsd: 1 }) });
    const error = await enforceBudget(opts).catch((e: unknown) => e);
    expect((error as BudgetExceededError).reason).toBe("ceiling");
    expect(ledger.readAllEntries().some((e) => e.kind === "budget" && e.event === "ceiling_hit")).toBe(true);
    expect(opts.audit.readAll().some((e) => e.tipo === "budget.ceiling_hit")).toBe(true);
  });
});

describe("aumento de budget com aprovação (D-30, #372)", () => {
  test("raise aplica os novos valores e o próximo check continua", async () => {
    const ledger = ledgerWith(2);
    const cfg = budget({ limitUsd: 1, hardCeilingUsd: 10 });
    const opts = base(ledger, { budget: cfg, decide: () => ({ choice: "raise" as const, limitUsd: 3 }) });
    await expect(enforceBudget(opts)).resolves.toEqual({ choice: "raise", limitUsd: 3 });
    expect(cfg.limitUsd).toBe(3);
    await expect(enforceBudget({ ...opts, decide: undefined })).resolves.toBe("continue_same");
    const raised = ledger.readAllEntries().find((e) => e.kind === "budget" && e.event === "raised") as
      { old_limit_usd?: number; new_limit_usd?: number } | undefined;
    expect(raised?.old_limit_usd).toBe(1);
    expect(raised?.new_limit_usd).toBe(3);
    expect(opts.audit.readAll().some((e) => e.tipo === "budget.raised")).toBe(true);
  });

  test("raise inválido (<= gasto ou <= limite antigo) fica esgotado", async () => {
    for (const limitUsd of [2, 1] as const) {
      const ledger = ledgerWith(2);
      const cfg = budget({ limitUsd: 1, hardCeilingUsd: 10 });
      const opts = base(ledger, { budget: cfg, decide: () => ({ choice: "raise" as const, limitUsd }) });
      const error = await enforceBudget(opts).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BudgetExceededError);
      expect((error as BudgetExceededError).reason).toBe("limit");
      expect(cfg.limitUsd).toBe(1);
      expect(ledger.readAllEntries().some((e) => e.kind === "budget" && e.event === "raised")).toBe(false);
      expect(opts.audit.readAll().some((e) => e.tipo === "budget.raise_denied")).toBe(true);
    }
  });

  test("limite acima do teto sem elevar o teto é negado", async () => {
    const ledger = ledgerWith(2);
    const cfg = budget({ limitUsd: 1, hardCeilingUsd: 3 });
    const opts = base(ledger, { budget: cfg, decide: () => ({ choice: "raise" as const, limitUsd: 5 }) });
    await expect(enforceBudget(opts)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(cfg.limitUsd).toBe(1);
    expect(opts.audit.readAll().some((e) => e.tipo === "budget.raise_denied"
      && (e.payload as { reason?: string }).reason === "ceiling_required")).toBe(true);
  });

  test("elevar o teto exige o novo teto e ele é aplicado", async () => {
    const ledger = ledgerWith(2);
    const cfg = budget({ limitUsd: 1, hardCeilingUsd: 3 });
    const opts = base(ledger, { budget: cfg, decide: () => ({ choice: "raise" as const, limitUsd: 5, hardCeilingUsd: 8, confirmedCeiling: true }) });
    await expect(enforceBudget(opts)).resolves.toEqual({ choice: "raise", limitUsd: 5, hardCeilingUsd: 8, confirmedCeiling: true });
    expect(cfg.hardCeilingUsd).toBe(8);
    const raised = ledger.readAllEntries().find((e) => e.kind === "budget" && e.event === "raised") as
      { old_ceiling_usd?: number; new_ceiling_usd?: number } | undefined;
    expect(raised?.old_ceiling_usd).toBe(3);
    expect(raised?.new_ceiling_usd).toBe(8);
  });

  test("novo teto que não sobe é negado", async () => {
    const ledger = ledgerWith(2);
    const cfg = budget({ limitUsd: 1, hardCeilingUsd: 3 });
    const opts = base(ledger, { budget: cfg, decide: () => ({ choice: "raise" as const, limitUsd: 2, hardCeilingUsd: 3 }) });
    await expect(enforceBudget(opts)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(cfg.hardCeilingUsd).toBe(3);
  });

  test("teto novo sem a segunda confirmação é negado", async () => {
    const ledger = ledgerWith(2);
    const cfg = budget({ limitUsd: 1, hardCeilingUsd: 3 });
    const opts = base(ledger, { budget: cfg, decide: () => ({ choice: "raise" as const, limitUsd: 5, hardCeilingUsd: 8 }) });
    await expect(enforceBudget(opts)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(cfg.hardCeilingUsd).toBe(3);
    expect(opts.audit.readAll().some((e) => e.tipo === "budget.raise_denied"
      && (e.payload as { reason?: string }).reason === "ceiling_not_confirmed")).toBe(true);
  });

  test("effectiveBudget aplica o último raise do run e ignora outros (#389)", () => {
    const ledger = ledgerWith(0);
    ledger.recordBudgetRaised({ run: "r1", agent: "a", old_limit_usd: 1, new_limit_usd: 5 });
    ledger.recordBudgetRaised({ run: "r2", agent: "a", old_limit_usd: 1, new_limit_usd: 9 });
    ledger.recordBudgetRaised({ run: "r1", agent: "a", old_limit_usd: 5, new_limit_usd: 7,
      old_ceiling_usd: 3, new_ceiling_usd: 8 });
    const cfg = budget({ limitUsd: 1, hardCeilingUsd: 3 });
    const eff = effectiveBudget(cfg, ledger, "r1");
    expect(eff.limitUsd).toBe(7);
    expect(eff.hardCeilingUsd).toBe(8);
    expect(cfg.limitUsd).toBe(1); // não muta o config
    expect(effectiveBudget(cfg, ledger, "r3").limitUsd).toBe(1);
  });

  test("effectiveBudget não remove o teto quando o raise só sobe o limite (#389)", () => {
    const ledger = ledgerWith(0);
    ledger.recordBudgetRaised({ run: "r1", agent: "a", old_limit_usd: 1, new_limit_usd: 5 });
    const cfg = budget({ limitUsd: 1, hardCeilingUsd: 3 });
    expect(effectiveBudget(cfg, ledger, "r1").hardCeilingUsd).toBe(3);
  });
});

interface RunOpts { usage?: number; priced?: boolean; final?: boolean; tool?: string; agents?: boolean; maxSteps?: number; finalAfter?: number }

/** Run com provider sintético: tool call (ou resposta final) e custo `usage` por chamada. */
async function runWithBudget(budgetCfg: Record<string, unknown>, opts: RunOpts = {}) {
  const { usage = 1000, priced = true, final = false, tool = "ghost", agents = false, maxSteps = 4, finalAfter } = opts;
  const cwd = mkdtempSync(join(tmpdir(), "astro-budget-enf-run-"));
  let calls = 0;
  const server = Bun.serve({ port: 0, async fetch() {
    calls++;
    const last = final || (finalAfter !== undefined && calls > finalAfter);
    const message = last
      ? { content: "fim", tool_calls: [] }
      : { content: "", tool_calls: [{ id: `c${calls}`, type: "function", function: { name: tool,
        arguments: tool === "handoff"
          ? JSON.stringify({ to: "coder", task: "t", objective: "o", decisions: [], constraints: [], next_steps: [] })
          : "{}" } }] };
    return Response.json({ choices: [{ message }], usage: { prompt_tokens: usage, completion_tokens: 0 } });
  } });
  const configPath = join(cwd, "astro.config.json");
  writeFileSync(configPath, JSON.stringify({
    providers: {
      p: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" },
      backup: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "BACKUP_KEY" },
    },
    models: [{ provider: "p", id: "m", tags: ["writing-code"], context: 8192,
      ...(priced ? { price: { inputPerM: 1000, outputPerM: 1000, fonte: "t", verificado: false } } : {}) }],
    agent: { model: "p/m", maxSteps, tools: agents ? ["handoff"] : [] },
    ...(agents ? { agents: {
      planner: { model: "p/m", maxSteps: 2, tools: ["handoff"] },
      coder: { model: "p/m", maxSteps: 2, tools: [] },
    } } : {}),
    budget: budgetCfg,
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }, null, 2));
  return { cwd, configPath, calls: () => calls, stop: () => server.stop(true) };
}

describe("corte de budget no run (F-05, #132 parte 3)", () => {
  test("não-interativo: para com checkpoint e resume re-aplica o enforcement", async () => {
    const { cwd, configPath, calls, stop } = await runWithBudget({ scope: "day", limitUsd: 9 });
    try {
      await expect(runTask({ configPath, task: "x", cwd, env: { KEY: "k" } })).rejects.toThrow(/budget esgotado/);
      expect(calls()).toBe(1);
      const ledger = new Ledger(join(cwd, ".astro", "ledger.jsonl"));
      expect(ledger.readStates().find((s) => s.state === "interrupted")?.reason).toBe("budget_exceeded");
      expect(ledger.readAllEntries().some((e) => e.kind === "budget" && e.event === "non_interactive")).toBe(true);
      await expect(runTask({ configPath, task: "x", cwd, env: { KEY: "k" }, resume: ledger.readStates()[0]!.run,
        onBudgetExceeded: () => "continue_same" })).rejects.toThrow(/excedeu 4 passos/);
      expect(calls()).toBeGreaterThan(1);
    } finally {
      stop();
    }
  });

  test("parada por budget com handoff recebido não invalida a retomada (I-19)", async () => {
    const { cwd, configPath, stop } = await runWithBudget({ scope: "day", limitUsd: 9 }, { tool: "handoff", agents: true });
    try {
      await expect(runTask({ configPath, task: "x", cwd, env: { KEY: "k" } })).rejects.toThrow(/budget esgotado/);
      const ledger = new Ledger(join(cwd, ".astro", "ledger.jsonl"));
      expect(ledger.readAllEntries().some((e) => (e as { kind: string }).kind === "handoff.failed")).toBe(false);
      expect(ledger.readStates().some((s) => s.state === "interrupted" && s.reason === "budget_exceeded")).toBe(true);
    } finally {
      stop();
    }
  });

  test("TTY: continue_same segue até o teto; lower_effort reduz os restantes", async () => {
    for (const [choice, expected] of [["continue_same", 4], ["lower_effort", 3]] as const) {
      const { cwd, configPath, calls, stop } = await runWithBudget({ scope: "day", limitUsd: 9 });
      try {
        await expect(runTask({ configPath, task: "x", cwd, env: { KEY: "k" },
          onBudgetExceeded: () => choice })).rejects.toBeDefined();
        expect(calls()).toBe(expected);
      } finally {
        stop();
      }
    }
  });

  test("ceiling cruzado no último step também para e registra o evento", async () => {
    const { cwd, configPath, stop } = await runWithBudget({ scope: "day", limitUsd: 50, hardCeilingUsd: 9 }, { final: true, usage: 10000 });
    try {
      await expect(runTask({ configPath, task: "x", cwd, env: { KEY: "k" }, onBudgetExceeded: () => "continue_same" }))
        .rejects.toThrow(/budget esgotado \(ceiling\)/);
      expect(new Ledger(join(cwd, ".astro", "ledger.jsonl")).readAllEntries()
        .some((e) => e.kind === "budget" && e.event === "ceiling_hit")).toBe(true);
    } finally {
      stop();
    }
  });

  test("ceiling no último step do multi também para (I-17)", async () => {
    const { cwd, configPath, stop } = await runWithBudget({ scope: "day", limitUsd: 50, hardCeilingUsd: 9 }, { final: true, agents: true, usage: 10000 });
    try {
      await expect(runTask({ configPath, task: "x", cwd, env: { KEY: "k" }, onBudgetExceeded: () => "continue_same" }))
        .rejects.toThrow(/budget esgotado \(ceiling\)/);
      expect(new Ledger(join(cwd, ".astro", "ledger.jsonl")).readStates()
        .find((s) => s.state === "interrupted")?.reason).toBe("budget_exceeded");
    } finally {
      stop();
    }
  });

  test("preço desconhecido com ceiling para após o uso (B6/I-17)", async () => {
    const { cwd, configPath, calls, stop } = await runWithBudget(
      { scope: "day", limitUsd: 10, hardCeilingUsd: 1 }, { usage: 10, priced: false, final: true });
    try {
      await expect(runTask({ configPath, task: "x", cwd, env: { KEY: "k" }, onBudgetExceeded: () => "continue_same" }))
        .rejects.toThrow(/budget esgotado \(unknown_price\)/);
      expect(calls()).toBe(1);
      expect(new Auditor(join(cwd, ".astro", "audit.jsonl")).readAll()
        .some((e) => e.tipo === "budget.exceeded" && (e.payload as { reason?: string }).reason === "unknown_price")).toBe(true);
    } finally {
      stop();
    }
  });

  test("TTY: raise aplica o novo limite e o run continua (D-30, #372)", async () => {
    const { cwd, configPath, calls, stop } = await runWithBudget({ scope: "day", limitUsd: 2 });
    let raised = false;
    try {
      await expect(runTask({ configPath, task: "x", cwd, env: { KEY: "k" }, onBudgetExceeded: () => {
        if (raised) return "stop";
        raised = true;
        return { choice: "raise", limitUsd: 15 };
      } })).rejects.toThrow(/excedeu 4 passos/);
      expect(calls()).toBe(4);
      const ledger = new Ledger(join(cwd, ".astro", "ledger.jsonl"));
      expect(ledger.readAllEntries().some((e) => e.kind === "budget" && e.event === "raised"
        && e.old_limit_usd === 2 && e.new_limit_usd === 15)).toBe(true);
    } finally {
      stop();
    }
  });

  test("teto elevado vale nos steps seguintes (D-30, #372)", async () => {
    const { cwd, configPath, calls, stop } = await runWithBudget(
      { scope: "day", limitUsd: 2, hardCeilingUsd: 15 }, { usage: 3000, maxSteps: 12 });
    let raised = false;
    try {
      await expect(runTask({ configPath, task: "x", cwd, env: { KEY: "k" }, onBudgetExceeded: () => {
        if (raised) return "stop";
        raised = true;
        return { choice: "raise", limitUsd: 30, hardCeilingUsd: 40, confirmedCeiling: true };
      } })).rejects.toThrow(/budget esgotado \(limit\)/);
      const entries = new Ledger(join(cwd, ".astro", "ledger.jsonl")).readAllEntries();
      expect(entries.some((e) => e.kind === "budget" && e.event === "ceiling_hit")).toBe(false);
      expect(entries.some((e) => e.kind === "budget" && e.event === "raised" && e.new_ceiling_usd === 40)).toBe(true);
      expect(calls()).toBe(8);
    } finally {
      stop();
    }
  });

  test("relatório usa o limite elevado do run (#389)", async () => {
    const { cwd, configPath, stop } = await runWithBudget({ scope: "day", limitUsd: 2 }, { finalAfter: 1 });
    let raised = false;
    try {
      const report = await runTask({ configPath, task: "x", cwd, env: { KEY: "k" }, onBudgetExceeded: () => {
        if (raised) return "stop";
        raised = true;
        return { choice: "raise", limitUsd: 30 };
      } });
      expect(report.budget?.limitUsd).toBe(30);
    } finally {
      stop();
    }
  });
});
