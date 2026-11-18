import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, validateConfig } from "../src/core/config";
import { CodexOAuthProvider } from "../src/providers/codex-oauth";
import { OpenAICompatProvider } from "../src/providers/openai-compat";
import { networkCall } from "../src/providers/network";
import { errorPolicy } from "../src/providers/policy";
import { ProviderError } from "../src/providers/types";

const req = { model: "m", messages: [{ role: "user" as const, content: "oi" }] };

/** Servidor pendurado: só termina quando o sinal da chamada aborta. */
const hungFetch = (_url: string, init?: RequestInit): Promise<Response> =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });

const jwt = (payload: object) =>
  ["e30", Buffer.from(JSON.stringify(payload)).toString("base64url"), "sig"].join(".");

const authPath = (exp: number) => {
  const path = join(mkdtempSync(join(tmpdir(), "astro-timeout-")), "auth.json");
  writeFileSync(path, JSON.stringify({ tokens: { access_token: jwt({ exp }), refresh_token: "r1", account_id: "acct_1" } }));
  return path;
};

test("openai-compat: servidor pendurado vira network_timeout", async () => {
  const p = new OpenAICompatProvider({
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "k",
    timeoutMs: 20,
    retry: { maxAttempts: 1 },
    fetchFn: hungFetch,
  });

  const error = (await p.complete(req).catch((e) => e)) as ProviderError;
  expect(error).toBeInstanceOf(ProviderError);
  expect(error.errClass).toBe("network_timeout");
  expect(error.errClass).not.toBe("hard_quota");
});

test("openai-compat: abort do caller continua sendo cancelamento, não timeout", async () => {
  const controller = new AbortController();
  const p = new OpenAICompatProvider({
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "k",
    timeoutMs: 5_000,
    retry: { maxAttempts: 1 },
    fetchFn: hungFetch,
  });

  setTimeout(() => controller.abort(new DOMException("cancelado", "AbortError")), 10);
  const error = (await p.complete(req, controller.signal).catch((e) => e)) as Error;
  expect(error.name).toBe("AbortError");
});

/** Stream SSE controlado por relógio: emite um chunk a cada `gapMs` (I-09, #475). */
interface SlowStream {
  gapMs: number;
  chunks: number;
  /** Emite só os N primeiros chunks e fica pendurado, sem fechar o corpo. */
  hangAfter?: number;
}

const slowSse = (spec: SlowStream): ((url: string, init?: RequestInit) => Promise<Response>) => {
  return async (_url, init) => {
    const encoder = new TextEncoder();
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const abort = (): void => {
      for (const timer of timers) clearTimeout(timer);
    };
    const body = new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener("abort", () => {
          abort();
          controller.error(init.signal?.reason ?? new DOMException("Abortado", "AbortError"));
        }, { once: true });
        const emit = (text: string): void => {
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            // corpo já encerrado pelo abort
          }
        };
        const sent = spec.hangAfter ?? spec.chunks;
        for (let index = 0; index < sent; index++) {
          timers.push(setTimeout(
            () => emit(`data: ${JSON.stringify({ choices: [{ delta: { content: `t${index}` } }] })}\n\n`),
            spec.gapMs * (index + 1),
          ));
        }
        if (spec.hangAfter === undefined) {
          timers.push(setTimeout(() => {
            emit("data: [DONE]\n\n");
            try {
              controller.close();
            } catch {
              // corpo já encerrado pelo abort
            }
          }, spec.gapMs * spec.chunks + 20));
        }
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
};

