/**
 * Guarda do loop de segmento (L5/L6, ADR-0014, #135): checkpoint na fração do
 * limite e detector de não-progresso, com a persistência do checkpoint no
 * store da sessão (ADR-0010) e a parada segura de não-progresso (I-19).
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { redactSecrets } from "./sanitize-external";
import { resolveWithin } from "./tools/paths";

/** Checkpoint gravado no store da sessão (ADR-0010); sempre sanitizado (I-03). */
export interface CheckpointV1 {
  schema: "checkpoint/v1";
  summary: string;
  /** Caminhos relativos ao cwd; arquivo fora do cwd nunca entra (I-11). */
  changedFiles: string[];
  nextStep: string;
  createdAt: string;
}

export interface CheckpointDraft {
  summary: string;
  changedFiles: string[];
  nextStep: string;
}

/** Checkpoint de turnos é devido quando o turno atual atinge a fração do limite (arredondada para cima). */
export function turnCheckpointDue(turn: number, maxTurns: number, checkpointAt: number): boolean {
  return turn >= Math.ceil(maxTurns * checkpointAt);
}

/** Checkpoint de budget é devido quando o gasto atinge a fração do limite. */
export function budgetCheckpointDue(spentUsd: number, limitUsd: number, checkpointAt: number): boolean {
  return spentUsd >= limitUsd * checkpointAt;
}

/**
 * Monta o checkpoint sanitizado: texto passa por `redactSecrets` (I-03) e só
 * arquivos dentro do `cwd` entram, como caminho relativo (I-11).
 */
export function buildCheckpoint(draft: CheckpointDraft, cwd: string, now: Date = new Date()): CheckpointV1 {
  const changedFiles: string[] = [];
  for (const file of draft.changedFiles) {
    try {
      // path vem de argumento de tool (controle do modelo): redige antes de gravar (I-03)
      changedFiles.push(redactSecrets(relative(resolve(cwd), resolveWithin(cwd, file))));
    } catch {
      // fora do cwd (I-11): descarta em vez de gravar
    }
  }
  return {
    schema: "checkpoint/v1",
    summary: redactSecrets(draft.summary),
    changedFiles,
    nextStep: redactSecrets(draft.nextStep),
    createdAt: now.toISOString(),
  };
}

/**
 * Detector de não-progresso (L6): `segments` segmentos consecutivos com o
 * mesmo hash de estado fazem `record` devolver true (pausa e pergunta).
 */
export class ProgressTracker {
  readonly #segments: number;
  #lastHash: string | undefined;
  #streak = 0;

  constructor(segments: number) {
    this.#segments = segments;
  }

  /** Registra o hash do segmento; true quando a sequência de iguais atinge o limite. */
  record(hash: string): boolean {
    if (hash === this.#lastHash) {
      this.#streak += 1;
    } else {
      this.#lastHash = hash;
      this.#streak = 1;
    }
    return this.#streak >= this.#segments;
  }

  /** Limpa a sequência (usado depois que o usuário escolhe continuar). */
  reset(): void {
    this.#lastHash = undefined;
    this.#streak = 0;
  }
}

const SAFE_ID = /^[A-Za-z0-9-]+$/;

/** Caminho do checkpoint no store da sessão (ADR-0010): `.astro/sessions/<run>/<agent>/checkpoint.json`. */
export function checkpointPath(cwd: string, run: string, agent: string): string {
  // run/agent entram no path do arquivo: só id alfanumérico com hífen (sem separador, sem "..")
  if (!SAFE_ID.test(run) || !SAFE_ID.test(agent)) {
    throw new Error("identificador de run/agent inválido para o checkpoint");
  }
  return join(resolve(cwd), ".astro", "sessions", run, agent, "checkpoint.json");
}

/** Grava o checkpoint atômico (tmp + rename, modo 0600 no POSIX). */
export function saveCheckpoint(checkpoint: CheckpointV1, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(checkpoint, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* tmp já não existe */ }
    throw error;
  }
}

/** Hash do segmento (L6): arquivos tocados (únicos, ordenados) + nº de erros de tool. */
export function segmentHash(touchedFiles: readonly string[], errorCount: number): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify([...new Set(touchedFiles)].sort()));
  hash.update(`\nerrors:${errorCount}`);
  return hash.digest("hex");
}

/** Extrai `path` (string) dos argumentos JSON de uma tool call; inválido → undefined. */
export function toolCallPath(argumentsJson: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    if (parsed !== null && typeof parsed === "object") {
      const path = (parsed as { path?: unknown }).path;
      if (typeof path === "string") return path;
    }
  } catch { /* não era JSON */ }
  return undefined;
}

/** Parada segura por não-progresso (L6, I-19): jogada quando a sequência de segmentos iguais atinge o limite sem decisão de continuar. */
export class NoProgressError extends Error {
  readonly code = "no_progress";
  constructor(readonly segments: number, readonly step: number) {
    super(`sem progresso por ${segments} segmentos consecutivos (turno ${step}); parado em ponto seguro`);
    this.name = "NoProgressError";
  }
}

/** Decisor de não-progresso (L6): true continua (e reseta a sequência); false/ausente para seguro. */
export type NoProgressDecider = (info: {
  run: string;
  agent: string;
  step: number;
  segments: number;
}) => boolean | Promise<boolean>;
