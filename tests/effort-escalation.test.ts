import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { validateConfig } from "../src/core/config";
import type { AgentEntry, ModelEntry } from "../src/core/registry";
import { runMultiAgentSession, runSession, type MultiAgentSessionOptions, type SessionOptions } from "../src/core/session";
import { Ledger } from "../src/ledger";
import type { CompletionRequest, CompletionResponse, Provider } from "../src/providers/types";
import { ToolExecutor } from "../src/tools/executor";
import { handoffTool } from "../src/tools/handoff";
import { writeFileTool } from "../src/tools/write-file";

const model: ModelEntry = {
  provider: "openai", id: "m", tags: [], context: 128000, status: "active",
  call: { effort: { param: "reasoning.effort", map: { "0": "minimal", "1": "low", "2": "medium", "3": "high", "4": "max" } } },
};
const resp = (p: Partial<CompletionResponse>): CompletionResponse => ({
  content: "", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, ...p,
});
const write = (id: string, path: string) => ({ id, name: "write_file", arguments: JSON.stringify({ path, content: "x" }) });
const handoff = (id: string, to: string) => ({
  id, name: "handoff",
  arguments: JSON.stringify({ to, task: "continuar", objective: "entregar", decisions: [], constraints: [], next_steps: [] }),
});
const auto = (autoJumpMax = 1, maxCumulativeJump = 3) => ({ auto: true, autoJumpMax, maxCumulativeJump });
const levels = (requests: CompletionRequest[]) => requests.map((request) => request.call?.lvl);
const jumps = (ledger: Ledger) => ledger.readAllEntries().filter((entry) => entry.kind === "effort");
const writes = (count: number) => Array.from({ length: count }, (_, index) => resp({ toolCalls: [write(`c${index}`, "a.txt")] }));
function setup(script: CompletionResponse[], overrides: Partial<SessionOptions> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "astro-effort-"));
  const audit = new Auditor(join(cwd, "audit.jsonl"));
  const ledger = new Ledger(join(cwd, "ledger.jsonl"));
  const requests: CompletionRequest[] = [];
  let i = 0;
  const provider: Provider = { complete: async (request) => { requests.push(request); return script[i++]!; } };
  const opts: SessionOptions = {
    run: "r1", agent: "default", quotaDomain: "default", cwd, provider, model,
    executor: new ToolExecutor({ approveTool: () => true, tools: [writeFileTool], allow: ["write_file"], audit }),
    ledger, audit, maxSteps: 7, call: { lvl: 2 }, ...overrides,
  };
  return { opts, ledger, requests };
}

