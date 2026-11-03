import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { Ledger } from "../src/ledger";
import { validateConfig } from "../src/config";
import {
  AGENT_PERMISSIONS,
  mostRestrictive,
  permissionAllows,
  requiredPermission,
  type AgentPermission,
} from "../src/permissions";
import type { CompletionResponse, Provider } from "../src/provider/types";
import type { AgentEntry, ModelEntry } from "../src/registry";
import { runMultiAgentSession, type MultiAgentSessionOptions } from "../src/session";
import { ToolExecutor } from "../src/tools/executor";
import type { Tool, ToolClass } from "../src/tools/types";

function fakeTool(
  name: string,
  klass: ToolClass,
  permission: string,
  onRun?: () => void,
): Tool {
  return {
    manifest: {
      name, description: name, parameters: {}, risk: "low", permission, class: klass,
      timeoutMs: 1000, retryable: false, idempotent: true, sideEffects: "none",
    },
    execute: async () => {
      onRun?.();
      return { output: `${name}:ok` };
    },
  };
}

describe("requiredPermission/permissionAllows (#58)", () => {
  test("mapeia classe e tools especiais", () => {
    expect(requiredPermission(fakeTool("read_file", "read_common", "read").manifest)).toBe("read-only");
    expect(requiredPermission(fakeTool("read_critical", "read_critical", "read").manifest)).toBe("read-only");
    expect(requiredPermission(fakeTool("write_file", "edit", "write").manifest)).toBe("write");
    expect(requiredPermission(fakeTool("delete_file", "delete", "write").manifest)).toBe("write");
    expect(requiredPermission(fakeTool("run_command", "shell", "execute").manifest)).toBe("execute");
    expect(requiredPermission(fakeTool("handoff", "read_common", "handoff").manifest)).toBe("full");
    expect(requiredPermission(fakeTool("spawn_agent", "read_common", "spawn_agent").manifest)).toBe("execute");
    expect(requiredPermission(fakeTool("swap", "identity_swap", "swap").manifest)).toBe("full");
    // sideEffects eleva mesmo com classe read_common (MCP http/sse)
    expect(requiredPermission({ ...fakeTool("mcp_http", "read_common", "read").manifest, sideEffects: "network" })).toBe("execute");
    expect(requiredPermission({ ...fakeTool("mcp_write", "read_common", "read").manifest, sideEffects: "filesystem" })).toBe("write");
    // permission declarada eleva mesmo com classe read_common (plugin)
    expect(requiredPermission(fakeTool("plugin_exec", "read_common", "execute").manifest)).toBe("execute");
    // classe desconhecida falha fechada
    expect(requiredPermission({ ...fakeTool("x", "read_common", "read").manifest, class: "mystery" as ToolClass })).toBe("full");
  });

  test("mostRestrictive compõe o perfil com a base", () => {
    expect(mostRestrictive("full", "read-only")).toBe("read-only");
    expect(mostRestrictive("write", "execute")).toBe("write");
    expect(mostRestrictive("full", "full")).toBe("full");
  });

  test("matriz de permissões é monotônica", () => {
    const expected: Record<AgentPermission, AgentPermission[]> = {
      "read-only": ["read-only"],
      write: ["read-only", "write"],
      execute: ["read-only", "write", "execute"],
      full: ["read-only", "write", "execute", "full"],
    };
    for (const granted of AGENT_PERMISSIONS) {
      for (const required of AGENT_PERMISSIONS) {
        expect(permissionAllows(granted, required)).toBe(expected[granted].includes(required));
      }
    }
  });
});

describe("ToolExecutor enforcement por permissão (#58)", () => {
  function executor(granted: AgentPermission, tools: Tool[], audit: Auditor): ToolExecutor {
    return new ToolExecutor({
      tools, allow: tools.map((tool) => tool.manifest.name), audit, permission: granted, permissionMode: "bypass",
    });
  }
  const names = ["read_file", "write_file", "run_command", "handoff"] as const;
  const makeTools = (): Tool[] => [
    fakeTool("read_file", "read_common", "read"),
    fakeTool("write_file", "edit", "write"),
    fakeTool("run_command", "shell", "execute"),
    fakeTool("handoff", "read_common", "handoff"),
  ];

  test("read-only só lê; write nega shell/handoff; execute nega handoff; full permite", async () => {
    const allowedBy: Record<AgentPermission, string[]> = {
      "read-only": ["read_file"],
      write: ["read_file", "write_file"],
      execute: ["read_file", "write_file", "run_command"],
      full: [...names],
    };
    for (const granted of AGENT_PERMISSIONS) {
      const cwd = mkdtempSync(join(tmpdir(), "astro-agent-perm-"));
      const audit = new Auditor(join(cwd, "audit.jsonl"));
      const ex = executor(granted, makeTools(), audit);
      for (const name of names) {
        const result = await ex.run({ cwd, run: "r", agent: "plan" }, { id: name, name, arguments: "{}" });
        expect(result.isError === true).toBe(!allowedBy[granted].includes(name));
      }
      const denied = audit.readAll().filter((event) => event.tipo === "tool.denied");
      const deniedNames = denied.map((event) => (event.payload as { name?: string }).name);
      expect(deniedNames).toEqual(names.filter((name) => !allowedBy[granted].includes(name)));
      expect(denied.every((event) => String((event.payload as { reason?: string }).reason).includes("permissão"))).toBe(true);
    }
  });
});

