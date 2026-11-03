import { describe, expect, test } from "bun:test";
import { createThrottledSink } from "../src/tui/stream";

function harness(intervalMs: number) {
  let t = 1_000;
  const emitted: string[] = [];
  const timers: Array<{ cb: () => void; at: number }> = [];
  const sink = createThrottledSink({
    intervalMs,
    now: () => t,
    schedule: (cb, ms) => {
      timers.push({ cb, at: t + ms });
    },
    emit: (text) => emitted.push(text),
  });
  return {
    sink,
    emitted,
    timers,
    advance(ms: number): void {
      t += ms;
      const due = timers.filter((timer) => timer.at <= t);
      for (const timer of due) timer.cb();
    },
  };
}

describe("createThrottledSink (#64 streaming backpressure)", () => {
  test("leading edge: primeiro chunk emite na hora; resto do intervalo fica bufferizado no timer", () => {
    const h = harness(40);
    h.sink.add("par");
    h.sink.add("ci");
    h.sink.add("al");
    expect(h.emitted).toEqual(["par"]);
    expect(h.sink.buffered()).toBe("cial");
    h.advance(40); // timer dispara
    expect(h.emitted).toEqual(["par", "cial"]);
    expect(h.sink.buffered()).toBe("");
  });

  test("após o intervalo passar, o próximo add emite na hora de novo", () => {
    const h = harness(40);
    h.sink.add("a");
    h.advance(50); // 50 >= 40: janela aberta
    h.sink.add("b");
    expect(h.emitted).toEqual(["a", "b"]);
  });

  test("flush emite o buffer pendente e invalida o timer agendado", () => {
    const h = harness(40);
    h.sink.add("a");
    h.sink.add("b"); // agendado
    h.sink.flush();
    expect(h.emitted).toEqual(["a", "b"]);
    h.advance(100); // timer antigo não deve emitir de novo
    expect(h.emitted).toEqual(["a", "b"]);
    h.sink.add("c"); // janela passou desde o último emit: leading edge de novo
    expect(h.emitted).toEqual(["a", "b", "c"]);
    h.advance(100);
    expect(h.emitted).toEqual(["a", "b", "c"]);
  });

  test("add vazio não emite nem agenda timer", () => {
    const h = harness(40);
    h.sink.add("");
    expect(h.emitted).toEqual([]);
    expect(h.timers).toHaveLength(0);
  });

  test("intervalMs 0 emite tudo imediatamente, sem timer", () => {
    const h = harness(0);
    h.sink.add("a");
    h.sink.add("b");
    expect(h.emitted).toEqual(["a", "b"]);
    expect(h.timers).toHaveLength(0);
  });
});
