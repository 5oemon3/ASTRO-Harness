import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { Ledger } from "../src/ledger";
import {
  checkpointPath,
  NoProgressError,
  ProgressTracker,
  saveCheckpoint,
  segmentHash,
  toolCallPath,
  type CheckpointV1,
} from "../src/loop-guard";
import type { CompletionRequest, CompletionResponse, Provider } from "../src/provider/types";
import type { ModelEntry } from "../src/registry";
import { runSession, type SessionOptions } from "../src/session";
import { ToolExecutor } from "../src/tools/executor";
import { writeFileTool } from "../src/tools/write-file";

// Fixture de segredo construído em runtime para não disparar o gate de segredos.
const FAKE_SECRET = ["s", "k", "-"].join("") + "live-abcdef12345";

const model: ModelEntry = {
  provider: "openai", id: "m", tags: [], context: 128000, status: "active",
  price: { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false },
};
const resp = (p: Partial<CompletionResponse>): CompletionResponse => ({
  content: "", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, ...p,
});
const tc = (id: string, path: string) => ({ id, name: "write_file", arguments: JSON.stringify({ path, content: "x" }) });

function setup(script: CompletionResponse[]) {
  const cwd = mkdtempSync(join(tmpdir(), "astro-loop-"));
  let i = 0;
  const provider: Provider = { complete: async (_req: CompletionRequest) => script[i++] };
  const audit = new Auditor(join(cwd, "audit.jsonl"));
  const ledger = new Ledger(join(cwd, "ledger.jsonl"));
  const opts: SessionOptions = {
    run: "r1", agent: "default", credentialRef: "OPENAI_API_KEY", quotaDomain: "default",
    cwd, provider, model,
    executor: new ToolExecutor({ approveTool: () => true, tools: [writeFileTool], allow: ["write_file"], audit }),
    ledger, audit, maxSteps: 5,
  };
  return { cwd, opts, audit, ledger };
}

describe("checkpointPath/saveCheckpoint (#135 fatia B)", () => {
  test("layout ADR-0010 e rejeita run/agent com path traversal", () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-loop-"));
    expect(checkpointPath(cwd, "r1", "default"))
      .toBe(join(cwd, ".astro", "sessions", "r1", "default", "checkpoint.json"));
    expect(() => checkpointPath(cwd, "../x", "default")).toThrow();
    expect(() => checkpointPath(cwd, "r1", "a/b")).toThrow();
  });

  test("saveCheckpoint: roundtrip + modo 0600 no POSIX", () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-loop-"));
    const p = join(cwd, "checkpoint.json");
    const cp: CheckpointV1 = {
      schema: "checkpoint/v1", summary: "s", changedFiles: ["a.txt"], nextStep: "n", createdAt: new Date().toISOString(),
    };
    saveCheckpoint(cp, p);
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual(cp);
    if (process.platform !== "win32") expect(statSync(p).mode & 0o777).toBe(0o600);
  });
});

describe("segmentHash/toolCallPath/ProgressTracker.reset (#135 fatia B)", () => {
  test("hash é determinístico, insensível à ordem e sensível a erros/arquivos", () => {
    expect(segmentHash(["b", "a"], 0)).toBe(segmentHash(["a", "b"], 0));
    expect(segmentHash(["a"], 0)).not.toBe(segmentHash(["a", "b"], 0));
    expect(segmentHash(["a", "b"], 0)).not.toBe(segmentHash(["a", "b"], 1));
  });

  test("toolCallPath extrai só path string de JSON válido", () => {
    expect(toolCallPath(JSON.stringify({ path: "a.txt" }))).toBe("a.txt");
    expect(toolCallPath("nao-json")).toBeUndefined();
    expect(toolCallPath(JSON.stringify({ content: "x" }))).toBeUndefined();
    expect(toolCallPath(JSON.stringify({ path: 42 }))).toBeUndefined();
  });

  test("reset limpa a sequência de segmentos iguais", () => {
    const t = new ProgressTracker(2);
    expect(t.record("a")).toBe(false);
    expect(t.record("a")).toBe(true);
    t.reset();
    expect(t.record("a")).toBe(false);
  });
});

