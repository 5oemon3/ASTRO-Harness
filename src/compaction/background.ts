/**
 * Fila de compactação em background (CMP-9): um job em voo por run, resultado
 * persistido de forma atômica (tmp+rename) com marcador de prontidão. Sem
 * marcador válido o runtime cai no inline — nunca lê artefato parcial.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isAbortError } from "../abort";
import type { Auditor } from "../audit";
import type { Ledger } from "../ledger";
import type { ChatMessage } from "../providers/types";
import { recordCompactionFailure } from "./breaker";
import type { CompactResult } from "./engine";
import { renderCompactionArtifact, type CompactionArtifactV1 } from "./types";

/** Crescimento mínimo (tokens) para um novo pré-aquecimento (CMP-9). */
export const PREWARM_MARGIN = 2_000;

export type BackgroundCompactionResult =
  Pick<CompactResult, "artifact" | "reduction" | "originalTokens" | "returnedTokens" | "olderCount" | "recentStart">;

/** Identidade que produziu o artefato; um resumo de outro modelo não é reaplicável. */
export interface CompactionIdentity {
  provider: string;
  model: string;
  window: number;
  buffer: number | null;
}

export interface BackgroundCompaction extends BackgroundCompactionResult {
  snapshotKey: string;
  snapshotCount: number;
  identity: CompactionIdentity;
}

export interface BackgroundCompactorOptions {
  /** Diretório dos artefatos; um par run/agent por arquivo. */
  dir: string;
  run: string;
  ledger: Ledger;
  audit: Auditor;
}

interface Persisted extends BackgroundCompaction {
  schemaVersion: 1;
  run: string;
  agent: string;
}

interface Marker {
  schemaVersion: 1;
  digest: string;
  snapshotKey: string;
  snapshotCount: number;
  identity: CompactionIdentity;
}

/** Projeção canônica: ordem de chaves e `undefined` explícito não mudam o hash. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) out[key] = canonical(item);
  }
  return out;
}

/** Hash determinístico do prefixo do histórico; o conteúdo não é persistido. */
export function snapshotKey(messages: readonly ChatMessage[]): string {
  return createHash("sha256").update(JSON.stringify(canonical(messages))).digest("hex");
}

function sameIdentity(a: CompactionIdentity, b: CompactionIdentity): boolean {
  return a.provider === b.provider && a.model === b.model && a.window === b.window && a.buffer === b.buffer;
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "default";
}

export function compactionArtifactPaths(
  dir: string,
  run: string,
  agent: string,
): { artifact: string; marker: string } {
  // Sufixo do par cru evita colisão entre nomes que sanitizam igual.
  const unique = createHash("sha256").update(`${run}\u0000${agent}`).digest("hex").slice(0, 8);
  const base = join(dir, `${safeName(run)}.${safeName(agent)}.${unique}`);
  return { artifact: `${base}.compaction.json`, marker: `${base}.ready` };
}

/** Escrita atômica do harness: tmp exclusivo + rename. */
function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, data, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* tmp não existe */ }
    throw error;
  }
}

function cloneMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls.map((call) => ({ ...call })) }),
  }));
}

function matches(job: BackgroundCompaction, messages: readonly ChatMessage[]): boolean {
  return job.snapshotCount <= messages.length
    && snapshotKey(messages.slice(0, job.snapshotCount)) === job.snapshotKey;
}

/** Aplica o artefato pronto; a cauda acrescentada depois do snapshot é preservada. */
export function applyBackgroundCompaction(messages: ChatMessage[], job: BackgroundCompaction): void {
  const next: ChatMessage[] = [
    ...(messages[0]?.role === "system" ? [messages[0]!] : []),
    { role: "system", content: renderCompactionArtifact(job.artifact) },
    ...messages.slice(job.recentStart),
  ];
  messages.length = 0;
  messages.push(...next);
}

/**
 * Fila limitada: um job em voo; pré-aquece uma vez por crescimento relevante.
 * Falha conta no breaker uma vez por snapshot e é engolida (o próximo turno
 * retenta inline).
 */
export class BackgroundCompactor {
  readonly #dir: string;
  readonly #run: string;
  readonly #ledger: Ledger;
  readonly #audit: Auditor;
  #running: Promise<void> | undefined;
  #memory: { agent: string; job: BackgroundCompaction } | undefined;
  #active: { agent: string; controller: AbortController } | undefined;
  readonly #lastScheduled = new Map<string, number>();
  readonly #failedKeys = new Set<string>();
  readonly #agents = new Set<string>();
  #closed = false;

  constructor(opts: BackgroundCompactorOptions) {
    this.#dir = opts.dir;
    this.#run = opts.run;
    this.#ledger = opts.ledger;
    this.#audit = opts.audit;
  }

