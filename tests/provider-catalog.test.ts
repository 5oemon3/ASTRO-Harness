import { expect, test } from "bun:test";
import { PROVIDER_CATALOG, catalogEntry } from "../src/provider/catalog";
import { validateProfileStore } from "../src/provider/profiles";

const asProfile = (entry: (typeof PROVIDER_CATALOG)[number]) => ({
  id: entry.key,
  name: entry.name,
  kind: entry.kind,
  ...(entry.baseUrl === undefined ? {} : { baseUrl: entry.baseUrl }),
  ...(entry.credentialRef === undefined ? {} : { credentialRef: entry.credentialRef }),
  ...(entry.credentialsPath === undefined ? {} : { credentialsPath: entry.credentialsPath }),
  models: entry.models,
});

test("catálogo tem as quatro entradas esperadas", () => {
  expect(PROVIDER_CATALOG.map((entry) => entry.key)).toEqual([
    "nvidia", "codex", "openrouter", "openai-compatible",
  ]);
});

test("template openai-compatible não fixa endpoint nem chave", () => {
  const entry = catalogEntry("openai-compatible");
  expect(entry?.baseUrl).toBeUndefined();
  expect(entry?.credentialRef).toBeUndefined();
  expect(entry?.models).toEqual([]);
});

test("cada entrada é um perfil válido", () => {
  for (const entry of PROVIDER_CATALOG) {
    if (entry.models.length === 0) continue;
    const store = validateProfileStore({ version: 1, profiles: [asProfile(entry)] });
    expect(store.profiles[0]!.models.length).toBeGreaterThan(0);
  }
});

test("entradas têm modelos com contexto positivo", () => {
  for (const entry of PROVIDER_CATALOG) {
    for (const model of entry.models) {
      expect(model.context).toBeGreaterThan(0);
    }
  }
});

test("codex usa credentialsPath e nenhuma chave", () => {
  const codex = catalogEntry("codex");
  expect(codex?.credentialsPath).toBe("~/.codex/auth.json");
  expect(codex?.credentialRef).toBeUndefined();
});

test("cada entrada declara o próprio quotaDomain", () => {
  for (const entry of PROVIDER_CATALOG) {
    expect(entry.quotaDomain).toBe(entry.key);
  }
});

test("buscas por chave inexistente retornam undefined", () => {
  expect(catalogEntry("nao-existe")).toBeUndefined();
});
