import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { Ledger } from "../src/ledger";
import { ProviderError, type ChatMessage, type CompletionResponse } from "../src/providers/types";
import { compactionState } from "../src/compaction/breaker";
import {
  BackgroundCompactor,
  compactionArtifactPaths,
  snapshotKey,
  type BackgroundCompactionResult,
  type CompactionIdentity,
} from "../src/compaction/background";
import { completeWithCompaction } from "../src/compaction/runtime";

const resp = (content = "ok"): CompletionResponse => ({
  content, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 },
});
const toolResp = (): CompletionResponse => ({
  content: "",
  toolCalls: [{ id: "c1", name: "read_file", arguments: "{\"path\":\"x\"}" }],
  usage: { inputTokens: 1, outputTokens: 1 },
});
const user = (content: string): ChatMessage => ({ role: "user", content });
const assistant = (content: string): ChatMessage => ({ role: "assistant", content });
const ID: CompactionIdentity = { provider: "p", model: "m", window: 24_000, buffer: null };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "astro-compaction-bg-"));
  return { dir, ledger: new Ledger(join(dir, "ledger.jsonl")), audit: new Auditor(join(dir, "audit.jsonl")) };
}

/** Janela 24k, reserva 16k: limiar 8k. O histórico tem ~7k (pré-aquecimento). */
function history(): ChatMessage[] {
  return [
    { role: "system", content: "SYS" },
    user("a".repeat(12_000)),
    assistant("b".repeat(12_000)),
    user("c".repeat(4_000)),
  ];
}

/** Empurra o contexto para ~9k, acima do limiar de 8k. */
function overTrigger(messages: ChatMessage[]): ChatMessage[] {
  messages.push({ role: "assistant", content: "",
    toolCalls: [{ id: "c1", name: "read_file", arguments: "{\"path\":\"x\"}" }] });
  messages.push({ role: "tool", toolCallId: "c1", content: "d".repeat(8_000) });
  return messages;
}

function options(ledger: Ledger, audit: Auditor, background: BackgroundCompactor) {
  return {
    ledger, audit, run: "r1", agent: () => "a", window: () => 24_000,
    provider: () => "p", model: () => "m", compaction: { buffer: null }, background,
  };
}

