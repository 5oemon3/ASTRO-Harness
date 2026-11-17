import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runTask } from "../../src/core/app";
import { testEnv } from "../setup";
import { newWorkspace, readAudit, removeWorkspace, requestMessages, startMockProvider, writeConfig, type TestServer } from "./helpers";

interface McpMock {
  server: TestServer;
  url: string;
  methods: string[];
}
function startMcpServer(tools: Array<{ name: string; text: string }>, opts: { failCall?: boolean } = {}): McpMock {
  const methods: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = (await req.json()) as {
        id?: number | string;
        method?: string;
        params?: { name?: string };
      };
      if (body.method !== undefined) methods.push(body.method);
      if (body.method === "initialize") {
        return Response.json({
          jsonrpc: "2.0", id: body.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "integration-mcp", version: "1" },
          },
        });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/list") {
        return Response.json({
          jsonrpc: "2.0", id: body.id,
          result: { tools: tools.map((tool) => ({ name: tool.name, description: tool.name, inputSchema: { type: "object" } })) },
        });
      }
      if (body.method === "tools/call") {
        if (opts.failCall === true) return new Response("mcp disconnected", { status: 500 });
        const tool = tools.find((entry) => entry.name === body.params?.name);
        return Response.json({
          jsonrpc: "2.0", id: body.id,
          result: { content: [{ type: "text", text: tool?.text ?? "" }] },
        });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, error: { message: "método desconhecido" } }, { status: 400 });
    },
  });
  return { server, url: `http://127.0.0.1:${server.port}/mcp`, methods };
}

test("mcp-flow: descobre a tool, chama o servidor e devolve o conteúdo ao modelo", async () => {
  const mcp = startMcpServer([{ name: "read_file", text: "MCP-FS-CONTENT" }]);
  const provider = startMockProvider([
    { toolCalls: [
      { name: "mcp__fs__read_file", arguments: { path: "notes.txt" } },
      { name: "write_file", arguments: { path: "out/mcp.txt", content: "MCP-FS-CONTENT\n" } },
    ] },
    { content: "mcp concluído" },
  ]);
  const dir = newWorkspace("mcp-flow");
  try {
    expect(provider.server.hostname).toBe("127.0.0.1");
    expect(mcp.server.hostname).toBe("127.0.0.1");
    const configPath = writeConfig(dir, {
      providers: { mock: { kind: "openai-compat", baseUrl: provider.baseUrl, credentialRef: "TEST_KEY" } },
      models: [{ provider: "mock", id: "mock-1", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } }],
      agent: { model: "mock/mock-1", maxSteps: 6, tools: ["mcp__fs__read_file", "write_file"] },
      mcpServers: { fs: { transport: "http", url: mcp.url, timeoutMs: 3000 } },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    });

    const report = await runTask({
      configPath,
      task: "leia notes.txt pelo MCP e registre em out/mcp.txt",
      cwd: dir,
      env: testEnv({ TEST_KEY: "test-key" }),
      approveTool: () => true,
    });

    expect(report.final).toBe("mcp concluído");
    expect(readFileSync(join(dir, "out", "mcp.txt"), "utf8")).toBe("MCP-FS-CONTENT\n");
    expect(provider.state.toolsPerCall[0]).toContain("mcp__fs__read_file");
    expect(requestMessages(provider.state.bodies[1]).some((message) => message.role === "tool" && message.content.includes("MCP-FS-CONTENT"))).toBe(true);
    expect(mcp.methods.filter((method) => method !== "notifications/initialized"))
      .toEqual(["initialize", "tools/list", "tools/call"]);

    const audit = readAudit(dir);
    expect(audit.events.find((event) => event.tipo === "mcp.call")?.payload)
      .toMatchObject({ server: "fs", tool: "read_file", status: "ok" });
    expect(audit.text.includes("test-key")).toBe(false);
    expect(audit.text.includes("MCP-FS-CONTENT")).toBe(false); // resposta MCP não é persistida
  } finally {
    provider.server.stop(true);
    mcp.server.stop(true);
    removeWorkspace(dir);
  }
}, 30000);

