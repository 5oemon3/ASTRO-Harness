import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/core/app";
import { Ledger } from "../src/ledger";
import { testEnv } from "./setup";

interface AuditRow { run: string; tipo: string; payload: Record<string, unknown> }
interface UsageRow {
  kind?: string; run: string; provider: string; model: string; credentialRef: string;
  quotaDomain: string; profile?: string; tokensIn: number; tokensOut: number; costUsd: number | null;
  fallbacks?: { profile: string; from_provider: string; to_provider: string; reason: string }[];
}

function mockServer(status: number, content: string, seen: string[] = []) {
  return Bun.serve({
    port: 0,
    fetch: async (req) => {
      seen.push(((await req.json()) as { model?: string }).model ?? "");
      return status === 200
        ? Response.json({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })
        : new Response(content, { status });
    },
  });
}

const provider = (baseUrl: string, credentialRef: string, extra: Record<string, unknown> = {}) => ({
  kind: "openai-compat", baseUrl, credentialRef, ...extra,
});
const model = (name: string, id: string) => ({ provider: name, id, tags: ["writing-code"], context: 4096 });
const price = (inputPerM: number, outputPerM: number) => ({
  inputPerM, outputPerM, fonte: "teste", verificado: true,
});
const baseUrl = (server: { port?: number }) => `http://127.0.0.1:${server.port}/v1`;

