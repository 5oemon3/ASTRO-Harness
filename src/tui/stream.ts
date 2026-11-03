/**
 * Sink throttled para o streaming da TUI (#64): o provider entrega deltas por
 * token, mas a TUI não re-renderiza a cada delta — emite na leading edge e
 * bufferiza o resto num timer trailing (backpressure de render).
 *
 * Puro e testável: `now` e `schedule` são injetados; `flush()` emite o buffer
 * pendente e invalida o timer (chamado no fim do turno para nada vazar depois).
 */

/** Intervalo padrão do throttle de streaming em ms. */
export const STREAM_THROTTLE_MS = 40;

export interface ThrottleDeps {
  /** Janela do throttle em ms; 0 emite tudo na hora. */
  intervalMs: number;
  now: () => number;
  schedule: (cb: () => void, ms: number) => void;
  emit: (text: string) => void;
}

export interface ThrottledSink {
  /** Acumula o delta; emite na hora se a janela passou, senão agenda o trailing. */
  add(text: string): void;
  /** Emite o buffer pendente agora e invalida o timer agendado. */
  flush(): void;
  /** Texto bufferizado aguardando o trailing. */
  buffered(): string;
}

export function createThrottledSink(deps: ThrottleDeps): ThrottledSink {
  const { intervalMs, now, schedule, emit } = deps;
  let buffer = "";
  let lastEmit = Number.NEGATIVE_INFINITY;
  let generation = 0;
  let timerActive = false;

  const fire = (gen: number): void => {
    if (gen !== generation) return; // timer invalidado por flush/leading
    timerActive = false;
    if (buffer === "") return;
    emit(buffer);
    buffer = "";
    lastEmit = now();
  };

  return {
    add(text: string): void {
      if (text === "") return;
      buffer += text;
      if (now() - lastEmit >= intervalMs) {
        generation++; // invalida timer pendente
        timerActive = false;
        emit(buffer);
        buffer = "";
        lastEmit = now();
        return;
      }
      if (!timerActive) {
        timerActive = true;
        const gen = ++generation;
        schedule(() => fire(gen), Math.max(intervalMs - (now() - lastEmit), 0));
      }
    },
    flush(): void {
      generation++; // invalida qualquer timer agendado
      timerActive = false;
      if (buffer === "") return;
      emit(buffer);
      buffer = "";
      lastEmit = now();
    },
    buffered(): string {
      return buffer;
    },
  };
}
