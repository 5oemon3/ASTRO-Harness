import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { SessionPicker } from "../src/tui/session-picker";
import type { SessionSummary } from "../src/chat/store";

const colors = { accent: "cyan", warning: "yellow", error: "red" };
const summary = (id: string, name?: string): SessionSummary => ({
  path: `/tmp/${id}.json`, id, startedAt: "2026-10-01T10:00:00.000Z", model: "p/m1", turns: 2, costUsd: 0.001,
  ...(name === undefined ? {} : { name }),
});
const frame = (instance: ReturnType<typeof render>): string => instance.lastFrame() ?? "";

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timeout esperando o frame");
}

test("lista, navega e retoma com enter (#64)", async () => {
  const resumed: string[] = [];
  const instance = render(
    <SessionPicker sessions={[summary("a"), summary("b", "feature")]} colors={colors}
      onClose={() => {}} onResume={(chosen) => resumed.push(chosen.id)} onRename={() => undefined} />,
  );
  try {
    await waitFor(() => frame(instance).includes("Sessões"));
    expect(frame(instance)).toContain("feature (b)");
    instance.stdin.write("\u001b[B"); // down
    await waitFor(() => frame(instance).includes("> 2."));
    instance.stdin.write("\r");
    expect(resumed).toEqual(["b"]);
  } finally { instance.unmount(); }
});

test("r renomeia; enter salva; erro fica na tela; esc cancela sem fechar (#64)", async () => {
  const calls: Array<[string, string]> = [];
  let fail = false;
  let closed = 0;
  const instance = render(
    <SessionPicker sessions={[summary("a", "antigo")]} colors={colors} onClose={() => { closed++; }}
      onResume={() => {}} onRename={(chosen, name) => { calls.push([chosen.id, name]); return fail ? "erro: nome inválido" : undefined; }} />,
  );
  try {
    await waitFor(() => frame(instance).includes("Sessões"));
    instance.stdin.write("r");
    await waitFor(() => frame(instance).includes("nome: _"));
    instance.stdin.write("novo");
    instance.stdin.write("\r");
    await waitFor(() => calls.length === 1);
    expect(calls[0]).toEqual(["a", "novo"]);
    await waitFor(() => !frame(instance).includes("nome: _"));
    fail = true;
    instance.stdin.write("r");
    await waitFor(() => frame(instance).includes("nome: _"));
    instance.stdin.write("x");
    instance.stdin.write("\r");
    await waitFor(() => frame(instance).includes("erro: nome inválido"));
    instance.stdin.write("\u001b"); // cancela o rename, não fecha o modal
    await waitFor(() => !frame(instance).includes("nome: _"));
    expect(closed).toBe(0);
  } finally { instance.unmount(); }
});

test("alt+enter não retoma; key repeat retoma uma vez (#64)", async () => {
  const resumed: string[] = [];
  const instance = render(
    <SessionPicker sessions={[summary("a")]} colors={colors} onClose={() => {}} onResume={(chosen) => resumed.push(chosen.id)} onRename={() => undefined} />,
  );
  try {
    await waitFor(() => frame(instance).includes("Sessões"));
    instance.stdin.write("\u001b\r"); // alt+enter
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(resumed).toEqual([]);
    instance.stdin.write("\r");
    instance.stdin.write("\r"); // repeat antes de o resume assíncrono fechar o modal
    await waitFor(() => resumed.length >= 1);
    expect(resumed).toEqual(["a"]);
  } finally { instance.unmount(); }
});

test("o rascunho descarta controles e mantém ZWJ/ZWNJ (#64)", async () => {
  const calls: Array<[string, string]> = [];
  const instance = render(
    <SessionPicker sessions={[summary("a")]} colors={colors} onClose={() => {}} onResume={() => {}}
      onRename={(chosen, name) => { calls.push([chosen.id, name]); return undefined; }} />,
  );
  try {
    await waitFor(() => frame(instance).includes("Sessões"));
    instance.stdin.write("r");
    await waitFor(() => frame(instance).includes("nome: _"));
    instance.stdin.write("a\u0000b\u200bc👨‍👩‍👧");
    await waitFor(() => frame(instance).includes("nome: ab"));
    instance.stdin.write("\r");
    await waitFor(() => calls.length === 1);
    expect(calls[0]![1]).toBe("abc👨‍👩‍👧");
  } finally { instance.unmount(); }
});

