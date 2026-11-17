import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { chatApprovers } from "../src/chat/approvers";
import type { ReplIO } from "../src/chat/repl";
import { ConfigError, validateConfig } from "../src/core/config";
import {
  actionClassOf,
  isCriticalPath,
  isCriticalReadPath,
  nonInteractiveApprover,
  PermissionPendingError,
  permissionDecision,
  resolvePermissionMode,
  type ActionClass,
  type PermissionDecision,
  type PermissionMode,
  type ToolPermissionRequest,
} from "../src/permissions";
import { editTool } from "../src/tools/edit";
import { ToolExecutor } from "../src/tools/executor";
import { grepTool } from "../src/tools/grep";
import { listDirTool } from "../src/tools/list-dir";
import { lspTool } from "../src/tools/lsp";
import { readFileTool } from "../src/tools/read-file";
import { configureRunCommand, runCommandTool } from "../src/tools/run-command";
import { writeFileTool } from "../src/tools/write-file";
import type { Tool } from "../src/tools/types";

const expected: Record<PermissionMode, Record<ActionClass, PermissionDecision>> = {
  bypass: {
    read_common: "allow", read_critical: "allow", edit: "allow", critical_write: "allow", delete: "allow", shell: "allow", identity: "ask",
  },
  "allow-edits": {
    read_common: "allow", read_critical: "ask", edit: "allow", critical_write: "ask", delete: "ask", shell: "ask", identity: "ask",
  },
  ask: {
    read_common: "allow", read_critical: "ask", edit: "ask", critical_write: "ask", delete: "ask", shell: "ask", identity: "ask",
  },
};

describe("matriz de permissão (#259)", () => {
  test("modo × classe de ação", () => {
    for (const [mode, row] of Object.entries(expected) as [PermissionMode, Record<ActionClass, PermissionDecision>][]) {
      for (const [action, decision] of Object.entries(row) as [ActionClass, PermissionDecision][]) {
        expect({ mode, action, decision: permissionDecision(mode, action) }).toEqual({ mode, action, decision });
      }
    }
  });

  test("troca de identidade nunca é automática, nem em bypass", () => {
    expect(permissionDecision("bypass", "identity")).toBe("ask");
    expect(permissionDecision("allow-edits", "identity")).toBe("ask");
  });

  test("resolução: explícito > config > padrão ask", () => {
    expect(resolvePermissionMode("bypass", "ask")).toBe("bypass");
    expect(resolvePermissionMode(undefined, "allow-edits")).toBe("allow-edits");
    expect(resolvePermissionMode(undefined, undefined)).toBe("ask");
  });

  test("classificação de leitura crítica por caminho", () => {
    expect(isCriticalReadPath(".env")).toBe(true);
    expect(isCriticalReadPath("config/keys/prod.json")).toBe(true);
    expect(isCriticalReadPath(".astro/ledger.jsonl")).toBe(true);
    expect(isCriticalReadPath("src/app.ts")).toBe(false);
  });

  test("classe da ação vem do manifesto da tool", () => {
    const call = (name: string, input: unknown) => ({ name, input });
    expect(actionClassOf(readFileTool, call("read_file", { path: "src/app.ts" }))).toBe("read_common");
    expect(actionClassOf(readFileTool, call("read_file", { path: ".env" }))).toBe("read_critical");
    expect(actionClassOf(writeFileTool, call("write_file", { path: "a.txt", content: "x" }))).toBe("edit");
    expect(actionClassOf(runCommandTool, call("run_command", { command: "echo oi" }))).toBe("shell");
    // `file` de lsp classifica (review A/B); keys.ts casa CRITICAL_PATH_PATTERN
    expect(actionClassOf(lspTool, call("lsp", { command: "hover", file: "src/app.ts", line: 1, column: 1 }))).toBe("read_common");
    expect(actionClassOf(lspTool, call("lsp", { command: "hover", file: "keys.ts", line: 1, column: 1 }))).toBe("read_critical");
  });

  test("allow-sensitive promove escrita normal para critical_write (ADR-0027)", () => {
    const call = (name: string, input: unknown) => ({ name, input });
    const sensitive = () => "sensitive" as const;
    const normal = () => "normal" as const;
    expect(actionClassOf(writeFileTool, call("write_file", { path: "notes.md", content: "x" }), sensitive)).toBe("critical_write");
    expect(actionClassOf(writeFileTool, call("write_file", { path: "notes.md", content: "x" }), normal)).toBe("edit");
    expect(actionClassOf(readFileTool, call("read_file", { path: "notes.md" }), sensitive)).toBe("read_common");
  });

  test("classe declarada read_critical nunca é rebaixada pelo input (#264)", () => {
    const vault: Tool = {
      manifest: {
        name: "vault_read", description: "lê um segredo do vault", parameters: { type: "object", properties: {} },
        risk: "high", permission: "read", class: "read_critical", timeoutMs: 5_000,
        retryable: false, idempotent: true, sideEffects: "none",
      },
      async execute() {
        return { output: "" };
      },
    };
    const call = (input: unknown) => ({ name: "vault_read", input });
    // sem campo path (input usa outro nome) não pode virar read_common
    expect(actionClassOf(vault, call({ secretName: "prod-db" }))).toBe("read_critical");
    // caminho não-crítico também não rebaixa
    expect(actionClassOf(vault, call({ path: "src/app.ts" }))).toBe("read_critical");
    // caminho crítico continua read_critical
    expect(actionClassOf(vault, call({ path: ".env" }))).toBe("read_critical");
  });

  test("config aceita permissions.mode e rejeita valor inválido", () => {
    const base = {
      providers: { p: { kind: "openai-compat", baseUrl: "https://p.example/v1", credentialRef: "KEY" } },
      models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
      agent: { model: "p/m1", maxSteps: 2, tools: ["read_file"] },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    };

    expect(validateConfig(structuredClone(base)).permissions).toEqual({ mode: "ask" });
    expect(validateConfig({ ...structuredClone(base), permissions: { mode: "bypass" } }).permissions)
      .toEqual({ mode: "bypass" });
    expect(() => validateConfig({ ...structuredClone(base), permissions: { mode: "yolo" } })).toThrow(ConfigError);
  });
});

