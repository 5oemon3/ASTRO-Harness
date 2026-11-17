/** CRUD de perfis de provider: store global + visão do projeto, com guardas. */
import { isPlainObject, type AstroConfig, type ProviderConfig } from "../core/config";
import { globalConfigPath } from "../astro-home";
import {
  loadGlobalConfig,
  loadProfileStore,
  profileFromEnv,
  profilesPath,
  readGlobalProfileStore,
  resolveEffectiveConfig,
  saveProfileStore,
  type ProfileModel,
  type ProviderProfile,
  type ProviderSource,
  type ProviderStore,
} from "./profiles";

export interface ProfileDraft {
  name: string;
  kind: string;
  baseUrl?: string;
  credentialRef?: string;
  credentialsPath?: string;
  quotaDomain?: string;
  headers?: Record<string, string>;
  models: ProfileModel[];
}

export interface ProfileView extends ProviderProfile {
  active: boolean;
  source: ProviderSource;
}

/** Escrita de perfil recusada porque a camada global está desligada (#459). */
export class GlobalStoreDisabledError extends Error {
  override name = "GlobalStoreDisabledError";
  readonly code = "global_store_disabled";
  constructor() {
    super("camada global desligada (--no-global-config); /provider não grava perfis");
  }
}

export interface ProfileManagerOptions {
  storePath?: string;
  project?: AstroConfig;
  /** Providers/modelos declarados na camada de projeto (sem os herdados de `$ASTRO_HOME/config.json`). */
  projectRefs?: { providers: string[]; modelProviders: string[] };
  env?: NodeJS.ProcessEnv;
  /** Flag `--provider` da execução: alinha o marcador ativo com o loader. */
  provider?: string;
}

function slug(name: string): string {
  const normalized = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const id = normalized.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  if (id === "") throw new Error("nome do provider precisa ter ao menos uma letra ou número");
  return id;
}

function providerOfModel(modelRef: string, providers: Record<string, ProviderConfig>): string | undefined {
  return Object.keys(providers)
    .sort((a, b) => b.length - a.length)
    .find((name) => modelRef.startsWith(`${name}/`));
}

function projectReferences(
  project: AstroConfig,
  id: string,
  projectRefs: { providers: string[]; modelProviders: string[] },
): string | undefined {
  const uses = (modelRef: string): boolean => modelRef.startsWith(`${id}/`);
  if (uses(project.agent.model)) return "agent.model";
  for (const [name, agent] of Object.entries(project.agents ?? {})) {
    if (uses(agent.model)) return `agents.${name}.model`;
  }
  if (projectRefs.modelProviders.includes(id)) return "models[].provider";
  for (const [name, profile] of Object.entries(project.modelPool ?? {})) {
    if (uses(profile.model)) return `modelPool.${name}.model`;
  }
  for (const name of projectRefs.providers) {
    const provider = project.providers[name];
    if (provider !== undefined && (provider.fallback ?? []).includes(id)) return `providers.${name}.fallback`;
  }
  return undefined;
}

export class ProfileManager {
  readonly #storePath: string;
  readonly #storeInjected: boolean;
  readonly #project: AstroConfig | undefined;
  readonly #projectRefs: { providers: string[]; modelProviders: string[] };
  readonly #globalProviders: string[];
  readonly #env: NodeJS.ProcessEnv;
  readonly #provider: string | undefined;
  #store: ProviderStore;

