import { expect, test } from "bun:test";
import { validateConfig, type AstroConfig } from "../src/config";
import {
  profileFromEnv,
  resolveEffectiveConfig,
  type EffectiveConfig,
  type ProviderStore,
} from "../src/provider/profiles";
import { buildModelCatalog, formatModelCatalog } from "../src/model-catalog";

const SENTINEL = "sentinel-xyz";

const PATHS = { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" };

function effectiveFrom(opts: {
  project?: AstroConfig;
  store?: ProviderStore;
  env?: NodeJS.ProcessEnv;
}): EffectiveConfig {
  return resolveEffectiveConfig({
    ...(opts.project === undefined ? {} : { project: opts.project }),
    store: opts.store ?? { version: 1, profiles: [] },
    ...(opts.env === undefined ? {} : { envProfile: profileFromEnv(opts.env) }),
    env: {},
  });
}

function projectWith(providers: AstroConfig["providers"], models: AstroConfig["models"], agentModel: string): AstroConfig {
  return validateConfig({
    providers,
    models,
    agent: { model: agentModel, maxSteps: 2, tools: ["read_file"] },
    paths: PATHS,
  });
}

const PROJ = { proj: { kind: "openai-compat", baseUrl: "https://proj.example/v1", credentialRef: "KEY" } } as const;

test("origem project/global/env e ordem por provider/id", () => {
  const eff = effectiveFrom({
    project: projectWith(
      PROJ,
      [{ provider: "proj", id: "p1", tags: ["writing-code"], context: 8192 }],
      "proj/p1",
    ),
    store: {
      version: 1,
      profiles: [{
        id: "glob",
        name: "Glob",
        kind: "openai-compat",
        baseUrl: "https://glob.example/v1",
        credentialRef: "GLOB_KEY",
        models: [{ id: "g1", tags: ["fast"], context: 4096 }],
      }],
    },
    env: { OPENAI_API_KEY: SENTINEL, OPENAI_MODEL: "e1" },
  });
  const catalog = buildModelCatalog(eff);
  const byRef = new Map(catalog.map((model) => [model.ref, model]));
  expect(byRef.get("proj/p1")?.source).toBe("project");
  expect(byRef.get("glob/g1")?.source).toBe("global");
  expect(byRef.get("env/e1")?.source).toBe("env");
  expect(catalog.map((model) => model.ref)).toEqual(["env/e1", "glob/g1", "proj/p1"]);
});

test("projeto vence global na mesma ref", () => {
  const eff = effectiveFrom({
    project: projectWith(
      PROJ,
      [{ provider: "proj", id: "p1", tags: ["writing-code"], context: 8192 }],
      "proj/p1",
    ),
    store: {
      version: 1,
      profiles: [{
        id: "proj",
        name: "Proj global",
        kind: "openai-compat",
        baseUrl: "https://global.example/v1",
        credentialRef: "GLOB_KEY",
        models: [{ id: "p1", tags: ["fast"], context: 4096 }],
      }],
    },
  });
  const rows = buildModelCatalog(eff).filter((model) => model.ref === "proj/p1");
  expect(rows).toHaveLength(1);
  expect(rows[0]?.source).toBe("project");
  expect(rows[0]?.context).toBe(8192);
});

test("identidade é par exato, não prefixo", () => {
  const eff = effectiveFrom({
    project: projectWith(
      { openai: { kind: "openai-compat", baseUrl: "https://openai.example/v1", credentialRef: "KEY" } },
      [{ provider: "openai", id: "x", tags: [], context: 1024 }],
      "openai/x",
    ),
    store: {
      version: 1,
      profiles: [{
        id: "openai-work",
        name: "Work",
        kind: "openai-compat",
        baseUrl: "https://work.example/v1",
        credentialRef: "WORK_KEY",
        models: [{ id: "x", tags: [], context: 2048 }],
      }],
    },
  });
  const catalog = buildModelCatalog(eff);
  const byRef = new Map(catalog.map((model) => [model.ref, model]));
  expect(catalog).toHaveLength(2);
  expect(byRef.get("openai/x")?.source).toBe("project");
  expect(byRef.get("openai-work/x")?.source).toBe("global");
});

test("disabled aparece com status", () => {
  const eff = effectiveFrom({
    project: projectWith(
      PROJ,
      [
        { provider: "proj", id: "p1", tags: [], context: 8192 },
        { provider: "proj", id: "pd", tags: [], context: 1024, status: "disabled" },
      ],
      "proj/p1",
    ),
  });
  const row = buildModelCatalog(eff).find((model) => model.ref === "proj/pd");
  expect(row?.status).toBe("disabled");
});

test("pricing do config vence price do modelo", () => {
  const eff = effectiveFrom({
    project: projectWith(
      PROJ,
      [{
        provider: "proj",
        id: "p1",
        tags: [],
        context: 8192,
        price: { inputPerM: 1, outputPerM: 2, fonte: "modelo", verificado: false },
      }],
      "proj/p1",
    ),
  });
  const withPricing = resolveEffectiveConfig({
    project: validateConfig({
      providers: PROJ,
      models: [{ provider: "proj", id: "p1", tags: [], context: 8192 }],
      pricing: { "proj/p1": { inputPerM: 10, outputPerM: 20, fonte: "config", verificado: true } },
      agent: { model: "proj/p1", maxSteps: 2, tools: ["read_file"] },
      paths: PATHS,
    }),
    store: { version: 1, profiles: [] },
    env: {},
  });
  expect(buildModelCatalog(eff).find((m) => m.ref === "proj/p1")?.price?.fonte).toBe("modelo");
  expect(buildModelCatalog(withPricing).find((m) => m.ref === "proj/p1")?.price?.fonte).toBe("config");
});

test("formatação não ecoa valor de ambiente", () => {
  const eff = effectiveFrom({
    project: projectWith(
      PROJ,
      [{ provider: "proj", id: "p1", tags: ["writing-code"], context: 8192 }],
      "proj/p1",
    ),
    env: { OPENAI_API_KEY: SENTINEL, OPENAI_MODEL: "e1" },
  });
  const out = formatModelCatalog(buildModelCatalog(eff));
  expect(out).toContain("proj/p1 · project · active");
  expect(out).not.toContain(SENTINEL);
});

test("catálogo vazio formata como nenhum modelo", () => {
  expect(formatModelCatalog([])).toBe("nenhum modelo");
});
