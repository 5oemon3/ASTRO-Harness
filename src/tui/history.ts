/**
 * Virtualização do histórico da TUI (#64): o `<Static>` do ink é append-only,
 * então com turnos longos o array de entradas cresce sem freio. A janela
 * visível é limitada e o resto vira um marcador "… N mensagens anteriores".
 */

/** Entradas do histórico mantidas visíveis por padrão (razoável para 80x24). */
export const HISTORY_LIMIT = 200;

/**
 * Devolve só a janela final de `items` com `limit` elementos.
 * limit <= 0 devolve vazio; se não estoura o limite, devolve tudo.
 */
export function visibleWindow<T>(items: readonly T[], limit: number): T[] {
  if (limit <= 0) return [];
  if (items.length <= limit) return [...items];
  return items.slice(items.length - limit);
}