function writeConfig(dir: string, cfg: Record<string, unknown>): string {
  const path = join(dir, "astro.config.json");
  writeFileSync(path, JSON.stringify({ ...cfg, paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" } }));
  return path;
}
function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
}
const readAudit = (dir: string) => readJsonl<AuditRow>(join(dir, ".astro", "audit.jsonl"));
function readUsage(dir: string): UsageRow[] {
  return readJsonl<UsageRow>(join(dir, ".astro", "ledger.jsonl")).filter((e) => e.kind === undefined || e.kind === "usage");
}

/** Pré-carrega uso de hoje no ledger para exercitar quota. */
function seedUsage(dir: string, quotaDomain: string, tokensIn: number): void {
  mkdirSync(join(dir, ".astro"), { recursive: true });
  new Ledger(join(dir, ".astro", "ledger.jsonl"), { warn: () => {} }).record({
    run: "seed", agent: "seed", provider: "seed", model: "seed",
    credentialRef: "SEED", quotaDomain, tokensIn, tokensOut: 0,
  });
}

/** Config base dos cenários: p1 (a/m1) cai para p2 (b/m2); preços bem distintos. */
function profileConfig() {
  return {
    providers: {
      a: provider("http://127.0.0.1:1/v1", "KEY_A", { quotaDomain: "dom-a", maxRetries: 0, retryBackoffMs: 1 }),
      b: provider("http://127.0.0.1:1/v1", "KEY_B", { quotaDomain: "dom-b" }),
    },
    models: [
      { ...model("a", "m1"), price: price(1_000_000, 0) },
      { ...model("b", "m2"), price: price(10, 20) },
    ],
    modelPool: { p1: { model: "a/m1", fallback: ["p2"] }, p2: { model: "b/m2" } },
    agent: { profile: "p1", maxSteps: 2, tools: [] },
  };
}

test("fallback de profile grava trilha e identidade efetiva no ledger", async () => {
  const seen: string[] = [];
  const up = mockServer(200, "do-b", seen);
  try {
    const dir = mkdtempSync(join(tmpdir(), "astro-f31d-"));
    const cfgPath = writeConfig(dir, {
      ...profileConfig(),
      providers: {
        a: provider("http://127.0.0.1:1/v1", "KEY_A", { quotaDomain: "dom-a" }), // sem credencial no env
        b: provider(baseUrl(up), "KEY_B", { quotaDomain: "dom-b" }),
      },
    });
    const report = await runTask({ approveSwap: () => true, configPath: cfgPath, task: "x", cwd: dir, env: testEnv({ KEY_B: "secret-b" }) });

    expect(report.final).toBe("do-b");
    expect(seen).toEqual(["m2"]);
    const usage = readUsage(dir).find((e) => e.run === report.runId)!;
    expect(usage).toMatchObject({
      provider: "b", model: "m2", credentialRef: "KEY_B", quotaDomain: "dom-b", profile: "p1",
    });
    expect(usage.fallbacks).toEqual([
      { profile: "p1", from_provider: "a", to_provider: "b", reason: "invalid_request" },
    ]);
    // preço de b/m2, não de a/m1 (que daria 10.0)
    expect(usage.costUsd).toBeCloseTo((10 * 10 + 5 * 20) / 1_000_000, 10);

    const audit = readAudit(dir);
    const acquired = audit.filter((e) => e.tipo === "credential.acquired");
    expect(acquired).toHaveLength(1); // a não adquiriu credencial
    expect(acquired[0]!.payload).toMatchObject({
      provider: "b", credentialRef: "KEY_B", quotaDomain: "dom-b", profile: "p2",
    });
    expect(audit.find((e) => e.tipo === "run.started")!.payload.profile).toBe("p1");
    expect(readFileSync(join(dir, ".astro", "audit.jsonl"), "utf8")).not.toContain("secret-b");
  } finally {
    up.stop(true);
  }
});

test("quota esgotada no profile de origem não impede o fallback para domínio saudável", async () => {
  const downSeen: string[] = [];
  const down = mockServer(503, "fora", downSeen);
  const up = mockServer(200, "do-b");
  try {
    const dir = mkdtempSync(join(tmpdir(), "astro-f31d-"));
    seedUsage(dir, "dom-a", 100);
    const cfgPath = writeConfig(dir, {
      ...profileConfig(),
      providers: {
        a: provider(baseUrl(down), "KEY_A", { quotaDomain: "dom-a", maxRetries: 0, retryBackoffMs: 1 }),
        b: provider(baseUrl(up), "KEY_B", { quotaDomain: "dom-b" }),
      },
      quota: { "dom-a": { dailyTokens: 100 } },
    });
    const report = await runTask({ approveSwap: () => true,
      configPath: cfgPath, task: "x", cwd: dir, env: testEnv({ KEY_A: "secret-a", KEY_B: "secret-b" }),
    });

    expect(report.final).toBe("do-b");
    expect(downSeen).toEqual([]); // barrado pela quota antes da chamada
    expect(readUsage(dir).find((e) => e.run === report.runId)).toMatchObject({
      provider: "b", model: "m2", quotaDomain: "dom-b",
    });
  } finally {
    down.stop(true);
    up.stop(true);
  }
});

test("quota esgotada no domínio de destino bloqueia antes de chamar o provider", async () => {
  const upSeen: string[] = [];
  const down = mockServer(503, "fora");
  const up = mockServer(200, "do-b", upSeen);
  try {
    const dir = mkdtempSync(join(tmpdir(), "astro-f31d-"));
    seedUsage(dir, "dom-b", 100);
    const cfgPath = writeConfig(dir, {
      ...profileConfig(),
      providers: {
        a: provider(baseUrl(down), "KEY_A", { quotaDomain: "dom-a", maxRetries: 0, retryBackoffMs: 1 }),
        b: provider(baseUrl(up), "KEY_B", { quotaDomain: "dom-b" }),
      },
      quota: { "dom-b": { dailyTokens: 100 } },
    });
    const err = (await runTask({ approveSwap: () => true,
      configPath: cfgPath, task: "x", cwd: dir, env: testEnv({ KEY_A: "secret-a", KEY_B: "secret-b" }),
    }).then(() => null, (e) => e)) as { errClass?: string; message?: string };

    expect(err?.errClass).toBe("hard_quota");
    expect(err?.message).toContain('"dom-b"');
    expect(upSeen).toEqual([]);
    expect(readUsage(dir).filter((e) => e.run !== "seed" && e.kind !== "run_state")).toHaveLength(0);
  } finally {
    down.stop(true);
    up.stop(true);
  }
});

function singleConfig(server: { port?: number }, modelId: string, pricing: Record<string, unknown> = {}) {
  return {
    providers: { p: provider(baseUrl(server), "KEY_P", { maxRetries: 0, retryBackoffMs: 1 }) },
    models: [{ ...model("p", modelId), ...pricing }],
    agent: { model: `p/${modelId}`, maxSteps: 3, tools: [] as string[] },
  };
}

test("#476 entrada histórica sem preço não torna n/d o custo de um run precificado", async () => {
  const server = mockServer(200, "ok");
  try {
    const dir = mkdtempSync(join(tmpdir(), "astro-f476-a-"));
    mkdirSync(join(dir, ".astro"), { recursive: true });
    new Ledger(join(dir, ".astro", "ledger.jsonl"), { warn: () => {} }).record({
      run: "old", agent: "old", provider: "old", model: "sem-preco",
      credentialRef: "OLD", quotaDomain: "d", tokensIn: 10, tokensOut: 0,
    });
    const cfgPath = writeConfig(dir, singleConfig(server, "m1", { price: price(1_000_000, 0) }));
    const report = await runTask({ configPath: cfgPath, task: "x", cwd: dir, env: testEnv({ KEY_P: "k" }) });
    expect(typeof report.costUsd).toBe("number");
    expect(report.costUsd!).toBeGreaterThan(0);
  } finally {
    server.stop(true);
  }
});

test("#476 modelo FREE sem preço curado reporta custo 0, nunca n/d", async () => {
  const server = mockServer(200, "ok");
  try {
    const dir = mkdtempSync(join(tmpdir(), "astro-f476-b-"));
    const cfgPath = writeConfig(dir, singleConfig(server, "llama3:free"));
    const report = await runTask({ configPath: cfgPath, task: "x", cwd: dir, env: testEnv({ KEY_P: "k" }) });
    expect(report.costUsd).toBe(0);
  } finally {
    server.stop(true);
  }
});

test("#476 custo do run ignora entrada de outro run gravada na mesma janela", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-f476-c-"));
  mkdirSync(join(dir, ".astro"), { recursive: true });
  const ledgerPath = join(dir, ".astro", "ledger.jsonl");
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      // writer concorrente no mesmo arquivo, com seq dentro da janela do run
      new Ledger(ledgerPath, { warn: () => {} }).record({
        run: "intruder", agent: "x", provider: "p", model: "m",
        credentialRef: "K", quotaDomain: "d", tokensIn: 1, tokensOut: 0,
      }, { inputPerM: 1_000_000, outputPerM: 0, fonte: "t", verificado: true });
      return Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    },
  });
  try {
    const cfgPath = writeConfig(dir, singleConfig(server, "m1", { price: price(1_000_000, 0) }));
    const report = await runTask({ configPath: cfgPath, task: "x", cwd: dir, env: testEnv({ KEY_P: "k" }) });
    expect(report.costUsd).toBeCloseTo(10, 10); // só os 10 tokens deste run, sem o US$ 1 do intruso
  } finally {
    server.stop(true);
  }
});

test("#476 aviso de preço ausente é único entre turnos com o mesmo Set", async () => {
  const server = mockServer(200, "ok");
  const warns: string[] = [];
  const spy = spyOn(console, "warn").mockImplementation((message?: unknown) => {
    warns.push(String(message));
  });
  try {
    const dir = mkdtempSync(join(tmpdir(), "astro-f476-d-"));
    const cfgPath = writeConfig(dir, singleConfig(server, "m1"));
    const warned = new Set<string>();
    await runTask({ configPath: cfgPath, task: "a", cwd: dir, env: testEnv({ KEY_P: "k" }), warnedNoPrice: warned });
    await runTask({ configPath: cfgPath, task: "b", cwd: dir, env: testEnv({ KEY_P: "k" }), warnedNoPrice: warned });
    expect(warns.filter((m) => m.includes("sem preço curado")).length).toBe(1);
  } finally {
    spy.mockRestore();
    server.stop(true);
  }
});
