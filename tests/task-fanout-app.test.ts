import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeLocks } from "../src/agent-lock";
import { Auditor } from "../src/audit";
import { budgetStatus } from "../src/budget";
import { providerAccountRefFor } from "../src/core/config";
import { runTask } from "../src/core/app";
import { Ledger, type LedgerAgentEntry } from "../src/ledger";
import { planResume, rebuildAgentTree } from "../src/resume";
import { testEnv } from "./setup";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const final = (content: string): Response =>
  Response.json({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });

interface Harness {
  cwd: string;
  configPath: string;
  ledgerPath: string;
  controller: AbortController;
  stats: {
    mode: "normal" | "resume";
    parentCalls: number;
    childCalls: Record<string, number>;
    activeChildren: number;
    maxChildren: number;
    maxLocks: number;
  };
  stop(): void;
}

/** App-level fan-out: parent em P, filhos em Q (com fallback R) e R. */
function harness(maxActive: number, opts: { abortParentSecond?: boolean; childSpawn?: boolean } = {}): Harness {
  const cwd = mkdtempSync(join(tmpdir(), "astro-task-fanout-app-"));
  const ledgerPath = join(cwd, ".astro", "ledger.jsonl");
  const controller = new AbortController();
  const stats: Harness["stats"] = {
    mode: "normal", parentCalls: 0, childCalls: {}, activeChildren: 0, maxChildren: 0, maxLocks: 0,
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { messages: Array<{ role: string; content: string }> };
      const system = body.messages[0]?.content ?? "";
      if (system === "child-q" || system === "child-r") {
        stats.childCalls[system] = (stats.childCalls[system] ?? 0) + 1;
        stats.activeChildren++;
        stats.maxChildren = Math.max(stats.maxChildren, stats.activeChildren);
        stats.maxLocks = Math.max(stats.maxLocks, activeLocks(new Ledger(ledgerPath)).length);
        try {
          if (opts.childSpawn === true && system === "child-q" && stats.childCalls[system] === 1) {
            return Response.json({
              choices: [{
                message: {
                  content: "",
                  tool_calls: [{
                    id: "s1", type: "function",
                    function: { name: "spawn_agent", arguments: JSON.stringify({ need: "writing-code", task: "neto" }) },
                  }],
                },
              }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            });
          }
          await delay(30);
          return final(`${system}-final`);
        } finally {
          stats.activeChildren--;
        }
      }
      stats.parentCalls++;
      if (stats.mode === "resume") return final("resumed-final");
      if (opts.abortParentSecond === true && stats.parentCalls >= 2) {
        controller.abort();
        return final("aborted-final");
      }
      if (body.messages.some((message) => message.role === "tool")) return final("parent-final");
      return Response.json({
        choices: [{
          message: {
            content: "",
            tool_calls: [{
              id: "t1",
              type: "function",
              function: {
                name: "task",
                arguments: JSON.stringify({
                  tasks: [{ agent: "qa", prompt: "q" }, { agent: "rb", prompt: "r" }],
                }),
              },
            }],
          },
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    },
  });
  writeFileSync(join(cwd, "astro.config.json"), JSON.stringify({
    providers: {
      p: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY_P" },
      q: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY_Q", fallback: ["r"] },
      r: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY_R" },
    },
    models: [
      { provider: "p", id: "m", tags: ["writing-code"], context: 8192 },
      { provider: "q", id: "m", tags: ["writing-code"], context: 8192 },
      { provider: "r", id: "m", tags: ["writing-code"], context: 8192 },
    ],
    agent: {
      model: "p/m", maxSteps: 6, entryAgent: "parent",
      tools: opts.childSpawn === true ? ["task", "spawn_agent"] : ["task"],
    },
    agents: {
      maxActive,
      parent: { model: "p/m", maxSteps: 6, tools: opts.childSpawn === true ? ["task", "spawn_agent"] : ["task"] },
      qa: { model: "q/m", maxSteps: 3, tools: opts.childSpawn === true ? ["spawn_agent"] : [], systemPrompt: "child-q" },
      rb: { model: "r/m", maxSteps: 3, tools: [], systemPrompt: "child-r" },
    },
    spawn: { parallel: true },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  return {
    cwd,
    configPath: join(cwd, "astro.config.json"),
    ledgerPath,
    controller,
    stats,
    stop: () => server.stop(true),
  };
}

const env = () => testEnv({ KEY_P: "p", KEY_Q: "q", KEY_R: "r" });

test("fan-out respeita maxActive=2 com o pai incluso e usa o provider do filho", async () => {
  const h = harness(2);
  try {
    const report = await runTask({
      configPath: h.configPath, cwd: h.cwd, task: "fan-out", env: env(), approveSwap: () => true,
    });
    expect(report.final).toBe("parent-final");
    expect(h.stats.childCalls["child-q"]).toBeGreaterThan(0);
    expect(h.stats.childCalls["child-r"]).toBeGreaterThan(0);
    expect(h.stats.maxLocks).toBeLessThanOrEqual(2);
    expect(h.stats.maxChildren).toBe(1);

    const ledger = new Ledger(h.ledgerPath);
    expect(activeLocks(ledger)).toEqual([]);
    expect(rebuildAgentTree(ledger, report.runId).nodes.map((node) => node.agent_id)).toEqual(["parent"]);
    expect(ledger.readAllEntries().some((entry) => entry.run.startsWith(`${report.runId}.task.`))).toBe(true);
    await expect(runTask({
      configPath: h.configPath, cwd: h.cwd, task: "fan-out", env: env(), resume: report.runId,
    })).rejects.toThrow(/já concluído/);
  } finally {
    h.stop();
  }
});

test("maxActive=3 libera dois filhos, ainda com lock/atribuição por conta", async () => {
  const h = harness(3);
  try {
    const report = await runTask({
      configPath: h.configPath, cwd: h.cwd, task: "fan-out", env: env(), approveSwap: () => true,
    });
    expect(report.final).toBe("parent-final");
    expect(h.stats.maxLocks).toBeLessThanOrEqual(3);
    expect(h.stats.maxChildren).toBe(2);
    const ledger = new Ledger(h.ledgerPath);
    const childRuns = ledger.readAllEntries().filter((entry) => entry.run.startsWith(`${report.runId}.task.`));
    expect(childRuns.some((entry) => entry.kind === "agent" && entry.credentialRef === "KEY_Q")).toBe(true);
    expect(childRuns.some((entry) => entry.kind === "agent" && entry.credentialRef === "KEY_R")).toBe(true);
  } finally {
    h.stop();
  }
});

test("fan-out real interrompido retoma só o pai; filhos não são reexecutados", async () => {
  const h = harness(2, { abortParentSecond: true });
  try {
    const options = {
      configPath: h.configPath, cwd: h.cwd, task: "fan-out", env: env(), approveSwap: () => true,
    };
    await expect(runTask({ ...options, runId: "run-fan-resume", signal: h.controller.signal })).rejects.toThrow();
    const ledger = new Ledger(h.ledgerPath);
    expect(ledger.lastState("run-fan-resume")?.state).toBe("interrupted");
    expect(planResume(ledger, "run-fan-resume").agent.agent_id).toBe("parent");
    const childrenBefore = { ...h.stats.childCalls };

    h.stats.mode = "resume";
    const resumed = await runTask({ ...options, resume: "run-fan-resume" });
    expect(resumed.final).toBe("resumed-final");
    expect(h.stats.childCalls).toEqual(childrenBefore);
  } finally {
    h.stop();
  }
});

test("fallback do filho move o lock do filho, nunca o lock do pai", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-task-fanout-fallback-"));
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { messages: Array<{ role: string; content: string }> };
      const system = body.messages[0]?.content ?? "";
      const auth = req.headers.get("authorization") ?? "";
      requests.push(`${system}|${auth}`);
      if (system === "child-q" && auth.includes("Bearer q")) {
        return Response.json({ error: { message: "outage" } }, { status: 503 });
      }
      if (system === "child-q") return final("child-q-final");
      if (body.messages.some((message) => message.role === "tool")) return final("parent-final");
      return Response.json({
        choices: [{
          message: {
            content: "",
            tool_calls: [{
              id: "t1", type: "function",
              function: { name: "task", arguments: JSON.stringify({ tasks: [{ agent: "qa", prompt: "q" }] }) },
            }],
          },
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    },
  });
  const configPath = join(cwd, "astro.config.json");
  writeFileSync(configPath, JSON.stringify({
    providers: {
      p: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY_P" },
      q: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY_Q", fallback: ["r"], maxRetries: 0 },
      r: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY_R" },
    },
    models: [
      { provider: "p", id: "m", tags: ["writing-code"], context: 8192 },
      { provider: "q", id: "m", tags: ["writing-code"], context: 8192 },
      { provider: "r", id: "m", tags: ["writing-code"], context: 8192 },
    ],
    agent: { model: "p/m", maxSteps: 6, tools: ["task"], entryAgent: "parent" },
    agents: {
      maxActive: 2,
      parent: { model: "p/m", maxSteps: 6, tools: ["task"] },
      qa: { model: "q/m", maxSteps: 3, tools: [], systemPrompt: "child-q" },
    },
    spawn: { parallel: true },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  try {
    const report = await runTask({
      configPath, cwd, task: "fan-out", env: env(), approveSwap: () => true,
    });
    expect(report.final).toBe("parent-final");
    expect(requests.some((entry) => entry.includes("child-q") && entry.includes("Bearer r"))).toBe(true);
    const ledger = new Ledger(join(cwd, ".astro", "ledger.jsonl"));
    const parent = ledger.readAllEntries().filter(
      (entry): entry is LedgerAgentEntry => entry.kind === "agent" && entry.run === report.runId
        && (entry.event === "created" || entry.event === "identity"),
    );
    expect(parent.every((entry) => entry.credentialRef === "KEY_P")).toBe(true);
    const child = ledger.readAllEntries().filter(
      (entry): entry is LedgerAgentEntry => entry.kind === "agent" && entry.run.startsWith(`${report.runId}.task.`),
    );
    expect(child.some((entry) => entry.event === "identity" && entry.credentialRef === "KEY_R")).toBe(true);
    expect(activeLocks(ledger)).toEqual([]);
  } finally {
    server.stop(true);
  }
});

test("task filho não recebe spawn_agent: sem neto (ADR-0008 A5)", async () => {
  const h = harness(2, { childSpawn: true });
  try {
    const report = await runTask({
      configPath: h.configPath, cwd: h.cwd, task: "fan-out", env: env(), approveSwap: () => true,
    });
    expect(report.final).toBe("parent-final");
    const audit = new Auditor(join(h.cwd, ".astro", "audit.jsonl")).readAll();
    expect(audit.some((event) => event.tipo === "tool.denied"
      && (event.payload as { name?: string }).name === "spawn_agent")).toBe(true);
    expect(audit.some((event) => event.tipo === "agent.spawned")).toBe(false);
    expect(new Ledger(h.ledgerPath).readAllEntries().some(
      (entry) => entry.kind === "agent" && entry.agent_id.startsWith("sub-"),
    )).toBe(false);
  } finally {
    h.stop();
  }
});

test("delegação em provider de plugin usa a mesma conta do helper de config", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-task-fanout-plugin-"));
  const pluginPath = join(cwd, "test-plugin.ts");
  writeFileSync(pluginPath, `
export function definePlugin() {
  return {
    name: "fanout-plugin",
    tools: [],
    providers: [{
      kind: "custom",
      create() {
        return {
          async complete() {
            return { content: "plugin-final", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
          },
        };
      },
    }],
  };
}
`, "utf8");
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { messages: Array<{ role: string; content: string }> };
      if (body.messages.some((message) => message.role === "tool")) return final("parent-final");
      return Response.json({
        choices: [{
          message: {
            content: "",
            tool_calls: [{
              id: "t1", type: "function",
              function: { name: "task", arguments: JSON.stringify({ tasks: [{ agent: "qa", prompt: "q" }] }) },
            }],
          },
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    },
  });
  const configPath = join(cwd, "astro.config.json");
  writeFileSync(configPath, JSON.stringify({
    providers: {
      p: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY_P" },
      bq: { kind: "custom" },
    },
    models: [
      { provider: "p", id: "m", tags: ["writing-code"], context: 4096 },
      { provider: "bq", id: "m", tags: ["writing-code"], context: 4096 },
    ],
    agent: { model: "p/m", maxSteps: 4, tools: ["task"], entryAgent: "parent" },
    agents: {
      maxActive: 2,
      parent: { model: "p/m", maxSteps: 4, tools: ["task"] },
      qa: { model: "bq/m", maxSteps: 2, tools: [], systemPrompt: "child-q" },
    },
    plugins: [pluginPath],
    spawn: { parallel: true },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  try {
    const report = await runTask({
      configPath, cwd, task: "fan-out", env: testEnv({ KEY_P: "p" }), approveSwap: () => true,
      trustAsk: () => true,
    });
    expect(report.final).toBe("parent-final");
    const ledger = new Ledger(join(cwd, ".astro", "ledger.jsonl"));
    const created = ledger.readAllEntries().find(
      (entry): entry is LedgerAgentEntry => entry.kind === "agent" && entry.event === "created"
        && entry.run.startsWith(`${report.runId}.task.`),
    );
    expect(created?.credentialRef).toBe(providerAccountRefFor("bq", { kind: "custom" } as never));
    expect(activeLocks(ledger)).toEqual([]);
  } finally {
    server.stop(true);
  }
});

test("reserva de budget impede o segundo filho paralelo a 0.985 + 0.01", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-task-fanout-budget-"));
  const ledgerPath = join(cwd, ".astro", "ledger.jsonl");
  mkdirSync(join(cwd, ".astro"), { recursive: true });
  appendFileSync(ledgerPath, `${JSON.stringify({
    schemaVersion: 3, kind: "usage", seq: 1, ts: new Date().toISOString(),
    run: "seed", agent: "seed", provider: "p", model: "m", credentialRef: "KEY_P",
    quotaDomain: "default", tokensIn: 0, tokensOut: 0, costUsd: 0.985,
  })}\n`);
  let childCalls = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { messages: Array<{ role: string; content: string }> };
      const system = body.messages[0]?.content ?? "";
      if (system === "child-q" || system === "child-r") {
        childCalls++;
        return final(`${system}-final`);
      }
      if (body.messages.some((message) => message.role === "tool")) return final("parent-final");
      return Response.json({
        choices: [{
          message: {
            content: "",
            tool_calls: [{
              id: "t1", type: "function",
              function: {
                name: "task",
                arguments: JSON.stringify({
                  tasks: [{ agent: "qa", prompt: "q" }, { agent: "rb", prompt: "r" }],
                }),
              },
            }],
          },
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    },
  });
  const configPath = join(cwd, "astro.config.json");
  writeFileSync(configPath, JSON.stringify({
    providers: {
      p: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY_P" },
      q: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY_Q" },
      r: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY_R" },
    },
    models: [
      { provider: "p", id: "m", tags: ["writing-code"], context: 1000, price: { inputPerM: 0, outputPerM: 0, fonte: "test", verificado: false } },
      { provider: "q", id: "m", tags: ["writing-code"], context: 1000, price: { inputPerM: 10, outputPerM: 10, fonte: "test", verificado: false } },
      { provider: "r", id: "m", tags: ["writing-code"], context: 1000, price: { inputPerM: 10, outputPerM: 10, fonte: "test", verificado: false } },
    ],
    agent: { model: "p/m", maxSteps: 6, tools: ["task"], entryAgent: "parent" },
    agents: {
      maxActive: 3,
      parent: { model: "p/m", maxSteps: 6, tools: ["task"] },
      qa: { model: "q/m", maxSteps: 3, tools: [], systemPrompt: "child-q" },
      rb: { model: "r/m", maxSteps: 3, tools: [], systemPrompt: "child-r" },
    },
    budget: { scope: "day", limitUsd: 2, warnAt: 0.8, onExceed: "stop", hardCeilingUsd: 1 },
    spawn: { parallel: true },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  try {
    const report = await runTask({
      configPath, cwd, task: "fan-out", env: env(), approveSwap: () => true,
    });
    expect(report.final).toBe("parent-final");
    expect(childCalls).toBe(1);
    const hits = new Ledger(ledgerPath).readAllEntries().filter(
      (entry) => entry.kind === "budget" && entry.event === "ceiling_hit",
    );
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(budgetStatus({ scope: "day", limitUsd: 2, warnAt: 0.8, onExceed: "stop", hardCeilingUsd: 1 },
      new Ledger(ledgerPath)).spentUsd!).toBeLessThanOrEqual(1);
  } finally {
    server.stop(true);
  }
});
