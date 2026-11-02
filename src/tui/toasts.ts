/**
 * Toasts não bloqueantes da TUI (#64): fila pura, sem React e sem I/O.
 * Erro/conclusão/aviso de custo aparecem por alguns segundos e expiram sozinhos;
 * o histórico em `<Static>` continua sendo a fonte permanente.
 */

export type ToastKind = "error" | "success" | "warning";

export interface Toast {
  readonly id: number;
  readonly kind: ToastKind;
  readonly text: string;
  readonly createdAt: number;
}

/** Tempo de vida padrão de um toast. */
export const TOAST_TTL_MS = 4000;
/** Quantos toasts ficam visíveis ao mesmo tempo (os mais antigos caem). */
export const MAX_TOASTS = 3;
/** Intervalo da varredura que remove toasts expirados. */
export const TOAST_TICK_MS = 250;

const ICONS: Record<ToastKind, string> = { error: "✖", success: "✔", warning: "⚠" };

/** Enfileira um toast com id sequencial, mantendo no máximo `MAX_TOASTS`. */
export function pushToast(current: readonly Toast[], toast: { kind: ToastKind; text: string }, now: number): Toast[] {
  const id = current.reduce((max, item) => Math.max(max, item.id), 0) + 1;
  return [...current, { id, kind: toast.kind, text: toast.text, createdAt: now }].slice(-MAX_TOASTS);
}

/** Remove os expirados; devolve a mesma referência quando nada expirou (evita re-render). */
export function pruneToasts(current: Toast[], now: number, ttlMs: number = TOAST_TTL_MS): Toast[] {
  const alive = current.filter((toast) => now - toast.createdAt < ttlMs);
  return alive.length === current.length ? current : alive;
}

/** Linha renderizada de um toast, com o ícone do tipo. */
export function toastLine(toast: Toast): string {
  return `${ICONS[toast.kind]} ${toast.text}`;
}