function done(text: string): BackgroundCompactionResult {
  return {
    artifact: { schemaVersion: 1, run: "r1", active: "", blocked: [], nextMove: "", relevantFiles: [], importantContext: text },
    reduction: 1, originalTokens: 1, returnedTokens: 1, olderCount: 1, recentStart: 3,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Um step em banda baixa: mantém o contexto abaixo do gatilho de 8k. */
function inBandStep(messages: ChatMessage[], index: number): void {
  messages.push({ role: "assistant", content: `a${index}` });
  messages.push({ role: "tool", toolCallId: "c1", content: "x".repeat(200) });
}

describe("compactação em background (CMP-9)", () => {
  test("próximo turno aplica o artefato pronto sem compactar inline", async () => {
    const { dir, ledger, audit } = setup();
    const background = new BackgroundCompactor({ dir, run: "r1", ledger, audit });
    const messages = history();
    let summaries = 0;

    await completeWithCompaction(messages, {
      ...options(ledger, audit, background),
      complete: async () => toolResp(),
      summarize: async () => { summaries++; return "BG"; },
    });
    await background.drain();
    expect(summaries).toBe(1);

    overTrigger(messages);
    let seen: readonly ChatMessage[] = [];
    await completeWithCompaction(messages, {
      ...options(ledger, audit, background),
      complete: async (current) => { seen = current; return resp("ok"); },
      summarize: async () => { summaries++; return "INLINE"; },
    });

    expect(summaries).toBe(1);
    expect(seen[1]!.content).toContain("CompactionArtifactV1");
    expect(seen[1]!.content).toContain("BG");
    expect(audit.readAll().find((event) => event.tipo === "compaction.applied")?.payload)
      .toMatchObject({ reason: "trigger", background: true });
    await background.close();
  });

  test("resultado não pronto cai no inline e cancela o prewarm em voo", async () => {
    const { dir, ledger, audit } = setup();
    const background = new BackgroundCompactor({ dir, run: "r1", ledger, audit });
    const gate = deferred<string>();
    const messages = history();
    let summaries = 0;
    let aborted = false;
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => { rejections.push(reason); };
    process.on("unhandledRejection", onRejection);
    try {
      await completeWithCompaction(messages, {
        ...options(ledger, audit, background),
        complete: async () => toolResp(),
        summarize: (_input, signal) => {
          summaries++;
          if (summaries > 1) return Promise.resolve("INLINE");
          return new Promise<string>((resolve, reject) => {
            signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("aborted", "AbortError")); }, { once: true });
            gate.promise.then(resolve);
          });
        },
      });
      overTrigger(messages);

      let seen: readonly ChatMessage[] = [];
      await completeWithCompaction(messages, {
        ...options(ledger, audit, background),
        complete: async (current) => { seen = current; return resp("ok"); },
        summarize: async () => { summaries++; return "INLINE"; },
      });
      await background.close();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(summaries).toBe(2);
      expect(aborted).toBe(true);
      expect(seen[1]!.content).toContain("INLINE");
      expect(ledger.readAllEntries().filter((entry) => entry.kind === "compaction")
        .every((entry) => entry.failure_count === 0)).toBe(true);
      expect(audit.readAll().some((event) => event.tipo === "compaction.failed")).toBe(false);
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  test("overflow cancela o prewarm e compacta inline antes do retry", async () => {
    const { dir, ledger, audit } = setup();
    const background = new BackgroundCompactor({ dir, run: "r1", ledger, audit });
    const messages = history();
    let summaries = 0;
    let completions = 0;
    let aborted = false;
    const gate = deferred<string>();

    await completeWithCompaction(messages, {
      ...options(ledger, audit, background),
      complete: async () => { completions++; return toolResp(); },
      summarize: (_input, signal) => {
        summaries++;
        return new Promise<string>((resolve, reject) => {
          signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("aborted", "AbortError")); }, { once: true });
          gate.promise.then(resolve);
        });
      },
    });

    const response = await completeWithCompaction(messages, {
      ...options(ledger, audit, background),
      complete: async () => {
        completions++;
        if (completions === 2) throw new ProviderError("invalid_request", "maximum context length exceeded");
        return resp("depois");
      },
      summarize: async () => { summaries++; return "INLINE"; },
    });

    expect(response.content).toBe("depois");
    expect(completions).toBe(3);
    expect(summaries).toBe(2);
    expect(aborted).toBe(true);
    expect(audit.readAll().some((event) => event.tipo === "compaction.failed")).toBe(false);
    await background.close();
  });

  test("N steps em banda geram um único resumo e não sobrescrevem o artefato", async () => {
    const { dir, ledger, audit } = setup();
    const background = new BackgroundCompactor({ dir, run: "r1", ledger, audit });
    const messages = history();
    let summaries = 0;
    let completions = 0;
    const step = async () => completeWithCompaction(messages, {
      ...options(ledger, audit, background),
      complete: async () => { completions++; return toolResp(); },
      summarize: async () => { summaries++; return summaries === 1 ? "BG" : "OUTRO"; },
    });

    await step();
    await background.drain();
    for (let index = 0; index < 3; index++) {
      inBandStep(messages, index);
      await step();
      await background.drain();
    }

    expect(completions).toBe(4);
    expect(summaries).toBe(1);
    expect(background.take("a", messages, ID)?.artifact.importantContext).toBe("BG");
    await background.close();
  });

  test("falha repetida em banda conta uma vez e não pausa o breaker", async () => {
    const { dir, ledger, audit } = setup();
    const background = new BackgroundCompactor({ dir, run: "r1", ledger, audit });
    const messages = history();
    let summaries = 0;
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => { rejections.push(reason); };
    process.on("unhandledRejection", onRejection);
    try {
      const step = async () => completeWithCompaction(messages, {
        ...options(ledger, audit, background),
        complete: async () => toolResp(),
        summarize: async () => { summaries++; throw new Error("resumo quebrou"); },
      });

      await step();
      await background.drain();
      for (let index = 0; index < 3; index++) {
        inBandStep(messages, index);
        await step();
        await background.drain();
      }
      await background.close();
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off("unhandledRejection", onRejection);
    }

    expect(summaries).toBe(1);
    expect(rejections).toEqual([]);
    expect(ledger.readAllEntries().filter((entry) => entry.kind === "compaction").at(-1))
      .toMatchObject({ failure_count: 1 });
    expect(audit.readAll().filter((event) => event.tipo === "compaction.failed")).toHaveLength(1);
    expect(compactionState(ledger, "r1").paused).toBe(false);
  });

  test("prefixo alterado entre agendar e consumir cai no inline", async () => {
    const { dir, ledger, audit } = setup();
    const background = new BackgroundCompactor({ dir, run: "r1", ledger, audit });
    const messages = history();
    let summaries = 0;
    await completeWithCompaction(messages, {
      ...options(ledger, audit, background),
      complete: async () => toolResp(),
      summarize: async () => { summaries++; return "BG"; },
    });
    await background.drain();

    messages[1] = user("z".repeat(12_000)); // mesmo tamanho, prefixo diferente
    overTrigger(messages);
    let seen: readonly ChatMessage[] = [];
    await completeWithCompaction(messages, {
      ...options(ledger, audit, background),
      complete: async (current) => { seen = current; return resp("ok"); },
      summarize: async () => { summaries++; return "INLINE"; },
    });

    expect(summaries).toBe(2);
    expect(seen[1]!.content).toContain("INLINE");
    expect(background.take("a", messages, ID)).toBeUndefined();
    await background.close();
  });

  test("turnos concorrentes não leem artefato parcial e a fila é limitada", async () => {
    const { dir, ledger, audit } = setup();
    const background = new BackgroundCompactor({ dir, run: "r1", ledger, audit });
    const gate = deferred<string>();
    let runs = 0;

    background.schedule("a", history(), 7_000, ID, async () => { runs++; await gate.promise; return done("BG"); });
    background.schedule("a", history(), 7_000, ID, async () => { runs++; return done("2"); });
    expect(runs).toBe(1);
    expect(background.take("a", history(), ID)).toBeUndefined();

    const result = await completeWithCompaction(overTrigger(history()), {
      ...options(ledger, audit, background),
      complete: async () => resp("concorrente"),
      summarize: async () => "INLINE",
    });
    expect(result.content).toBe("concorrente");

    const closing = background.close();
    gate.resolve("BG");
    await closing;
  });

  test("artefato sobrevive ao restart, exige marcador e identidade iguais", async () => {
    const { dir, ledger, audit } = setup();
    const messages = history();
    const first = new BackgroundCompactor({ dir, run: "r1", ledger, audit });
    first.schedule("a", messages, 7_000, ID, async () => done("PERSISTIDO"));
    await first.drain();

    const marker = JSON.parse(readFileSync(compactionArtifactPaths(dir, "r1", "a").marker, "utf8"));
    expect(marker.identity).toEqual(ID);

    const second = new BackgroundCompactor({ dir, run: "r1", ledger, audit });
    expect(second.take("a", messages, { ...ID, model: "outro" })).toBeUndefined();
    expect(second.take("a", messages, ID)?.artifact.importantContext).toBe("PERSISTIDO");

    first.schedule("b", messages, 7_000, ID, async () => done("PARCIAL"));
    await first.drain();
    unlinkSync(compactionArtifactPaths(dir, "r1", "b").marker);
    const third = new BackgroundCompactor({ dir, run: "r1", ledger, audit });
    expect(third.take("b", messages, ID)).toBeUndefined();
    await first.close();
    await third.close();
  });

  test("close aguarda o job, apaga artefato não consumido e varre tmp", async () => {
    const { dir, ledger, audit } = setup();
    const producer = new BackgroundCompactor({ dir, run: "r1", ledger, audit });
    producer.schedule("a", history(), 7_000, ID, async () => done("PRONTO"));
    await producer.drain();

    const otherRun = new BackgroundCompactor({ dir, run: "r2", ledger, audit });
    expect(otherRun.take("a", history(), ID)).toBeUndefined();
    const otherAgent = new BackgroundCompactor({ dir, run: "r1", ledger, audit });
    expect(otherAgent.take("b", history(), ID)).toBeUndefined();
    expect(producer.take("a", history(), ID)?.artifact.importantContext).toBe("PRONTO");

    const gate = deferred<string>();
    producer.schedule("a", history(), 12_000, ID, async () => { await gate.promise; return done("NOVO"); });
    const stale = join(dir, "r1.a.deadbeef.compaction.json.123.tmp");
    writeFileSync(stale, "x");
    const closing = producer.close();
    let closed = false;
    void closing.then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(false);
    gate.resolve("NOVO");
    await closing;

    expect(existsSync(stale)).toBe(false);
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    const fresh = new BackgroundCompactor({ dir, run: "r1", ledger, audit });
    expect(fresh.take("a", history(), ID)).toBeUndefined();
    await otherRun.close();
    await otherAgent.close();
    await fresh.close();
  });

  test("snapshotKey é canônico para ordem e chaves opcionais", () => {
    const a: ChatMessage[] = [{ role: "user", content: "x" }];
    const b = [{ content: "x", role: "user", toolCallId: undefined }] as ChatMessage[];
    expect(snapshotKey(a)).toBe(snapshotKey(b));
  });
});