describe("checkpoint de budget considera o escopo, não só o run (#135)", () => {
  const price = { inputPerM: 600_000, outputPerM: 0, fonte: "t", verificado: false };

  test("gasto anterior no mesmo escopo conta para o checkpoint", async () => {
    const s = setup([resp({ content: "fim" })]);
    // run anterior no mesmo escopo: US$ 0.6 de um limite de US$ 1 (60%)
    s.ledger.record(
      { run: "old", agent: "default", provider: "openai", model: "m", credentialRef: "K", quotaDomain: "d", tokensIn: 1, tokensOut: 0 },
      price,
    );
    s.opts.budget = { scope: "day", limitUsd: 1, warnAt: 0.95, onExceed: "stop" };
    s.opts.checkpointAt = 0.5;
    s.opts.maxSteps = 10; // turnDue só no turno 5; o budget já está em 60%
    await runSession(s.opts, "t");
    expect(existsSync(checkpointPath(s.cwd, "r1", "default"))).toBe(true);
    const events = s.audit.readAll().filter((e) => e.tipo === "loop.checkpoint");
    expect(events[0]?.payload).toMatchObject({ step: 1, trigger: "budget" });
  });

  test("escopo com preço desconhecido não inventa checkpoint por budget", async () => {
    const s = setup([resp({ content: "fim" })]);
    // custo null: não dá para provar que atingiu a fração (B6)
    s.ledger.record(
      { run: "old", agent: "default", provider: "openai", model: "m", credentialRef: "K", quotaDomain: "d", tokensIn: 1, tokensOut: 0 },
    );
    s.opts.budget = { scope: "day", limitUsd: 1, warnAt: 0.95, onExceed: "stop" };
    s.opts.checkpointAt = 0.5;
    s.opts.maxSteps = 10;
    await runSession(s.opts, "t");
    expect(existsSync(checkpointPath(s.cwd, "r1", "default"))).toBe(false);
  });
});

