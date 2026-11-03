/** Janelas de rolagem da TUI (#64): listas longas cabem na altura do terminal. */

export interface Window {
  readonly start: number;
  readonly end: number;
}

/** Janela [start, end) que mantém `selected` visível numa lista de `length`. */
export function listWindow(length: number, selected: number, max: number): Window {
  if (length <= 0 || max <= 0) return { start: 0, end: 0 };
  const count = Math.min(length, max);
  if (length <= max) return { start: 0, end: count };
  const start = Math.max(0, Math.min(selected - Math.floor(max / 2), length - max));
  return { start, end: start + count };
}

export interface RowOptions {
  /** Linhas assumidas quando o terminal não informa (80x24). */
  readonly fallback?: number;
  /** Piso de linhas úteis, mesmo em terminais minúsculos. */
  readonly min?: number;
  /** Teto de linhas úteis para não engolir a tela. */
  readonly cap?: number;
}

/** Linhas úteis de uma lista: altura do terminal menos o chrome fixo. */
export function listRows(rows: number | undefined, chrome: number, options: RowOptions = {}): number {
  const fallback = options.fallback ?? 24;
  const min = options.min ?? 3;
  const cap = options.cap ?? 12;
  const total = rows !== undefined && rows > 0 ? rows : fallback;
  return Math.max(min, Math.min(cap, total - chrome));
}