  /** Agenda um snapshot; profundidade 1 e um pré-aquecimento por crescimento. */
  schedule(
    agent: string,
    messages: readonly ChatMessage[],
    tokens: number,
    identity: CompactionIdentity,
    work: (snapshot: readonly ChatMessage[], signal: AbortSignal) => Promise<BackgroundCompactionResult>,
    signal?: AbortSignal,
  ): void {
    if (this.#closed || this.#running !== undefined || signal?.aborted === true) return;
    const last = this.#lastScheduled.get(agent);
    if (last !== undefined && tokens - last < PREWARM_MARGIN) return;
    if (this.#hasReady(agent, messages, identity)) return;

    this.#agents.add(agent);
    this.#lastScheduled.set(agent, tokens);
    const snapshot = cloneMessages(messages);
    const key = snapshotKey(snapshot);
    const count = snapshot.length;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    this.#active = { agent, controller };
    const task = (async () => {
      try {
        const result = await work(snapshot, controller.signal);
        if (controller.signal.aborted || this.#closed || result.olderCount === 0) return;
        const job: BackgroundCompaction = { ...result, snapshotKey: key, snapshotCount: count, identity };
        this.#memory = { agent, job };
        try { this.#persist(agent, job); } catch { /* sem disco a memória ainda vale */ }
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error, controller.signal)) return;
        // Uma falha por snapshot: tentativas em banda não podem abrir o breaker
        // antes do gatilho real.
        const failureId = `${agent}\u0000${key}`;
        if (this.#failedKeys.has(failureId)) return;
        this.#failedKeys.add(failureId);
        try {
          recordCompactionFailure(this.#ledger, this.#run, agent);
          this.#audit.append({
            run: this.#run, agent, tipo: "compaction.failed",
            payload: { reason: "background", error: error instanceof Error ? error.name : "unknown" },
          });
        } catch { /* bookkeeping nunca vira unhandled rejection */ }
      } finally {
        signal?.removeEventListener("abort", onAbort);
        if (this.#active?.controller === controller) this.#active = undefined;
      }
    })();
    this.#running = task.finally(() => { this.#running = undefined; });
  }

  /** Consome o artefato pronto (memória ou disco) se prefixo e identidade casarem. */
  take(
    agent: string,
    messages: readonly ChatMessage[],
    identity: CompactionIdentity,
  ): BackgroundCompaction | undefined {
    this.#agents.add(agent);
    // O contexto vai mudar (artefato aplicado ou inline): libera o próximo
    // pré-aquecimento e cancela um job que ficaria obsoleto.
    this.#lastScheduled.delete(agent);
    if (this.#active?.agent === agent) this.#active.controller.abort();
    const memory = this.#memory;
    if (memory?.agent === agent) {
      this.#memory = undefined;
      if (sameIdentity(memory.job.identity, identity) && matches(memory.job, messages)) {
        this.#clear(agent); // remove a cópia persistida do mesmo job
        return memory.job;
      }
    }
    const job = this.#load(agent, identity);
    if (job === undefined) return undefined;
    this.#clear(agent);
    return matches(job, messages) ? job : undefined;
  }

  /** Aguarda a tarefa em voo (testes e encerramento limpo). */
  async drain(): Promise<void> {
    while (this.#running !== undefined) await this.#running;
  }

  /** Aguarda o job em voo e apaga artefatos não consumidos do run. */
  async close(): Promise<void> {
    this.#closed = true;
    await this.drain();
    this.#memory = undefined;
    this.#lastScheduled.clear();
    this.#failedKeys.clear();
    for (const agent of this.#agents) this.#clear(agent);
    this.#sweepTmp();
  }

  #hasReady(agent: string, messages: readonly ChatMessage[], identity: CompactionIdentity): boolean {
    const memory = this.#memory;
    if (memory?.agent === agent && sameIdentity(memory.job.identity, identity) && matches(memory.job, messages)) {
      return true;
    }
    const disk = this.#load(agent, identity);
    return disk !== undefined && matches(disk, messages);
  }

  #persist(agent: string, job: BackgroundCompaction): void {
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    const { artifact, marker } = compactionArtifactPaths(this.#dir, this.#run, agent);
    const json = JSON.stringify({ schemaVersion: 1, run: this.#run, agent, ...job } satisfies Persisted);
    // Artefato primeiro, marcador depois: o leitor exige os dois.
    atomicWrite(artifact, json);
    const ready: Marker = {
      schemaVersion: 1,
      digest: createHash("sha256").update(json).digest("hex"),
      snapshotKey: job.snapshotKey,
      snapshotCount: job.snapshotCount,
      identity: job.identity,
    };
    atomicWrite(marker, JSON.stringify(ready));
  }

  #load(agent: string, identity: CompactionIdentity): BackgroundCompaction | undefined {
    const { artifact, marker } = compactionArtifactPaths(this.#dir, this.#run, agent);
    if (!existsSync(artifact) || !existsSync(marker)) return undefined;
    try {
      const raw = readFileSync(artifact, "utf8");
      const payload = JSON.parse(raw) as Persisted;
      const ready = JSON.parse(readFileSync(marker, "utf8")) as Marker;
      const valid = payload.schemaVersion === 1 && ready.schemaVersion === 1
        && payload.run === this.#run && payload.agent === agent
        && payload.artifact?.schemaVersion === 1 && payload.artifact.run === this.#run
        && ready.digest === createHash("sha256").update(raw).digest("hex")
        && ready.snapshotKey === payload.snapshotKey && ready.snapshotCount === payload.snapshotCount
        && sameIdentity(payload.identity, identity) && sameIdentity(ready.identity, identity)
        && Number.isInteger(payload.recentStart) && payload.recentStart >= 0
        && payload.recentStart <= payload.snapshotCount;
      if (!valid) return undefined;
      return {
        artifact: payload.artifact, reduction: payload.reduction,
        originalTokens: payload.originalTokens, returnedTokens: payload.returnedTokens,
        olderCount: payload.olderCount, recentStart: payload.recentStart,
        snapshotKey: payload.snapshotKey, snapshotCount: payload.snapshotCount,
        identity: payload.identity,
      };
    } catch {
      return undefined; // parcial/corrompido: o turno cai no inline
    }
  }

  #clear(agent: string): void {
    const { artifact, marker } = compactionArtifactPaths(this.#dir, this.#run, agent);
    for (const path of [artifact, marker]) {
      try { unlinkSync(path); } catch { /* já consumido */ }
    }
  }

  #sweepTmp(): void {
    let entries: string[];
    try { entries = readdirSync(this.#dir); } catch { return; }
    const prefix = `${safeName(this.#run)}.`;
    for (const name of entries) {
      if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
      try { unlinkSync(join(this.#dir, name)); } catch { /* já removido */ }
    }
  }
}