/** Mesmo relógio do `slowSse`, mas com eventos SSE do Codex (responses). */
const slowCodexSse = (spec: SlowStream): ((url: string, init?: RequestInit) => Promise<Response>) => {
  return async (_url, init) => {
    const encoder = new TextEncoder();
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const body = new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener("abort", () => {
          for (const timer of timers) clearTimeout(timer);
          controller.error(init.signal?.reason ?? new DOMException("Abortado", "AbortError"));
        }, { once: true });
        const sent = spec.hangAfter ?? spec.chunks;
        for (let index = 0; index < sent; index++) {
          timers.push(setTimeout(() => {
            const event = index === spec.chunks - 1
              ? { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } }
              : { type: "response.output_text.delta", delta: `t${index}` };
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            } catch {
              // corpo já encerrado pelo abort
            }
          }, spec.gapMs * (index + 1)));
        }
        if (spec.hangAfter === undefined) {
          timers.push(setTimeout(() => {
            try {
              controller.close();
            } catch {
              // corpo já encerrado pelo abort
            }
          }, spec.gapMs * spec.chunks + 20));
        }
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
};

test("codex-oauth: stream saudável mais longo que o timeout completa", async () => {
  const p = new CodexOAuthProvider({
    credentialsPath: authPath(4102444800),
    timeoutMs: 400,
    providerName: "codex",
    fetchFn: slowCodexSse({ gapMs: 50, chunks: 10 }),
  });

  const response = await p.complete(req);
  expect(response.content).toBe("t0t1t2t3t4t5t6t7t8");
  expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
});

test("codex-oauth: stream silencioso vira network_timeout citando limite e ajuste", async () => {
  const p = new CodexOAuthProvider({
    credentialsPath: authPath(4102444800),
    timeoutMs: 300,
    providerName: "codex",
    fetchFn: slowCodexSse({ gapMs: 20, chunks: 3, hangAfter: 1 }),
  });

  const error = (await p.complete(req).catch((e) => e)) as ProviderError;
  expect(error).toBeInstanceOf(ProviderError);
  expect(error.errClass).toBe("network_timeout");
  expect(error.message).toContain("300ms");
  expect(error.message).toContain("inatividade");
  expect(error.message).toContain("providers.codex.timeoutMs");
});

test("codex-oauth: abort do caller durante o stream continua cancelamento", async () => {
  const controller = new AbortController();
  const p = new CodexOAuthProvider({
    credentialsPath: authPath(4102444800),
    timeoutMs: 5_000,
    providerName: "codex",
    fetchFn: slowCodexSse({ gapMs: 50, chunks: 10 }),
  });

  setTimeout(() => controller.abort(new DOMException("cancelado", "AbortError")), 80);
  const error = (await p.complete(req, controller.signal).catch((e) => e)) as Error;
  expect(error.name).toBe("AbortError");
});

test("networkCall: reset depois de dispose não re-arma o prazo", async () => {
  const net = networkCall(undefined, 10);
  net.dispose();
  net.reset();
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(net.timedOut()).toBe(false);
  net.dispose();
});

test("openai-compat: stream saudável mais longo que o timeout completa", async () => {
  // 600ms de stream contra timeoutMs 400: nenhum silêncio de 50ms chega perto do limite.
  const p = new OpenAICompatProvider({
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "k",
    timeoutMs: 400,
    retry: { maxAttempts: 1 },
    fetchFn: slowSse({ gapMs: 50, chunks: 12 }),
  });

  const deltas: string[] = [];
  const response = await p.complete({ ...req, onToken: (text) => deltas.push(text) });
  expect(deltas).toEqual(["t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10", "t11"]);
  expect(response.content).toBe("t0t1t2t3t4t5t6t7t8t9t10t11");
});

test("openai-compat: stream silencioso vira network_timeout citando limite e ajuste", async () => {
  const p = new OpenAICompatProvider({
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "k",
    timeoutMs: 120,
    retry: { maxAttempts: 1 },
    fetchFn: slowSse({ gapMs: 20, chunks: 3, hangAfter: 1 }),
  });

  const error = (await p.complete({ ...req, onToken: () => {} }).catch((e) => e)) as ProviderError;
  expect(error).toBeInstanceOf(ProviderError);
  expect(error.errClass).toBe("network_timeout");
  expect(error.message).toContain("120ms");
  expect(error.message).toContain("inatividade");
  expect(error.message).toContain("providers.<name>.timeoutMs");
});

