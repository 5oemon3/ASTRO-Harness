import { describe, expect, test } from "bun:test";
import { validateConfig } from "../src/config";
import { configLines, configSummaryOf, type ConfigSummary } from "../src/chat/config-summary";

const base = {
  providers: {
    p: { kind: "openai-compat", baseUrl: "https://p.example/v1", credentialRef: "KEY" },
    q: { kind: "openai-compat", baseUrl: "https://q.example/v1", credentialRef: "KEY_Q" },
  },
  models: [
    { provider: "p", id: "m1", tags: ["writing-code"], context: 8192,
      price: { inputPerM: 1, outputPerM: 2, fonte: "t", verificado: false } },
    { provider: "p", id: "m2", tags: ["writing-code"], context: 8192 },
    { provider: "q", id: "m2", tags: ["writing-code"], context: 8192 },
  ],
  agent: { model: "p/m1", maxSteps: 3, tools: [] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
};

describe("configSummaryOf / configLines (#273)", () => {
  test("resume maxTurns, modo, custos (pricing sobrescreve model.price) e budget", () => {
    const config = validateConfig({
      ...base,
      run: { maxTurns: 5, checkpointAt: 0.8, noProgressSegments: 3, judge: "off" },
      budget: { scope: "day", limitUsd: 5, warnAt: 0.8, onExceed: "ask" },
      pricing: { "p/m2": { inputPerM: 2, outputPerM: 3, fonte: "t", verificado: true } },
    });
    const summary = configSummaryOf(config, "/cfg/astro.config.json", "ask");
    expect(summary.configPath).toBe("/cfg/astro.config.json");
    expect(summary.maxTurns).toBe("5");
    expect(summary.permissionMode).toBe("ask");
    // p/m1 vem do model.price; p/m2 é sobrescrito pelo pricing global; q/m2 não tem preço
    expect(summary.costs).toEqual([
      { ref: "p/m1", inputPerM: 1, outputPerM: 2 },
      { ref: "p/m2", inputPerM: 2, outputPerM: 3 },
    ]);
    expect(summary.budget).toBe("day · limite US$ 5.00 · aviso em 80% · ao exceder: ask");
  });

  test("sem run.maxTurns exibe unlimited; sem budget exibe 'sem budget'", () => {
    const summary = configSummaryOf(validateConfig(base), "/cfg/astro.config.json", "bypass");
    expect(summary.maxTurns).toBe("unlimited");
    expect(summary.budget).toBe("sem budget");
    expect(summary.costs).toEqual([{ ref: "p/m1", inputPerM: 1, outputPerM: 2 }]);
    expect(summary.permissionMode).toBe("bypass");
  });

  test("configLines monta o texto exibido no REPL e na tela", () => {
    const summary: ConfigSummary = {
      configPath: "/cfg/astro.config.json",
      maxTurns: "5",
      permissionMode: "ask",
      costs: [{ ref: "p/m1", inputPerM: 1, outputPerM: 2 }],
      budget: "sem budget",
    };
    expect(configLines(summary, []).join("\n")).toBe(
      "config: /cfg/astro.config.json\n"
      + "run.maxTurns: 5\n"
      + "permissions.mode: ask\n"
      + "budget: sem budget\n"
      + "custos por modelo:\n"
      + "  p/m1: in US$ 1.00/M · out US$ 2.00/M\n"
      + "pastas confiáveis: nenhuma",
    );
    const lines = configLines({ ...summary, costs: [] }, ["/a", "/b"]);
    expect(lines[lines.length - 4]).toBe("custos: nenhum preço declarado");
    expect(lines.slice(-3).join("\n")).toBe("pastas confiáveis:\n  /a\n  /b");
  });
});