  constructor(opts: ProfileManagerOptions = {}) {
    this.#env = opts.env ?? process.env;
    this.#project = opts.project;
    this.#projectRefs = opts.projectRefs ?? {
      providers: Object.keys(opts.project?.providers ?? {}),
      modelProviders: (opts.project?.models ?? []).map((model) => model.provider),
    };
    const global = this.#env.ASTRO_NO_GLOBAL_CONFIG === "1" ? undefined : loadGlobalConfig(this.#env);
    this.#globalProviders = global !== undefined && isPlainObject(global.providers)
      ? Object.keys(global.providers)
      : [];
    this.#provider = opts.provider;
    this.#storePath = opts.storePath ?? profilesPath(this.#env);
    this.#storeInjected = opts.storePath !== undefined;
    this.#store = this.#storeInjected ? loadProfileStore(this.#storePath) : readGlobalProfileStore(this.#env);
  }

  list(): ProfileView[] {
    this.#reload();
    const envProfile = profileFromEnv(this.#env);
    const activeId = this.#activeProvider();
    const view = (profile: ProviderProfile, source: ProviderSource): ProfileView => ({
      ...profile,
      source,
      active: profile.id === activeId,
    });

    const result = new Map<string, ProfileView>();
    for (const name of this.#projectRefs.providers) {
      const provider = this.#project?.providers[name];
      if (provider === undefined) continue;
      result.set(name, view(this.#projectProfile(name, provider), "project"));
    }
    for (const profile of this.#store.profiles) {
      if (!result.has(profile.id)) result.set(profile.id, view(profile, "global"));
    }
    if (envProfile !== undefined && !result.has(envProfile.id)) {
      result.set(envProfile.id, view(envProfile, "env"));
    }
    return [...result.values()];
  }

  add(draft: ProfileDraft): ProfileView {
    this.#reload();
    const name = draft.name.trim();
    const id = slug(name);
    if (id === "env") throw new Error('"env" é reservado para o perfil efêmero');
    this.#assertNoConfigCollision(name);
    if (this.#store.profiles.some((profile) => profile.id === id)) {
      throw new Error(`já existe um provider com esse nome: "${name}"`);
    }
    const profile: ProviderProfile = { id, ...draft, name };
    this.#save({ ...this.#store, profiles: [...this.#store.profiles, profile] });
    return { ...profile, active: false, source: "global" };
  }

  edit(id: string, draft: ProfileDraft): ProfileView {
    this.#reload();
    this.#requireEditable(id);
    const index = this.#store.profiles.findIndex((profile) => profile.id === id);
    if (index < 0) throw new Error(`provider "${id}" não existe no store`);
    const name = draft.name.trim();
    if (slug(name) === "env") throw new Error('"env" é reservado para o perfil efêmero');
    this.#assertNoConfigCollision(name);
    const profile: ProviderProfile = { ...draft, id, name };
    const profiles = [...this.#store.profiles];
    profiles[index] = profile;
    this.#save({ ...this.#store, profiles });
    return { ...profile, active: this.#activeProvider() === id, source: "global" };
  }

  remove(id: string): void {
    this.#reload();
    this.#requireEditable(id);
    const index = this.#store.profiles.findIndex((profile) => profile.id === id);
    if (index < 0) throw new Error(`provider "${id}" não existe no store`);
    const reference = this.#project === undefined ? undefined : projectReferences(this.#project, id, this.#projectRefs);
    if (reference !== undefined) {
      throw new Error(`provider "${id}" é usado por astro.config.json (${reference}); troque a referência antes`);
    }
    const { activeProfileId, ...rest } = this.#store;
    const profiles = this.#store.profiles.filter((profile) => profile.id !== id);
    this.#save(activeProfileId === id ? { ...rest, profiles } : { ...rest, profiles, activeProfileId });
  }

  use(id: string): ProviderProfile {
    this.#reload();
    this.#requireEditable(id);
    if (this.#project?.agent.profile !== undefined) {
      throw new Error("agent.profile tem precedência; ajuste o profile no astro.config.json");
    }
    if (this.#env.ASTRO_PROVIDER !== undefined && this.#env.ASTRO_PROVIDER !== "") {
      throw new Error("ASTRO_PROVIDER está definido nesta sessão; remova para salvar o ativo");
    }
    const profile = this.#store.profiles.find((item) => item.id === id);
    if (profile === undefined) throw new Error(`provider "${id}" não existe no store`);
    this.#save({ ...this.#store, activeProfileId: id });
    return profile;
  }

  #assertNoConfigCollision(name: string): void {
    const wanted = slug(name);
    for (const key of this.#projectRefs.providers) {
      if (key === name || slug(key) === wanted) {
        throw new Error(`provider "${name}" está definido no astro.config.json; edite o arquivo`);
      }
    }
    for (const key of this.#globalProviders) {
      if (key === name || slug(key) === wanted) {
        throw new Error(
          `provider "${name}" está definido em "${globalConfigPath(this.#env)}"; edite o arquivo`,
        );
      }
    }
  }

  #activeProvider(): string | undefined {
    const envProfile = profileFromEnv(this.#env);
    try {
      return resolveEffectiveConfig({
        ...(this.#project === undefined ? {} : { project: this.#project }),
        store: this.#store,
        ...(envProfile === undefined ? {} : { envProfile }),
        ...(this.#provider === undefined ? {} : { providerFlag: this.#provider }),
        env: this.#env,
      }).activeProvider;
    } catch {
      return undefined;
    }
  }

  #reload(): void {
    this.#store = this.#storeInjected ? loadProfileStore(this.#storePath) : readGlobalProfileStore(this.#env);
  }

  /** Variável de credencial presente no env desta execução. */
  credentialPresent(name: string): boolean {
    const value = this.#env[name];
    return value !== undefined && value.trim() !== "";
  }

  #requireEditable(id: string): void {
    if (this.#projectRefs.providers.includes(id)) {
      throw new Error(`provider "${id}" está definido no astro.config.json; edite o arquivo`);
    }
    if (this.#globalProviders.includes(id)) {
      throw new Error(`provider "${id}" está definido em "${globalConfigPath(this.#env)}"; edite o arquivo`);
    }
    if (profileFromEnv(this.#env)?.id === id) {
      throw new Error(`perfil "${id}" é efêmero (env) e não pode ser editado`);
    }
  }

  #projectProfile(name: string, provider: ProviderConfig): ProviderProfile {
    const config = provider as {
      baseUrl?: string;
      credentialRef?: string;
      credentialsPath?: string;
      quotaDomain?: string;
      headers?: Record<string, string>;
    };
    const models = (this.#project?.models ?? [])
      .filter((model) => model.provider === name)
      .map((model) => ({ id: model.id, tags: model.tags, context: model.context }));
    return {
      id: name,
      name,
      kind: provider.kind,
      ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
      ...(config.credentialRef === undefined ? {} : { credentialRef: config.credentialRef }),
      ...(config.credentialsPath === undefined ? {} : { credentialsPath: config.credentialsPath }),
      ...(config.quotaDomain === undefined ? {} : { quotaDomain: config.quotaDomain }),
      ...(config.headers === undefined ? {} : { headers: config.headers }),
      models,
    };
  }

  #save(store: ProviderStore): void {
    // Sem a camada global, a leitura é vazia (`readGlobalProfileStore`): gravar no
    // `providers.json` produziria um perfil que ninguém lê (#459).
    if (!this.#storeInjected && this.#env.ASTRO_NO_GLOBAL_CONFIG === "1") {
      throw new GlobalStoreDisabledError();
    }
    saveProfileStore(store, this.#storePath);
    this.#store = store;
  }
}
