import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig, ConfigError } from "../src/config";
import { Auditor } from "../src/audit";
import { Ledger } from "../src/ledger";
import { assertWithinQuota, quotaAvailable, quotaStatus, QuotaExceededError } from "../src/quota";
import type { CompletionResponse, Provider } from "../src/provider/types";
import type { ModelEntry } from "../src/registry";
import { runSession, type SessionOptions } from "../src/session";
import { ToolExecutor } from "../src/tools/executor";
import { ProviderError } from "../src/provider/types";

const baseConfig = {
  providers: { openai: { kind: "openai-compat" as const, baseUrl: "http://localhost", credentialRef: "OPENAI_API_KEY" } },
  models: [{ provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000 }],
  agent: { model: "openai/gpt-4o-mini", maxSteps: 5, tools: ["read_file"] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
};

describe("config quota (F6-3)", () => {
  test("quota válida por domínio", () => {
    const raw = { ...structuredClone(baseConfig), quota: { nvidia: { dailyTokens: 1000, monthlyCostUsd: 5 } } };
    const cfg = validateConfig(raw);
    expect(cfg.quota!.nvidia!.dailyTokens).toBe(1000);
    expect(cfg.quota!.nvidia!.monthlyCostUsd).toBe(5);
  });

  test("limite sem campos → ConfigError", () => {
    const raw = { ...structuredClone(baseConfig), quota: { nvidia: {} } };
    expect(() => validateConfig(raw)).toThrow(/dailyTokens ou monthlyCostUsd/);
  });

  test("dailyTokens inválido → ConfigError", () => {
    const raw = { ...structuredClone(baseConfig), quota: { nvidia: { dailyTokens: -1 } } };
    expect(() => validateConfig(raw)).toThrow(ConfigError);
  });

  test("domínio vazio → ConfigError", () => {
    const raw = { ...structuredClone(baseConfig), quota: { " ": { dailyTokens: 1 } } };
    expect(() => validateConfig(raw)).toThrow(ConfigError);
  });

  test("sem seção quota → undefined", () => {
    expect(validateConfig(structuredClone(baseConfig)).quota).toBeUndefined();
  });
});

describe("assertWithinQuota (F6-3)", () => {
  // now fixo é ok aqui: nenhum registro no ledger para comparar
  const emptyNow = new Date("2026-10-23T12:00:00Z");

  test("domínio sem limite passa direto", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-quota-"));
    const ledger = new Ledger(join(dir, "ledger.jsonl"), { warn: () => {} });
    expect(() => assertWithinQuota(ledger, {}, "default", emptyNow)).not.toThrow();
  });

  test("abaixo do limite passa", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-quota-"));
    const ledger = new Ledger(join(dir, "ledger.jsonl"), { warn: () => {} });
    const entry = ledger.record(
      { run: "r", agent: "a", provider: "p", model: "m", credentialRef: "K", quotaDomain: "d", tokensIn: 40, tokensOut: 10 },
      undefined,
    );
    // now derivado do ts gravado: imune a virada de meia-noite entre record e assert
    const now = new Date(entry.ts);
    expect(() => assertWithinQuota(ledger, { d: { dailyTokens: 100 } }, "d", now)).not.toThrow();
  });

  test("tokens de hoje no limite → QuotaExceededError hard_quota", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-quota-"));
    const ledger = new Ledger(join(dir, "ledger.jsonl"), { warn: () => {} });
    const entry = ledger.record(
      { run: "r", agent: "a", provider: "p", model: "m", credentialRef: "K", quotaDomain: "d", tokensIn: 60, tokensOut: 40 },
      undefined,
    );
    const now = new Date(entry.ts);
    const err = capture(() => assertWithinQuota(ledger, { d: { dailyTokens: 100 } }, "d", now));
    expect(err).toBeInstanceOf(QuotaExceededError);
    expect(err.errClass).toBe("hard_quota");
    expect(err.message).toContain("limite diário");
    expect(err.message).toContain("100");
  });

  test("uso de outro domínio é ignorado", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-quota-"));
    const ledger = new Ledger(join(dir, "ledger.jsonl"), { warn: () => {} });
    const entry = ledger.record(
      { run: "r", agent: "a", provider: "p", model: "m", credentialRef: "K", quotaDomain: "outro", tokensIn: 9999, tokensOut: 0 },
      undefined,
    );
    const now = new Date(entry.ts);
    expect(() => assertWithinQuota(ledger, { d: { dailyTokens: 100 } }, "d", now)).not.toThrow();
  });

  test("custo do mês no limite bloqueia", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-quota-"));
    const ledger = new Ledger(join(dir, "ledger.jsonl"), { warn: () => {} });
    const entry = ledger.record(
      { run: "r", agent: "a", provider: "p", model: "m", credentialRef: "K", quotaDomain: "d", tokensIn: 1, tokensOut: 1 },
      { inputPerM: 500_000, outputPerM: 0, fonte: "t", verificado: true }, // 1 token in = US$ 0.5
    );
    const now = new Date(entry.ts);
    const err = capture(() => assertWithinQuota(ledger, { d: { monthlyCostUsd: 0.5 } }, "d", now));
    expect(err).toBeInstanceOf(QuotaExceededError);
    expect(err.message).toContain("limite mensal");
  });
});

