/**
 * #252: segredo em hex não tem prefixo/JWT/PEM; a redação cobre 64+ hex sem
 * contexto em TODOS os sinks que persistem ou devolvem conteúdo externo.
 * O valor é sintético e montado em runtime (gate G6).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { CompletionCache } from "../src/cache";
import { mcpTools } from "../src/mcp/tool";
import { createWebFetchTool } from "../src/tools/web-fetch";
import { installDockerSpawnMock, isolatedRunCommand } from "./helpers/docker-mock";

const HEX = "a1b2c3d4".repeat(8); // 64 hex chars

function dir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `astro-hex-${prefix}-`));
}

function auditorIn(target: string): Auditor {
  return new Auditor(join(target, "audit.jsonl"));
}

describe("redação hex nos sinks (#252, P0)", () => {
  test("audit: hex 64+ em texto livre é redigido; digest/ID interno é preservado", () => {
    const cwd = dir("audit");
    const audit = auditorIn(cwd);
    const artifactRef = `run-${HEX}/${HEX}`;
    audit.append({
      run: "r1",
      tipo: "probe",
      payload: {
        note: `chave ${HEX}`, sha256: HEX, callId: HEX, handoff_id: HEX, ledger_id: HEX,
        ref: artifactRef, hash: HEX,
      },
    });

    const event = audit.readAll()[0]!;
    expect(event.payload.note).toBe("chave [REDACTED]");
    // digest/ID gerado pelo harness continua correlacionável (handoff show/ack/scan)
    expect(event.payload.sha256).toBe(HEX);
    expect(event.payload.callId).toBe(HEX);
    expect(event.payload.handoff_id).toBe(HEX);
    expect(event.payload.ledger_id).toBe(HEX);
    expect(event.payload.ref).toBe(artifactRef);
    expect(event.payload.hash).toBe(HEX);
    audit.append({ run: "r1", tipo: "probe_bare_ref", payload: { ref: HEX } });
    const bare = audit.readAll()[1]!;
    expect(bare.payload.ref).toBe("[REDACTED]");
    const text = readFileSync(join(cwd, "audit.jsonl"), "utf8");
    expect(text).not.toContain(`chave ${HEX}`);
  });

  test("cache: resposta persistida com hex 64+ sai redigida no hit", () => {
    const cache = new CompletionCache(join(dir("cache"), "cache.db"));
    try {
      cache.set("k", { content: `token ${HEX}`, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }, 10);
      const hit = cache.get("k", 1);
      expect(hit?.content).not.toContain(HEX);
      expect(hit?.content).toContain("[REDACTED]");
    } finally {
      cache.close();
    }
  });

  test("MCP: conteúdo de servidor com hex 64+ é sanitizado antes do contexto", async () => {
    const cwd = dir("mcp");
    const [tool] = mcpTools({
      registry: {
        listTools: () => [{ server: "fs", tool: { name: "leak", description: "x", inputSchema: { type: "object" } } }],
        call: async () => ({ content: [{ type: "text", text: `segredo ${HEX}` }] }),
      },
      servers: { fs: { transport: "stdio", command: "x", timeoutMs: 1_000, enabled: true } },
      audit: auditorIn(cwd),
      reserved: [],
    });

    const result = await tool!.execute({}, { cwd, run: "r1", agent: "a" });
    expect(result.output).not.toContain(HEX);
    expect(result.output).toContain("[REDACTED]");
  });

  test("run_command: stdout do sandbox com hex 64+ é redigido antes do truncamento", async () => {
    const mock = installDockerSpawnMock(() => `${HEX}\n`);
    try {
      const mod = await isolatedRunCommand("hex-redaction");
      mod.configureRunCommand({ sandbox: true });
      const result = await mod.runCommandTool.execute(
        { command: "echo ok" },
        { cwd: dir("run"), run: "r1", agent: "a" },
      );

      expect(result.isError).toBeFalsy();
      expect(result.output).not.toContain(HEX);
      expect(result.output).toContain("[REDACTED]");
    } finally {
      mock.restore();
    }
  });

  test("web_fetch: página com hex 64+ devolve texto redigido", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(`<html><body><p>chave ${HEX}</p></body></html>`, {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    });
    try {
      const cwd = dir("fetch");
      const tool = createWebFetchTool({ audit: auditorIn(cwd), allowPrivate: true });
      const result = await tool.execute({ url: `${server.url.origin}/` }, { cwd, run: "r1", agent: "a" });

      expect(result.isError).not.toBe(true);
      expect(result.output).not.toContain(HEX);
      expect(result.output).toContain("[REDACTED]");
    } finally {
      server.stop(true);
    }
  });
});
