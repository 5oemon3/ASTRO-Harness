import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubConfigRegistry } from "../src/config-share";
import { validateConfig } from "../src/core/config";
import { runHealthCheck } from "../src/health";
import { OpenAICompatProvider } from "../src/providers/openai-compat";
import { refreshCodexTokens, type CodexTokens } from "../src/providers/codex-auth";
import { startCodexLogin } from "../src/providers/codex-login";
import { ProviderError, type CompletionRequest, type FetchLike } from "../src/providers/types";
import { sendTelemetry, type TelemetryPayload } from "../src/telemetry";
import { OtlpTracer, type SpanHandle } from "../src/tracing";

const req: CompletionRequest = { model: "m", messages: [{ role: "user", content: "oi" }] };
const payload: TelemetryPayload = {
  runId: "r1", model: "m", tokensIn: 1, tokensOut: 1, latencyMs: 1, steps: 1, costUsd: null,
};

function recorder(): { server: ReturnType<typeof Bun.serve>; seen: Array<{ authorization: string | null }> } {
  const seen: Array<{ authorization: string | null }> = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      seen.push({ authorization: request.headers.get("authorization") });
      return Response.json({
        choices: [{ message: { content: "destino atingido" } }],
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      });
    },
  });
  return { server, seen };
}

function redirector(location: string, status: 307 | 308): { server: ReturnType<typeof Bun.serve>; hits: { count: number } } {
  const hits = { count: 0 };
  const server = Bun.serve({
    port: 0,
    fetch() {
      hits.count++;
      return new Response(null, { status, headers: { location } });
    },
  });
  return { server, hits };
}

