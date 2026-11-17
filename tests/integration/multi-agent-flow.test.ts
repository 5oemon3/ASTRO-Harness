import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { activeLocks } from "../../src/agent-lock";
import { runTask } from "../../src/core/app";
import { Ledger } from "../../src/ledger";
import { rebuildAgentTree } from "../../src/resume";
import { testEnv } from "../setup";
import { newWorkspace, readAudit, removeWorkspace, startMockProvider, writeConfig } from "./helpers";

const HANDOFF = {
  to: "sub-1",
  task: "construir",
  objective: "criar o arquivo",
  decisions: [],
  constraints: [],
  next_steps: [],
};

test("multi-agent-flow: planner spawna em outra conta, faz handoff e o filho escreve", async () => {
  const provider = startMockProvider([
    { toolCalls: [{ name: "spawn_agent", arguments: { need: "writing-code", task: "construir", tools: ["write_file"] } }] },
    { toolCalls: [{ name: "handoff", arguments: HANDOFF }] },
    { toolCalls: [{ name: "write_file", arguments: { path: "out/build.txt", content: "built by subagent\n" } }] },
    { content: "build ok" },
  ]);
  const dir = newWorkspace("multi-flow");
  const previousMode = process.env.ASTRO_PERMISSION_MODE;
  process.env.ASTRO_PERMISSION_MODE = "bypass";
  try {
    expect(provider.server.hostname).toBe("127.0.0.1");
    const configPath = writeConfig(dir, {
      providers: {
        p1: { kind: "openai-compat", baseUrl: provider.baseUrl, credentialRef: "KEY1" },
        p2: { kind: "openai-compat", baseUrl: provider.baseUrl, credentialRef: "KEY2" },
      },
      models: [
        { provider: "p1", id: "m1", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } },
        { provider: "p2", id: "m1", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } },
      ],
      modelPool: { builder: { model: "p2/m1" } },
      pricing: {
        "p1/m1": { inputPerM: 2, outputPerM: 4, fonte: "teste", verificado: true },
        "p2/m1": { inputPerM: 2, outputPerM: 4, fonte: "teste", verificado: true },
      },
      agent: { model: "p1/m1", maxSteps: 8, tools: ["spawn_agent", "handoff", "write_file"], entryAgent: "planner" },
      agents: { planner: { model: "p1/m1", maxSteps: 8, tools: ["spawn_agent", "handoff", "write_file"] } },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    });

    const report = await runTask({
      configPath,
      task: "planeje e delegue a construção",
      cwd: dir,
      env: testEnv({ KEY1: "key-one", KEY2: "key-two" }),
      permissionMode: "allow-edits",
      approveTool: () => true,
      approveSwap: () => true,
    });

    expect(report.final).toBe("build ok");
    expect(report.agentsUsed).toEqual(["planner", "sub-1"]);
    expect(readFileSync(join(dir, "out", "build.txt"), "utf8")).toBe("built by subagent\n");

    const audit = readAudit(dir);
    expect(audit.events.some((event) => event.tipo === "agent.spawned")).toBe(true);
    expect(audit.events.some((event) => event.tipo === "agent.switch")).toBe(true);
    expect(audit.events.find((event) => event.tipo === "mode.changed")?.payload.mode).toBe("allow-edits");
    expect(audit.text.includes("key-one")).toBe(false);
    expect(audit.text.includes("key-two")).toBe(false);

    const ledger = new Ledger(join(dir, ".astro", "ledger.jsonl"));
    expect(rebuildAgentTree(ledger, report.runId).nodes.map((node) => node.agent_id)).toEqual(["planner", "sub-1"]);
    const byAgent = ledger.byAgent();
    const planner = Object.values(byAgent).find((row) => row.agent === "planner");
    const child = Object.values(byAgent).find((row) => row.agent === "sub-1");
    expect(planner?.provider).toBe("p1");
    expect(child?.provider).toBe("p2");
    expect((child?.tokensIn ?? 0) + (child?.tokensOut ?? 0)).toBeGreaterThan(0);
    expect(child?.costUsd ?? 0).toBeGreaterThan(0);
    expect(planner?.costUsd ?? 0).toBeGreaterThan(0);
    expect(activeLocks(ledger)).toEqual([]);
  } finally {
    provider.server.stop(true);
    removeWorkspace(dir);
    if (previousMode === undefined) delete process.env.ASTRO_PERMISSION_MODE;
    else process.env.ASTRO_PERMISSION_MODE = previousMode;
  }
}, 30000);

test("multi-agent-flow: task delega e o filho não excede a permissão do agente", async () => {
  const provider = startMockProvider([
    { toolCalls: [{ name: "task", arguments: { agent: "builder", prompt: "tente escrever o arquivo" } }] },
    { toolCalls: [{ name: "write_file", arguments: { path: "out/child.txt", content: "forbidden\n" } }] },
    { content: "child blocked" },
    { toolCalls: [{ name: "write_file", arguments: { path: "out/boundary.txt", content: "boundary respected\n" } }] },
    { content: "boundary ok" },
  ]);
  const dir = newWorkspace("multi-boundary");
  const previousMode = process.env.ASTRO_PERMISSION_MODE;
  process.env.ASTRO_PERMISSION_MODE = "bypass";
  try {
    expect(provider.server.hostname).toBe("127.0.0.1");
    const configPath = writeConfig(dir, {
      providers: {
        p1: { kind: "openai-compat", baseUrl: provider.baseUrl, credentialRef: "KEY1" },
        p2: { kind: "openai-compat", baseUrl: provider.baseUrl, credentialRef: "KEY2" },
      },
      models: [
        { provider: "p1", id: "m1", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } },
        { provider: "p2", id: "m1", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } },
      ],
      agent: { model: "p1/m1", maxSteps: 8, tools: ["task", "write_file"], entryAgent: "planner" },
      agents: {
        planner: { model: "p1/m1", maxSteps: 8, tools: ["task", "write_file"] },
        builder: { model: "p1/m1", maxSteps: 4, tools: ["write_file"], permission: "read-only" },
      },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    });

    const report = await runTask({
      configPath,
      task: "delegue sem furar a permissão do filho",
      cwd: dir,
      env: testEnv({ KEY1: "key-one", KEY2: "key-two" }),
      permissionMode: "allow-edits",
      approveTool: () => true,
      approveSwap: () => true,
    });

    expect(report.final).toBe("boundary ok");
    expect(existsSync(join(dir, "out", "child.txt"))).toBe(false);
    expect(readFileSync(join(dir, "out", "boundary.txt"), "utf8")).toBe("boundary respected\n");

    const audit = readAudit(dir);
    expect(audit.events.some((event) => event.tipo === "task.delegated")).toBe(true);
    expect(audit.events.find((event) => event.tipo === "mode.changed")?.payload.mode).toBe("allow-edits");
    const denied = audit.events.find((event) => event.tipo === "tool.denied");
    expect(denied?.payload).toMatchObject({ name: "write_file" });
    expect(String(denied?.payload.reason)).toContain("read-only");
    expect(activeLocks(new Ledger(join(dir, ".astro", "ledger.jsonl")))).toEqual([]);
  } finally {
    provider.server.stop(true);
    removeWorkspace(dir);
    if (previousMode === undefined) delete process.env.ASTRO_PERMISSION_MODE;
    else process.env.ASTRO_PERMISSION_MODE = previousMode;
  }
}, 30000);
