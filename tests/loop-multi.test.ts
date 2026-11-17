import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { Ledger } from "../src/ledger";
import {
  checkpointPath,
  encodeCheckpointId,
  findCheckpointAgents,
  loadCheckpoint,
  NoProgressError,
  saveCheckpoint,
  type CheckpointV1,
} from "../src/loop-guard";
import type { CompletionRequest, CompletionResponse, Provider } from "../src/providers/types";
import type { AgentEntry, ModelEntry } from "../src/core/registry";
import { runMultiAgentSession, type MultiAgentSessionOptions } from "../src/core/session";
import { runTask } from "../src/core/app";
import { ToolExecutor } from "../src/tools/executor";
import { writeFileTool } from "../src/tools/write-file";
import { handoffTool } from "../src/tools/handoff";
import type { Tool } from "../src/tools/types";
import { testEnv } from "./setup";

const model: ModelEntry = {
  provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000, status: "active",
  price: { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false },
};
const resp = (p: Partial<CompletionResponse>): CompletionResponse => ({
  content: "", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, ...p,
});
const write = (id: string, path: string) => ({ id, name: "write_file", arguments: JSON.stringify({ path, content: "x" }) });
const reply = (content: string): Response => Response.json({
  choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 },
});
const replyTool = (name: string, args: unknown, id = `c-${name}`): Response => Response.json({
  choices: [{ message: { content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});
const handoff = (id: string, to: string) => ({
  id, name: "handoff",
  arguments: JSON.stringify({ to, task: "continuar", objective: "entregar", decisions: [], constraints: [], next_steps: [] }),
});

function makeExecutor(tools: Tool[], allow: string[], audit: Auditor) {
  return new ToolExecutor({ approveTool: () => true, tools, allow, audit });
}

function makeRegistry(agents: Record<string, AgentEntry>) {
  return {
    requireAgent(name: string): AgentEntry {
      const a = agents[name];
      if (!a) throw new Error(`agent "${name}" não encontrado`);
      return a;
    },
    getAgent(name: string): AgentEntry | undefined {
      return agents[name];
    },
    listAgentNames: () => Object.keys(agents),
  };
}

function setup(script: CompletionResponse[], agents: Record<string, AgentEntry>, entryAgent: string) {
  const cwd = mkdtempSync(join(tmpdir(), "astro-loop-multi-"));
  const audit = new Auditor(join(cwd, "audit.jsonl"));
  const ledger = new Ledger(join(cwd, "ledger.jsonl"));
  let i = 0;
  const provider: Provider = { complete: async (_req: CompletionRequest) => script[i++]! };
  const baseExecutor = makeExecutor([writeFileTool, handoffTool], ["write_file", "handoff"], audit);
  const opts: MultiAgentSessionOptions = {
    run: "r1", credentialRef: "OPENAI_API_KEY", quotaDomain: "default",
    cwd, provider, registry: makeRegistry(agents), baseModel: model, baseExecutor,
    ledger, audit, baseMaxSteps: 10, entryAgent,
  };
  return { cwd, audit, ledger, opts };
}

describe("checkpoint com nome de agent fora do alfabeto seguro (#135)", () => {
  test("code_reviewer e nomes com ponto gravam/leem o checkpoint (segmento reversível)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-loop-name-"));
    const cp: CheckpointV1 = {
      schema: "checkpoint/v1", summary: "s", changedFiles: ["a.txt"], nextStep: "n", createdAt: new Date().toISOString(),
    };
    for (const agent of ["code_reviewer", "review.v2"]) {
      saveCheckpoint(cp, checkpointPath(cwd, "run.1", agent));
      expect(loadCheckpoint(cwd, "run.1", agent)).toEqual(cp);
    }
    // separadores continuam recusados (não viram segmento codificado)
    expect(() => checkpointPath(cwd, "r1", "a/b")).toThrow();
    expect(() => checkpointPath(cwd, "../x", "default")).toThrow();
  });

  test("findCheckpointAgents devolve o nome original e ignora diretório com caractere de formatação", () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-loop-list-"));
    const cp: CheckpointV1 = {
      schema: "checkpoint/v1", summary: "s", changedFiles: [], nextStep: "n", createdAt: new Date().toISOString(),
    };
    saveCheckpoint(cp, checkpointPath(cwd, "run.1", "code_reviewer"));
    saveCheckpoint(cp, join(cwd, ".astro", "sessions", encodeCheckpointId("run.1"), encodeCheckpointId("rev\u202Esec"), "checkpoint.json"));
    expect(findCheckpointAgents(cwd, "run.1")).toEqual(["code_reviewer"]);
  });
});

