/** Próximo passo de um erro da TUI (#480): a linha de erro nunca termina sem saída. */
import { ConfigError } from "../core/config";
import { NoProviderError } from "../providers/profiles";
import { ProviderError } from "../providers/types";

/**
 * Texto curto de próximo passo para o erro. `undefined` quando a causa é
 * desconhecida: melhor não inventar instrução do que mandar o usuário ao lugar
 * errado. Tabela dona: `docs/tui-layout.md`.
 */
export function errorHint(error: unknown): string | undefined {
  if (error instanceof ProviderError) {
    switch (error.errClass) {
      case "auth":
        return "revise a credencial com /provider";
      case "hard_quota":
        return "troque de modelo com /model";
      case "transient_rate_limit":
        return "aguarde e repita; o retry já tentou";
      case "network_timeout":
        return "repita; se persistir, aumente providers.<nome>.timeoutMs";
      case "outage":
        return "repita ou troque com /model";
      case "invalid_request":
        return "ajuste o pedido; /help lista os comandos";
    }
  }
  if (error instanceof NoProviderError) return "configure com /provider";
  if (error instanceof ConfigError) return "rode astro doctor";
  return undefined;
}

/** C0/C1 e marcas de direção: a mensagem não pode forjar uma linha no painel. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Linha de erro com próximo passo quando conhecido (#480). */
export function errorLine(error: unknown, message: string): string {
  const safe = message.replace(CONTROL, " ").trim();
  const hint = errorHint(error);
  return hint === undefined ? `erro: ${safe}` : `erro: ${safe} · ${hint}`;
}
