import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { validateConfig } from "../src/core/config";
import { definePlugin, loadPlugins, pluginAllowlistFromEnv } from "../src/plugins";
import { runTask } from "../src/core/app";
import { testEnv } from "./setup";

/** Plugin de teste: tool sql_query + provider factory bigquery. */
const PLUGIN_SOURCE = `
export function definePlugin() {
  return {
    name: "test-plugin",
    tools: [
      {
        manifest: {
          name: "sql_query",
          description: "Executa uma consulta SQL no banco de teste.",
          parameters: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] },
          risk: "high", permission: "execute", timeoutMs: 5000, retryable: false,
          idempotent: false, sideEffects: "process", class: "shell",
        },
        async execute(input) {
          const sql = input.sql ?? "";
          return { output: \`resultado da consulta: \${sql}\` };
        },
      },
    ],
    providers: [
      {
        kind: "bigquery",
        create(rawConfig, env) {
          return {
            async complete(req) {
              return {
                content: "resposta do bigquery: " + (env.BQ_STUB ?? "sem-stub"),
                toolCalls: [],
                usage: { inputTokens: 7, outputTokens: 3 },
              };
            },
          };
        },
      },
    ],
  };
}
`;

function writePlugin(dir: string): string {
  const path = join(dir, "test-plugin.ts");
  writeFileSync(path, PLUGIN_SOURCE, "utf8");
  return path;
}

/** Plugin cru: tool sem `class` (manifesto que o SDK rejeita, mas o loader aceitava). */
const RAW_TOOL_PLUGIN = `
export function definePlugin() {
  return {
    name: "raw-plugin",
    tools: [{
      manifest: {
        name: "raw_plugin_tool",
        description: "tool sem class",
        parameters: { type: "object", properties: {} },
        risk: "high", permission: "execute", timeoutMs: 1000,
        retryable: false, idempotent: false, sideEffects: "process",
      },
      async execute() { return { output: "executou" }; },
    }],
  };
}
`;

function writeConfig(dir: string, plugins: string[], providers: Record<string, unknown>): string {
  const path = join(dir, "astro.config.json");
  writeFileSync(path, JSON.stringify({
    providers,
    models: [{ provider: "bq", id: "model-x", tags: ["writing-code"], context: 4096 }],
    agent: { model: "bq/model-x", maxSteps: 3, tools: ["sql_query"] },
    plugins,
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }, null, 2));
  return path;
}

/** Plugin cujo import grava um marcador: prova se o módulo foi EXECUTADO, não só registrado. */
function writeMarkerPlugin(dir: string): { entry: string; marker: string } {
  const marker = join(dir, "plugin-executed.txt");
  const entry = join(dir, "marker-plugin.ts");
  writeFileSync(entry, `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "executou");
export function definePlugin() {
  return { name: "marker-plugin", tools: [] };
}
`, "utf8");
  return { entry, marker };
}

/** Config mínima de run (provider mock HTTP) com plugins declarados. */
function writeRunConfig(dir: string, plugins: string[], baseUrl: string): string {
  const path = join(dir, "astro.config.json");
  writeFileSync(path, JSON.stringify({
    providers: { mock: { kind: "openai-compat", baseUrl, credentialRef: "TEST_KEY" } },
    models: [{ provider: "mock", id: "mock-1", tags: ["writing-code"], context: 4096 }],
    agent: { model: "mock/mock-1", maxSteps: 1, tools: [] },
    plugins,
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }, null, 2));
  return path;
}

async function withOkProvider<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
  });
  try {
    return await fn(`http://127.0.0.1:${server.port}/v1`);
  } finally {
    server.stop(true);
  }
}

