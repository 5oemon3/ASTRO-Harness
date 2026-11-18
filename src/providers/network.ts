/**
 * Sinal efetivo de uma chamada de rede (I-09): o abort do caller continua
 * cancelando, mas um timeout próprio impede que um servidor pendurado segure a
 * chamada para sempre. O timeout é classificado como `network_timeout`, não
 * como cota dura.
 */

/** Timeout de rede padrão por chamada de provider. */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 120_000;

export interface NetworkCall {
  signal: AbortSignal;
  /** O timeout próprio disparou (distinto de o caller ter cancelado). */
  timedOut(): boolean;
  /**
   * Reinicia o prazo (#475): no stream o timeout mede inatividade, então cada
   * chunk recebido conta como atividade. Depois de estourar, de o caller
   * cancelar ou de `dispose()`, não faz nada.
   */
  reset(): void;
  /** Cancela o timer e remove o listener do caller. */
  dispose(): void;
}

export function networkCall(caller: AbortSignal | undefined, timeoutMs: number): NetworkCall {
  const controller = new AbortController();
  let timedOut = false;
  let disposed = false;

  const onCallerAbort = (): void => controller.abort(caller?.reason);
  if (caller?.aborted === true) controller.abort(caller.reason);
  else caller?.addEventListener("abort", onCallerAbort, { once: true });

  const arm = (): ReturnType<typeof setTimeout> =>
    setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException(`timeout de rede após ${timeoutMs}ms`, "TimeoutError"));
    }, timeoutMs);

  let timer = arm();

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    reset: () => {
      if (disposed || timedOut || controller.signal.aborted) return;
      clearTimeout(timer);
      timer = arm();
    },
    dispose: () => {
      disposed = true;
      clearTimeout(timer);
      caller?.removeEventListener("abort", onCallerAbort);
    },
  };
}
