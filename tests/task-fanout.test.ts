import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { NoProgressError } from "../src/loop-guard";
import { PermissionPendingError } from "../src/permissions";
import { createTaskTool, type TaskDelegator } from "../src/tools/task";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(opts: {
  parallel?: boolean;
  delegate?: TaskDelegator;
  activeCount?: () => number;
  maxActive?: number;
} = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "astro-task-fanout-"));
  const audit = new Auditor(join(cwd, "audit.jsonl"));
  const probe = { active: 0, max: 0, calls: [] as Array<{ agent: string; prompt: string }> };
  const delegate: TaskDelegator = opts.delegate ?? (async (input) => {
    probe.active++;
    probe.max = Math.max(probe.max, probe.active);
    probe.calls.push({ agent: input.agent, prompt: input.prompt });
    try {
      await delay(20);
      return `${input.agent}:${input.prompt}`;
    } finally {
      probe.active--;
    }
  });
  const tool = createTaskTool({
    audit,
    knownAgents: () => ["a", "b"],
    delegate,
    ...(opts.parallel === undefined ? {} : { parallel: opts.parallel }),
    maxActive: opts.maxActive ?? 2,
    accountOf: (agent) => `account-${agent}`,
    ...(opts.activeCount === undefined ? {} : { activeCount: opts.activeCount }),
  });
  const ctx = { cwd, run: "r1", agent: "plan", maxSteps: 7 };
  return { tool, audit, probe, ctx };
}