describe("gate no executor (#259)", () => {
  const manifest = {
    description: "teste", parameters: { type: "object", properties: {} },
    risk: "low" as const, permission: "test", timeoutMs: 5_000, retryable: false,
    idempotent: false, sideEffects: "none" as const,
  };

  function setup(tools: Tool[], opts: { mode?: PermissionMode; approve?: () => boolean } = {}) {
    const cwd = mkdtempSync(join(tmpdir(), "astro-perm-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const executor = new ToolExecutor({
      tools,
      allow: tools.map((t) => t.manifest.name),
      audit,
      ...(opts.mode === undefined ? {} : { permissionMode: opts.mode }),
      ...(opts.approve === undefined ? {} : { approveTool: opts.approve }),
    });
    return { cwd, audit, executor };
  }

  test("bypass libera shell no gate; sem sandbox a tool recusa (sandbox_required_for_shell, I-19)", async () => {
    // opt-out do sandbox (#248 default-on): exercita o gate, não a execução no host (slice 4b)
    configureRunCommand({ sandbox: false });
    try {
      const { cwd, executor } = setup([runCommandTool], { mode: "bypass" });
      const result = await executor.run({ cwd, run: "r1", agent: "a", env: { ...process.env } },
        { id: "c1", name: "run_command", arguments: JSON.stringify({ command: "echo oi" }) });
      expect(result.isError).toBe(true); // recusa do sandbox, não de permissão
      expect(result.output).toContain("sandbox_required_for_shell");
      expect(result.output).not.toContain("permissão negada");
    } finally {
      configureRunCommand({ sandbox: true });
    }
  });

  test("ask + approver negando bloqueia a tool e audita", async () => {
    let ran = false;
    const write: Tool = {
      manifest: { ...manifest, name: "write_probe", permission: "write", sideEffects: "filesystem", class: "edit" },
      async execute() {
        ran = true;
        return { output: "ok" };
      },
    };
    const { cwd, audit, executor } = setup([write], { mode: "ask", approve: () => false });
    const result = await executor.run({ cwd, run: "r1", agent: "a" },
      { id: "c1", name: "write_probe", arguments: "{}" });

    expect(ran).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("permiss");
    const decisoes = audit.readAll().filter((e) => e.tipo === "permission.decision");
    expect(decisoes).toHaveLength(1);
    expect(decisoes[0]!.payload).toMatchObject({ name: "write_probe", action: "edit", mode: "ask", decision: "deny" });
  });

  test("ask + approver permitindo executa", async () => {
    let ran = false;
    const write: Tool = {
      manifest: { ...manifest, name: "write_probe", permission: "write", sideEffects: "filesystem", class: "edit" },
      async execute() {
        ran = true;
        return { output: "ok" };
      },
    };
    const { cwd, executor } = setup([write], { mode: "ask", approve: () => true });
    const result = await executor.run({ cwd, run: "r1", agent: "a" },
      { id: "c1", name: "write_probe", arguments: "{}" });

    expect(ran).toBe(true);
    expect(result.isError).toBeFalsy();
  });

  test("gate anexa o diff da tool edit (redacted) ao pedido de aprovação (#64 D2)", async () => {
    const secret = "sk-live-abcdef12345";
    const diff = `@@ -1 +1 @@\n-const a = 1;\n+const k = "${secret}";\n`;
    const cwd = mkdtempSync(join(tmpdir(), "astro-perm-edit-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    let captured: ToolPermissionRequest | undefined;
    const executor = new ToolExecutor({
      tools: [editTool],
      allow: ["edit"],
      audit,
      permissionMode: "ask",
      approveTool: (request) => {
        captured = request;
        return false; // deny: a tool não executa e não precisa de arquivo em disco
      },
    });
    const result = await executor.run({ cwd, run: "r1", agent: "a", env: {} },
      { id: "c1", name: "edit", arguments: JSON.stringify({ path: "a.ts", diff }) });

    expect(result.isError).toBe(true);
    expect(captured?.name).toBe("edit");
    expect(captured?.diff?.path).toBe("a.ts");
    expect(captured?.diff?.content).toContain("+const k = \"[REDACTED]\";");
    expect(captured?.diff?.content).not.toContain(secret);
    // o diff nunca vai para a trilha de auditoria (I-03)
    expect(JSON.stringify(audit.readAll())).not.toContain(secret);
  });

  test("pedido de aprovação de tool que não é edit não traz diff (#64 D2)", async () => {
    const write: Tool = {
      manifest: { ...manifest, name: "write_probe", permission: "write", sideEffects: "filesystem", class: "edit" },
      async execute() {
        return { output: "ok" };
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "astro-perm-nodiff-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    let captured: ToolPermissionRequest | undefined;
    const executor = new ToolExecutor({
      tools: [write],
      allow: ["write_probe"],
      audit,
      permissionMode: "ask",
      approveTool: (request) => {
        captured = request;
        return true;
      },
    });
    await executor.run({ cwd, run: "r1", agent: "a", env: {} },
      { id: "c1", name: "write_probe", arguments: "{}" });
    expect(captured?.diff).toBeUndefined();
  });

  test("edit com input que não é objeto não traz anexo e não quebra o gate (#64 D2)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-perm-edit-nonobj-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    let captured: ToolPermissionRequest | undefined;
    const executor = new ToolExecutor({
      tools: [editTool],
      allow: ["edit"],
      audit,
      permissionMode: "ask",
      approveTool: (request) => {
        captured = request;
        return false;
      },
    });
    const result = await executor.run({ cwd, run: "r1", agent: "a", env: {} },
      { id: "c1", name: "edit", arguments: '"só texto"' });
    expect(result.isError).toBe(true);
    expect(captured?.name).toBe("edit");
    expect(captured?.diff).toBeUndefined();
  });

  test("ask sem aprovador falha fechado: bloqueia e audita deny", async () => {
    let ran = false;
    const write: Tool = {
      manifest: { ...manifest, name: "write_probe", permission: "write", sideEffects: "filesystem", class: "edit" as const },
      async execute() {
        ran = true;
        return { output: "ok" };
      },
    };
    const { cwd, audit, executor } = setup([write], { mode: "ask" }); // sem approveTool
    const result = await executor.run({ cwd, run: "r1", agent: "a" },
      { id: "c1", name: "write_probe", arguments: "{}" });

    expect(ran).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("permiss");
    const decisoes = audit.readAll().filter((e) => e.tipo === "permission.decision");
    expect(decisoes).toHaveLength(1);
    expect(decisoes[0]!.payload).toMatchObject({ name: "write_probe", action: "edit", mode: "ask", decision: "deny" });
  });

  test("piso fixo: bypass não escreve em .astro", async () => {
    const { cwd, executor } = setup([writeFileTool], { mode: "bypass" });
    const result = await executor.run({ cwd, run: "r1", agent: "a" }, {
      id: "c1", name: "write_file",
      arguments: JSON.stringify({ path: ".astro/ledger.jsonl", content: "x" }),
    });

    expect(result.isError).toBe(true);
    expect(existsSync(join(cwd, ".astro", "ledger.jsonl"))).toBe(false);
  });
});

describe("fail closed sem class (#264, P0)", () => {
  function rawTool(onRun: () => void = () => {}): Tool {
    return {
      manifest: {
        name: "raw_plugin",
        description: "tool de plugin sem class",
        parameters: { type: "object", properties: {} },
        risk: "high", permission: "execute", timeoutMs: 1_000,
        retryable: false, idempotent: false, sideEffects: "process",
      } as unknown as Tool["manifest"],
      async execute() {
        onRun();
        return { output: "executou" };
      },
    };
  }

  test("classe desconhecida nega em todos os modos, nunca undefined", () => {
    for (const mode of ["bypass", "allow-edits", "ask"] as const) {
      expect(permissionDecision(mode, "root" as ActionClass)).toBe("deny");
    }
  });

  test("actionClassOf rejeita class ausente/desconhecida", () => {
    expect(() => actionClassOf(rawTool(), { name: "raw_plugin", input: {} })).toThrow(/class/);
    const unknown = rawTool();
    (unknown.manifest as { class?: string }).class = "root";
    expect(() => actionClassOf(unknown, { name: "raw_plugin", input: {} })).toThrow(/class/);
  });

  test("tool crua sem class não executa em ask, mesmo com aprovador", async () => {
    let ran = false;
    const cwd = mkdtempSync(join(tmpdir(), "astro-perm-noclass-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const executor = new ToolExecutor({
      tools: [rawTool(() => { ran = true; })],
      allow: ["raw_plugin"],
      audit,
      permissionMode: "ask",
      approveTool: () => true,
    });
    const result = await executor.run(
      { cwd, run: "r1", agent: "a" },
      { id: "c1", name: "raw_plugin", arguments: "{}" },
    );

    expect(ran).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.code).toBe("invalid_manifest");
    const denied = audit.readAll().filter((e) => e.tipo === "tool.denied");
    expect(denied.at(-1)?.payload).toMatchObject({ name: "raw_plugin", reason: "invalid_manifest" });
  });

  test("tool com class desconhecida também não executa em ask", async () => {
    let ran = false;
    const tool = rawTool(() => { ran = true; });
    (tool.manifest as { class?: string }).class = "root";
    const cwd = mkdtempSync(join(tmpdir(), "astro-perm-unknown-class-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const executor = new ToolExecutor({
      tools: [tool],
      allow: ["raw_plugin"],
      audit,
      permissionMode: "ask",
      approveTool: () => true,
    });
    const result = await executor.run(
      { cwd, run: "r1", agent: "a" },
      { id: "c1", name: "raw_plugin", arguments: "{}" },
    );

    expect(ran).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.code).toBe("invalid_manifest");
  });

  test("manifesto removido após o load nega invalid_manifest, nunca TypeError", async () => {
    let ran = false;
    const tool = rawTool(() => { ran = true; });
    const cwd = mkdtempSync(join(tmpdir(), "astro-perm-nomanifest-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const executor = new ToolExecutor({
      tools: [tool],
      allow: ["raw_plugin"],
      audit,
      permissionMode: "ask",
      approveTool: () => true,
    });
    // Simula plugin que zera o manifesto depois do registro no executor.
    (tool as { manifest: unknown }).manifest = undefined;
    const result = await executor.run(
      { cwd, run: "r1", agent: "a" },
      { id: "c1", name: "raw_plugin", arguments: "{}" },
    );

    expect(ran).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.code).toBe("invalid_manifest");
  });
});