test("mcp-flow: tool MCP fora da allowlist não é exposta nem executa", async () => {
  const mcp = startMcpServer([{ name: "read_file", text: "MCP-FS-CONTENT" }]);
  const provider = startMockProvider([
    { toolCalls: [
      { name: "mcp__fs__read_file", arguments: { path: "notes.txt" } },
      { name: "write_file", arguments: { path: "out/denied.txt", content: "allowlist respeitada\n" } },
    ] },
    { content: "allowlist ok" },
  ]);
  const dir = newWorkspace("mcp-allowlist");
  try {
    expect(provider.server.hostname).toBe("127.0.0.1");
    expect(mcp.server.hostname).toBe("127.0.0.1");
    const configPath = writeConfig(dir, {
      providers: { mock: { kind: "openai-compat", baseUrl: provider.baseUrl, credentialRef: "TEST_KEY" } },
      models: [{ provider: "mock", id: "mock-1", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } }],
      agent: { model: "mock/mock-1", maxSteps: 6, tools: ["write_file"] },
      mcpServers: { fs: { transport: "http", url: mcp.url, timeoutMs: 3000 } },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    });

    const report = await runTask({
      configPath,
      task: "tente usar o MCP fora da allowlist",
      cwd: dir,
      env: testEnv({ TEST_KEY: "test-key" }),
      approveTool: () => true,
    });

    expect(report.final).toBe("allowlist ok");
    expect(readFileSync(join(dir, "out", "denied.txt"), "utf8")).toBe("allowlist respeitada\n");
    expect(provider.state.toolsPerCall[0]).toEqual(["write_file"]);
    const denied = readAudit(dir).events.find((event) => event.tipo === "tool.denied");
    expect(denied?.payload.name).toBe("mcp__fs__read_file");
    expect(mcp.methods.filter((method) => method !== "notifications/initialized"))
      .toEqual(["initialize", "tools/list"]);
  } finally {
    provider.server.stop(true);
    mcp.server.stop(true);
    removeWorkspace(dir);
  }
}, 30000);

test("mcp-flow: servidor responde HTTP 500 em tools/call e a sessão continua", async () => {
  const mcp = startMcpServer([{ name: "read_file", text: "nunca chega" }], { failCall: true });
  const provider = startMockProvider([
    { toolCalls: [
      { name: "mcp__fs__read_file", arguments: { path: "notes.txt" } },
      { name: "write_file", arguments: { path: "out/continued.txt", content: "sessão continua\n" } },
    ] },
    { content: "mcp survived" },
  ]);
  const dir = newWorkspace("mcp-disconnect");
  try {
    expect(provider.server.hostname).toBe("127.0.0.1");
    expect(mcp.server.hostname).toBe("127.0.0.1");
    const configPath = writeConfig(dir, {
      providers: { mock: { kind: "openai-compat", baseUrl: provider.baseUrl, credentialRef: "TEST_KEY" } },
      models: [{ provider: "mock", id: "mock-1", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } }],
      agent: { model: "mock/mock-1", maxSteps: 6, tools: ["mcp__fs__read_file", "write_file"] },
      mcpServers: { fs: { transport: "http", url: mcp.url, timeoutMs: 1000, retryBackoffMs: 1 } },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    });

    const report = await runTask({
      configPath,
      task: "use o MCP mesmo com o servidor caindo",
      cwd: dir,
      env: testEnv({ TEST_KEY: "test-key" }),
      approveTool: () => true,
    });

    expect(report.final).toBe("mcp survived");
    expect(readFileSync(join(dir, "out", "continued.txt"), "utf8")).toBe("sessão continua\n");
    const audit = readAudit(dir);
    expect(audit.events.find((event) => event.tipo === "mcp.call")?.payload)
      .toMatchObject({ server: "fs", tool: "read_file", status: "error" });
    const mcpResult = audit.events.find((event) => event.tipo === "tool.result" && event.payload.name === "mcp__fs__read_file");
    expect(mcpResult?.payload.isError).toBe(true);
    expect(requestMessages(provider.state.bodies[1]).some((message) =>
      message.role === "tool" && message.content.includes("HTTP 500"))).toBe(true);
    expect(audit.text.includes("run.completed")).toBe(true);
  } finally {
    provider.server.stop(true);
    mcp.server.stop(true);
    removeWorkspace(dir);
  }
}, 30000);
