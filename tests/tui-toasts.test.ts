import { describe, expect, test } from "bun:test";
import { MAX_TOASTS, TOAST_TTL_MS, pruneToasts, pushToast, toastLine, type Toast } from "../src/tui/toasts";

const toast = (kind: "error" | "success" | "warning", text: string, createdAt = 0): Toast =>
  ({ id: 1, kind, text, createdAt });

describe("toasts da TUI (#64)", () => {
  test("pushToast enfileira com id sequencial e createdAt", () => {
    const first = pushToast([], { kind: "error", text: "erro: boom" }, 1000);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ id: 1, kind: "error", text: "erro: boom", createdAt: 1000 });
    const second = pushToast(first, { kind: "success", text: "ok" }, 2000);
    expect(second.map((item) => item.id)).toEqual([1, 2]);
    expect(second[1]).toMatchObject({ kind: "success", createdAt: 2000 });
  });

  test(`pushToast mantém no máximo ${MAX_TOASTS} e descarta o mais antigo`, () => {
    let list: Toast[] = [];
    for (let i = 1; i <= MAX_TOASTS + 2; i++) list = pushToast(list, { kind: "success", text: `t${i}` }, i);
    expect(list).toHaveLength(MAX_TOASTS);
    expect(list.map((item) => item.text)).toEqual(["t3", "t4", "t5"]);
    expect(list.map((item) => item.id)).toEqual([3, 4, 5]);
  });

  test("pruneToasts remove expirados e preserva a referência quando nada expirou", () => {
    const list = [toast("error", "velho", 0), toast("success", "novo", TOAST_TTL_MS - 1)];
    expect(pruneToasts(list, TOAST_TTL_MS - 2)).toBe(list); // nada expirou: mesma referência (sem re-render)
    const pruned = pruneToasts(list, TOAST_TTL_MS + 1);
    expect(pruned).toHaveLength(1);
    expect(pruned[0]!.text).toBe("novo");
    expect(pruneToasts([], 10)).toEqual([]);
  });

  test("pruneToasts respeita TTL customizado", () => {
    const list = [toast("warning", "aviso", 100)];
    expect(pruneToasts(list, 100 + 29, 30)).toBe(list);
    expect(pruneToasts(list, 100 + 30, 30)).toEqual([]);
  });

  test("toastLine prefixa o ícone de cada tipo", () => {
    expect(toastLine(toast("error", "erro: boom"))).toBe("✖ erro: boom");
    expect(toastLine(toast("success", "turno concluído"))).toBe("✔ turno concluído");
    expect(toastLine(toast("warning", "custo alto · budget: 90%"))).toBe("⚠ custo alto · budget: 90%");
  });
});