test("openai-compat: chamada sem streaming mantém o timeout total", async () => {
  const p = new OpenAICompatProvider({
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "k",
    timeoutMs: 30,
    retry: { maxAttempts: 1 },
    fetchFn: hungFetch,
  });

  const error = (await p.complete(req).catch((e) => e)) as ProviderError;
  expect(error).toBeInstanceOf(ProviderError);
  expect(error.errClass).toBe("network_timeout");
  expect(error.message).toContain("30ms");
  expect(error.message).toContain("timeout total");
  expect(error.message).toContain("providers.<name>.timeoutMs");
});

test("openai-compat: timeout cita o provider real quando o nome é conhecido", async () => {
  const p = new OpenAICompatProvider({
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "k",
    timeoutMs: 20,
    providerName: "mock",
    retry: { maxAttempts: 1 },
    fetchFn: hungFetch,
  });

  const error = (await p.complete(req).catch((e) => e)) as ProviderError;
  expect(error.message).toContain("providers.mock.timeoutMs");
  expect(error.message).not.toContain("<name>");
});

test("openai-compat: abort do caller durante o stream continua cancelamento", async () => {
  const controller = new AbortController();
  const p = new OpenAICompatProvider({
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "k",
    timeoutMs: 5_000,
    retry: { maxAttempts: 1 },
    fetchFn: slowSse({ gapMs: 50, chunks: 10 }),
  });

  setTimeout(() => controller.abort(new DOMException("cancelado", "AbortError")), 30);
  const error = (await p.complete({ ...req, onToken: () => {} }, controller.signal).catch((e) => e)) as Error;
  expect(error.name).toBe("AbortError");
});

test("codex-oauth: servidor pendurado vira network_timeout", async () => {
  const p = new CodexOAuthProvider({
    credentialsPath: authPath(4102444800),
    timeoutMs: 20,
    fetchFn: hungFetch,
  });

  const error = (await p.complete(req).catch((e) => e)) as ProviderError;
  expect(error).toBeInstanceOf(ProviderError);
  expect(error.errClass).toBe("network_timeout");
  expect(error.message).not.toContain(jwt({ exp: 4102444800 }));
});

test("codex-oauth: refresh pendurado vira network_timeout (não trava o run)", async () => {
  const p = new CodexOAuthProvider({
    credentialsPath: authPath(1), // expirado → força o refresh
    timeoutMs: 20,
    fetchFn: hungFetch, // endpoint de auth pendurado: só termina se o sinal da chamada abortar
  });

  // corrida com rélogua própria para o RED não travar a suíte: antes do fix o
  // refresh usa o signal nu do caller (undefined aqui) e nunca resolve.
  const outcome = await Promise.race([
    p.complete(req).then(
      () => "resolved",
      (e) => (e instanceof ProviderError ? `err:${e.errClass}` : `err:${String(e)}`),
    ),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 500)),
  ]);
  expect(outcome).toBe("err:network_timeout");
});

test("policy: network_timeout retenta com backoff e nunca faz skip de quota", () => {
  expect(errorPolicy("network_timeout", 1)).toBe("retry_backoff");
  expect(errorPolicy("network_timeout", 99)).toBe("fallback");
});

test("config aceita provider.timeoutMs e rejeita valor não positivo", () => {
  const base = {
    providers: { p: { kind: "openai-compat", baseUrl: "https://p.example/v1", credentialRef: "KEY" } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "p/m1", maxSteps: 2, tools: ["read_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  };

  const config = validateConfig({
    ...structuredClone(base),
    providers: { p: { ...base.providers.p, timeoutMs: 2500 } },
  });
  expect(config.providers.p.timeoutMs).toBe(2500);

  expect(() => validateConfig({
    ...structuredClone(base),
    providers: { p: { ...base.providers.p, timeoutMs: 0 } },
  })).toThrow(ConfigError);
});
