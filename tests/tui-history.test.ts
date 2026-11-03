import { describe, expect, test } from "bun:test";
import { HISTORY_LIMIT, visibleWindow } from "../src/tui/history";

describe("visibleWindow (#64 virtualização do histórico)", () => {
  test("abaixo do limite devolve tudo; no limite ou acima devolve só a janela final", () => {
    const items = [1, 2, 3, 4, 5];
    expect(visibleWindow(items, 10)).toEqual([1, 2, 3, 4, 5]);
    expect(visibleWindow(items, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(visibleWindow(items, 3)).toEqual([3, 4, 5]);
    expect(visibleWindow([], 3)).toEqual([]);
    expect(visibleWindow(items, 0)).toEqual([]);
  });

  test("limite padrão existe e é razoável para 80x24", () => {
    expect(HISTORY_LIMIT).toBeGreaterThanOrEqual(50);
    expect(HISTORY_LIMIT).toBeLessThanOrEqual(1000);
  });
});