describe("plugin system (F7-1)", () => {
  test("definePlugin é identidade para DX", () => {
    const def = definePlugin({ name: "x", tools: [], providers: [] });
    expect(def.name).toBe("x");
  });

  test("loadPlugins carrega tool e provider factory de arquivo .ts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-plugin-"));
    const loaded = await loadPlugins([writePlugin(dir)], { localTrusted: true, baseDir: dir });
    expect(loaded.tools).toHaveLength(1);
    expect(loaded.tools[0]!.manifest.name).toBe("sql_query");
    expect(loaded.providerFactories.size).toBe(1);
    expect(loaded.providerFactories.has("bigquery")).toBe(true);
  });

  test("plugin com path inexistente: warn isolado, segue sem ele", async () => {
    const warnings: string[] = [];
    const loaded = await loadPlugins(["./plugin-fantasma.ts"], { warn: (m) => warnings.push(m), localTrusted: true });
    expect(loaded.tools).toHaveLength(0);
    expect(loaded.providerFactories.size).toBe(0);
    expect(warnings.some((w) => w.includes("plugin-fantasma"))).toBe(true);
  });

  test("módulo sem definePlugin válido: warn e ignorado", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-plugin-"));
    const bad = join(dir, "bad-plugin.ts");
    writeFileSync(bad, "export const outra = 1;\n", "utf8");
    const warnings: string[] = [];
    const loaded = await loadPlugins([bad], { warn: (m) => warnings.push(m), localTrusted: true, baseDir: dir });
    expect(loaded.tools).toHaveLength(0);
    expect(warnings.some((w) => w.includes("não exporta"))).toBe(true);
  });

  test("runTask ponta a ponta com plugin: tool sql_query e provider bigquery sem tocar o core", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-plugin-"));
    const configPath = writeConfig(dir, [writePlugin(dir)], {
      bq: { kind: "bigquery", credentialRef: "BQ_KEY", dataset: "meu" },
    });

    const report = await runTask({ configPath, task: "consulte o banco", cwd: dir, env: testEnv({ BQ_KEY: "k", BQ_STUB: "stub-ok" }), trustAsk: () => true });
    // provider do plugin respondeu
    expect(report.final).toContain("resposta do bigquery: stub-ok");
    expect(report.tokensIn).toBe(7);
    expect(report.tokensOut).toBe(3);

    // a tool do plugin foi validada na config (não rejeitada como desconhecida)
    // e o run passou pelo fluxo normal com ledger/audit
    const audit = readFileSync(join(dir, ".astro", "audit.jsonl"), "utf8");
    expect(audit).toContain("run.started");
    expect(audit).toContain("run.completed");
  });

  test("kind de plugin sem factory registrada → erro claro", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-plugin-"));
    const configPath = writeConfig(dir, [], { bq: { kind: "bigquery" } });
    const err = (await runTask({ configPath, task: "x", cwd: dir, env: testEnv({}) }).then(() => null, (e) => e)) as Error;
    expect(String(err!.message)).toContain("sem factory");
  });

  test("config com plugins inválidos → ConfigError", () => {
    expect(() =>
      validateConfig({
        providers: { openai: { kind: "openai-compat", baseUrl: "http://x", credentialRef: "K" } },
        models: [{ provider: "openai", id: "m", tags: ["fast"], context: 1 }],
        agent: { model: "openai/m", maxSteps: 1, tools: [] },
        plugins: [""],
        paths: { ledger: "l", audit: "a" },
      }),
    ).toThrow();
  });
});

describe("plugin manifest validation (#264, P0)", () => {
  test("tool de plugin sem class é ignorada no load, com warn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-plugin-raw-"));
    const entry = join(dir, "raw-plugin.ts");
    writeFileSync(entry, RAW_TOOL_PLUGIN, "utf8");
    const warnings: string[] = [];
    const loaded = await loadPlugins([entry], { localTrusted: true, baseDir: dir, warn: (m) => warnings.push(m) });
    expect(loaded.tools).toHaveLength(0);
    expect(warnings.join("\n")).toMatch(/class|inválid/i);
  });
});

