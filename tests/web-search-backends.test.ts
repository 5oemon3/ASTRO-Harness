import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { validateConfig } from "../src/config";
import { createWebSearchTool, retryAfterMs, type WebSearchConfig, type WebSearchDeps } from "../src/tools/web-search";

const HOST_SECRET = ["s", "k", "-"].join("") + "host-secret-123456";
const WEB_SECRET = "web-secret-value";

let seq = 0;
function setup(config: WebSearchConfig, overrides: Partial<WebSearchDeps> = {}) {
  seq += 1;
  const cwd = mkdtempSync(join(tmpdir(), `astro-web-backends-${seq}-`));
  const audit = new Auditor(join(cwd, "audit.jsonl"));
  const sleeps: number[] = [];
  const tool = createWebSearchTool({
    config,
    audit,
    env: { WEB_KEY: WEB_SECRET, HOST_KEY: HOST_SECRET },
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 0.5,
    ...overrides,
  });
  return { tool, audit, sleeps, cwd };
}

const ctx = (cwd: string) => ({ cwd, run: "r1", agent: "plan" });
const parse = (output: string) => JSON.parse(output) as {
  provider: string;
  results: Array<{ title: string; url: string; snippet: string }>;
};

const base = {
  providers: { p: { kind: "openai-compat", baseUrl: "https://example.test/v1", credentialRef: "P_KEY" } },
  models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
  agent: { model: "p/m1", maxSteps: 4, tools: ["web_search"] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
};

describe("webSearch backends config (#57)", () => {
  test("aceita brave, google e custom", () => {
    for (const provider of ["brave", "google"] as const) {
      expect(validateConfig({
        ...structuredClone(base),
        webSearch: { provider, apiKeyEnv: "WEB_KEY" },
      }).webSearch?.provider).toBe(provider);
    }
    expect(validateConfig({
      ...structuredClone(base),
      webSearch: { provider: "custom", apiKeyEnv: "WEB_KEY", baseUrl: "https://search.example.test" },
    }).webSearch?.provider).toBe("custom");
  });

  test("custom exige baseUrl", () => {
    expect(() => validateConfig({
      ...structuredClone(base),
      webSearch: { provider: "custom", apiKeyEnv: "WEB_KEY" },
    })).toThrow(/baseUrl/);
  });
});

describe("web_search brave (#57)", () => {
  test("GET com q/count, X-Subscription-Token e normalização", async () => {
    let seenUrl = "";
    let seenToken = "";
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        seenUrl = req.url;
        seenToken = req.headers.get("x-subscription-token") ?? "";
        expect(url.searchParams.get("q")).toBe("astro");
        expect(url.searchParams.get("count")).toBe("2");
        return Response.json({
          web: { results: [{ title: "B", url: "https://b.test", description: "trecho B", page_age: "2d" }] },
        });
      },
    });
    try {
      const { tool, cwd } = setup({ provider: "brave", apiKeyEnv: "WEB_KEY", baseUrl: server.url.origin });
      const result = await tool.execute({ query: "astro", maxResults: 2 }, ctx(cwd));
      expect(seenUrl).toContain("/res/v1/web/search");
      expect(seenToken).toBe(WEB_SECRET);
      expect(parse(result.output).results[0]).toMatchObject({ title: "B", snippet: "trecho B" });
    } finally {
      server.stop(true);
    }
  });
});

describe("web_search google (#57)", () => {
  test("key/q/num/dateRestrict e cx do baseUrl", async () => {
    let seen = new URL("https://example.test");
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        seen = new URL(req.url);
        return Response.json({ items: [{ title: "G", link: "https://g.test", snippet: "trecho G" }] });
      },
    });
    try {
      const { tool, cwd } = setup({
        provider: "google", apiKeyEnv: "WEB_KEY", baseUrl: `${server.url.origin}/customsearch/v1?cx=engine-1`,
      });
      const result = await tool.execute({ query: "astro", maxResults: 4, recencyDays: 7 }, ctx(cwd));
      expect(seen.searchParams.get("key")).toBe(WEB_SECRET);
      expect(seen.searchParams.get("cx")).toBe("engine-1");
      expect(seen.searchParams.get("q")).toBe("astro");
      expect(seen.searchParams.get("num")).toBe("4");
      expect(seen.searchParams.get("dateRestrict")).toBe("d7");
      expect(parse(result.output).results[0]).toMatchObject({ title: "G", url: "https://g.test", snippet: "trecho G" });
    } finally {
      server.stop(true);
    }
  });
});

