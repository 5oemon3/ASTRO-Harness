import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { CAPABILITY_KEYS } from "../src/capabilities";
import { Ledger } from "../src/ledger";
import { CodexOAuthProvider } from "../src/providers/codex-oauth";
import { OpenAICompatProvider } from "../src/providers/openai-compat";
import type { CompletionRequest, CompletionResponse, Provider } from "../src/providers/types";
import { VisionUnsupportedError } from "../src/providers/types";
import type { ModelEntry } from "../src/core/registry";
import { runSession, type SessionOptions } from "../src/core/session";
import { ToolExecutor } from "../src/tools/executor";

const image = { mediaType: "image/png", dataBase64: "AAAA" };
const request: CompletionRequest = {
  model: "m",
  messages: [{ role: "user", content: "olhe", images: [image] }],
};

const jwt = (payload: object) =>
  ["e30", Buffer.from(JSON.stringify(payload)).toString("base64url"), "sig"].join(".");
const sse = (events: object[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
const authPath = () => {
  const path = join(mkdtempSync(join(tmpdir(), "astro-codex-att-")), "auth.json");
  writeFileSync(path, JSON.stringify({ tokens: { access_token: jwt({ exp: 4102444800 }), refresh_token: "r1", account_id: "acct_1" } }));
  return path;
};

function sessionOptions(model: ModelEntry, provider: Provider): SessionOptions {
  const cwd = mkdtempSync(join(tmpdir(), "astro-att-vision-"));
  const audit = new Auditor(join(cwd, "audit.jsonl"));
  const ledger = new Ledger(join(cwd, "ledger.jsonl"));
  return {
    run: "r1",
    agent: "default",
    credentialRef: "KEY",
    quotaDomain: "default",
    cwd,
    provider,
    model,
    executor: new ToolExecutor({ approveTool: () => true, tools: [], allow: [], audit }),
    ledger,
    audit,
    maxSteps: 1,
    images: [image],
  };
}

const model = (vision: boolean): ModelEntry => ({
  provider: "openai",
  id: "m",
  tags: [],
  context: 8192,
  status: "active",
  capabilities: { vision },
});

describe("capability vision", () => {
  test("entra no vocabulário fechado", () => {
    expect(CAPABILITY_KEYS as readonly string[]).toContain("vision");
  });
});

describe("runSession com imagem", () => {
  test("modelo sem vision rejeita antes de chamar o provider", async () => {
    let calls = 0;
    const provider: Provider = {
      complete: async (): Promise<CompletionResponse> => {
        calls++;
        return { content: "x", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    await expect(runSession(sessionOptions(model(false), provider), "olhe")).rejects.toBeInstanceOf(
      VisionUnsupportedError,
    );
    expect(calls).toBe(0);
  });

  test("modelo com vision envia a imagem na mensagem do usuário", async () => {
    let seen: CompletionRequest | undefined;
    const provider: Provider = {
      complete: async (req): Promise<CompletionResponse> => {
        seen = req;
        return { content: "ok", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    await runSession(sessionOptions(model(true), provider), "olhe");
    const user = seen?.messages.find((message) => message.role === "user");
    expect(user?.images).toEqual([image]);
  });
});

describe("wire de imagem", () => {
  test("openai-compat usa content parts text + image_url", async () => {
    let body: Record<string, unknown> | undefined;
    const fetchFn = async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    };
    const provider = new OpenAICompatProvider({ baseUrl: "http://x/v1", apiKey: "k", fetchFn, retry: { maxAttempts: 1 } });
    await provider.complete(request);
    const messages = body?.messages as Array<{ content: unknown }>;
    expect(messages[0]?.content).toEqual([
      { type: "text", text: "olhe" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
  });

  test("codex-oauth usa input_image no Responses", async () => {
    let body: { input?: Array<{ type: string; role?: string; content?: unknown[] }> } | undefined;
    const fetchFn = async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as typeof body;
      return sse([{ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } }]);
    };
    const provider = new CodexOAuthProvider({ credentialsPath: authPath(), fetchFn });
    await provider.complete(request);
    const user = body?.input?.find((item) => item.type === "message" && item.role === "user");
    expect(user?.content).toContainEqual({ type: "input_image", image_url: "data:image/png;base64,AAAA" });
  });
});
