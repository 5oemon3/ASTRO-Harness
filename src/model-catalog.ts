/** Catálogo efetivo de modelos derivado da config (#307): listagem sem tocar segredo (I-03). */
import type { ModelStatus, PriceConfig } from "./config";
import {
  providerIdentityFor,
  type EffectiveConfig,
  type ProviderSource,
} from "./provider/profiles";
import { PROVIDER_CATALOG, type CatalogEntry } from "./provider/catalog";

export interface CatalogModel {
  ref: string;
  provider: string;
  id: string;
  tags: string[];
  context: number;
  status: ModelStatus;
  source: ProviderSource;
  price?: PriceConfig;
}

/** Deriva o catálogo da config efetiva; projeto vence global na mesma ref (mergeModels). */
export function buildModelCatalog(effective: EffectiveConfig): CatalogModel[] {
  const seen = new Map<string, CatalogModel>();
  for (const model of effective.config.models) {
    const ref = `${model.provider}/${model.id}`;
    if (seen.has(ref)) continue;
    const price = effective.config.pricing?.[ref] ?? model.price;
    seen.set(ref, {
      ref,
      provider: model.provider,
      id: model.id,
      tags: [...model.tags],
      context: model.context,
      status: model.status ?? "active",
      source: providerIdentityFor(effective, model.provider).providerSource,
      ...(price === undefined ? {} : { price }),
    });
  }
  return [...seen.values()].sort((a, b) =>
    a.provider === b.provider
      ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      : (a.provider < b.provider ? -1 : 1)
  );
}

/** Uma linha por modelo: `ref · source · status · tags · contexto · preço`. Nunca ecoa segredo. */
export function formatModelCatalog(models: readonly CatalogModel[]): string {
  if (models.length === 0) return "nenhum modelo";
  return models.map((model) => {
    const tags = model.tags.length === 0 ? "-" : model.tags.join(", ");
    const price = model.price === undefined
      ? "n/d"
      : `in ${model.price.inputPerM}/M out ${model.price.outputPerM}/M (${model.price.fonte})`;
    return `${model.ref} · ${model.source} · ${model.status} · ${tags} · ${model.context} · ${price}`;
  }).join("\n");
}

/** Sementes do wizard; só metadados e nomes de variável, nunca valor de segredo (I-03). */
export function formatSeedList(entries: readonly CatalogEntry[] = PROVIDER_CATALOG): string {
  if (entries.length === 0) return "nenhuma semente";
  return entries.map((entry) => {
    const endpoint = entry.baseUrl ?? entry.credentialsPath ?? "(definir no wizard)";
    const key = entry.credentialRef === undefined ? "sem chave" : `chave: ${entry.credentialRef}`;
    const models = entry.models.length === 0 ? "-" : entry.models.map((model) => model.id).join(", ");
    return `${entry.key} · ${entry.name} · ${entry.kind} · ${endpoint} · ${key} · modelos: ${models}`;
  }).join("\n");
}
