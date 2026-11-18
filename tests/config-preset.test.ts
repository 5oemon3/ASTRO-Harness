import { describe, expect, test } from "bun:test";
import { ConfigError, effectiveMaxTurns, validateConfig } from "../src/core/config";

/** Config mínima sem `maxSteps`/`maxTurns`: o preset decide (ou o default) os limites. */
function base() {
  return {
    providers: { p: { kind: "openai-compat", baseUrl: "https://p.example/v1", credentialRef: "KEY" } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "p/m1", tools: [] as string[] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  };
}

describe("preset simple/control (#515)", () => {
  test("preset ausente é control e não muda os limites declarados", () => {
    const raw = base() as unknown as Record<string, unknown>;
    (raw.agent as Record<string, unknown>).maxSteps = 3;
    raw.run = { maxTurns: 2 };
    const cfg = validateConfig(raw);
    expect(cfg.preset).toBe("control");
    expect(cfg.agent.maxSteps).toBe(3);
    expect(cfg.run?.maxTurns).toBe(2);
  });

  test("sem limites declarados, os dois presets começam em 500", () => {
    for (const preset of ["simple", "control"] as const) {
      const cfg = validateConfig({ ...base(), preset });
      expect(cfg.agent.maxSteps).toBe(500);
      expect(effectiveMaxTurns(cfg)).toBe(500);
    }
  });

  test("simple fixa 500/500 sem declarar limites", () => {
    const cfg = validateConfig({ ...base(), preset: "simple" });
    expect(cfg.preset).toBe("simple");
    expect(cfg.agent.maxSteps).toBe(500);
    expect(effectiveMaxTurns(cfg)).toBe(500);
  });

  test("simple aceita um teto mais restrito vindo de outra camada", () => {
    const raw = base() as unknown as Record<string, unknown>;
    (raw.agent as Record<string, unknown>).maxSteps = 30;
    raw.run = { maxTurns: 10 };
    const cfg = validateConfig({ ...raw, preset: "simple" });
    expect(cfg.agent.maxSteps).toBe(30);
    expect(effectiveMaxTurns(cfg)).toBe(10);
  });

  test("simple recusa agent.maxSteps acima de 500 citando preset control", () => {
    const raw = base() as unknown as Record<string, unknown>;
    (raw.agent as Record<string, unknown>).maxSteps = 600;
    expect(() => validateConfig({ ...raw, preset: "simple" })).toThrow(ConfigError);
    expect(() => validateConfig({ ...raw, preset: "simple" })).toThrow(/preset.*control/);
  });

  test("simple mantém agents.*.maxSteps restritivo e recusa acima de 500", () => {
    const stricter = base() as unknown as Record<string, unknown>;
    stricter.providers = {
      p: { kind: "openai-compat", baseUrl: "https://p.example/v1", credentialRef: "KEY" },
      q: { kind: "openai-compat", baseUrl: "https://q.example/v1", credentialRef: "KEY2" },
    };
    stricter.models = [
      { provider: "p", id: "m1", tags: ["writing-code"], context: 8192 },
      { provider: "q", id: "m2", tags: ["writing-code"], context: 8192 },
    ];
    stricter.agents = { coder: { model: "q/m2", maxSteps: 30 } };
    const cfg = validateConfig({ ...stricter, preset: "simple" });
    expect(cfg.agents?.coder?.maxSteps).toBe(30);

    const raised = base() as unknown as Record<string, unknown>;
    raised.agents = { coder: { model: "p/m1", maxSteps: 700 } };
    expect(() => validateConfig({ ...raised, preset: "simple" })).toThrow(/preset.*control/);
  });

  test("simple recusa run.maxTurns não numérico ou acima de 500", () => {
    const withTurns = base() as unknown as Record<string, unknown>;
    withTurns.run = { maxTurns: "unlimited" };
    expect(() => validateConfig({ ...withTurns, preset: "simple" })).toThrow(/preset.*control/);

    const raised = base() as unknown as Record<string, unknown>;
    raised.run = { maxTurns: 600 };
    expect(() => validateConfig({ ...raised, preset: "simple" })).toThrow(/preset.*control/);
  });

  test("simple aceita 500 explícito, que é o próprio teto", () => {
    const raw = base() as unknown as Record<string, unknown>;
    (raw.agent as Record<string, unknown>).maxSteps = 500;
    raw.run = { maxTurns: 500 };
    expect(validateConfig({ ...raw, preset: "simple" }).agent.maxSteps).toBe(500);
  });

  test("preset desconhecido falha", () => {
    expect(() => validateConfig({ ...base(), preset: "turbo" })).toThrow(ConfigError);
  });

  test("agent de tipo errado não é mascarado pelo preset", () => {
    expect(() => validateConfig({ ...base(), agent: "p/m1", preset: "simple" })).toThrow(/agent/);
  });
});