describe("quotaStatus (F6-3, #64)", () => {
  const make = (): Ledger => new Ledger(
    join(mkdtempSync(join(tmpdir(), "astro-quota-status-")), "ledger.jsonl"),
    { warn: () => {} },
  );
  const usage = (
    ledger: Ledger,
    domain: string,
    tokensIn: number,
    tokensOut: number,
    price?: { inputPerM: number; outputPerM: number; fonte: string; verificado: boolean },
  ): Date => {
    const entry = ledger.record(
      { run: "r", agent: "a", provider: "p", model: "m", credentialRef: "K", quotaDomain: domain, tokensIn, tokensOut },
      price,
    );
    return new Date(entry.ts);
  };

  test("domínio sem limite devolve undefined", () => {
    const ledger = make();
    expect(quotaStatus(ledger, {}, "d")).toBeUndefined();
    expect(quotaStatus(ledger, { outro: { dailyTokens: 1 } }, "d")).toBeUndefined();
  });

  test("tokens do dia: uso, razão e aviso a partir de 80%", () => {
    const ledger = make();
    let now = usage(ledger, "d", 40, 10);
    expect(quotaStatus(ledger, { d: { dailyTokens: 100 } }, "d", now)).toMatchObject({
      quotaDomain: "d", warnAt: 0.8, warning: false, exhausted: false,
      dailyTokens: { used: 50, limit: 100, ratio: 0.5 },
    });
    now = usage(ledger, "d", 20, 10); // +30 → 80
    expect(quotaStatus(ledger, { d: { dailyTokens: 100 } }, "d", now)).toMatchObject({
      warning: true, exhausted: false, dailyTokens: { used: 80, ratio: 0.8 },
    });
  });

  test("no limite fica esgotado (e em aviso)", () => {
    const ledger = make();
    const now = usage(ledger, "d", 60, 40);
    expect(quotaStatus(ledger, { d: { dailyTokens: 100 } }, "d", now)).toMatchObject({
      warning: true, exhausted: true, dailyTokens: { used: 100, ratio: 1 },
    });
  });

  test("custo do mês conta na janela e ignora outros domínios", () => {
    const ledger = make();
    const price = { inputPerM: 500_000, outputPerM: 0, fonte: "t", verificado: true };
    const now = usage(ledger, "d", 1, 0, price); // US$ 0.5
    usage(ledger, "outro", 9999, 0);
    expect(quotaStatus(ledger, { d: { monthlyCostUsd: 1 } }, "d", now)).toMatchObject({
      warning: false, exhausted: false, monthlyCostUsd: { used: 0.5, limit: 1, ratio: 0.5 },
    });
    expect(quotaStatus(ledger, { d: { monthlyCostUsd: 0.4 } }, "d", now)).toMatchObject({
      warning: true, exhausted: true,
    });
  });

  test("limite zero conta como esgotado e quotaAvailable concorda", () => {
    const ledger = make();
    const now = usage(ledger, "d", 1, 0);
    expect(quotaStatus(ledger, { d: { dailyTokens: 0 } }, "d", now)).toMatchObject({
      exhausted: true, dailyTokens: { ratio: 1 },
    });
    expect(quotaAvailable(ledger, { d: { dailyTokens: 0 } }, "d", now)).toBe(false);
    expect(quotaAvailable(ledger, { d: { dailyTokens: 10 } }, "d", now)).toBe(true);
  });
});

function capture(fn: () => void): QuotaExceededError {
  try {
    fn();
    throw new Error("esperava QuotaExceededError");
  } catch (error) {
    if (error instanceof QuotaExceededError) return error;
    throw error;
  }
}

describe("sessão com quota (F6-3)", () => {
  const model: ModelEntry = {
    provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000, status: "active",
  };
  const resp = (p: Partial<CompletionResponse>): CompletionResponse => ({
    content: "", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, ...p,
  });

  test("quota excedida bloqueia o provider ANTES da chamada", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-quota-s-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const ledger = new Ledger(join(cwd, "ledger.jsonl"), { warn: () => {} });
    // pré-carrega uso de hoje no limite
    ledger.record(
      { run: "old", agent: "a", provider: "p", model: "m", credentialRef: "K", quotaDomain: "d", tokensIn: 100, tokensOut: 0 },
      undefined,
    );

    let calls = 0;
    const provider: Provider = { complete: async () => { calls++; return resp({ content: "x" }); } };
    const opts: SessionOptions = {
      run: "r1", agent: "a", credentialRef: "K", quotaDomain: "d",
      cwd, provider, model,
      executor: new ToolExecutor({ tools: [], allow: [], audit }),
      ledger, audit, maxSteps: 3,
      quotaLimits: { d: { dailyTokens: 100 } },
    };

    const err = await runSession(opts, "tarefa").then(() => null, (e) => e);
    expect(err).toBeInstanceOf(QuotaExceededError);
    expect(calls).toBe(0); // provider nunca chamado
  });

  test("abaixo do limite: sessão roda normal", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-quota-s-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const ledger = new Ledger(join(cwd, "ledger.jsonl"), { warn: () => {} });
    const provider: Provider = { complete: async () => resp({ content: "ok" }) };
    const opts: SessionOptions = {
      run: "r1", agent: "a", credentialRef: "K", quotaDomain: "d",
      cwd, provider, model,
      executor: new ToolExecutor({ tools: [], allow: [], audit }),
      ledger, audit, maxSteps: 3,
      quotaLimits: { d: { dailyTokens: 1000 } },
    };
    const result = await runSession(opts, "tarefa");
    expect(result.final).toBe("ok");
  });

  test("QuotaExceededError é ProviderError (taxonomia D-18)", () => {
    const err = new QuotaExceededError("x");
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.errClass).toBe("hard_quota");
  });
});