describe("ask sem TTY (#262)", () => {
  test("ask sem aprovador nega, audita pending e não executa", async () => {
    let ran = false;
    const write: Tool = {
      manifest: {
        name: "write_probe", description: "x", parameters: { type: "object", properties: {} },
        risk: "low", permission: "write", timeoutMs: 5_000, retryable: false, idempotent: false, sideEffects: "filesystem",
        class: "edit",
      },
      async execute() {
        ran = true;
        return { output: "ok" };
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "astro-perm-pending-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const executor = new ToolExecutor({
      tools: [write], allow: ["write_probe"], audit, permissionMode: "ask", approveTool: nonInteractiveApprover(),
    });

    const error = (await executor.run({ cwd, run: "r1", agent: "a" },
      { id: "c1", name: "write_probe", arguments: "{}" }).catch((e) => e)) as Error;

    expect(error).toBeInstanceOf(PermissionPendingError);
    expect(error.message).toContain("permiss");
    expect(ran).toBe(false);
    const pending = audit.readAll().filter((e) => e.tipo === "permission.pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.payload).toMatchObject({ name: "write_probe", action: "edit", mode: "ask" });
  });
});

describe("caminhos críticos (#263)", () => {
  test("CRITICAL_PATHS cobre cada categoria com um único classificador", () => {
    const criticos = [
      ".astro/ledger.jsonl",
      ".git/config",
      ".env",
      ".env.local",
      "astro.config.json",
      "sub/.astro/state.json",
      "keys/prod.pem",
      "my-secret.txt",
      "token.json",
      "api_key.txt",
    ];
    for (const path of criticos) {
      expect({ path, critical: isCriticalPath(path) }).toEqual({ path, critical: true });
    }
    for (const path of ["src/app.ts", "README.md", "tests/tools.test.ts", "docs/invariants.md"]) {
      expect({ path, critical: isCriticalPath(path) }).toEqual({ path, critical: false });
    }
  });

  test("gate classifica escrita em caminho crítico", () => {
    const call = (name: string, input: unknown) => ({ name, input });
    expect(actionClassOf(writeFileTool, call("write_file", { path: ".env", content: "x" }))).toBe("critical_write");
    expect(actionClassOf(writeFileTool, call("write_file", { path: "src/a.ts", content: "x" }))).toBe("edit");
  });

  test("critical_write pede aprovação fora do bypass e é liberado no bypass", () => {
    expect(permissionDecision("ask", "critical_write")).toBe("ask");
    expect(permissionDecision("allow-edits", "critical_write")).toBe("ask");
    expect(permissionDecision("bypass", "critical_write")).toBe("allow");
  });

  test("piso: .astro continua bloqueado por protectedPaths mesmo em bypass", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-critical-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const executor = new ToolExecutor({ tools: [writeFileTool], allow: ["write_file"], audit, permissionMode: "bypass" });
    const result = await executor.run({ cwd, run: "r1", agent: "a" }, {
      id: "c1", name: "write_file",
      arguments: JSON.stringify({ path: ".astro/ledger.jsonl", content: "x" }),
    });
    expect(result.isError).toBe(true);
    expect(existsSync(join(cwd, ".astro", "ledger.jsonl"))).toBe(false);
  });
});