describe("config agents.permission (#58)", () => {
  const valid = {
    providers: { openai: { kind: "openai-compat", baseUrl: "https://api.openai.com/v1", credentialRef: "OPENAI_API_KEY" } },
    models: [{ provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000 }],
    agent: { model: "openai/gpt-4o-mini", maxSteps: 2, tools: ["read_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  };
  const withPlan = (plan: Record<string, unknown>) => validateConfig({
    ...structuredClone(valid),
    agents: { maxActive: 1, plan: { model: "openai/gpt-4o-mini", tools: ["read_file"], ...plan } },
  });

  test("aceita as quatro permissões e ausência (default full no runtime)", () => {
    expect(withPlan({ permission: "read-only" }).agents!.plan.permission).toBe("read-only");
    expect(withPlan({ permission: "write" }).agents!.plan.permission).toBe("write");
    expect(withPlan({ permission: "execute" }).agents!.plan.permission).toBe("execute");
    expect(withPlan({}).agents!.plan.permission).toBeUndefined();
  });

  test("permissão fora do vocabulário → ConfigError", () => {
    for (const permission of ["root", "readonly", "", null, 1]) {
      expect(() => withPlan({ permission })).toThrow(/permission/);
    }
  });
});

describe("runMultiAgentSession aplica a permissão do agent (#58)", () => {
  const model: ModelEntry = {
    provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000, status: "active",
    price: { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false },
  };
  const resp = (p: Partial<CompletionResponse>): CompletionResponse => ({
    content: "", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, ...p,
  });

  async function run(
    permission: AgentPermission | undefined,
    basePermission: AgentPermission = "full",
  ): Promise<{ writes: number; shells: number; audit: Auditor; final: string }> {
    const cwd = mkdtempSync(join(tmpdir(), "astro-agent-perm-session-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const ledger = new Ledger(join(cwd, "ledger.jsonl"));
    let writes = 0;
    let shells = 0;
    const tools = [
      fakeTool("read_file", "read_common", "read"),
      fakeTool("write_file", "edit", "write", () => { writes++; }),
      fakeTool("run_command", "shell", "execute", () => { shells++; }),
    ];
    let call = 0;
    const provider: Provider = {
      complete: async () => {
        call++;
        return call === 1
          ? resp({ toolCalls: [
              { id: "w", name: "write_file", arguments: "{}" },
              { id: "s", name: "run_command", arguments: "{}" },
            ] })
          : resp({ content: "fim" });
      },
    };
    const agents: Record<string, AgentEntry> = {
      plan: {
        model: "openai/gpt-4o-mini", maxSteps: 3, tools: ["read_file", "write_file", "run_command"],
        ...(permission === undefined ? {} : { permission }),
      },
    };
    const opts: MultiAgentSessionOptions = {
      run: "r1", credentialRef: "OPENAI_API_KEY", quotaDomain: "default",
      cwd, provider,
      registry: {
        requireAgent(name: string): AgentEntry {
          const agent = agents[name];
          if (agent === undefined) throw new Error(`agent "${name}" não encontrado`);
          return agent;
        },
        getAgent(name: string): AgentEntry | undefined {
          return agents[name];
        },
      },
      baseModel: model,
      baseExecutor: new ToolExecutor({
        approveTool: () => true, tools, allow: tools.map((tool) => tool.manifest.name), audit, permission: basePermission,
      }),
      ledger, audit, baseMaxSteps: 5, entryAgent: "plan",
    };
    const result = await runMultiAgentSession(opts, "plan");
    return { writes, shells, audit, final: result.final };
  }

  test("plan read-only não executa write_file nem run_command", async () => {
    const r = await run("read-only");
    expect(r.final).toBe("fim");
    expect(r.writes).toBe(0);
    expect(r.shells).toBe(0);
    const denied = r.audit.readAll().filter((event) => event.tipo === "tool.denied");
    expect(denied.map((event) => (event.payload as { name?: string }).name)).toEqual(["write_file", "run_command"]);
  });

  test("base executor mais restritivo vence o perfil do agent", async () => {
    const r = await run("full", "read-only");
    expect(r.writes).toBe(0);
    expect(r.shells).toBe(0);
  });

  test("sem permission (default full) as tools executam", async () => {
    const r = await run(undefined);
    expect(r.writes).toBe(1);
    expect(r.shells).toBe(1);
  });
});