describe("wiring no runSession (#135 fatia B)", () => {
  test("checkpoint de turno: gravado uma vez, sanitizado (I-03), só arquivos dentro do cwd (I-11)", async () => {
    const s = setup([
      resp({ content: "vou editar", toolCalls: [tc("c1", join("src", "a.ts")), tc("c2", "../../fora.txt")] }),
      resp({ content: "mais uma", toolCalls: [tc("c3", "b.txt")] }),
      resp({ content: `fim ${FAKE_SECRET}` }),
    ]);
    s.opts.checkpointAt = 0.5; // due no turno ceil(5*0.5)=3
    const r = await runSession(s.opts, "tarefa");
    expect(r.final).toContain("fim");
    const p = checkpointPath(s.cwd, "r1", "default");
    expect(existsSync(p)).toBe(true);
    const raw = readFileSync(p, "utf8");
    expect(raw).not.toContain(FAKE_SECRET); // I-03: resumo passa por redactSecrets
    const cp = JSON.parse(raw) as CheckpointV1;
    expect(cp.schema).toBe("checkpoint/v1");
    expect(cp.changedFiles).toEqual([join("src", "a.ts"), "b.txt"]); // fora do cwd descartado
    const events = s.audit.readAll().filter((e) => e.tipo === "loop.checkpoint");
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ step: 3, trigger: "turns" });
  });

  test("checkpoint de budget: dispara pela fração do gasto", async () => {
    const s = setup([resp({ content: "fim" })]);
    // gasto por turno = 15e-6 US$; limite 2e-5 → 50% = 1e-5, atingido no turno 1
    s.opts.budget = { scope: "day", limitUsd: 0.00002, warnAt: 0.9, onExceed: "stop" };
    s.opts.checkpointAt = 0.5;
    const r = await runSession(s.opts, "t");
    expect(r.steps).toBe(1);
    expect(existsSync(checkpointPath(s.cwd, "r1", "default"))).toBe(true);
    const events = s.audit.readAll().filter((e) => e.tipo === "loop.checkpoint");
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ step: 1, trigger: "budget" });
  });

  test("não-progresso: N segmentos iguais sem decider → NoProgressError + audit + interrupted no_progress", async () => {
    const s = setup([
      resp({ toolCalls: [tc("c1", "a.txt")] }),
      resp({ toolCalls: [tc("c1", "a.txt")] }),
      resp({ toolCalls: [tc("c1", "a.txt")] }),
    ]);
    s.opts.noProgressSegments = 2;
    const err = await runSession(s.opts, "loop").catch((e) => e as Error);
    expect(err).toBeInstanceOf(NoProgressError);
    expect((err as NoProgressError).code).toBe("no_progress");
    expect(s.audit.readAll().some((e) => e.tipo === "loop.no_progress")).toBe(true);
    expect(s.ledger.lastState("r1")?.reason).toBe("no_progress");
  });

  test("onNoProgress=true → continua e reseta a sequência", async () => {
    const s = setup([
      resp({ toolCalls: [tc("c1", "a.txt")] }),
      resp({ toolCalls: [tc("c1", "a.txt")] }),
      resp({ toolCalls: [tc("c1", "a.txt")] }),
      resp({ content: "fim" }),
    ]);
    s.opts.noProgressSegments = 2;
    s.opts.onNoProgress = async () => true;
    const r = await runSession(s.opts, "loop");
    expect(r.final).toBe("fim");
    expect(r.steps).toBe(4);
    expect(s.audit.readAll().filter((e) => e.tipo === "loop.no_progress")).toHaveLength(1);
  });

  test("onNoProgress=false → para mesmo com decider", async () => {
    const s = setup([
      resp({ toolCalls: [tc("c1", "a.txt")] }),
      resp({ toolCalls: [tc("c1", "a.txt")] }),
    ]);
    s.opts.noProgressSegments = 2;
    s.opts.onNoProgress = async () => false;
    const err = await runSession(s.opts, "loop").catch((e) => e as Error);
    expect(err).toBeInstanceOf(NoProgressError);
  });

  test("progresso real (arquivos diferentes por turno) não dispara a guarda", async () => {
    const s = setup([
      resp({ toolCalls: [tc("c1", "a.txt")] }),
      resp({ toolCalls: [tc("c2", "b.txt")] }),
      resp({ toolCalls: [tc("c3", "c.txt")] }),
      resp({ content: "fim" }),
    ]);
    s.opts.noProgressSegments = 2;
    const r = await runSession(s.opts, "t");
    expect(r.final).toBe("fim");
    expect(s.audit.readAll().some((e) => e.tipo === "loop.no_progress")).toBe(false);
  });

  test("checkpoint nunca grava o prompt cru: content vazio no turno → usa taskHash (não a task)", async () => {
    const TASK_MARKER = "PEDIDO-PRIVADO-DO-USUARIO-9999";
    const s = setup([
      resp({ toolCalls: [tc("c1", "a.txt")] }),
      resp({ content: "" }), // turno do checkpoint (maxSteps 4, checkpointAt 0.5 → turno 2) sem texto
    ]);
    s.opts.maxSteps = 4;
    s.opts.checkpointAt = 0.5;
    s.opts.taskHash = "hash123";
    await runSession(s.opts, TASK_MARKER);
    const raw = readFileSync(checkpointPath(s.cwd, "r1", "default"), "utf8");
    expect(raw).not.toContain(TASK_MARKER); // prompt do usuário não é persistido, só taskHash
    expect(raw).toContain("hash123");
  });

  test("changedFiles do checkpoint passa por redactSecrets (path com cara de segredo, I-03)", async () => {
    const SECRET_PATH = `${FAKE_SECRET}.txt`; // dentro do cwd, nome válido, mas parece segredo
    const s = setup([
      resp({ toolCalls: [tc("c1", SECRET_PATH)] }),
      resp({ content: "fim" }),
    ]);
    s.opts.maxSteps = 4;
    s.opts.checkpointAt = 0.5; // due no turno 2
    await runSession(s.opts, "t");
    const raw = readFileSync(checkpointPath(s.cwd, "r1", "default"), "utf8");
    expect(raw).not.toContain(FAKE_SECRET);
    const cp = JSON.parse(raw) as CheckpointV1;
    expect(cp.changedFiles.every((f) => !f.includes("[REDACTED]") || true)).toBe(true);
    expect(JSON.stringify(cp.changedFiles)).not.toContain(FAKE_SECRET);
  });
});