describe("web_search custom (#57)", () => {
  test("POST no baseUrl com Bearer e contrato results[]", async () => {
    let seenAuth = "";
    let seenBody: unknown;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seenAuth = req.headers.get("authorization") ?? "";
        seenBody = await req.json();
        return Response.json({ results: [{ title: "C", url: "https://c.test", snippet: "trecho C" }] });
      },
    });
    try {
      const { tool, cwd } = setup({
        provider: "custom", apiKeyEnv: "WEB_KEY", baseUrl: `${server.url.origin}/search`,
      });
      const result = await tool.execute({ query: "astro", recencyDays: 7 }, ctx(cwd));
      expect(seenAuth).toBe(`Bearer ${WEB_SECRET}`);
      expect(seenBody).toMatchObject({ query: "astro", maxResults: 5, recencyDays: 7 });
      expect(parse(result.output).results[0]).toMatchObject({ title: "C", snippet: "trecho C" });
    } finally {
      server.stop(true);
    }
  });
});

describe("web_search rate limit e backoff (#57)", () => {
  test("429 com Retry-After espera o header e tenta de novo", async () => {
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        calls += 1;
        return calls === 1
          ? new Response("limit", { status: 429, headers: { "retry-after": "1" } })
          : Response.json({ results: [{ title: "A", url: "https://a.test", text: "ok" }] });
      },
    });
    try {
      const { tool, audit, sleeps, cwd } = setup({ provider: "exa", apiKeyEnv: "WEB_KEY", baseUrl: server.url.origin });
      const result = await tool.execute({ query: "x" }, ctx(cwd));
      expect(result.isError).not.toBe(true);
      expect(sleeps).toEqual([1000]);
      expect(calls).toBe(2);
      expect(audit.readAll().find((item) => item.tipo === "web.search")?.payload)
        .toMatchObject({ status: 200, resultsCount: 1 });
    } finally {
      server.stop(true);
    }
  });

  test("5xx usa backoff com jitter e desiste após 3 tentativas", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response(`boom ${HOST_SECRET}`, { status: 500 }) });
    try {
      const { tool, audit, sleeps, cwd } = setup({ provider: "exa", apiKeyEnv: "WEB_KEY", baseUrl: server.url.origin });
      const result = await tool.execute({ query: "x" }, ctx(cwd));
      expect(result.isError).toBe(true);
      expect(result.output).not.toContain(HOST_SECRET);
      expect(sleeps).toEqual([500, 1000]);
      expect(audit.readAll().find((item) => item.tipo === "web.search")?.payload).toMatchObject({ status: 500 });
    } finally {
      server.stop(true);
    }
  });

  test("não repete erro não recuperável (400)", async () => {
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch() { calls += 1; return new Response("bad request", { status: 400 }); },
    });
    try {
      const { tool, sleeps, cwd } = setup({ provider: "exa", apiKeyEnv: "WEB_KEY", baseUrl: server.url.origin });
      const result = await tool.execute({ query: "x" }, ctx(cwd));
      expect(result.isError).toBe(true);
      expect(sleeps).toEqual([]);
      expect(calls).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("Retry-After tem teto e entende data HTTP", () => {
    expect(retryAfterMs("86400")).toBe(8000);
    expect(retryAfterMs("-1")).toBe(0);
    expect(retryAfterMs("not-a-date")).toBeUndefined();
    expect(retryAfterMs(new Date(Date.now() + 60_000).toUTCString())).toBe(8000);
  });

  test("abort durante o backoff encerra a espera", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("limit", { status: 429, headers: { "retry-after": "5" } }),
    });
    const controller = new AbortController();
    try {
      const { tool, cwd } = setup(
        { provider: "exa", apiKeyEnv: "WEB_KEY", baseUrl: server.url.origin },
        {
          sleep: (_ms, signal) => new Promise<void>((resolve) => {
            signal?.addEventListener("abort", () => resolve(), { once: true });
            setTimeout(() => controller.abort(), 10);
          }),
        },
      );
      const result = await tool.execute({ query: "x" }, { ...ctx(cwd), signal: controller.signal });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("cancelada");
    } finally {
      server.stop(true);
    }
  });
});