describe("grants de sessão (#266)", () => {
  const manifest = {
    name: "write_probe", description: "x", parameters: { type: "object", properties: {} },
    risk: "low" as const, permission: "write", timeoutMs: 5_000, retryable: false,
    idempotent: false, sideEffects: "filesystem" as const, class: "edit" as const,
  };

  function setup(approve: () => boolean | "once" | "session") {
    let ran = 0;
    let asked = 0;
    const tool: Tool = {
      manifest,
      async execute() {
        ran++;
        return { output: "ok" };
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "astro-grants-"));
    const audit = new Auditor(join(cwd, ".astro", "audit.jsonl"));
    const executor = new ToolExecutor({
      tools: [tool],
      allow: ["write_probe"],
      audit,
      permissionMode: "ask",
      approveTool: () => {
        asked++;
        return approve();
      },
    });
    return { cwd, audit, executor, runs: () => ran, asks: () => asked };
  }

  const call = () => ({ id: "c1", name: "write_probe", arguments: "{}" });

  test("once vale para uma chamada só", async () => {
    const s = setup(() => "once");
    const ctx = { cwd: s.cwd, run: "r1", agent: "a" };
    expect((await s.executor.run(ctx, call())).isError).toBeFalsy();
    expect((await s.executor.run(ctx, call())).isError).toBeFalsy();
    expect(s.runs()).toBe(2);
    expect(s.asks()).toBe(2); // perguntou de novo
  });

  test("session vale até fechar e não persiste em disco", async () => {
    const s = setup(() => "session");
    const ctx = { cwd: s.cwd, run: "r1", agent: "a" };
    expect((await s.executor.run(ctx, call())).isError).toBeFalsy();
    expect((await s.executor.run(ctx, call())).isError).toBeFalsy();
    expect(s.runs()).toBe(2);
    expect(s.asks()).toBe(1); // reaproveitou o grant

    s.executor.permissionGrants.clear();
    expect((await s.executor.run(ctx, call())).isError).toBeFalsy();
    expect(s.asks()).toBe(2); // fechou a sessão, pergunta de novo

    // Nenhum arquivo de grants: o único diretório é o do audit.
    expect(readdirSync(s.cwd)).toEqual([".astro"]);
  });
});