const valid = {
  providers: { openai: { kind: "openai-compat", baseUrl: "https://api.openai.com/v1", credentialRef: "OPENAI_API_KEY" } },
  models: [{ provider: "openai", id: "m", tags: [], context: 128000 }],
  agent: { model: "openai/m", maxSteps: 10, tools: ["read_file"] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
};
describe("config de escalada (#451)", () => {
  test("off por default; caps validados com erro claro", () => {
    expect(validateConfig(structuredClone(valid)).effort).toBeUndefined();
    expect(validateConfig({ ...structuredClone(valid), effort: auto(2, 1) }).effort).toEqual(auto(2, 1));
    for (const [effort, pattern] of [
      [{ autoJumpMax: 3 }, /effort\.autoJumpMax/],
      [{ maxCumulativeJump: 5 }, /effort\.maxCumulativeJump/],
      [{ auto: "sim" }, /effort\.auto/],
    ] as const) {
      expect(() => validateConfig({ ...structuredClone(valid), effort })).toThrow(pattern);
    }
  });
});

describe("escalada automática no runSession (#451)", () => {
  test("sem sinal de não-progresso (ou default off) o nível não sobe", async () => {
    const below = setup([
      resp({ toolCalls: [write("b0", "0.txt")] }),
      resp({ toolCalls: [write("b1", "1.txt")] }),
      resp({ content: "fim" }),
    ], { noProgressSegments: 2, effort: auto() });
    await runSession(below.opts, "t");
    expect(levels(below.requests)).toEqual([2, 2, 2]);
    expect(jumps(below.ledger)).toHaveLength(0);

    const off = setup([...writes(2), resp({ content: "fim" })], { noProgressSegments: 2, onNoProgress: () => true });
    await runSession(off.opts, "t");
    expect(levels(off.requests)).toEqual([2, 2, 2]);
    expect(jumps(off.ledger)).toHaveLength(0);
  });

  test("sinal de não-progresso sobe um nível e grava effort.jump no ledger", async () => {
    const s = setup([...writes(3), resp({ content: "fim" })], { noProgressSegments: 2, effort: auto() });
    await runSession(s.opts, "t");
    expect(levels(s.requests)).toEqual([2, 2, 3, 3]);
    expect(jumps(s.ledger)).toMatchObject([{
      kind: "effort", event: "jump", run: "r1", agent: "default", from: 2, to: 3,
      delta: 1, baseline: 2, cumulative: 1, allowed: true, reason: "up_auto",
    }]);
    expect(JSON.stringify(jumps(s.ledger))).not.toContain("a.txt");
    const entry = jumps(s.ledger)[0]!;
    if (entry.kind === "effort") {
      expect(entry.segment).toMatch(/^[0-9a-f]{64}$/);
      expect(["up_auto", "ceiling", "cumulative_cap"]).toContain(entry.reason);
    }
  });

  test("salto encolhe para o budget acumulado e para o teto L4", async () => {
    const shrink = setup([...writes(4), resp({ content: "fim" })], {
      call: { lvl: 0 }, noProgressSegments: 2, effort: auto(2, 3),
    });
    await runSession(shrink.opts, "t");
    expect(levels(shrink.requests)).toEqual([0, 0, 2, 2, 3]);
    expect(jumps(shrink.ledger)).toMatchObject([
      { from: 0, to: 2, delta: 2, cumulative: 2, allowed: true },
      { from: 2, to: 3, delta: 1, cumulative: 3, allowed: true },
    ]);

    const ceiling = setup([...writes(2), resp({ content: "fim" })], {
      call: { lvl: 3 }, noProgressSegments: 2, effort: auto(2, 3),
    });
    await runSession(ceiling.opts, "t");
    expect(levels(ceiling.requests)).toEqual([3, 3, 4]);
    expect(jumps(ceiling.ledger)).toMatchObject([{ from: 3, to: 4, delta: 1, allowed: true }]);
  });

  test("ledger corrompido fora de 0..4 é ignorado, sem RangeError", async () => {
    const s = setup([...writes(2), resp({ content: "fim" })], {
      noProgressSegments: 2, effort: auto(),
    });
    s.ledger.recordEffortJump({
      run: "r1", agent: "default", from: 2, to: 99, delta: 97, baseline: 2, cumulative: 0,
      allowed: true, reason: "up_auto",
    });
    await runSession(s.opts, "t");
    expect(levels(s.requests)).toEqual([2, 2, 3]);
  });

  test("respeita autoJumpMax e maxCumulativeJump", async () => {
    const s = setup([...writes(5), resp({ content: "fim" })], {
      call: { lvl: 1 }, noProgressSegments: 2, effort: auto(2, 2), onNoProgress: () => true,
    });
    await runSession(s.opts, "t");
    expect(levels(s.requests)).toEqual([1, 1, 3, 3, 3, 3]);
    const log = jumps(s.ledger);
    expect(log[0]).toMatchObject({ from: 1, to: 3, delta: 2, cumulative: 2, allowed: true });
    expect(log.at(-1)).toMatchObject({ allowed: false, reason: "cumulative_cap", cumulative: 2 });
  });

  test("resume mantém o lock: estado vem do ledger do mesmo run", async () => {
    const s = setup([...writes(2), resp({ content: "fim" })], {
      call: { lvl: 1 }, noProgressSegments: 2, effort: auto(1, 2), onNoProgress: () => true,
    });
    s.ledger.recordEffortJump({
      run: "r1", agent: "default", from: 1, to: 3, delta: 2, baseline: 1, cumulative: 2, allowed: true, reason: "up_auto",
    });
    await runSession(s.opts, "t");
    expect(levels(s.requests)).toEqual([3, 3, 3]);
    expect(jumps(s.ledger).at(-1)).toMatchObject({ allowed: false, reason: "cumulative_cap" });
  });

  test("salto negado não repete em loop apertado (uma tentativa por segmento)", async () => {
    const s = setup([...writes(4), resp({ content: "fim" })], {
      noProgressSegments: 2, effort: auto(1, 0), onNoProgress: () => true,
    });
    await runSession(s.opts, "t");
    expect(levels(s.requests)).toEqual([2, 2, 2, 2, 2]);
    expect(jumps(s.ledger)).toHaveLength(1);
    expect(jumps(s.ledger)[0]).toMatchObject({ allowed: false, reason: "cumulative_cap" });
  });
});

describe("escalada no multi-agent (#451)", () => {
  test("cada agente tem lock e caps próprios; o salto do pai não vaza para o filho", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-effort-multi-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const ledger = new Ledger(join(cwd, "ledger.jsonl"));
    const requests: CompletionRequest[] = [];
    const script = [
      resp({ toolCalls: [write("p1", "p.txt")] }), resp({ toolCalls: [write("p2", "p.txt")] }),
      resp({ toolCalls: [handoff("h1", "coder")] }), resp({ toolCalls: [write("c1", "c.txt")] }),
      resp({ toolCalls: [write("c2", "c.txt")] }), resp({ content: "fim" }),
    ];
    let i = 0;
    const provider: Provider = { complete: async (request) => { requests.push(request); return script[i++]!; } };
    const agents: Record<string, AgentEntry> = {
      planner: { model: "openai/m", maxSteps: 4, tools: ["write_file", "handoff"], systemPrompt: "p" },
      coder: { model: "openai/m", maxSteps: 4, tools: ["write_file"], systemPrompt: "c" },
    };
    const registry = {
      requireAgent: (name: string) => agents[name]!, getAgent: (name: string) => agents[name],
      listAgentNames: () => Object.keys(agents),
    };
    const opts: MultiAgentSessionOptions = {
      run: "r1", quotaDomain: "default", cwd, provider, registry, baseModel: model,
      baseExecutor: new ToolExecutor({ approveTool: () => true, tools: [writeFileTool, handoffTool], allow: ["write_file", "handoff"], audit }),
      ledger, audit, baseMaxSteps: 6, entryAgent: "planner", noProgressSegments: 2, effort: auto(), call: { lvl: 2 },
    };
    expect((await runMultiAgentSession(opts, "t")).final).toBe("fim");
    expect(levels(requests)).toEqual([2, 2, 3, 2, 2, 3]);
    expect(jumps(ledger)).toMatchObject([
      { agent: "planner", from: 2, to: 3 },
      { agent: "coder", from: 2, to: 3 },
    ]);
  });
});