// O loop multi grava checkpoint em disco (uma vez por agente) além de ledger/audit
// por step e handoffs reais; o default de 5 s não cobre o Windows CI.
describe("runMultiAgentSession: checkpoint e não-progresso (#135)", () => {
  test("handoff troca o agent ativo e o checkpoint é do agente que está executando", { timeout: 30_000 }, async () => {
    const agents: Record<string, AgentEntry> = {
      planner: { model: "openai/gpt-4o-mini", maxSteps: 4, tools: ["handoff"], systemPrompt: "p" },
      coder: { model: "openai/gpt-4o-mini", maxSteps: 4, tools: ["write_file"], systemPrompt: "c" },
    };
    const s = setup([
      resp({ toolCalls: [handoff("h1", "coder")] }),
      resp({ content: "editando a", toolCalls: [write("c1", "a.txt")] }),
      resp({ content: "editando b", toolCalls: [write("c2", "b.txt")] }),
      resp({ content: "fim" }),
    ], agents, "planner");
    s.opts.checkpointAt = 0.5; // coder: ceil(4 * 0.5) = turno 2 do próprio agente

    const result = await runMultiAgentSession(s.opts, "entregue");

    expect(result.final).toBe("fim");
    expect(result.agentsUsed).toEqual(["planner", "coder"]);
    const path = checkpointPath(s.cwd, "r1", "coder");
    expect(existsSync(path)).toBe(true);
    expect(existsSync(checkpointPath(s.cwd, "r1", "planner"))).toBe(false);
    const checkpoint = JSON.parse(readFileSync(path, "utf8")) as CheckpointV1;
    expect(checkpoint.changedFiles).toEqual(["a.txt", "b.txt"]); // inclui o arquivo executado no próprio turno
    const event = s.audit.readAll().filter((e) => e.tipo === "loop.checkpoint");
    expect(event).toHaveLength(1); // uma gravação por agente, não uma por step/tool
    expect(event[0]?.agent).toBe("coder");
    expect(event[0]?.payload).toMatchObject({ step: 3, trigger: "turns" });
  });

  test("não-progresso no multi-agent sem decider → NoProgressError e estado interrupted", { timeout: 30_000 }, async () => {
    const agents: Record<string, AgentEntry> = {
      coder: { model: "openai/gpt-4o-mini", maxSteps: 5, tools: ["write_file"], systemPrompt: "c" },
    };
    const s = setup([
      resp({ toolCalls: [write("c1", "a.txt")] }),
      resp({ toolCalls: [write("c2", "a.txt")] }),
      resp({ content: "fim" }),
    ], agents, "coder");
    s.opts.noProgressSegments = 2;

    const error = await runMultiAgentSession(s.opts, "loop").catch((e) => e as Error);

    expect(error).toBeInstanceOf(NoProgressError);
    expect((error as NoProgressError).code).toBe("no_progress");
    const event = s.audit.readAll().find((e) => e.tipo === "loop.no_progress");
    expect(event?.agent).toBe("coder");
    expect(event?.payload).toMatchObject({ step: 2, segments: 2 });
    expect(s.ledger.lastState("r1")?.state).toBe("interrupted");
    expect(s.ledger.lastState("r1")?.reason).toBe("no_progress");
  });

  test("onNoProgress=true no multi-agent continua e reseta a sequência", { timeout: 30_000 }, async () => {
    const agents: Record<string, AgentEntry> = {
      coder: { model: "openai/gpt-4o-mini", maxSteps: 5, tools: ["write_file"], systemPrompt: "c" },
    };
    const s = setup([
      resp({ toolCalls: [write("c1", "a.txt")] }),
      resp({ toolCalls: [write("c2", "a.txt")] }),
      resp({ content: "fim" }),
    ], agents, "coder");
    s.opts.noProgressSegments = 2;
    s.opts.onNoProgress = async () => true;

    const result = await runMultiAgentSession(s.opts, "loop");

    expect(result.final).toBe("fim");
    expect(result.steps).toBe(3);
    expect(s.audit.readAll().filter((e) => e.tipo === "loop.no_progress")).toHaveLength(1);
  });

  test("checkpoint do primeiro turno já inclui o arquivo executado pelas tools", { timeout: 30_000 }, async () => {
    const agents: Record<string, AgentEntry> = {
      coder: { model: "openai/gpt-4o-mini", maxSteps: 2, tools: ["write_file"], systemPrompt: "c" },
    };
    const s = setup([
      resp({ content: "editando", toolCalls: [write("c1", "first.txt")] }),
      resp({ content: "fim" }),
    ], agents, "coder");
    s.opts.checkpointAt = 0.5; // ceil(2 * 0.5) = turno 1

    await runMultiAgentSession(s.opts, "entregue");

    const checkpoint = JSON.parse(readFileSync(checkpointPath(s.cwd, "r1", "coder"), "utf8")) as CheckpointV1;
    expect(checkpoint.changedFiles).toEqual(["first.txt"]);
  });

  test("falha de I/O do checkpoint não queima o handoff já recebido", { timeout: 30_000 }, async () => {
    const agents: Record<string, AgentEntry> = {
      planner: { model: "openai/gpt-4o-mini", maxSteps: 2, tools: ["handoff"], systemPrompt: "p" },
      coder: { model: "openai/gpt-4o-mini", maxSteps: 2, tools: ["write_file"], systemPrompt: "c" },
    };
    const s = setup([
      resp({ toolCalls: [handoff("h1", "coder")] }),
      resp({ content: "fim" }),
    ], agents, "planner");
    s.opts.checkpointAt = 0.5; // planner: turno 1, mas `.astro` é arquivo e a gravação falha
    writeFileSync(join(s.cwd, ".astro"), "não é diretório");

    const result = await runMultiAgentSession(s.opts, "entregue");

    expect(result.final).toBe("fim");
    const events = s.audit.readAll();
    expect(events.some((e) => e.tipo === "handoff.failed")).toBe(false);
    const error = events.find((e) => e.tipo === "loop.checkpoint_error");
    expect(error?.agent).toBe("planner");
    expect(Object.keys(error!.payload).sort()).toEqual(["code", "step"]);
    expect(error!.payload).toMatchObject({ step: 1 });
  });

  test("handoff ping-pong conta o segmento do emissor e para por não-progresso", { timeout: 30_000 }, async () => {
    const agents: Record<string, AgentEntry> = {
      planner: { model: "openai/gpt-4o-mini", maxSteps: 5, tools: ["handoff"], systemPrompt: "p" },
      coder: { model: "openai/gpt-4o-mini", maxSteps: 5, tools: ["handoff"], systemPrompt: "c" },
    };
    const s = setup([
      resp({ toolCalls: [handoff("h1", "coder")] }),
      resp({ toolCalls: [handoff("h2", "planner")] }),
      resp({ toolCalls: [handoff("h3", "coder")] }),
      resp({ content: "fim" }),
    ], agents, "planner");
    s.opts.noProgressSegments = 2;

    const error = await runMultiAgentSession(s.opts, "ping-pong").catch((e) => e as Error);

    expect(error).toBeInstanceOf(NoProgressError);
    const events = s.audit.readAll();
    expect(events.some((e) => e.tipo === "handoff.failed")).toBe(false);
    expect(s.ledger.lastState("r1")?.state).toBe("interrupted");
    expect(s.ledger.lastState("r1")?.reason).toBe("no_progress");
  });
});

