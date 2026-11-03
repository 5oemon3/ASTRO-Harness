import { describe, expect, test } from "bun:test";
import { listRows, listWindow } from "../src/tui/viewport";

describe("listWindow (#64 viewport)", () => {
  test("lista menor que a janela mostra tudo", () => {
    expect(listWindow(3, 1, 5)).toEqual({ start: 0, end: 3 });
    expect(listWindow(0, 0, 5)).toEqual({ start: 0, end: 0 });
  });

  test("lista no tamanho da janela mostra tudo", () => {
    expect(listWindow(5, 4, 5)).toEqual({ start: 0, end: 5 });
  });

  test("lista maior desliza mantendo o selecionado visível", () => {
    // selecionado no topo: janela começa em 0
    expect(listWindow(30, 0, 5)).toEqual({ start: 0, end: 5 });
    // selecionado no meio: centraliza (selected - floor(max/2))
    expect(listWindow(30, 10, 5)).toEqual({ start: 8, end: 13 });
    // selecionado no fim: prende na cauda
    expect(listWindow(30, 29, 5)).toEqual({ start: 25, end: 30 });
  });

  test("max <= 0 devolve janela vazia sem estourar", () => {
    expect(listWindow(10, 3, 0)).toEqual({ start: 0, end: 0 });
    expect(listWindow(10, 3, -2)).toEqual({ start: 0, end: 0 });
  });
});

describe("listRows (#64 viewport)", () => {
  test("deriva das linhas do terminal descontando o chrome", () => {
    expect(listRows(24, 6)).toBe(12); // cap padrão 12
    expect(listRows(30, 6)).toBe(12);
    expect(listRows(10, 6)).toBe(4);
  });

  test("sem linhas do terminal usa o fallback 80x24", () => {
    expect(listRows(undefined, 6)).toBe(12);
    expect(listRows(undefined, 20)).toBe(4);
  });

  test("respeita o piso mínimo de linhas", () => {
    expect(listRows(5, 6)).toBe(3);
    expect(listRows(1, 10)).toBe(3);
  });

  test("cap configurável", () => {
    expect(listRows(40, 4, { cap: 20 })).toBe(20);
    expect(listRows(24, 4, { cap: 20 })).toBe(20);
    expect(listRows(12, 4, { cap: 20 })).toBe(8);
  });
});
