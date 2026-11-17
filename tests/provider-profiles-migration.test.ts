import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadEffectiveConfig,
  loadGlobalProfileStore,
  loadProjectConfig,
  ProfileStoreError,
  ProfileStoreMigratedError,
  readGlobalProfileStore,
  saveProfileStore,
} from "../src/providers/profiles";
import { ProfileManager } from "../src/providers/profile-manager";

const profileA = {
  id: "a",
  name: "Provider A",
  kind: "openai-compat",
  baseUrl: "https://a.example/v1",
  credentialRef: "A_KEY",
  models: [{ id: "m1", tags: ["writing-code"], context: 8192 }],
};
const profileB = {
  id: "b",
  name: "Provider B",
  kind: "openai-compat",
  baseUrl: "https://b.example/v1",
  models: [{ id: "m2", tags: ["writing-code"], context: 4096 }],
};

const homeDir = (): string => mkdtempSync(join(tmpdir(), "astro-migrate-"));
// Fixture de segredo montada em runtime para não disparar o gate de segredos.
const SENTINEL = ["s", "k", "-"].join("") + "live-SENTINEL";

function jsonAt(home: string, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, name), "utf8")) as Record<string, unknown>;
}

const legacyWith = (profiles: unknown[]): string => JSON.stringify({ version: 1, profiles });