describe("plugin trust (I-13, #255)", () => {
  test("pacote remoto fora da allowlist falha fechado, com warn", async () => {
    const warnings: string[] = [];
    const loaded = await loadPlugins(["dark-plugin"], { warn: (m) => warnings.push(m) });
    expect(loaded.tools).toHaveLength(0);
    expect(loaded.providerFactories.size).toBe(0);
    expect(warnings.join("\n")).toContain("ASTRO_PLUGIN_ALLOWLIST");
  });

  test("allowlist libera o pacote remoto", async () => {
    const warnings: string[] = [];
    await loadPlugins(["dark-plugin"], { allowlist: new Set(["dark-plugin"]), warn: (m) => warnings.push(m) });
    expect(warnings.join("\n")).not.toContain("ASTRO_PLUGIN_ALLOWLIST");
  });

  test("caminho local não exige allowlist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-plugin-"));
    const warnings: string[] = [];
    const loaded = await loadPlugins([writePlugin(dir)], { warn: (m) => warnings.push(m), localTrusted: true, baseDir: dir });
    expect(loaded.tools).toHaveLength(1);
    expect(warnings).toHaveLength(0);
  });

  test("allowlist do env é lista separada por vírgula", () => {
    expect([...pluginAllowlistFromEnv({ ASTRO_PLUGIN_ALLOWLIST: "a, b ,," })]).toEqual(["a", "b"]);
    expect([...pluginAllowlistFromEnv({})]).toEqual([]);
  });
});

