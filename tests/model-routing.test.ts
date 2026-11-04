import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/app";
import { Auditor } from "../src/audit";
import { validateConfig } from "../src/config";
import { Ledger } from "../src/ledger";
import { createRoutedProvider, routedModelKey } from "../src/provider/model-routing";
import { ProviderError, type CompletionRequest, type CompletionResponse, type Provider } from "../src/provider/types";
import type { ModelEntry } from "../src/registry";
import { runSession } from "../src/session";
import { ToolExecutor } from "../src/tools/executor";

const entry = (id: string): ModelEntry => ({
  provider: "p", id, tags: ["writing-code"], context: 8192, status: "active",
});

const response = (content: string): CompletionResponse => ({
  content, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 },
});

const fixture: {
  providers: Record<string, unknown>;
  models: Array<Record<string, unknown>>;
  agent: Record<string, unknown>;
  agents: { plan: Record<string, unknown> } & Record<string, unknown>;
  paths: Record<string, string>;
} = {
  providers: {
    p: { kind: "openai-compat", baseUrl: "https://example.test/v1", credentialRef: "P_KEY" },
    q: { kind: "openai-compat", baseUrl: "https://example.test/v1", credentialRef: "Q_KEY" },
  },
  models: [
    { provider: "p", id: "base", tags: ["writing-code"], context: 8192 },
    { provider: "p", id: "cheap", tags: ["writing-code"], context: 8192 },
    { provider: "p", id: "strong", tags: ["writing-code"], context: 8192 },
    { provider: "q", id: "other", tags: ["writing-code"], context: 8192 },
  ],
  agent: { model: "p/base", maxSteps: 4, tools: ["read_file"] },
  agents: {
    maxActive: 1,
    plan: {
      model: "p/base",
      maxSteps: 3,
      tools: ["read_file"],
      modelRouting: { cheapModel: "p/cheap", strongModel: "p/strong" },
    },
  },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
};

describe("modelRouting config (#58)", () => {
  test("aceita cheapModel/strongModel declarados e ativos", () => {
    const cfg = validateConfig(structuredClone(fixture));
    expect(cfg.agents!.plan.modelRouting).toEqual({ cheapModel: "p/cheap", strongModel: "p/strong" });
  });

  test("aceita só um dos lados", () => {
    const onlyCheap = structuredClone(fixture);
    onlyCheap.agents.plan.modelRouting = { cheapModel: "p/cheap" };
    expect(validateConfig(onlyCheap).agents!.plan.modelRouting).toEqual({ cheapModel: "p/cheap" });
  });

  test("recusa modelo não declarado, objeto vazio e campo não-string", () => {
    const unknown = structuredClone(fixture);
    unknown.agents.plan.modelRouting = { cheapModel: "p/ghost" };
    expect(() => validateConfig(unknown)).toThrow(/modelRouting\.cheapModel/);

    const empty = structuredClone(fixture);
    empty.agents.plan.modelRouting = {};
    expect(() => validateConfig(empty)).toThrow(/modelRouting/);

    const wrongType = structuredClone(fixture);
    (wrongType.agents.plan.modelRouting as { strongModel?: unknown }).strongModel = 1;
    expect(() => validateConfig(wrongType)).toThrow(/modelRouting\.strongModel/);
  });

  test("recusa combinar profile e modelRouting", () => {
    const both = structuredClone(fixture);
    (both.agents.plan as { profile?: string }).profile = "pooled";
    expect(() => validateConfig(both)).toThrow(/profile/);
  });

  test("recusa rota em outro provider (troca de conta sem aprovação)", () => {
    const other = structuredClone(fixture);
    other.agents.plan.modelRouting = { strongModel: "q/other" };
    expect(() => validateConfig(other)).toThrow(/provider "p"/);
  });
});