describe("task fan-out (A11)", () => {
  test("paralelo respeita maxActive, preserva a ordem de entrada e audita em ordem", async () => {
    const { tool, audit, probe, ctx } = setup({ parallel: true, activeCount: () => 0 });
    const result = await tool.execute({
      tasks: [{ agent: "a", prompt: "um" }, { agent: "b", prompt: "dois" }],
    }, ctx);

    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(result.output) as { tasks: Array<{ taskId: string; agent: string; status: string; output: string }> };
    expect(parsed.tasks.map((item) => [item.taskId, item.agent, item.status])).toEqual([
      ["t1", "a", "ok"], ["t2", "b", "ok"],
    ]);
    expect(parsed.tasks.map((item) => item.output)).toEqual(["a:um", "b:dois"]);
    expect(probe.max).toBe(2);
    // Audit do run pai é determinístico mesmo com os filhos terminando fora de ordem.
    const delegated = audit.readAll().filter((event) => event.tipo === "task.delegated");
    expect(delegated.map((event) => event.payload.toAgent)).toEqual(["a", "b"]);
    expect(delegated.map((event) => event.payload.taskId)).toEqual(["t1", "t2"]);
  });

  test("fan-out sem a flag é serial (default inalterado)", async () => {
    const { tool, probe, ctx } = setup();
    const result = await tool.execute({
      tasks: [{ agent: "a", prompt: "um" }, { agent: "b", prompt: "dois" }],
    }, ctx);
    expect(JSON.parse(result.output).tasks.map((item: { status: string }) => item.status)).toEqual(["ok", "ok"]);
    expect(probe.max).toBe(1);
  });

  test("falha de um filho volta no resultado sem abortar o outro", async () => {
    const { tool, ctx } = setup({
      parallel: true,
      delegate: async (input) => {
        if (input.agent === "b") throw new Error("falha em b");
        return `${input.agent}:ok`;
      },
    });
    const result = await tool.execute({
      tasks: [{ agent: "a", prompt: "um" }, { agent: "b", prompt: "dois" }],
    }, ctx);
    const parsed = JSON.parse(result.output).tasks;
    expect(parsed[0]).toMatchObject({ agent: "a", status: "ok", output: "a:ok" });
    expect(parsed[1]).toMatchObject({ agent: "b", status: "error" });
    expect(parsed[1].error).toContain("falha em b");
  });

  test("valida fan-out: lista vazia, excesso, mistura e item inválido", async () => {
    const { tool, ctx } = setup({ parallel: true });
    for (const input of [
      { tasks: [] },
      { tasks: Array.from({ length: 9 }, () => ({ agent: "a", prompt: "x" })) },
      { agent: "a", prompt: "x", tasks: [{ agent: "b", prompt: "y" }] },
      { tasks: [{ agent: "a" }] },
    ]) {
      expect(await tool.execute(input, ctx)).toMatchObject({ isError: true });
    }
  });

  test("o teto desconta os locks vivos do run (pai incluso)", async () => {
    const { tool, probe, ctx } = setup({ parallel: true, activeCount: () => 1 });
    const result = await tool.execute({
      tasks: [{ agent: "a", prompt: "um" }, { agent: "b", prompt: "dois" }],
    }, ctx);
    expect(JSON.parse(result.output).tasks.map((item: { status: string }) => item.status)).toEqual(["ok", "ok"]);
    expect(probe.max).toBe(1);
  });

  test("sem filho concluído o fan-out é erro de tool", async () => {
    const { tool, ctx } = setup({
      parallel: true,
      delegate: async () => { throw new Error("falha total"); },
    });
    const result = await tool.execute({
      tasks: [{ agent: "a", prompt: "um" }, { agent: "b", prompt: "dois" }],
    }, ctx);
    expect(result.isError).toBe(true);
  });

  test("serial rethrow de PermissionPendingError antes do próximo filho (I-19)", async () => {
    const calls: string[] = [];
    const { tool, ctx } = setup({
      delegate: async (input) => {
        calls.push(input.agent);
        if (input.agent === "a") {
          throw new PermissionPendingError({ name: "read_file", action: "read_common", mode: "ask" });
        }
        return "ok";
      },
    });
    await expect(tool.execute({
      tasks: [{ agent: "a", prompt: "um" }, { agent: "b", prompt: "dois" }],
    }, ctx)).rejects.toBeInstanceOf(PermissionPendingError);
    expect(calls).toEqual(["a"]);
  });

  test("serial rethrow de NoProgressError antes do próximo filho (I-19)", async () => {
    const calls: string[] = [];
    const { tool, ctx } = setup({
      delegate: async (input) => {
        calls.push(input.agent);
        if (input.agent === "a") throw new NoProgressError(2, 3);
        return "ok";
      },
    });
    await expect(tool.execute({
      tasks: [{ agent: "a", prompt: "um" }, { agent: "b", prompt: "dois" }],
    }, ctx)).rejects.toBeInstanceOf(NoProgressError);
    expect(calls).toEqual(["a"]);
  });

  test("task single também respeita o teto antes de auditar ou delegar", async () => {
    const { tool, audit, probe, ctx } = setup({ parallel: true, activeCount: () => 2 });
    const result = await tool.execute({ agent: "a", prompt: "um" }, ctx);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output).error).toBe("spawn_limit_exceeded");
    expect(audit.readAll().filter((event) => event.tipo === "task.delegated")).toHaveLength(0);
    expect(probe.calls).toHaveLength(0);
  });

  test("serial single com lock do pai e maxActive=1 delega normalmente (#451)", async () => {
    const { tool, audit, probe, ctx } = setup({ maxActive: 1, activeCount: () => 1 });
    const result = await tool.execute({ agent: "a", prompt: "um" }, ctx);
    expect(result.isError).not.toBe(true);
    expect(result.output).toBe("a:um");
    expect(probe.calls).toHaveLength(1);
    expect(audit.readAll().filter((event) => event.tipo === "task.delegated")).toHaveLength(1);
  });

  test("serial não consulta activeCount nem o ledger", async () => {
    let reads = 0;
    const { tool, ctx } = setup({
      activeCount: () => {
        reads++;
        throw new Error("ledger lido no caminho serial");
      },
    });
    const result = await tool.execute({ agent: "a", prompt: "um" }, ctx);
    expect(result.output).toBe("a:um");
    expect(reads).toBe(0);
  });

  test("single gated com um slot livre delega", async () => {
    const { tool, probe, ctx } = setup({ parallel: true, activeCount: () => 1 });
    const result = await tool.execute({ agent: "a", prompt: "um" }, ctx);
    expect(result.isError).not.toBe(true);
    expect(result.output).toBe("a:um");
    expect(probe.calls).toHaveLength(1);
  });

  test("maxActive/live fracionários normalizam sem RangeError", async () => {
    const { tool, ctx } = setup({ parallel: true, maxActive: 2.5, activeCount: () => 1.2 });
    const result = await tool.execute({
      tasks: [{ agent: "a", prompt: "um" }, { agent: "b", prompt: "dois" }],
    }, ctx);
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.output).tasks.map((item: { status: string }) => item.status)).toEqual(["ok", "ok"]);
  });

  test("serial tasks com a flag desligada não é barrado por slot", async () => {
    const { tool, probe, ctx } = setup({ maxActive: 1, activeCount: () => 1 });
    const result = await tool.execute({
      tasks: [{ agent: "a", prompt: "um" }, { agent: "b", prompt: "dois" }],
    }, ctx);
    expect(JSON.parse(result.output).tasks.map((item: { status: string }) => item.status)).toEqual(["ok", "ok"]);
    expect(probe.max).toBe(1);
  });

  test("fan-out também recusa sem slot antes de auditar ou delegar", async () => {
    const { tool, audit, probe, ctx } = setup({ parallel: true, activeCount: () => 2 });
    const result = await tool.execute({
      tasks: [{ agent: "a", prompt: "um" }, { agent: "b", prompt: "dois" }],
    }, ctx);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output).error).toBe("spawn_limit_exceeded");
    expect(audit.readAll().filter((event) => event.tipo === "task.delegated")).toHaveLength(0);
    expect(probe.calls).toHaveLength(0);
  });
});