const configFor = (baseUrl: string) => validateConfig({
  providers: { p: { kind: "openai-compat", baseUrl, credentialRef: "P_KEY" } },
  models: [{ provider: "p", id: "m", tags: ["writing-code"], context: 4096 }],
  agent: { model: "p/m", maxSteps: 2, tools: [] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
});

describe("redirect hardening (#442)", () => {
  test("provider recusa 307/308 para loopback/metadata e nunca reenvia authorization", async () => {
    for (const status of [307, 308] as const) {
      const target = recorder();
      const hop = redirector(`http://127.0.0.1:${target.server.port}/latest/meta-data/`, status);
      const apiKey = `sk-redirect-${status}-sentinel`;
      try {
        const provider = new OpenAICompatProvider({
          baseUrl: `http://127.0.0.1:${hop.server.port}/v1`,
          apiKey,
          retry: { maxAttempts: 1 },
        });
        const error = await provider.complete(req).then(() => null, (e) => e as ProviderError);
        expect(error).toBeInstanceOf(ProviderError);
        expect(error!.errClass).toBe("invalid_request");
        expect(error!.message).toMatch(/redirect/i);
        expect(error!.message).not.toContain(apiKey);
        expect(hop.hits.count).toBe(1);
        expect(target.seen).toEqual([]); // destino do redirect nunca recebe request nem header
      } finally {
        hop.server.stop(true);
        target.server.stop(true);
      }
    }
  });

  test("provider sem redirect continua funcionando", async () => {
    const target = recorder();
    try {
      const provider = new OpenAICompatProvider({ baseUrl: `http://127.0.0.1:${target.server.port}/v1`, apiKey: "k" });
      const result = await provider.complete(req);
      expect(result.content).toBe("destino atingido");
      expect(target.seen).toHaveLength(1);
    } finally {
      target.server.stop(true);
    }
  });

  test("health recusa redirect, classifica o check e não derruba o relatório", async () => {
    const target = recorder();
    const hop = redirector(`http://127.0.0.1:${target.server.port}/latest/meta-data/`, 307);
    const apiKey = "sk-health-redirect-sentinel";
    try {
      const report = await runHealthCheck(
        configFor(`http://127.0.0.1:${hop.server.port}/v1`),
        { P_KEY: apiKey, ASTRO_HOME: mkdtempSync(join(tmpdir(), "astro-redirect-")) },
        { timeoutMs: 2_000 },
      );
      const check = report.checks.find((entry) => entry.name === "provider:p")!;
      expect(check.status).toBe("down");
      expect(check.detail).toMatch(/redirect/i);
      expect(check.detail).not.toContain(apiKey);
      expect(report.status).toBe("down");
      expect(hop.hits.count).toBe(1);
      expect(target.seen).toEqual([]);
    } finally {
      hop.server.stop(true);
      target.server.stop(true);
    }
  });

  test("health sem redirect continua ok", async () => {
    const target = recorder();
    try {
      const report = await runHealthCheck(
        configFor(`http://127.0.0.1:${target.server.port}/v1`),
        { P_KEY: "k", ASTRO_HOME: mkdtempSync(join(tmpdir(), "astro-redirect-")) },
        { timeoutMs: 2_000 },
      );
      expect(report.checks.find((entry) => entry.name === "provider:p")!.status).toBe("ok");
      expect(target.seen).toHaveLength(1);
    } finally {
      target.server.stop(true);
    }
  });

  test("telemetria e tracing recusam redirect sem quebrar o run", async () => {
    const target = recorder();
    const hop = redirector(`http://127.0.0.1:${target.server.port}/collect`, 307);
    try {
      expect(await sendTelemetry(
        { enabled: true, endpoint: `http://127.0.0.1:${hop.server.port}/v1/runs`, sampleRate: 1 },
        payload,
      )).toBe(false);

      const tracer = new OtlpTracer(`http://127.0.0.1:${hop.server.port}`);
      tracer.end(tracer.start("run", {}) as SpanHandle);
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(tracer.recorded()).toHaveLength(1);

      expect(target.seen).toEqual([]);
    } finally {
      hop.server.stop(true);
      target.server.stop(true);
    }
  });

  test("config-share recusa redirect do registry sem vazar o token", async () => {
    const target = recorder();
    const hop = redirector(`http://127.0.0.1:${target.server.port}/repos/org/repo/contents/configs/x.json`, 308);
    const token = "ghp_redirect_sentinel";
    try {
      const registry = new GitHubConfigRegistry({
        owner: "org", repo: "repo", token, baseUrl: `http://127.0.0.1:${hop.server.port}`,
      });
      const error = await registry.pull("x").then(() => null, (e) => e as Error);
      expect(error!.message).toMatch(/redirect/i);
      expect(error!.message).not.toContain(token);
      expect(hop.hits.count).toBe(1);
      expect(target.seen).toEqual([]);
    } finally {
      hop.server.stop(true);
      target.server.stop(true);
    }
  });

  test("renovação do Codex recusa redirect e classifica sem expor tokens", async () => {
    const tokens: CodexTokens = {
      accessToken: "access-sentinel", refreshToken: "refresh-sentinel", accountId: "acc", expiresAt: 0,
    };
    let redirectOption: RequestInit["redirect"] | undefined;
    const fetchLike = (async (_url: string, init?: RequestInit) => {
      redirectOption = init?.redirect;
      throw new TypeError("UnexpectedRedirect fetching \"https://auth.openai.com/oauth/token\"");
    }) as FetchLike;
    const error = await refreshCodexTokens(tokens, fetchLike).then(() => null, (e) => e as ProviderError);
    expect(redirectOption).toBe("error");
    expect(error!.errClass).toBe("invalid_request");
    expect(error!.message).toMatch(/redirect/i);
    expect(error!.message).not.toContain(tokens.refreshToken);
  });

  test("login do Codex recusa redirect na primeira chamada", async () => {
    let redirectOption: RequestInit["redirect"] | undefined;
    const fetchLike = (async (_url: string, init?: RequestInit) => {
      redirectOption = init?.redirect;
      throw new TypeError("UnexpectedRedirect fetching \"https://auth.openai.com/api/accounts/deviceauth/usercode\"");
    }) as FetchLike;
    const error = await startCodexLogin({ fetchLike, issuer: "http://127.0.0.1:1" })
      .then(() => null, (e) => e as ProviderError);
    expect(redirectOption).toBe("error");
    expect(error!.message).toMatch(/redirect/i);
  });
});