describe("createRoutedProvider (#58)", () => {
  const models: Record<string, ModelEntry> = {
    "p/base": entry("base"), "p/cheap": entry("cheap"), "p/strong": entry("strong"),
  };
  const collect = () => {
    const seen: Array<{ model: string; purpose?: string }> = [];
    const providerFor = (m: ModelEntry): Provider => ({
      complete: async (req: CompletionRequest) => {
        seen.push({ model: req.model, ...(req.purpose === undefined ? {} : { purpose: req.purpose }) });
        return response(`${m.id}:ok`);
      },
    });
    const routed = createRoutedProvider({
      routing: { cheapModel: "p/cheap", strongModel: "p/strong" },
      fallback: models["p/base"]!,
      resolve: (key) => models[key]!,
      providerFor,
    });
    return { seen, routed };
  };

  test("sem purpose usa o strongModel e registra a identidade real", async () => {
    const { seen, routed } = collect();
    const result = await routed.complete({ model: "base", messages: [] });
    expect(seen).toEqual([{ model: "strong" }]);
    expect(result.content).toBe("strong:ok");
    expect(result.provider).toBe("p");
    expect(result.model).toBe("strong");
  });

  test("purpose cheap usa o cheapModel", async () => {
    const { seen, routed } = collect();
    await routed.complete({ model: "base", messages: [], purpose: "cheap" });
    expect(seen).toEqual([{ model: "cheap", purpose: "cheap" }]);
  });

  test("lado ausente cai no modelo do agente", () => {
    expect(routedModelKey({ strongModel: "p/strong" }, "cheap", "p/base")).toBe("p/base");
    expect(routedModelKey({}, "strong", "p/base")).toBe("p/base");
  });

  test("modelo roteado inexistente falha antes da chamada", async () => {
    await expect(createRoutedProvider({
      routing: { strongModel: "p/ghost" },
      fallback: models["p/base"]!,
      resolve: (key) => {
        const found = models[key];
        if (found === undefined) throw new Error(`modelo "${key}" não encontrado`);
        return found;
      },
      providerFor: () => ({ complete: async () => response("nunca") }),
    }).complete({ model: "base", messages: [] })).rejects.toThrow(/p\/ghost/);
  });
});

describe("sessão marca o resumo de compactação como cheap (#58)", () => {
  test("overflow compacta no cheap e repete no strong", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-model-routing-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const ledger = new Ledger(join(cwd, "ledger.jsonl"));
    const models: Record<string, ModelEntry> = {
      "p/base": entry("base"), "p/cheap": entry("cheap"), "p/strong": entry("strong"),
    };
    const seen: Array<{ model: string; purpose?: string }> = [];
    let strongCalls = 0;
    const providerFor = (m: ModelEntry): Provider => ({
      complete: async (req: CompletionRequest) => {
        seen.push({ model: req.model, ...(req.purpose === undefined ? {} : { purpose: req.purpose }) });
        if (m.id === "cheap") return response("resumo");
        if (m.id === "strong") {
          strongCalls += 1;
          if (strongCalls === 1) {
            throw new ProviderError("invalid_request", "context length exceeded");
          }
          return response("final");
        }
        return response("base");
      },
    });
    const provider = createRoutedProvider({
      routing: { cheapModel: "p/cheap", strongModel: "p/strong" },
      fallback: models["p/base"]!,
      resolve: (key) => models[key]!,
      providerFor,
    });
    const result = await runSession({
      run: "r1", agent: "plan", credentialRef: "K", quotaDomain: "d", cwd,
      provider, model: models["p/base"]!,
      executor: new ToolExecutor({ tools: [], allow: [], audit }),
      ledger, audit, maxSteps: 2,
      history: [
        { role: "system", content: "sys" },
        { role: "user", content: "primeira tarefa" },
        { role: "assistant", content: "x".repeat(70_000) },
      ],
    }, "segunda tarefa");
    expect(result.final).toBe("final");
    expect(seen).toContainEqual({ model: "cheap", purpose: "cheap" });
    expect(seen).toContainEqual({ model: "strong" });
    const rows = ledger.byAgent().plan;
    expect(rows?.tokensIn).toBeGreaterThan(0);
  });
});

describe("runTask aplica o modelRouting do agent (#58)", () => {
  test("geração usa o strongModel e o ledger cobra o modelo roteado", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-model-routing-app-"));
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { model: string };
        seen.push(body.model);
        return Response.json({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        });
      },
    });
    const configPath = join(cwd, "astro.config.json");
    writeFileSync(configPath, JSON.stringify({
      providers: {
        p: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" },
        q: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY2" },
      },
      models: [
        { provider: "p", id: "base", tags: ["writing-code"], context: 8192 },
        { provider: "p", id: "strong", tags: ["writing-code"], context: 8192 },
      ],
      agent: { model: "p/base", maxSteps: 4, tools: [], entryAgent: "plan" },
      agents: {
        plan: {
          model: "p/base", maxSteps: 3, tools: [],
          modelRouting: { strongModel: "p/strong" },
        },
      },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    }));
    try {
      const result = await runTask({
        configPath, cwd, task: "tarefa", env: { KEY: "k", KEY2: "k2" },
        permissionMode: "bypass", approveTool: () => true,
      });
      expect(result.final).toBe("ok");
      expect(seen).toEqual(["strong"]);
      const ledger = new Ledger(join(cwd, ".astro", "ledger.jsonl"));
      expect(ledger.byAgent().plan?.model).toBe("strong");
    } finally {
      server.stop(true);
    }
  });
});
