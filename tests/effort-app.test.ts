import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/core/app";
import { Ledger } from "../src/ledger";
import { testEnv } from "./setup";

const MAP = { "0": "minimal", "1": "low", "2": "medium", "3": "high", "4": "max" };
const model = (id = "m") => ({
  provider: "mock", id, tags: ["writing-code"], context: 8192,
  price: { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false },
  call: { effort: { param: "reasoning.effort", map: MAP } },
});
const reply = (content: string): Response => Response.json({
  choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 },
});
const replyTool = (name: string, args: unknown, id: string): Response => Response.json({
  choices: [{
    message: {
      content: "",
      tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
    },
  }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});
const write = (path: string, id: string) => replyTool("write_file", { path, content: "x" }, id);
const base = (cwd: string, port: number, over: Record<string, unknown>) => ({
  providers: { mock: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${port}/v1`, credentialRef: "KEY" } },
  models: [model()],
  agent: { model: "mock/m", maxSteps: 5, tools: ["write_file"] },
  run: { noProgressSegments: 2 },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  ...over,
});
/** `effort` é política do usuário: vive na camada global, nunca no projeto. */
function effortEnv(extra: Record<string, string> = {}): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), "astro-effort-home-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({
    effort: { auto: true, autoJumpMax: 1, maxCumulativeJump: 3 },
  }));
  return testEnv({ ASTRO_HOME: home, ...extra });
}

describe("escalada em runTask (#451)", () => {
  test("resume real (runTask --resume) restaura o lock no mesmo run", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-effort-resume-"));
    const efforts: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { reasoning?: { effort?: string } };
        efforts.push(body.reasoning?.effort ?? "");
        return efforts.length <= 3 ? write("a.txt", `c${efforts.length}`) : reply("retomado ok");
      },
    });
    const configPath = join(cwd, "astro.config.json");
    writeFileSync(configPath, JSON.stringify(base(cwd, server.port!, {
      agent: { model: "mock/m", maxSteps: 3, tools: ["write_file"] },
    })));
    try {
      await expect(runTask({ configPath, runId: "r1", task: "t", cwd, env: effortEnv({ KEY: "k" }) }))
        .rejects.toThrow(/passos/);
      const ledger = new Ledger(join(cwd, ".astro", "ledger.jsonl"));
      expect(ledger.lastState("r1")?.state).toBe("interrupted");
      expect(ledger.lastEffortJump("r1", "default")).toMatchObject({ from: 2, to: 3 });
      expect(efforts).toEqual(["medium", "medium", "high"]);

      const report = await runTask({ configPath, resume: "r1", task: "continue", cwd, env: effortEnv({ KEY: "k" }) });
      expect(report.runId).toBe("r1");
      expect(efforts).toEqual(["medium", "medium", "high", "high"]);
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("task child tem lock próprio e não herda o nível corrente do pai", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-effort-task-"));
    const calls: Array<{ system: string; effort: string }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as {
          messages: Array<{ role: string; content: string }>;
          reasoning?: { effort?: string };
        };
        const system = body.messages[0]?.content ?? "";
        calls.push({ system, effort: body.reasoning?.effort ?? "" });
        const own = calls.filter((call) => call.system === system).length;
        if (system === "child-agent") {
          return own < 3 ? write("child.txt", `k${own}`) : reply("child-final");
        }
        if (own === 3) return replyTool("task", { agent: "builder", prompt: "sub" }, "t1");
        return own < 3 ? write("parent.txt", `p${own}`) : reply("parent-final");
      },
    });
    const configPath = join(cwd, "astro.config.json");
    writeFileSync(configPath, JSON.stringify(base(cwd, server.port!, {
      agent: { model: "mock/m", maxSteps: 5, tools: ["task", "write_file"], entryAgent: "planner" },
      agents: {
        maxActive: 1,
        planner: { model: "mock/m", maxSteps: 5, tools: ["task", "write_file"], systemPrompt: "parent-agent" },
        builder: { model: "mock/m", maxSteps: 5, tools: ["write_file"], systemPrompt: "child-agent" },
      },
    })));
    try {
      const report = await runTask({ configPath, runId: "r1", task: "t", cwd, env: effortEnv({ KEY: "k" }) });
      expect(report.final).toBe("parent-final");
      const effortOf = (system: string) =>
        calls.filter((call) => call.system === system).map((call) => call.effort);
      expect(effortOf("parent-agent")).toEqual(["medium", "medium", "high", "high"]);
      expect(effortOf("child-agent")).toEqual(["medium", "medium", "high"]);
      // #476: o custo do pai inclui o run do filho (`run.task.*`), nunca outro run
      expect(report.tokensIn).toBe(70);
      expect(report.costUsd).toBeCloseTo(0.000105, 10);

      const ledger = new Ledger(join(cwd, ".astro", "ledger.jsonl"));
      const jumps = ledger.readAllEntries().filter((entry) => entry.kind === "effort");
      expect(jumps.filter((entry) => entry.kind === "effort" && entry.run === "r1"))
        .toMatchObject([{ agent: "planner", from: 2, to: 3 }]);
      expect(jumps.filter((entry) => entry.kind === "effort" && entry.run.startsWith("r1.task.")))
        .toMatchObject([{ agent: "builder", from: 2, to: 3 }]);
    } finally {
      server.stop(true);
    }
  }, 30_000);
});