describe("plugin trust order (#255, P0)", () => {
  async function runPluginTask(
    dir: string,
    pluginEntry: string,
    trustAsk?: () => boolean,
    extraEnv: Record<string, string> = {},
  ): Promise<{ report: Awaited<ReturnType<typeof runTask>>; warnings: string[] }> {
    return withOkProvider(async (baseUrl) => {
      const configPath = writeRunConfig(dir, [pluginEntry], baseUrl);
      const warnings: string[] = [];
      const original = console.warn;
      console.warn = (message?: unknown) => { warnings.push(String(message)); };
      try {
        const report = await runTask({
          configPath, task: "x", cwd: dir, env: testEnv({ TEST_KEY: "k", ...extraEnv }),
          ...(trustAsk === undefined ? {} : { trustAsk }),
        });
        return { report, warnings };
      } finally {
        console.warn = original;
      }
    });
  }

  test("loadPlugins não importa caminho local sem trust do cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-plugin-untrusted-"));
    const { entry, marker } = writeMarkerPlugin(dir);
    const warnings: string[] = [];
    const loaded = await loadPlugins([entry], { warn: (m) => warnings.push(m) });
    expect(loaded.tools).toHaveLength(0);
    expect(existsSync(marker)).toBe(false); // import executaria o módulo antes da aprovação
    expect(warnings.join("\n")).toMatch(/trust|confiável/i);
  });

  test("runTask sem trust e sem TTY não executa plugin local absoluto", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-plugin-untrusted-run-"));
    const { entry, marker } = writeMarkerPlugin(dir);
    const { report, warnings } = await runPluginTask(dir, entry);
    expect(report.final).toBe("ok");
    expect(existsSync(marker)).toBe(false);
    expect(warnings.join("\n")).toMatch(/trust|confiável/i);
  });

  test("config com plugins relativos em pasta não confiável não executa o plugin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-plugin-untrusted-rel-"));
    const { entry, marker } = writeMarkerPlugin(dir);
    const { report, warnings } = await runPluginTask(dir, `./${basename(entry)}`);
    expect(report.final).toBe("ok");
    expect(existsSync(marker)).toBe(false);
    expect(warnings.join("\n")).toMatch(/trust|confiável/i);
  });

  test("runTask com trust aprovado carrega o plugin local relativo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-plugin-trusted-run-"));
    const { entry, marker } = writeMarkerPlugin(dir);
    const { report } = await runPluginTask(dir, `./${basename(entry)}`, () => true);
    expect(report.final).toBe("ok");
    expect(existsSync(marker)).toBe(true);
  });

  test("trust do cwd não carrega plugin local fora da pasta", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-plugin-inside-"));
    const outside = mkdtempSync(join(tmpdir(), "astro-plugin-outside-"));
    const { entry, marker } = writeMarkerPlugin(outside);
    const { report, warnings } = await runPluginTask(dir, entry, () => true);
    expect(report.final).toBe("ok");
    expect(existsSync(marker)).toBe(false); // trust da pasta não cobre código externo
    expect(warnings.join("\n")).toMatch(/fora do cwd|fora da pasta|fora do projeto/i);
  });

  test("trust do cwd não carrega plugin local via ../", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-plugin-rel-inside-"));
    const outside = mkdtempSync(join(tmpdir(), "astro-plugin-rel-outside-"));
    const { entry, marker } = writeMarkerPlugin(outside);
    const { report, warnings } = await runPluginTask(dir, relative(dir, entry), () => true);
    expect(report.final).toBe("ok");
    expect(existsSync(marker)).toBe(false);
    expect(warnings.join("\n")).toMatch(/fora do cwd/i);
  });

  test("trust do cwd não carrega plugin local via junction/symlink para fora", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-plugin-link-inside-"));
    const outside = mkdtempSync(join(tmpdir(), "astro-plugin-link-outside-"));
    const { entry, marker } = writeMarkerPlugin(outside);
    // Junction (Windows) / symlink de diretório (POSIX): não exige Developer Mode.
    symlinkSync(outside, join(dir, "link-dir"), process.platform === "win32" ? "junction" : "dir");
    const { report, warnings } = await runPluginTask(dir, `./link-dir/${basename(entry)}`, () => true);
    expect(report.final).toBe("ok");
    expect(existsSync(marker)).toBe(false);
    expect(warnings.join("\n")).toMatch(/fora do cwd/i);
  });

  test("runTask usa ASTRO_PLUGIN_ALLOWLIST do env do run, não do process.env", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-plugin-run-env-"));
    const { entry, marker } = writeMarkerPlugin(dir);
    const fileUrl = pathToFileURL(entry).href;
    const original = process.env.ASTRO_PLUGIN_ALLOWLIST;
    delete process.env.ASTRO_PLUGIN_ALLOWLIST;
    try {
      const { report } = await runPluginTask(dir, fileUrl, undefined, { ASTRO_PLUGIN_ALLOWLIST: fileUrl });
      expect(report.final).toBe("ok");
      expect(existsSync(marker)).toBe(true);
    } finally {
      if (original === undefined) delete process.env.ASTRO_PLUGIN_ALLOWLIST;
      else process.env.ASTRO_PLUGIN_ALLOWLIST = original;
    }
  });

  test("file URL fora do cwd é ignorada sem allowlist e carregada com ela", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-plugin-fileurl-inside-"));
    const outside = mkdtempSync(join(tmpdir(), "astro-plugin-fileurl-outside-"));
    const { entry, marker } = writeMarkerPlugin(outside);
    const fileUrl = pathToFileURL(entry).href;
    const original = process.env.ASTRO_PLUGIN_ALLOWLIST;
    delete process.env.ASTRO_PLUGIN_ALLOWLIST;
    try {
      const blocked = await runPluginTask(dir, fileUrl);
      expect(blocked.report.final).toBe("ok");
      expect(existsSync(marker)).toBe(false);
      expect(blocked.warnings.join("\n")).toMatch(/ASTRO_PLUGIN_ALLOWLIST/i);

      const allowed = await runPluginTask(dir, fileUrl, undefined, { ASTRO_PLUGIN_ALLOWLIST: fileUrl });
      expect(allowed.report.final).toBe("ok");
      expect(existsSync(marker)).toBe(true);
    } finally {
      if (original === undefined) delete process.env.ASTRO_PLUGIN_ALLOWLIST;
      else process.env.ASTRO_PLUGIN_ALLOWLIST = original;
    }
  });
});