function projectConfig(cwd: string, id: string, baseUrl: string, credentialRef: string): string {
  const path = join(cwd, "astro.config.json");
  writeFileSync(path, JSON.stringify({
    providers: { [id]: { kind: "openai-compat", baseUrl, credentialRef } },
    models: [{ provider: id, id: "m", tags: ["writing-code"], context: 8192 }],
    agent: { model: `${id}/m`, maxSteps: 2, tools: ["read_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  return path;
}

test("importa providers.json para config.json uma vez e preserva o legado", () => {
  const home = homeDir();
  const legacy = join(home, "providers.json");
  const bytes = JSON.stringify({ version: 1, activeProfileId: "b", profiles: [profileA, profileB] });
  writeFileSync(legacy, bytes);

  const store = loadGlobalProfileStore({ ASTRO_HOME: home });

  expect(store.profiles.map((profile) => profile.id)).toEqual(["a", "b"]);
  expect(store.activeProfileId).toBe("b");
  const config = jsonAt(home, "config.json");
  expect(config.providers).toEqual({
    a: { kind: "openai-compat", baseUrl: "https://a.example/v1", credentialRef: "A_KEY" },
    b: { kind: "openai-compat", baseUrl: "https://b.example/v1" },
  });
  expect(config.models).toEqual([
    { provider: "a", id: "m1", tags: ["writing-code"], context: 8192 },
    { provider: "b", id: "m2", tags: ["writing-code"], context: 4096 },
  ]);
  expect(config.activeProfileId).toBe("b");
  expect(jsonAt(home, "state.json").migrations).toEqual({ providers: true, trust: false });
  expect(readFileSync(legacy, "utf8")).toBe(bytes);
});

test("a segunda carga não reescreve config.json nem relê o legado", () => {
  const home = homeDir();
  const legacy = join(home, "providers.json");
  writeFileSync(legacy, JSON.stringify({ version: 1, profiles: [profileA, profileB] }));
  loadGlobalProfileStore({ ASTRO_HOME: home });
  const before = readFileSync(join(home, "config.json"), "utf8");
  // Se o legado fosse relido, este conteúdo inválido faria a carga falhar.
  writeFileSync(legacy, "lixo");

  const again = loadGlobalProfileStore({ ASTRO_HOME: home });

  expect(again.profiles.map((profile) => profile.id)).toEqual(["a", "b"]);
  expect(readFileSync(join(home, "config.json"), "utf8")).toBe(before);
  expect(readFileSync(legacy, "utf8")).toBe("lixo");
  expect(() => saveProfileStore({ version: 1, profiles: [profileA] }, legacy)).toThrow(ProfileStoreMigratedError);
  expect(readFileSync(legacy, "utf8")).toBe("lixo");
});

test("conflito por chave: config.json vence e models não duplicam", () => {
  const home = homeDir();
  const existingProvider = { kind: "openai-compat", baseUrl: "https://config.example/v1", credentialRef: "CONFIG_KEY" };
  writeFileSync(join(home, "config.json"), JSON.stringify({
    providers: { a: existingProvider },
    models: [{ provider: "a", id: "m1", tags: ["writing-code"], context: 1 }],
    activeProfileId: "a",
  }));
  writeFileSync(join(home, "providers.json"), JSON.stringify({
    version: 1,
    activeProfileId: "b",
    profiles: [profileA, profileB],
  }));

  const store = loadGlobalProfileStore({ ASTRO_HOME: home });

  const config = jsonAt(home, "config.json");
  expect((config.providers as Record<string, unknown>).a).toEqual(existingProvider);
  expect((config.providers as Record<string, unknown>).b).toEqual({
    kind: "openai-compat",
    baseUrl: "https://b.example/v1",
  });
  expect(config.models).toEqual([
    { provider: "a", id: "m1", tags: ["writing-code"], context: 1 },
    { provider: "b", id: "m2", tags: ["writing-code"], context: 4096 },
  ]);
  expect(config.activeProfileId).toBe("a");
  expect(store.activeProfileId).toBe("a");
});

test("sem store legado nem config global o carregamento não cria arquivos", () => {
  const home = homeDir();

  expect(loadGlobalProfileStore({ ASTRO_HOME: home })).toEqual({ version: 1, profiles: [] });
  expect(readdirSync(home)).toEqual([]);
});

test("store legado inválido: erro tipado com caminho, sem ecoar conteúdo (I-03)", () => {
  const home = homeDir();
  const legacy = join(home, "providers.json");
  // JSON truncado que contém o sentinela: o detalhe do parser nunca pode vazar.
  const bytes = `{"version":1,"profiles":[{"credentialRef":"${SENTINEL}"`;
  writeFileSync(legacy, bytes);

  let thrown: unknown;
  try {
    loadGlobalProfileStore({ ASTRO_HOME: home });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(ProfileStoreError);
  expect((thrown as ProfileStoreError).path).toBe(legacy);
  expect((thrown as Error).message).toContain("providers.json");
  expect((thrown as Error).message).not.toContain(SENTINEL);
  expect(existsSync(join(home, "config.json"))).toBe(false);
  expect(existsSync(join(home, "state.json"))).toBe(false);
  expect(readFileSync(legacy, "utf8")).toBe(bytes);
});

test("depois do import config.json é a fonte de verdade na resolução", () => {
  const home = homeDir();
  writeFileSync(join(home, "providers.json"), JSON.stringify({
    version: 1,
    activeProfileId: "b",
    profiles: [profileA, profileB],
  }));
  loadGlobalProfileStore({ ASTRO_HOME: home });
  const config = jsonAt(home, "config.json");
  ((config.providers as Record<string, Record<string, unknown>>).a!).baseUrl = "https://edited.example/v1";
  writeFileSync(join(home, "config.json"), JSON.stringify(config));

  const effective = loadEffectiveConfig(join(home, "astro.config.json"), {
    env: { ASTRO_HOME: home },
    allowMissing: true,
  });

  expect(effective.config.providers.a).toMatchObject({ baseUrl: "https://edited.example/v1" });
  expect(effective.activeProvider).toBe("b");
  expect(effective.providerSelection).toBe("store");
});

test("legado aposentado: arquivo corrompido não quebra loadProjectConfig", () => {
  const home = homeDir();
  const legacy = join(home, "providers.json");
  writeFileSync(legacy, legacyWith([profileA]));
  loadGlobalProfileStore({ ASTRO_HOME: home });
  writeFileSync(legacy, "corrompido");
  const configPath = projectConfig(homeDir(), "p", "https://p.example/v1", "P_KEY");

  const config = loadProjectConfig(configPath, { env: { ASTRO_HOME: home } });

  expect(config?.providers.p).toBeDefined();
});

test("entrada obsoleta no legado não amplia o allow-set de endpoint da credencial", () => {
  const home = homeDir();
  const legacy = join(home, "providers.json");
  writeFileSync(legacy, legacyWith([profileA]));
  loadGlobalProfileStore({ ASTRO_HOME: home });
  // Perfil obsoleto reusa A_KEY em outro endpoint: se fosse lido, permitiria o projeto.
  writeFileSync(legacy, legacyWith([{ ...profileA, id: "evil", name: "Evil", baseUrl: "https://evil.example/v1" }]));
  const configPath = projectConfig(homeDir(), "evil", "https://evil.example/v1", "A_KEY");

  expect(() => loadProjectConfig(configPath, { env: { ASTRO_HOME: home } }))
    .toThrow(/redireciona a credencial global/);
});

test("/provider recusa escrita pós-migração e preserva o legado", () => {
  const home = homeDir();
  const legacy = join(home, "providers.json");
  const bytes = legacyWith([profileA]);
  writeFileSync(legacy, bytes);
  loadGlobalProfileStore({ ASTRO_HOME: home });
  const manager = new ProfileManager({ env: { ASTRO_HOME: home } });

  // Provider só da config não é removível/ativável pelo store legado.
  expect(() => manager.remove("a")).toThrow(/config\.json/);
  expect(() => manager.use("a")).toThrow(/config\.json/);
  expect(() => manager.add({
    name: "Novo",
    kind: "openai-compat",
    baseUrl: "https://novo.example/v1",
    credentialRef: "NOVO_KEY",
    models: [{ id: "m", tags: ["writing-code"], context: 8192 }],
  })).toThrow(ProfileStoreMigratedError);

  expect(readFileSync(legacy, "utf8")).toBe(bytes);
  expect((jsonAt(home, "config.json").providers as Record<string, unknown>).a).toBeDefined();
});

test("legado com zero perfis não cria config.json", () => {
  const home = homeDir();
  writeFileSync(join(home, "providers.json"), legacyWith([]));

  expect(loadGlobalProfileStore({ ASTRO_HOME: home })).toEqual({ version: 1, profiles: [] });
  expect(existsSync(join(home, "config.json"))).toBe(false);
  expect(jsonAt(home, "state.json").migrations).toEqual({ providers: true, trust: false });
});

test("vault:<id> sobrevive ao import e segredo cru no legado é recusado (I-03)", () => {
  const home = homeDir();
  const vaultRef = "vault:cred-12345678-abcd";
  writeFileSync(join(home, "providers.json"), legacyWith([{ ...profileA, credentialRef: vaultRef }]));

  expect(loadGlobalProfileStore({ ASTRO_HOME: home }).profiles[0]?.credentialRef).toBe(vaultRef);
  expect((jsonAt(home, "config.json").providers as Record<string, Record<string, unknown>>).a!.credentialRef).toBe(vaultRef);
  expect(readGlobalProfileStore({ ASTRO_HOME: home }).profiles[0]?.credentialRef).toBe(vaultRef);

  const rawHome = homeDir();
  writeFileSync(join(rawHome, "providers.json"), legacyWith([{ ...profileA, credentialRef: SENTINEL }]));
  let thrown: unknown;
  try {
    loadGlobalProfileStore({ ASTRO_HOME: rawHome });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ProfileStoreError);
  expect((thrown as Error).message).not.toContain(SENTINEL);
});

test("credentialRef cru na config não entra no store derivado (I-03)", () => {
  const home = homeDir();
  writeFileSync(join(home, "config.json"), JSON.stringify({
    providers: { bad: { kind: "openai-compat", baseUrl: "https://bad.example/v1", credentialRef: SENTINEL } },
    models: [{ provider: "bad", id: "m", tags: ["writing-code"], context: 8192 }],
    activeProfileId: "bad",
  }));
  writeFileSync(join(home, "state.json"), JSON.stringify({
    version: 1,
    trust: { folders: [] },
    migrations: { providers: true, trust: false },
  }));

  const store = readGlobalProfileStore({ ASTRO_HOME: home });

  expect(store.profiles).toHaveLength(1);
  expect(store.profiles[0]?.credentialRef).toBeUndefined();
  expect(JSON.stringify(store)).not.toContain(SENTINEL);
});

test("detalhe de validação não ecoa tag nem nome (I-03)", () => {
  const tagHome = homeDir();
  writeFileSync(join(tagHome, "providers.json"), legacyWith([
    { ...profileA, models: [{ id: "m1", tags: [SENTINEL], context: 8192 }] },
  ]));
  let tagError: unknown;
  try {
    loadGlobalProfileStore({ ASTRO_HOME: tagHome });
  } catch (error) {
    tagError = error;
  }
  expect(tagError).toBeInstanceOf(ProfileStoreError);
  expect((tagError as Error).message).not.toContain(SENTINEL);

  const nameHome = homeDir();
  writeFileSync(join(nameHome, "providers.json"), legacyWith([
    { ...profileA, name: SENTINEL },
    { ...profileB, name: SENTINEL },
  ]));
  let nameError: unknown;
  try {
    loadGlobalProfileStore({ ASTRO_HOME: nameHome });
  } catch (error) {
    nameError = error;
  }
  expect(nameError).toBeInstanceOf(ProfileStoreError);
  expect((nameError as Error).message).not.toContain(SENTINEL);
});
