import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { runTask } from "../src/core/app";
import { CompactionPausedError, recordCompactionFailure } from "../src/compaction/breaker";
import { compactionArtifactPaths } from "../src/compaction/background";
import { Ledger } from "../src/ledger";
import type { BudgetConfig } from "../src/core/config";
import type { CompletionResponse, Provider } from "../src/providers/types";
import { ProviderError } from "../src/providers/types";
import type { AgentEntry, ModelEntry } from "../src/core/registry";
import { runMultiAgentSession } from "../src/core/session";
import { handoffTool } from "../src/tools/handoff";
import { readFileTool } from "../src/tools/read-file";
import { ToolExecutor } from "../src/tools/executor";
import { testEnv } from "./setup";

interface Body {
  tools?: unknown[];
  messages?: Array<{ role?: string; content?: string }>;
}

function server(handler: (calls: number, body: Body) => Response | Promise<Response>) {
  let calls = 0;
  const bodies: Body[] = [];
  const instance = Bun.serve({
    port: 0,
    async fetch(req) {
      calls++;
      const body = (await req.json()) as Body;
      bodies.push(body);
      return handler(calls, body);
    },
  });
  return { instance, bodies, calls: () => calls };
}

function writeConfig(dir: string, port: number, extra: Record<string, unknown> = {}): string {
  const path = join(dir, "astro.config.json");
  writeFileSync(path, JSON.stringify({
    providers: { mock: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${port}/v1`, credentialRef: "KEY" } },
    models: [{ provider: "mock", id: "m1", tags: ["writing-code"], context: 400 }],
    agent: { model: "mock/m1", maxSteps: 4, tools: [], systemPrompt: "SYS-PROMPT" },
    compaction: { buffer: 100 },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    ...extra,
  }));
  return path;
}

const ok = (content: string): Response => Response.json({
  choices: [{ message: { content } }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});

const toolCall = (name: string, args: object): Response => Response.json({
  choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function",
    function: { name, arguments: JSON.stringify(args) } }] } }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});

const resp = (p: Partial<CompletionResponse> = {}): CompletionResponse => ({
  content: "", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, ...p,
});

const pricedModel = {
  provider: "mock", id: "m1", tags: ["writing-code"], context: 24_000,
  price: { inputPerM: 100, outputPerM: 100, fonte: "teste", verificado: false },
};
/** US$ 5 por completion (reserva B9 = US$ 2,40 com a janela de 24k). */
const ceilingBudget: BudgetConfig = {
  scope: "use-as-you-go", limitUsd: null, warnAt: 0.8, onExceed: "stop", hardCeilingUsd: 13,
};
const bigUsage = { inputTokens: 50_000, outputTokens: 0 };
const bigOk = (content: string): Response => Response.json({
  choices: [{ message: { content } }],
  usage: { prompt_tokens: 50_000, completion_tokens: 0 },
});
const bigToolCall = (name: string, args: object): Response => Response.json({
  choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function",
    function: { name, arguments: JSON.stringify(args) } }] } }],
  usage: { prompt_tokens: 50_000, completion_tokens: 0 },
});
const midBandHistory = [
  { role: "user" as const, content: "a".repeat(15_000) },
  { role: "assistant" as const, content: "b".repeat(15_000) },
];
const isSummary = (body: Body): boolean =>
  body.tools === undefined && body.messages?.[0]?.content?.includes("Resuma") === true;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const unit = (p: Partial<CompletionResponse> = {}): CompletionResponse => ({
  content: "", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, ...p,
});

describe("compactação na sessão (S-17, CMP-8)", () => {
  test("cruza o gatilho com histórico, resume sem tools e continua preservando o system", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-compaction-session-"));
    writeFileSync(join(cwd, "AGENTS.md"), "REGRAS DO PROJETO");
    const mock = server((calls) => ok(calls === 1 ? "resumo do histórico" : "concluído"));
    try {
      const configPath = writeConfig(cwd, mock.instance.port!, {
        models: [{ provider: "mock", id: "m1", tags: ["writing-code"], context: 24_000 }],
        agent: { model: "mock/m1", maxSteps: 3, tools: [], systemPrompt: "SYS-PROMPT" },
        compaction: { buffer: null },
      });
      const report = await runTask({
        configPath, task: "tarefa", cwd, env: testEnv({ KEY: "k" }),
        history: [
          { role: "user", content: `sk-live-0123456789abcdef ${"a".repeat(40_000)}` },
          { role: "assistant", content: "b".repeat(40_000) },
        ],
      });

      expect(report.final).toBe("concluído");
      expect(mock.calls()).toBe(2);

      const summary = mock.bodies[0]!;
      expect(summary.tools).toBeUndefined();
      expect(summary.messages?.[0]?.content).toContain("Resuma");
      // O resumo passa pela mesma redação do prompt normal (I-03).
      expect(JSON.stringify(summary)).not.toContain("sk-live-0123456789abcdef");
      expect(JSON.stringify(summary)).toContain("[REDACTED]");

      const completion = mock.bodies[1]!;
      // CMP-8: AGENTS.md volta ao contexto depois de compactar.
      expect(completion.messages?.[0]?.content).toContain("REGRAS DO PROJETO");
      expect(completion.messages?.[0]?.content).toContain("SYS-PROMPT");
      expect(completion.messages?.[1]?.content).toContain("CompactionArtifactV1");
      // CMP-3: a parte recente começa no usuário, nunca num tool result órfão.
      expect(completion.messages?.[2]?.role).toBe("user");

      const ledger = new Ledger(join(cwd, ".astro", "ledger.jsonl"));
      expect(ledger.readAllEntries().filter((entry) => entry.kind === "compaction")).toHaveLength(1);
      expect(ledger.readAllEntries().find((entry) => entry.kind === "compaction"))
        .toMatchObject({ failure_count: 0, manual: false });
      // O uso do resumo também entra no ledger (custo/quota).
      expect(ledger.readAllEntries().filter((entry) => entry.kind === "usage")).toHaveLength(2);
    } finally {
      mock.instance.stop(true);
    }
  });

  test("breaker pausado interrompe o run com a mensagem do CMP-6", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-compaction-paused-"));
    mkdirSync(join(cwd, ".astro"), { recursive: true });
    const ledger = new Ledger(join(cwd, ".astro", "ledger.jsonl"));
    for (let index = 0; index < 3; index++) recordCompactionFailure(ledger, "r-paused", "default");

    const mock = server(() => ok("não deveria chamar"));
    try {
      const configPath = writeConfig(cwd, mock.instance.port!, {
        models: [{ provider: "mock", id: "m1", tags: ["writing-code"], context: 24_000 }],
        agent: { model: "mock/m1", maxSteps: 3, tools: [], systemPrompt: "SYS-PROMPT" },
        compaction: { buffer: null },
      });
      const error = await runTask({
        configPath, task: "oi", cwd, env: testEnv({ KEY: "k" }), runId: "r-paused",
        history: [
          { role: "user", content: "a".repeat(40_000) },
          { role: "assistant", content: "b".repeat(40_000) },
        ],
      }).then(() => null, (caught: unknown) => caught);

      expect(error).toBeInstanceOf(CompactionPausedError);
      expect((error as Error).message).toMatch(/^Compaction paused \(3 failures, retry in \d+s\)$/);
      expect(mock.calls()).toBe(0);
      expect(ledger.lastState("r-paused")).toMatchObject({ state: "interrupted", reason: "compaction_paused" });
    } finally {
      mock.instance.stop(true);
    }
  });

  test("pausa após handoff não grava handoff.failed (retomável)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-compaction-handoff-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const ledger = new Ledger(join(cwd, "ledger.jsonl"));
    for (let index = 0; index < 3; index++) recordCompactionFailure(ledger, "r1", "planner");

    const model: ModelEntry = {
      provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 24_000, status: "active",
    };
    const agents: Record<string, AgentEntry> = {
      planner: { model: "openai/gpt-4o-mini", maxSteps: 3, tools: ["handoff"] },
      coder: { model: "openai/gpt-4o-mini", maxSteps: 3, tools: [] },
    };
    const registry = {
      requireAgent: (name: string) => agents[name] as AgentEntry,
      getAgent: (name: string) => agents[name],
      listAgentNames: () => Object.keys(agents),
    };
    let calls = 0;
    // Handoff com task grande: o receptor herda ~10k tokens e dispara o gatilho.
    const provider: Provider = {
      complete: async () => {
        calls++;
        return resp({ toolCalls: [{ id: "h1", name: "handoff", arguments: JSON.stringify({
          to: "coder",
          task: "x".repeat(40_000),
          objective: "o",
          decisions: [],
          constraints: [],
          next_steps: [],
        }) }] });
      },
    };

    const error = await runMultiAgentSession({
      run: "r1", credentialRef: "K", quotaDomain: "d", cwd, provider, registry,
      baseModel: model, baseExecutor: new ToolExecutor({
        tools: [handoffTool], allow: ["handoff"], audit,
      }),
      ledger, audit, baseMaxSteps: 3, entryAgent: "planner", compaction: { buffer: null },
    }, "plan").then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(CompactionPausedError);
    expect(calls).toBe(1); // o receptor nem chama o provider
    const events = ledger.readAllEntries()
      .map((entry) => (entry as { kind?: string }).kind)
      .filter((kind): kind is string => typeof kind === "string" && kind.startsWith("handoff."));
    expect(events).toContain("handoff.received");
    expect(events).not.toContain("handoff.failed");
    expect(ledger.lastState("r1")).toMatchObject({ state: "interrupted", reason: "compaction_paused" });
  });

  test("rejeição por tamanho compacta e retenta uma vez (CMP-7)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-compaction-overflow-"));
    const mock = server((calls) => {
      if (calls === 1) return Response.json({ error: { message: "maximum context length exceeded" } }, { status: 400 });
      if (calls === 2) return ok("resumo");
      return ok("concluído");
    });
    try {
      const configPath = writeConfig(cwd, mock.instance.port!, {
        models: [{ provider: "mock", id: "m1", tags: ["writing-code"], context: 128_000 }],
        agent: { model: "mock/m1", maxSteps: 3, tools: [] },
        compaction: { buffer: null },
      });
      const history = [
        { role: "user" as const, content: "a".repeat(40_000) },
        { role: "assistant" as const, content: "b".repeat(40_000) },
      ];
      const report = await runTask({ configPath, task: "oi", cwd, env: testEnv({ KEY: "k" }), history });

      expect(report.final).toBe("concluído");
      expect(mock.calls()).toBe(3);
      expect(mock.bodies[1]!.tools).toBeUndefined(); // o resumo não expõe tools
      expect(mock.bodies[2]!.messages?.[1]?.content).toContain("CompactionArtifactV1");
    } finally {
      mock.instance.stop(true);
    }
  });

  test("segunda rejeição por tamanho encerra com erro", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-compaction-overflow2-"));
    const mock = server((calls) => calls === 2
      ? ok("resumo")
      : Response.json({ error: { message: "maximum context length exceeded" } }, { status: 400 }));
    try {
      const configPath = writeConfig(cwd, mock.instance.port!, {
        models: [{ provider: "mock", id: "m1", tags: ["writing-code"], context: 128_000 }],
        agent: { model: "mock/m1", maxSteps: 3, tools: [] },
        compaction: { buffer: null },
      });
      const history = [
        { role: "user" as const, content: "a".repeat(40_000) },
        { role: "assistant" as const, content: "b".repeat(40_000) },
      ];
      const error = await runTask({ configPath, task: "oi", cwd, env: testEnv({ KEY: "k" }), history })
        .then(() => null, (caught: unknown) => caught);

      expect(error).toBeDefined();
      expect((error as Error).message).toMatch(/maximum context length/);
      expect(mock.calls()).toBe(3);
    } finally {
      mock.instance.stop(true);
    }
  });

  test("encerramento aguarda o prewarm e apaga artefato não consumido", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-compaction-close-"));
    writeFileSync(join(cwd, "nota.txt"), "conteúdo");
    const mock = server(async (calls, body) => {
      if (body.tools === undefined && body.messages?.[0]?.content?.includes("Resuma")) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return ok("resumo");
      }
      if (calls === 1) return toolCall("read_file", { path: "nota.txt" });
      return ok("concluído");
    });
    try {
      const configPath = writeConfig(cwd, mock.instance.port!, {
        models: [{ provider: "mock", id: "m1", tags: ["writing-code"], context: 24_000 }],
        agent: { model: "mock/m1", maxSteps: 3, tools: ["read_file"], systemPrompt: "SYS-PROMPT" },
        compaction: { buffer: null },
      });
      const report = await runTask({
        configPath, task: "oi", cwd, env: testEnv({ KEY: "k" }), runId: "r-close",
        history: [
          { role: "user", content: "a".repeat(15_000) },
          { role: "assistant", content: "b".repeat(15_000) },
        ],
      });

      expect(report.final).toBe("concluído");
      expect(mock.calls()).toBe(3);
      const ledger = new Ledger(join(cwd, ".astro", "ledger.jsonl"));
      // 2 completions + o resumo em background: close() esperou o job gravar usage.
      expect(ledger.readAllEntries().filter((entry) => entry.kind === "usage")).toHaveLength(3);
      const paths = compactionArtifactPaths(join(cwd, ".astro", "compaction"), "r-close", "default");
      expect(existsSync(paths.artifact)).toBe(false);
      expect(existsSync(paths.marker)).toBe(false);
    } finally {
      mock.instance.stop(true);
    }
  });

  test("sucesso + resumo no close cruzando o teto falha por ceiling e audita", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-compaction-ceiling-ok-"));
    writeFileSync(join(cwd, "nota.txt"), "conteúdo");
    let completions = 0;
    const mock = server(async (_calls, body) => {
      if (isSummary(body)) { await sleep(200); return bigOk("resumo"); }
      completions++;
      if (completions <= 2) return bigToolCall("read_file", { path: "nota.txt" });
      return ok("concluído");
    });
    try {
      const configPath = writeConfig(cwd, mock.instance.port!, {
        models: [pricedModel],
        agent: { model: "mock/m1", maxSteps: 4, tools: ["read_file"], systemPrompt: "SYS-PROMPT" },
        compaction: { buffer: null },
        budget: ceilingBudget,
      });
      const error = await runTask({
        configPath, task: "oi", cwd, env: testEnv({ KEY: "k" }), runId: "r-ceil-ok", history: midBandHistory,
      }).then(() => null, (caught: unknown) => caught);

      expect((error as Error).message).toMatch(/budget esgotado \(ceiling\)/);
      const audit = new Auditor(join(cwd, ".astro", "audit.jsonl"));
      expect(audit.readAll().some((event) => event.tipo === "budget.ceiling_hit")).toBe(true);
      expect(audit.readAll().find((event) => event.tipo === "run.stopped")?.payload)
        .toMatchObject({ reason: "budget_exceeded" });
    } finally {
      mock.instance.stop(true);
    }
  });

  test("falha do provider + resumo no close preserva o erro terminal e audita ceiling", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-compaction-ceiling-fail-"));
    writeFileSync(join(cwd, "nota.txt"), "conteúdo");
    let completions = 0;
    const mock = server(async (_calls, body) => {
      if (isSummary(body)) { await sleep(200); return bigOk("resumo"); }
      completions++;
      if (completions <= 2) return bigToolCall("read_file", { path: "nota.txt" });
      return Response.json({ error: { message: "provider boom" } }, { status: 500 });
    });
    try {
      const configPath = writeConfig(cwd, mock.instance.port!, {
        models: [pricedModel],
        agent: { model: "mock/m1", maxSteps: 4, tools: ["read_file"], systemPrompt: "SYS-PROMPT" },
        compaction: { buffer: null },
        budget: ceilingBudget,
      });
      const error = await runTask({
        configPath, task: "oi", cwd, env: testEnv({ KEY: "k" }), runId: "r-ceil-fail", history: midBandHistory,
      }).then(() => null, (caught: unknown) => caught);

      expect(error).toBeInstanceOf(ProviderError);
      expect((error as Error).message).toContain("provider boom");
      const audit = new Auditor(join(cwd, ".astro", "audit.jsonl"));
      expect(audit.readAll().some((event) => event.tipo === "budget.ceiling_hit")).toBe(true);
      const stopped = audit.readAll().filter((event) => event.tipo === "run.stopped");
      expect(stopped.at(-1)?.payload).toMatchObject({ reason: "error", error: "ProviderError" });
      expect(stopped.some((event) => (event.payload as { reason?: string }).reason === "budget_exceeded")).toBe(false);
      expect(new Ledger(join(cwd, ".astro", "ledger.jsonl")).lastState("r-ceil-fail"))
        .toMatchObject({ state: "interrupted", reason: "ProviderError" });
    } finally {
      mock.instance.stop(true);
    }
  });

  test("overflow cancela o resumo em background sem gravar usage", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-compaction-overflow-bg-"));
    writeFileSync(join(cwd, "nota.txt"), "conteúdo");
    let completions = 0;
    let summaries = 0;
    const mock = server(async (_calls, body) => {
      if (isSummary(body)) {
        summaries++;
        if (summaries === 1) await sleep(100); // abortado pelo take do overflow
        return ok("resumo");
      }
      completions++;
      if (completions === 1) return toolCall("read_file", { path: "nota.txt" });
      if (completions === 2) return Response.json({ error: { message: "maximum context length exceeded" } }, { status: 400 });
      return ok("concluído");
    });
    try {
      const configPath = writeConfig(cwd, mock.instance.port!, {
        models: [{ provider: "mock", id: "m1", tags: ["writing-code"], context: 24_000 }],
        agent: { model: "mock/m1", maxSteps: 4, tools: ["read_file"], systemPrompt: "SYS-PROMPT" },
        compaction: { buffer: null },
      });
      const report = await runTask({
        configPath, task: "oi", cwd, env: testEnv({ KEY: "k" }), runId: "r-overflow-bg", history: midBandHistory,
      });

      expect(report.final).toBe("concluído");
      expect(summaries).toBe(2); // background cancelado + inline
      const ledger = new Ledger(join(cwd, ".astro", "ledger.jsonl"));
      // 2 completions registradas (a rejeitada não grava usage) + 1 resumo inline.
      expect(ledger.readAllEntries().filter((entry) => entry.kind === "usage")).toHaveLength(3);
      const audit = new Auditor(join(cwd, ".astro", "audit.jsonl"));
      expect(audit.readAll().some((event) => event.tipo === "compaction.failed")).toBe(false);
    } finally {
      mock.instance.stop(true);
    }
  });

  for (const failure of [false, true]) {
    test(`multi-agent: resumo no close ${failure ? "preserva ProviderError" : "falha por ceiling"}`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), "astro-compaction-multi-ceiling-"));
      writeFileSync(join(cwd, "nota.txt"), "conteúdo");
      const audit = new Auditor(join(cwd, "audit.jsonl"));
      const ledger = new Ledger(join(cwd, "ledger.jsonl"));
      const model: ModelEntry = {
        provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 24_000, status: "active",
        price: { inputPerM: 100, outputPerM: 100, fonte: "teste", verificado: false },
      };
      const agents: Record<string, AgentEntry> = {
        planner: { model: "openai/gpt-4o-mini", maxSteps: 4, tools: ["read_file"] },
      };
      const registry = {
        requireAgent: (name: string) => agents[name] as AgentEntry,
        getAgent: (name: string) => agents[name],
        listAgentNames: () => Object.keys(agents),
      };
      let completions = 0;
      const provider: Provider = {
        complete: async (request) => {
          if (request.tools === undefined) {
            await sleep(200);
            return unit({ content: "resumo", usage: bigUsage });
          }
          completions++;
          if (completions <= 2) {
            return unit({
              toolCalls: [{ id: `c${completions}`, name: "read_file", arguments: "{\"path\":\"nota.txt\"}" }],
              usage: bigUsage,
            });
          }
          if (failure) throw new ProviderError("outage", "provider boom");
          return unit({ content: "concluído" });
        },
      };

      const error = await runMultiAgentSession({
        run: "r-multi-ceil", credentialRef: "K", quotaDomain: "d", cwd, provider, registry,
        baseModel: model, baseExecutor: new ToolExecutor({ tools: [readFileTool], allow: ["read_file"], audit }),
        ledger, audit, baseMaxSteps: 4, entryAgent: "planner", budget: ceilingBudget,
      }, "x".repeat(30_000)).then(() => null, (caught: unknown) => caught);

      expect(audit.readAll().some((event) => event.tipo === "budget.ceiling_hit")).toBe(true);
      if (failure) {
        expect(error).toBeInstanceOf(ProviderError);
        expect((error as Error).message).toContain("provider boom");
        expect(ledger.lastState("r-multi-ceil")).toMatchObject({ state: "interrupted", reason: "ProviderError" });
      } else {
        expect((error as Error).message).toMatch(/budget esgotado \(ceiling\)/);
      }
    });
  }
});