describe("runTask: config.run chega ao multi-agent e ao filho da task (#135)", () => {
  test("agent code_reviewer com checkpointAt não morre no caminho e grava o checkpoint", { timeout: 30_000 }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-loop-app-"));
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { messages: Array<{ role: string; content: string }> };
        calls++;
        if (body.messages.some((message) => message.role === "tool")) return reply("ok");
        return replyTool("write_file", { path: "notes.txt", content: "x" }, "c1");
      },
    });
    const configPath = join(cwd, "astro.config.json");
    writeFileSync(configPath, JSON.stringify({
      providers: {
        p: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" },
        q: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY2" },
      },
      models: [
        { provider: "p", id: "m1", tags: ["writing-code"], context: 8192 },
        { provider: "q", id: "m1", tags: ["writing-code"], context: 8192 },
      ],
      agent: { model: "p/m1", maxSteps: 4, tools: ["write_file"], entryAgent: "code_reviewer" },
      agents: { code_reviewer: { model: "q/m1", maxSteps: 4, tools: ["write_file"], permission: "full", systemPrompt: "review" } },
      run: { checkpointAt: 0.5 },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    }));
    try {
      const result = await runTask({
        configPath, cwd, task: "revise", env: testEnv({ KEY: "k", KEY2: "k2" }),
        permissionMode: "bypass", approveTool: () => true,
      });
      expect(result.final).toBe("ok");
      expect(calls).toBe(2);
      const path = checkpointPath(cwd, result.runId, "code_reviewer");
      expect(existsSync(path)).toBe(true);
      const event = new Auditor(join(cwd, ".astro", "audit.jsonl")).readAll()
        .find((e) => e.tipo === "loop.checkpoint");
      expect(event?.agent).toBe("code_reviewer");
    } finally {
      server.stop(true);
    }
  });

  test("filho da task herda checkpointAt/noProgressSegments e o decider do pai", { timeout: 30_000 }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-loop-task-"));
    let childCalls = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { messages: Array<{ role: string; content: string }> };
        const system = body.messages[0]?.content ?? "";
        if (system === "child-agent") {
          childCalls++;
          if (childCalls === 3) return reply("child-final");
          return replyTool("write_file", { path: "child.txt", content: "x" }, `c${childCalls}`);
        }
        if (body.messages.some((message) => message.role === "tool")) return reply("parent-final");
        return replyTool("task", { agent: "code_reviewer", prompt: "revise o arquivo" }, "t1");
      },
    });
    const configPath = join(cwd, "astro.config.json");
    writeFileSync(configPath, JSON.stringify({
      providers: {
        p: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" },
        q: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY2" },
      },
      models: [
        { provider: "p", id: "m1", tags: ["writing-code"], context: 8192 },
        { provider: "q", id: "m1", tags: ["writing-code"], context: 8192 },
      ],
      agent: { model: "p/m1", maxSteps: 4, tools: ["task", "write_file"], entryAgent: "planner" },
      agents: {
        planner: { model: "q/m1", maxSteps: 4, tools: ["task", "write_file"], permission: "full", systemPrompt: "planner" },
        code_reviewer: { model: "q/m1", maxSteps: 3, tools: ["write_file"], permission: "full", systemPrompt: "child-agent" },
      },
      run: { checkpointAt: 0.5, noProgressSegments: 2 },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    }));
    let decisions = 0;
    try {
      const result = await runTask({
        configPath, cwd, task: "delegue", env: testEnv({ KEY: "k", KEY2: "k2" }),
        permissionMode: "bypass", approveTool: () => true,
        onNoProgress: async () => { decisions++; return true; },
      });
      expect(result.final).toBe("parent-final");
      expect(childCalls).toBe(3);
      expect(decisions).toBe(1);
      const audit = new Auditor(join(cwd, ".astro", "audit.jsonl")).readAll();
      expect(audit.some((e) => e.tipo === "loop.no_progress" && e.agent === "code_reviewer")).toBe(true);
      const event = audit.find((e) => e.tipo === "loop.checkpoint" && e.agent === "code_reviewer");
      expect(event).toBeDefined();
      const path = checkpointPath(cwd, event!.run, "code_reviewer");
      expect(existsSync(path)).toBe(true);
      expect((JSON.parse(readFileSync(path, "utf8")) as CheckpointV1).changedFiles).toContain("child.txt");
    } finally {
      server.stop(true);
    }
  });
});
