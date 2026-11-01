/**
 * Guarda do loop de segmento (L5/L6, ADR-0014, #135): checkpoint na fração do
 * limite e detector de não-progresso. Funções puras — a fiação no loop da
 * sessão (`src/session.ts`) entra na fatia seguinte.
 */
import { relative, resolve } from "node:path";
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
      changedFiles.push(relative(resolve(cwd), resolveWithin(cwd, file)));
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
}
