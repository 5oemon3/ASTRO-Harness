import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/app";
import { Auditor } from "../src/audit";
import { Ledger } from "../src/ledger";

const final = (content: string): Response =>
  Response.json({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });

const toolCall = (name: string, args: unknown): Response =>
  Response.json({
    choices: [{
      message: {
        content: "",
        tool_calls: [{ id: `c-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });

test("runTask: plan → task(build) → handoff(reviewer) completa a cadeia (#58)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-task-handoff-"));
  const calls = { plan: 0, build: 0, reviewer: 0 };
  const unknown: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { messages: Array<{ role: string; content: string }> };
      const system = body.messages[0]?.content ?? "";
      if (system === "plan-agent") {
        calls.plan += 1;
        if (calls.plan === 1) {
          return toolCall("task", { agent: "build", prompt: "implemente a feature" });
        }
        return toolCall("handoff", {
          to: "reviewer",
          task: "revisar a implementação",
          objective: "revisão aprovada",
          decisions: [],
          constraints: [],
          next_steps: [],
        });
      }
      if (system === "build-agent") {
        calls.build += 1;
        return final("build-final");
      }
      if (system === "reviewer-agent") {
        calls.reviewer += 1;
        return final("review-final");
      }
      unknown.push(system);
      return final("unknown-agent");
    },
  });
  const configPath = join(cwd, "astro.config.json");
  writeFileSync(configPath, JSON.stringify({
    providers: {
      p: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" },
      q: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY2" },
    },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "p/m1", maxSteps: 5, tools: ["task", "handoff", "read_file"], entryAgent: "plan" },
    agents: {
      plan: { model: "p/m1", maxSteps: 3, tools: ["task", "handoff"], permission: "full", systemPrompt: "plan-agent" },
      build: { model: "p/m1", maxSteps: 2, tools: [], permission: "write", systemPrompt: "build-agent" },
      reviewer: { model: "p/m1", maxSteps: 2, tools: [], permission: "write", systemPrompt: "reviewer-agent" },
    },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  try {
    const result = await runTask({
      configPath, cwd, task: "planeje e entregue", env: { KEY: "k", KEY2: "k2" },
      permissionMode: "bypass", approveTool: () => true,
    });
    expect(result.final).toBe("review-final");
    expect(calls).toEqual({ plan: 2, build: 1, reviewer: 1 });
    expect(unknown).toEqual([]);

    const audit = new Auditor(join(cwd, ".astro", "audit.jsonl")).readAll();
    expect(audit.find((event) => event.tipo === "task.delegated")?.payload)
      .toMatchObject({ fromAgent: "plan", toAgent: "build" });
    expect(audit.some((event) => event.tipo === "agent.switch"
      && (event.payload as { to?: string }).to === "reviewer")).toBe(true);
    expect(audit.some((event) => event.tipo === "account_locked" || event.tipo === "agent.lock.denied")).toBe(false);

    const ledger = new Ledger(join(cwd, ".astro", "ledger.jsonl")).byAgent();
    expect(ledger.build?.tokensIn).toBeGreaterThan(0);
    expect(ledger.reviewer?.tokensIn).toBeGreaterThan(0);
  } finally {
    server.stop(true);
  }
});