test("ctrl+r não abre o rename; r simples abre (#64)", async () => {
  const instance = render(
    <SessionPicker sessions={[summary("a")]} colors={colors} onClose={() => {}} onResume={() => {}} onRename={() => undefined} />,
  );
  try {
    await waitFor(() => frame(instance).includes("Sessões"));
    instance.stdin.write("\u0012"); // ctrl+r
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(frame(instance)).not.toContain("nome: _");
    instance.stdin.write("r");
    await waitFor(() => frame(instance).includes("nome: _"));
  } finally { instance.unmount(); }
});

test("navegação multi-passo no mesmo chunk usa o estado mais novo (#64)", async () => {
  const instance = render(
    <SessionPicker sessions={[summary("a"), summary("b"), summary("c")]} colors={colors}
      onClose={() => {}} onResume={() => {}} onRename={() => undefined} />,
  );
  try {
    await waitFor(() => frame(instance).includes("Sessões"));
    instance.stdin.write("\u001b[B\u001b[B"); // dois downs no mesmo chunk
    await waitFor(() => frame(instance).includes("> 3."));
  } finally { instance.unmount(); }
});

test("janela limita a lista e mantém o selecionado visível (#64)", async () => {
  const sessions = Array.from({ length: 30 }, (_, i) => summary(`s${i}`));
  const resumed: string[] = [];
  const instance = render(
    <SessionPicker sessions={sessions} colors={colors} maxRows={5}
      onClose={() => {}} onResume={(chosen) => resumed.push(chosen.id)} onRename={() => undefined} />,
  );
  try {
    await waitFor(() => frame(instance).includes("… 25 abaixo"));
    expect(frame(instance)).toContain("> 1.");
    expect(frame(instance)).toContain(" s4 ");
    expect(frame(instance)).not.toContain(" s5 ");
    for (let i = 0; i < 10; i++) instance.stdin.write("\u001b[B");
    await waitFor(() => frame(instance).includes("… 8 acima"));
    expect(frame(instance)).toContain("… 17 abaixo");
    expect(frame(instance)).toContain("> 11.");
    expect(frame(instance)).toContain(" s8 ");
    expect(frame(instance)).not.toContain(" s7 ");
    expect(frame(instance)).not.toContain(" s13 ");
    instance.stdin.write("\r");
    await waitFor(() => resumed.length === 1);
    expect(resumed).toEqual(["s10"]);
  } finally { instance.unmount(); }
});

test("redimensionar o terminal encolhe a janela do picker (#64)", async () => {
  const sessions = Array.from({ length: 30 }, (_, i) => summary(`s${i}`));
  const instance = render(
    <SessionPicker sessions={sessions} colors={colors} onClose={() => {}} onResume={() => {}} onRename={() => undefined} />,
  );
  try {
    await waitFor(() => frame(instance).includes("Sessões"));
    Object.defineProperty(instance.stdout, "rows", { get: () => 24, configurable: true });
    instance.stdout.emit("resize");
    await waitFor(() => frame(instance).includes("… 18 abaixo")); // 24 - chrome 6 = 12 (cap)
    Object.defineProperty(instance.stdout, "rows", { get: () => 10, configurable: true });
    instance.stdout.emit("resize");
    await waitFor(() => frame(instance).includes("… 26 abaixo")); // 10 - 6 = 4
    expect(frame(instance)).toContain(" s3 ");
    expect(frame(instance)).not.toContain(" s4 ");
  } finally { instance.unmount(); }
});

test("lista vazia avisa e esc fecha (#64)", async () => {
  let closed = 0;
  const instance = render(
    <SessionPicker sessions={[]} colors={colors} onClose={() => { closed++; }} onResume={() => {}} onRename={() => undefined} />,
  );
  try {
    await waitFor(() => frame(instance).includes("nenhuma sessão salva"));
    instance.stdin.write("\u001b");
    await waitFor(() => closed === 1);
  } finally { instance.unmount(); }
});