describe("prompt de tool no REPL em modo ask (#265)", () => {
  const manifest = {
    name: "write_probe", description: "x", parameters: { type: "object", properties: {} },
    risk: "low" as const, permission: "write", timeoutMs: 5_000, retryable: false,
    idempotent: false, sideEffects: "filesystem" as const, class: "edit" as const,
  };

  test("ask dispara o prompt do chat, executa com 's' e audita decision sanitizado", async () => {
    let ran = 0;
    const tool: Tool = { manifest, async execute() { ran++; return { output: "ok" }; } };
    const cwd = mkdtempSync(join(tmpdir(), "astro-perm265-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const prompts: string[] = [];
    const fakeSecret = ["s", "k", "-"].join("") + "live-abcdef12345";
    const repl: ReplIO = { read: async (p: string) => { prompts.push(p); return "s"; }, write: () => {} };
    const executor = new ToolExecutor({
      tools: [tool], allow: ["write_probe"], audit, permissionMode: "ask",
      approveTool: chatApprovers(repl, true).approveTool!,
    });
    const ctx = { cwd, run: "r1", agent: "a" };
    const call = { id: "c1", name: "write_probe", arguments: JSON.stringify({ path: "x.ts", content: fakeSecret }) };

    const result = await executor.run(ctx, call);
    expect(result.isError).toBeFalsy();
    expect(ran).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("write_probe");

    const decisions = audit.readAll().filter((e) => e.tipo === "permission.decision");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.payload).toMatchObject({ name: "write_probe", action: "edit", mode: "ask", decision: "allow" });
    // I-03/I-04: audit não carrega argumentos da call (nem o segredo dentro deles)
    expect(JSON.stringify(decisions[0]!.payload)).not.toContain(fakeSecret);
    expect(JSON.stringify(decisions[0]!.payload)).not.toContain("x.ts");
  });

  test("resposta 'S' (sessão) não pergunta de novo na 2ª chamada", async () => {
    let ran = 0;
    const tool: Tool = { manifest, async execute() { ran++; return { output: "ok" }; } };
    const cwd = mkdtempSync(join(tmpdir(), "astro-perm265b-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const prompts: string[] = [];
    const repl: ReplIO = { read: async (p: string) => { prompts.push(p); return "S"; }, write: () => {} };
    const executor = new ToolExecutor({
      tools: [tool], allow: ["write_probe"], audit, permissionMode: "ask",
      approveTool: chatApprovers(repl, true).approveTool!,
    });
    const ctx = { cwd, run: "r1", agent: "a" };
    const call = { id: "c1", name: "write_probe", arguments: "{}" };
    expect((await executor.run(ctx, call)).isError).toBeFalsy();
    expect((await executor.run(ctx, call)).isError).toBeFalsy();
    expect(ran).toBe(2);
    expect(prompts).toHaveLength(1); // grant de sessão reaproveitado
  });
});

describe("hard-block no gate de dispatch (ADR-0027, #391 slice 1)", () => {
  // Espelha PATH_HARD_BLOCKED (src/permissions.ts) como literal para o RED
  // compilar antes da implementação.
  const HARD_BLOCKED = "path_hard_blocked";
  // Segredo sintético construído em runtime (gate G6: sem literal de segredo no diff).
  const SYNTH = ["s", "k", "-"].join("") + "live-synthetic-9f8e7d6c5b";

  function setup(tools: Tool[], opts: { mode?: PermissionMode; approve?: () => boolean } = {}) {
    const cwd = mkdtempSync(join(tmpdir(), "astro-hardblock-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const executor = new ToolExecutor({
      tools,
      allow: tools.map((t) => t.manifest.name),
      audit,
      ...(opts.mode === undefined ? {} : { permissionMode: opts.mode }),
      ...(opts.approve === undefined ? {} : { approveTool: opts.approve }),
    });
    return { cwd, audit, executor };
  }

  test("bypass não lê .env: deny antes da MATRIX, sem vazar conteúdo (I-03)", async () => {
    const { cwd, audit, executor } = setup([readFileTool], { mode: "bypass" });
    writeFileSync(join(cwd, ".env"), `CHAVE=${SYNTH}\n`);

    const result = await executor.run({ cwd, run: "r1", agent: "a" },
      { id: "c1", name: "read_file", arguments: JSON.stringify({ path: ".env" }) });

    expect(result.isError).toBe(true);
    expect(result.output).toContain(HARD_BLOCKED);
    expect(result.code).toBe(HARD_BLOCKED);
    expect(result.output).toContain("hard-block");
    expect(result.output).toContain(".env");
    expect(result.output).not.toContain(SYNTH);
    const denied = audit.readAll().filter((e) => e.tipo === "tool.denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]!.payload).toMatchObject({ name: "read_file", reason: HARD_BLOCKED });
    // deny antes da MATRIX: nenhum permission.decision para a chamada
    expect(audit.readAll().filter((e) => e.tipo === "permission.decision")).toHaveLength(0);
    expect(JSON.stringify(audit.readAll())).not.toContain(SYNTH);
  });

  test("bypass não lê ~/.ssh/id_rsa nem .git (fora do cwd / qualquer profundidade)", async () => {
    const { cwd, executor } = setup([readFileTool], { mode: "bypass" });
    for (const path of ["~/.ssh/id_rsa", ".git/HEAD", ".git"]) {
      const result = await executor.run({ cwd, run: "r1", agent: "a" },
        { id: "c1", name: "read_file", arguments: JSON.stringify({ path }) });
      expect(result.isError).toBe(true);
      expect(result.output).toContain(HARD_BLOCKED);
    }
    const fora = await executor.run({ cwd, run: "r1", agent: "a" },
      { id: "c2", name: "read_file", arguments: JSON.stringify({ path: "~/.ssh/id_rsa" }) });
    expect(fora.output).toContain("<fora do cwd>");
  });

  test("bypass não escreve .env (hard-block tem precedência sobre critical_write)", async () => {
    const { cwd, audit, executor } = setup([writeFileTool], { mode: "bypass" });
    const result = await executor.run({ cwd, run: "r1", agent: "a" }, {
      id: "c1", name: "write_file",
      arguments: JSON.stringify({ path: ".env", content: "x" }),
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain(HARD_BLOCKED);
    expect(existsSync(join(cwd, ".env"))).toBe(false);
    expect(audit.readAll().some((e) => e.tipo === "tool.denied" && e.payload?.reason === HARD_BLOCKED)).toBe(true);
  });

  test("bypass não lista .git (list_dir) nem faz grep em caminho hard-block", async () => {
    const { cwd, executor } = setup([listDirTool, grepTool], { mode: "bypass" });
    const list = await executor.run({ cwd, run: "r1", agent: "a" },
      { id: "c1", name: "list_dir", arguments: JSON.stringify({ path: ".git" }) });
    expect(list.isError).toBe(true);
    expect(list.output).toContain(HARD_BLOCKED);
    const grep = await executor.run({ cwd, run: "r1", agent: "a" },
      { id: "c2", name: "grep", arguments: JSON.stringify({ pattern: "x", path: ".ssh" }) });
    expect(grep.isError).toBe(true);
    expect(grep.output).toContain(HARD_BLOCKED);
  });

  test("ask com aprovador aprovaria, mas hard-block segue deny sem perguntar", async () => {
    let asked = 0;
    const { cwd, executor } = setup([readFileTool], { mode: "ask", approve: () => { asked++; return true; } });
    writeFileSync(join(cwd, ".env"), `CHAVE=${SYNTH}\n`);
    const result = await executor.run({ cwd, run: "r1", agent: "a" },
      { id: "c1", name: "read_file", arguments: JSON.stringify({ path: ".env" }) });
    expect(result.isError).toBe(true);
    expect(result.output).toContain(HARD_BLOCKED);
    expect(asked).toBe(0); // precedência sobre o ask
  });

  test("run_command com token hard-block é deny mesmo em bypass", async () => {
    // opt-out do sandbox (#248): exercita o gate de dispatch, não o sandbox (slice 4)
    configureRunCommand({ sandbox: false });
    try {
      const { cwd, executor } = setup([runCommandTool], { mode: "bypass" });
      writeFileSync(join(cwd, ".env"), `CHAVE=${SYNTH}\n`);
      for (const command of ["cat .env", "cat '~/.ssh/id_rsa'", "ls .git && echo fim"]) {
        const result = await executor.run({ cwd, run: "r1", agent: "a", env: { ...process.env } },
          { id: "c1", name: "run_command", arguments: JSON.stringify({ command }) });
        expect(result.isError).toBe(true);
        expect(result.output).toContain(HARD_BLOCKED);
        expect(result.output).not.toContain(SYNTH);
      }
    } finally {
      configureRunCommand({ sandbox: true });
    }
  });

  test("caminho não-hard-block não é barrado pelo gate; o shell recusa por sandbox (I-19)", async () => {
    configureRunCommand({ sandbox: false });
    try {
      const { cwd, executor } = setup([readFileTool, runCommandTool], { mode: "bypass" });
      writeFileSync(join(cwd, "ok.txt"), "conteudo-ok\n");
      const read = await executor.run({ cwd, run: "r1", agent: "a" },
        { id: "c1", name: "read_file", arguments: JSON.stringify({ path: "ok.txt" }) });
      expect(read.isError).toBeFalsy();
      expect(read.output).toContain("conteudo-ok");
      const run = await executor.run({ cwd, run: "r1", agent: "a", env: { ...process.env } },
        { id: "c2", name: "run_command", arguments: JSON.stringify({ command: "echo ok.txt" }) });
      expect(run.isError).toBe(true);
      expect(run.output).toContain("sandbox_required_for_shell");
      expect(run.output).not.toContain(HARD_BLOCKED);
    } finally {
      configureRunCommand({ sandbox: true });
    }
  });

  test("bypass não faz lsp em caminho hard-block via campo `file` (review A/B)", async () => {
    const { cwd, audit, executor } = setup([lspTool], { mode: "bypass" });
    for (const file of ["keys.ts", ".env"]) {
      const result = await executor.run({ cwd, run: "r1", agent: "a" },
        { id: "c1", name: "lsp", arguments: JSON.stringify({ command: "hover", file, line: 1, column: 1 }) });
      expect(result.isError).toBe(true);
      expect(result.output).toContain(HARD_BLOCKED);
      expect(result.output).toContain(file); // mensagem cita o path, sem conteúdo (I-03)
    }
    expect(audit.readAll().filter((e) => e.tipo === "tool.denied" && e.payload?.reason === HARD_BLOCKED)).toHaveLength(2);
  });
  test("grep/list_dir sem path negam quando o próprio cwd é hard-block (review A/B)", async () => {
    const home = mkdtempSync(join(tmpdir(), "astro-hb-home-"));
    const savedEnv = { ASTRO_HOME: process.env.ASTRO_HOME, ASTRO_ARTIFACT_ROOT: process.env.ASTRO_ARTIFACT_ROOT };
    process.env.ASTRO_HOME = home;
    delete process.env.ASTRO_ARTIFACT_ROOT;
    try {
      const cwd = join(home, "projeto"); // dentro de $ASTRO_HOME → hard-block
      mkdirSync(cwd);
      const audit = new Auditor(join(cwd, "audit.jsonl"));
      const executor = new ToolExecutor({
        tools: [grepTool, listDirTool], allow: ["grep", "list_dir"], audit, permissionMode: "bypass",
      });
      for (const [name, args] of [["grep", { pattern: "x" }], ["list_dir", {}]] as const) {
        const result = await executor.run({ cwd, run: "r1", agent: "a" }, { id: "c1", name, arguments: JSON.stringify(args) });
        expect(result.isError).toBe(true);
        expect(result.output).toContain(HARD_BLOCKED);
      }
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
  test("grep sem path em cwd normal segue liberado (review A/B)", async () => {
    const { cwd, executor } = setup([grepTool], { mode: "bypass" });
    const result = await executor.run({ cwd, run: "r1", agent: "a" }, { id: "c1", name: "grep", arguments: JSON.stringify({ pattern: "zzz-sem-match" }) });
    expect(result.isError).toBeFalsy();
  });
});
