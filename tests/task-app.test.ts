import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/app";
import { Auditor } from "../src/audit";
import { Ledger } from "../src/ledger";

const final = (content: string): Response =>
  Response.json({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });

test("runTask: task delega em run próprio sem conflitar o lock da conta (#58)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-task-app-"));
  const requests: string[] = [];
  let childCalls = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { messages: Array<{ role: string; content: string }> };
      const system = body.messages[0]?.content ?? "";
      requests.push(system);
      if (system === "build-agent") {
        childCalls++;
        // Chamada 1 do filho tenta run_command; o perfil herdado (write) deve negar.
        return childCalls === 1
          ? Response.json({
              choices: [{
                message: {
                  content: "",
                  tool_calls: [{
                    id: "c1", type: "function",
                    function: { name: "run_command", arguments: JSON.stringify({ command: "echo x" }) },
                  }],
                },
              }],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            })
          : final("child-final");
      }
      if (body.messages.some((message) => message.role === "tool")) return final("parent-final");
      return Response.json({
        choices: [{
          message: {
            content: "",
            tool_calls: [{
              id: "t1", type: "function",
              function: { name: "task", arguments: JSON.stringify({ agent: "build", prompt: "sub tarefa" }) },
            }],
          },
        }],
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
      { provider: "p", id: "m1", tags: ["writing-code"], context: 8192 },
      { provider: "q", id: "m1", tags: ["writing-code"], context: 8192 },
    ],
    agent: { model: "p/m1", maxSteps: 4, tools: ["task", "read_file", "run_command"], entryAgent: "plan" },
    agents: {
      plan: { model: "q/m1", maxSteps: 3, tools: ["task", "run_command"], permission: "write" },
      build: {
        model: "q/m1", maxSteps: 3, tools: ["run_command"], permission: "full", systemPrompt: "build-agent",
      },
    },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  try {
    const result = await runTask({
      configPath,
      cwd,
      task: "tarefa do pai",
      env: { KEY: "k", KEY2: "k2" },
      permissionMode: "bypass",
      approveTool: () => true,
    });
    expect(result.final).toBe("parent-final");
    expect(requests.filter((system) => system === "build-agent")).toHaveLength(2);
    expect(childCalls).toBe(2);
    const ledger = new Ledger(join(cwd, ".astro", "ledger.jsonl"));
    expect(ledger.byAgent().build?.tokensIn).toBeGreaterThan(0);
    const audit = new Auditor(join(cwd, ".astro", "audit.jsonl")).readAll();
    expect(audit.some((event) => event.tipo === "task.delegated")).toBe(true);
    const denied = audit.find((event) => event.tipo === "tool.denied"
      && (event.payload as { name?: string }).name === "run_command");
    expect(denied?.payload).toMatchObject({ required: "execute", permission: "write" });
  } finally {
    server.stop(true);
  }
});
