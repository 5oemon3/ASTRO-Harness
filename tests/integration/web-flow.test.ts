import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runTask } from "../../src/app";
import { testEnv } from "../setup";
import { newWorkspace, readAudit, removeWorkspace, startMockProvider, writeConfig, type TestServer } from "./helpers";

interface SearchMock {
  server: TestServer;
  url: string;
  requests: number;
}

/** Backend Exa mock: primeira chamada 429 com Retry-After 0, depois resultados. */
function startSearchServer(): SearchMock {
  const state = { requests: 0 };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      state.requests += 1;
      if (state.requests === 1) {
        return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
      }
      return Response.json({ results: [{ title: "ASTRO", url: "https://astro.test", text: "WEB-SNIPPET" }] });
    },
  });
  return {
    server,
    url: `http://127.0.0.1:${server.port}`,
    get requests() { return state.requests; },
  };
}

function startPageServer(): { server: TestServer; url: string } {
  const page = "<html><body><h1>Título</h1><script>evil()</script><p>PAGE-CONTENT</p></body></html>";
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } }),
  });
  return { server, url: `http://127.0.0.1:${server.port}/page` };
}

test("web-flow: search com retry, fetch sanitizado e resultado no contexto", async () => {
  const search = startSearchServer();
  const page = startPageServer();
  const provider = startMockProvider([
    { toolCalls: [{ name: "web_search", arguments: { query: "astro harness", maxResults: 2 } }] },
    { toolCalls: [{ name: "web_fetch", arguments: { url: page.url, format: "markdown" } }] },
    { toolCalls: [{ name: "write_file", arguments: { path: "out/web.md", content: "WEB-SNIPPET\nPAGE-CONTENT\n" } }] },
    { content: "web concluído" },
  ]);
  const dir = newWorkspace("web-flow");
  try {
    expect(provider.server.hostname).toBe("127.0.0.1");
    expect(search.server.hostname).toBe("127.0.0.1");
    expect(page.server.hostname).toBe("127.0.0.1");
    const configPath = writeConfig(dir, {
      providers: { mock: { kind: "openai-compat", baseUrl: provider.baseUrl, credentialRef: "TEST_KEY" } },
      models: [{ provider: "mock", id: "mock-1", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } }],
      agent: { model: "mock/mock-1", maxSteps: 8, tools: ["web_search", "web_fetch", "write_file"] },
      webSearch: { provider: "exa", apiKeyEnv: "WEB_KEY", baseUrl: search.url, defaultMaxResults: 2 },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    });

    const report = await runTask({
      configPath,
      task: "pesquise, busque a página e registre o conteúdo",
      cwd: dir,
      env: testEnv({ TEST_KEY: "test-key", WEB_KEY: "web-secret-value" }),
      approveTool: () => true,
    });

    expect(report.final).toBe("web concluído");
    expect(readFileSync(join(dir, "out", "web.md"), "utf8")).toBe("WEB-SNIPPET\nPAGE-CONTENT\n");
    expect(search.requests).toBe(2); // 429 + retry determinístico (Retry-After: 0)

    const afterSearch = JSON.stringify(provider.state.bodies[1]);
    expect(afterSearch).toContain("WEB-SNIPPET");
    const afterFetch = JSON.stringify(provider.state.bodies[2]);
    expect(afterFetch).toContain("PAGE-CONTENT");
    expect(afterFetch).not.toContain("evil()");
    expect(afterFetch).not.toContain("<script");

    const audit = readAudit(dir);
    expect(audit.events.find((event) => event.tipo === "web.search")?.payload)
      .toMatchObject({ provider: "exa", status: 200, resultsCount: 1 });
    expect(audit.events.find((event) => event.tipo === "web.fetch")?.payload)
      .toMatchObject({ status: 200 });
    expect(audit.text.includes("web-secret-value")).toBe(false);
    expect(audit.text.includes("test-key")).toBe(false);
  } finally {
    provider.server.stop(true);
    search.server.stop(true);
    page.server.stop(true);
    removeWorkspace(dir);
  }
}, 30000);
