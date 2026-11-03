import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { PermissionPendingError } from "../src/permissions";
import { createTaskTool, type TaskDelegator } from "../src/tools/task";
import { ToolExecutor } from "../src/tools/executor";

const SENTINEL = ["s", "k", "-"].join("") + "live-abcdef12345";
const PROMPT = "prompt privado do usuario 123";

function setup(delegate?: TaskDelegator) {
  const cwd = mkdtempSync(join(tmpdir(), "astro-task-tool-"));
  const audit = new Auditor(join(cwd, "audit.jsonl"));
  const calls: Parameters<TaskDelegator>[0][] = [];
  const tool = createTaskTool({
    audit,
    knownAgents: () => ["build", "plan"],
    delegate: delegate ?? (async (input) => {
      calls.push(input);
      return `final:${input.agent}`;
    }),
  });
  return { cwd, audit, tool, calls };
}

function ctx(cwd: string) {
  return { cwd, run: "r1", agent: "plan", maxSteps: 7 };
}

describe("task tool manifest/validation (#58)", () => {
  test("manifesto: risk medium, permission write, timeout 120s", () => {
    const { tool } = setup();
    expect(tool.manifest.name).toBe("task");
    expect(tool.manifest.risk).toBe("medium");
    expect(tool.manifest.permission).toBe("write");
    expect(tool.manifest.timeoutMs).toBe(120000);
  });

  test("recusa agent desconhecido, prompt vazio e context inválido", async () => {
    const { cwd, tool, calls } = setup();
    expect(await tool.execute({ agent: "ghost", prompt: "x" }, ctx(cwd))).toMatchObject({ isError: true });
    expect(await tool.execute({ agent: "build", prompt: "  " }, ctx(cwd))).toMatchObject({ isError: true });
    expect(await tool.execute({ agent: "build", prompt: "x", context: 1 }, ctx(cwd))).toMatchObject({ isError: true });
    expect(calls).toHaveLength(0);
  });

  test("compõe context + prompt, passa fromAgent/maxSteps/signal e devolve o final", async () => {
    const { cwd, tool, calls } = setup();
    const signal = new AbortController().signal;
    const result = await tool.execute(
      { agent: "build", prompt: PROMPT, context: "contexto explícito" },
      { ...ctx(cwd), signal, allow: ["read_file"], permission: "write" },
    );
    expect(result).toEqual({ output: "final:build" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      agent: "build", fromAgent: "plan", maxSteps: 7, signal,
      callerAllow: ["read_file"], callerPermission: "write",
      prompt: `contexto explícito\n\n${PROMPT}`,
    });
  });

  test("audit task.delegated guarda promptHash, nunca o prompt", async () => {
    const { cwd, audit, tool } = setup();
    await tool.execute({ agent: "build", prompt: PROMPT }, ctx(cwd));
    const event = audit.readAll().find((item) => item.tipo === "task.delegated");
    expect(event?.payload).toMatchObject({ fromAgent: "plan", toAgent: "build" });
    expect(String(event?.payload?.promptHash)).toMatch(/^[a-f0-9]{16}$/);
    expect(JSON.stringify(event)).not.toContain(PROMPT);
  });

  test("falha do subagente volta como erro redigido", async () => {
    const { cwd, tool } = setup(async () => {
      throw new Error(`falhou com ${SENTINEL}`);
    });
    const result = await tool.execute({ agent: "build", prompt: "x" }, ctx(cwd));
    expect(result.isError).toBe(true);
    expect(result.output).not.toContain(SENTINEL);
    expect(result.output).toContain("[REDACTED]");
  });
});

describe("task tool respeita o perfil de permissão (#58)", () => {
  const run = async (permission: "read-only" | "write") => {
    const { cwd, audit, tool, calls } = setup();
    const executor = new ToolExecutor({
      tools: [tool], allow: ["task"], audit, permission, permissionMode: "bypass",
    });
    const result = await executor.run(
      { cwd, run: "r1", agent: "plan", maxSteps: 7 },
      { id: "c1", name: "task", arguments: JSON.stringify({ agent: "build", prompt: "x" }) },
    );
    return { result, calls };
  };

  test("read-only nega; write executa", async () => {
    const denied = await run("read-only");
    expect(denied.result.isError).toBe(true);
    expect(denied.calls).toHaveLength(0);
    const allowed = await run("write");
    expect(allowed.result.isError).not.toBe(true);
    expect(allowed.calls).toHaveLength(1);
  });

  test("PermissionPendingError sobe do filho e do executor (I-19)", async () => {
    const { cwd, tool } = setup(async () => {
      throw new PermissionPendingError({ name: "read_file", action: "read_common", mode: "ask" });
    });
    await expect(tool.execute({ agent: "build", prompt: "x" }, ctx(cwd)))
      .rejects.toBeInstanceOf(PermissionPendingError);
    const audit = new Auditor(join(cwd, "audit2.jsonl"));
    const executor = new ToolExecutor({ tools: [tool], allow: ["task"], audit, permissionMode: "bypass" });
    await expect(executor.run(
      { cwd, run: "r1", agent: "plan" },
      { id: "c1", name: "task", arguments: JSON.stringify({ agent: "build", prompt: "x" }) },
    )).rejects.toBeInstanceOf(PermissionPendingError);
  });
});
