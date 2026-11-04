/**
 * Roteamento de modelo por agente (#58): `cheapModel` atende classificação e
 * sumarização (compactação), `strongModel` atende a geração de código. A
 * chamada escolhe o lado por `purpose`; sem lado configurado, mantém o modelo
 * do agente.
 */
import type { ModelPurpose, Provider } from "./types";

/** Rotas declaradas em `agents.<nome>.modelRouting` (chaves `provider/id`). */
export interface ModelRouting {
  cheapModel?: string;
  strongModel?: string;
}

/** Menor superfície de um modelo roteado (compatível com `ModelEntry`). */
export interface RoutedModel {
  provider: string;
  id: string;
}

export interface RoutedProviderOptions<M extends RoutedModel> {
  routing: ModelRouting;
  /** Modelo do agente: usado quando o propósito não tem rota. */
  fallback: M;
  /** Resolve uma chave `provider/id` da configuração. */
  resolve(key: string): M;
  /** Provider já guardado (quota/audit/cache) para o modelo resolvido. */
  providerFor(model: M): Provider;
}

/** Chave do modelo que atende o propósito (fallback = modelo do agente). */
export function routedModelKey(
  routing: ModelRouting | undefined,
  purpose: ModelPurpose,
  fallbackKey: string,
): string {
  if (routing === undefined) return fallbackKey;
  return (purpose === "cheap" ? routing.cheapModel : routing.strongModel) ?? fallbackKey;
}

/**
 * Provider que troca o modelo por chamada. A identidade efetiva
 * (`provider`/`model` da resposta) é preenchida para o ledger cobrar o modelo
 * que de fato atendeu, não o modelo base do agente.
 */
export function createRoutedProvider<M extends RoutedModel>(opts: RoutedProviderOptions<M>): Provider {
  const fallbackKey = `${opts.fallback.provider}/${opts.fallback.id}`;
  return {
    async complete(req, signal) {
      const key = routedModelKey(opts.routing, req.purpose ?? "strong", fallbackKey);
      const model = key === fallbackKey ? opts.fallback : opts.resolve(key);
      const response = await opts.providerFor(model).complete({ ...req, model: model.id }, signal);
      return {
        ...response,
        provider: response.provider ?? model.provider,
        model: response.model ?? model.id,
      };
    },
  };
}
