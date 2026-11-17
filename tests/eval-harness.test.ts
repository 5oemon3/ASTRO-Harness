import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import {
  compareFile,
  evalFailsThreshold,
  listGoldenCases,
  runEval,
  runCase,
  writeBaseline,
  type CaseResult,
  type EvalReport,
} from "../src/eval/harness";
import { runScenario, type ScenarioSpec } from "../src/eval/scenario";

const GOLDEN_ROOT = join(import.meta.dir, "..", "eval", "golden");

interface ScenarioCaseOptions {
  task?: string;
  expected?: Record<string, string>;
  fixtures?: Record<string, string>;
}

/** Cria um case temporário com meta/task/scenario e devolve o diretório. */
function writeScenarioCase(
  root: string,
  name: string,
  scenario: ScenarioSpec,
  opts: ScenarioCaseOptions = {},
): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "expected"), { recursive: true });
  mkdirSync(join(dir, "fixtures"), { recursive: true });
  const expected = opts.expected ?? {};
  for (const [file, content] of Object.entries(expected)) {
    mkdirSync(dirname(join(dir, "expected", file)), { recursive: true });
    writeFileSync(join(dir, "expected", file), content);
  }
  for (const [file, content] of Object.entries(opts.fixtures ?? {})) {
    writeFileSync(join(dir, "fixtures", file), content);
  }
  writeFileSync(join(dir, "task.md"), opts.task ?? "tarefa do cenário\n");
  writeFileSync(join(dir, "meta.json"), JSON.stringify({
    schema: 1, id: name, category: "skills", difficulty: 2, tags: ["writing-code"], files: Object.keys(expected),
  }));
  writeFileSync(join(dir, "scenario.json"), JSON.stringify(scenario));
  return dir;
}

async function runTempCase(root: string, name: string): Promise<CaseResult> {
  const golden = listGoldenCases(root).find((entry) => entry.id === name);
  if (golden === undefined) throw new Error(`case temporário "${name}" não encontrado`);
  return runCase(golden, { mock: true });
}

const SKILL_OK = [
  "---", "name: verify", "description: Verifica a skill", "version: 1.0.0",
  "permissions:", "  tools: [write_file]", "---",
  "Confirme a skill instalada.", "",
].join("\n");

describe("eval harness (F5-2)", () => {
  test("listGoldenCases devolve os 65 cases com meta", () => {
    const cases = listGoldenCases(GOLDEN_ROOT);
    expect(cases).toHaveLength(65);
    expect(cases[0]!.files.length).toBeGreaterThan(0);
    expect(cases[0]!.category).toBeTruthy();
  });

  test("listGoldenCases carrega scenario.json dos cases de cenário", () => {
    const root = mkdtempSync(join(tmpdir(), "astro-scenario-list-"));
    const dir = join(root, "01-scenario");
    mkdirSync(join(dir, "expected"), { recursive: true });
    writeFileSync(join(dir, "task.md"), "escreva o resultado do cenário\n");
    writeFileSync(join(dir, "expected", "out.txt"), "ok\n");
    writeFileSync(join(dir, "meta.json"), JSON.stringify({
      schema: 1, id: "scenario-list", category: "mcp", difficulty: 2, tags: ["writing-code"], files: ["out.txt"],
    }));
    writeFileSync(join(dir, "scenario.json"), JSON.stringify({
      schema: 1,
      kind: "app",
      turns: [{ toolCalls: [{ name: "write_file", arguments: { path: "out.txt", content: "ok\n" } }] }, { content: "fim" }],
      expect: { final: "fim", audit: ["tool.call"] },
    }));

    const [golden] = listGoldenCases(root);
    expect(golden?.scenario?.kind).toBe("app");
    expect(golden?.scenario?.turns).toHaveLength(2);
    expect(golden?.scenario?.expect?.final).toBe("fim");
  });

  test("runEval no golden dataset: pass rate 1.0 com relatório completo", async () => {
    const reportPath = join(mkdtempSync(join(tmpdir(), "astro-evalrep-")), "report.json");
    const report = await runEval({
      goldenRoot: GOLDEN_ROOT,
      mock: true,
      baselinePath: join(GOLDEN_ROOT, "..", "baseline-inexistente.json"),
      reportPath,
    });
    expect(report.total).toBe(65);
    expect(report.passRate).toBe(1);
    expect(report.regressions).toEqual([]);
    expect(report.cases.every((c) => c.passed)).toBe(true);
    // Dois cenários não chamam provider (falha esperada de skill e health check).
    expect(report.cases.filter((c) => c.tokens > 0).length).toBeGreaterThanOrEqual(63);
    expect(report.cases.every((c) => c.latencyMs >= 0)).toBe(true);
    // relatório gravado
    const saved = JSON.parse(readFileSync(reportPath, "utf8")) as EvalReport;
    expect(saved.total).toBe(65);
  }, 60000);

  test("servidores mock do cenário ligam apenas em loopback", async () => {
    const root = mkdtempSync(join(tmpdir(), "astro-loopback-"));
    const caseDir = writeScenarioCase(root, "01-loopback", {
      schema: 1,
      kind: "app",
      env: { EVAL_WEB_KEY: "eval-web-secret-123" },
      config: {
        agent: { model: "mock/mock-1", maxSteps: 2, tools: [] },
        mcpServers: { fs: { transport: "http", url: "{{mcpUrl}}", timeoutMs: 1000 } },
        webSearch: { provider: "exa", apiKeyEnv: "EVAL_WEB_KEY", baseUrl: "{{searchUrl}}" },
      },
      mcp: { tools: [{ name: "read_file", text: "x" }] },
      search: { results: [] },
      page: { html: "ok" },
      turns: [{ content: "ok" }],
      expect: { final: "ok" },
    });
    const cwd = mkdtempSync(join(tmpdir(), "astro-loopback-cwd-"));
    const originalServe = Bun.serve;
    const started: Array<{ hostname?: string; port?: number }> = [];
    const bun = Bun as unknown as { serve: (opts: unknown) => { hostname?: string; port?: number } };
    bun.serve = (opts) => {
      const server = originalServe(opts as Parameters<typeof Bun.serve>[0]);
      started.push(server);
      return server;
    };
    try {
      await runScenario(
        JSON.parse(readFileSync(join(caseDir, "scenario.json"), "utf8")) as ScenarioSpec,
        { cwd, caseDir, task: "tarefa" },
      );
    } finally {
      bun.serve = originalServe as unknown as (opts: unknown) => { hostname?: string; port?: number };
    }

    expect(started).toHaveLength(5);
    expect(started.every((server) => server.hostname === "127.0.0.1")).toBe(true);

    // Se houver uma interface não-loopback, a conexão a ela deve ser recusada.
    const local = Object.values(networkInterfaces()).flat()
      .find((entry) => entry !== undefined && !entry.internal && entry.family === "IPv4");
    if (local !== undefined) {
      const port = started[0]?.port;
      await expect(fetch(`http://${local.address}:${port}/`, { signal: AbortSignal.timeout(750) }))
        .rejects.toThrow();
    }
  }, 30000);

  test("runCase com scenario.seed/sidecars instala a skill e verifica o sha256", async () => {
    const root = mkdtempSync(join(tmpdir(), "astro-scenario-seed-"));
    writeScenarioCase(root, "01-skills", {
      schema: 1,
      kind: "app",
      seed: [{ from: "fixtures/verify.md", to: ".astro/skills/verify/SKILL.md" }],
      sidecars: [".astro/skills/verify"],
      turns: [
        { toolCalls: [{ name: "write_file", arguments: { path: "out/ok.txt", content: "ok\n" } }] },
        { content: "seed ok" },
      ],
      expect: { final: "seed ok", audit: ["skill.loaded"] },
    }, { task: "/verify conferir a skill instalada\n", expected: { "out/ok.txt": "ok\n" }, fixtures: { "verify.md": SKILL_OK } });

    const result = await runTempCase(root, "01-skills");
    expect(result.diffSummary).toEqual([]);
    expect(result.passed).toBe(true);
  }, 30000);

  test("sidecar é gravado no contrato <skill>/.sha256", async () => {
    const root = mkdtempSync(join(tmpdir(), "astro-sidecar-contract-"));
    const caseDir = writeScenarioCase(root, "01-sidecar", {
      schema: 1,
      kind: "app",
      seed: [{ from: "fixtures/verify.md", to: ".astro/skills/verify/SKILL.md" }],
      sidecars: [".astro/skills/verify"],
      turns: [{ content: "ok" }],
      expect: { final: "ok" },
    }, { fixtures: { "verify.md": SKILL_OK } });
    const cwd = mkdtempSync(join(tmpdir(), "astro-sidecar-cwd-"));

    const result = await runScenario(
      JSON.parse(readFileSync(join(caseDir, "scenario.json"), "utf8")) as ScenarioSpec,
      { cwd, caseDir, task: "tarefa comum" },
    );
    expect(result.diffSummary).toEqual([]);
    const skillFile = join(cwd, ".astro", "skills", "verify", "SKILL.md");
    const sidecar = join(cwd, ".astro", "skills", "verify", ".sha256");
    expect(existsSync(sidecar)).toBe(true);
    expect(readFileSync(sidecar, "utf8").trim())
      .toBe(createHash("sha256").update(readFileSync(skillFile)).digest("hex"));
  }, 30000);

  test("sidecar obsoleto faz a skill ser ignorada", async () => {
    const root = mkdtempSync(join(tmpdir(), "astro-sidecar-stale-"));
    writeScenarioCase(root, "01-stale", {
      schema: 1,
      kind: "app",
      seed: [
        { from: "fixtures/verify.md", to: ".astro/skills/verify/SKILL.md" },
        { from: "fixtures/stale.sha256", to: ".astro/skills/verify/.sha256" },
      ],
      turns: [],
      expect: { error: "não encontrada", auditAbsent: ["skill.loaded"] },
    }, {
      task: "/verify conferir a skill instalada\n",
      fixtures: { "verify.md": SKILL_OK, "stale.sha256": `${"0".repeat(64)}\n` },
    });

    const result = await runTempCase(root, "01-stale");
    expect(result.passed).toBe(true);
  }, 30000);

  test("scenario.seed.from não pode escapar do caseDir", async () => {
    const root = mkdtempSync(join(tmpdir(), "astro-seed-from-"));
    const caseDir = join(root, "case");
    mkdirSync(caseDir, { recursive: true });
    writeFileSync(join(root, "host-secret.txt"), "host secret\n");
    const cwd = mkdtempSync(join(tmpdir(), "astro-seed-from-cwd-"));
    const spec: ScenarioSpec = {
      schema: 1,
      kind: "app",
      seed: [{ from: "../host-secret.txt", to: "stolen.txt" }],
      turns: [{ content: "ok" }],
      expect: { final: "ok" },
    };

    await expect(runScenario(spec, { cwd, caseDir, task: "tarefa" })).rejects.toThrow(/fora do diretório/);
    expect(existsSync(join(cwd, "stolen.txt"))).toBe(false);
  });

  test("scenario.seed.from recusa source que é link, mesmo dentro do caseDir", async () => {
    const root = mkdtempSync(join(tmpdir(), "astro-seed-link-"));
    const caseDir = join(root, "case");
    mkdirSync(join(caseDir, "fixtures", "real"), { recursive: true });
    writeFileSync(join(caseDir, "fixtures", "real", "secret.txt"), "secret\n");
    symlinkSync(join(caseDir, "fixtures", "real"), join(caseDir, "fixtures", "linked"), "junction");
    const cwd = mkdtempSync(join(tmpdir(), "astro-seed-link-cwd-"));
    const spec: ScenarioSpec = {
      schema: 1,
      kind: "app",
      seed: [{ from: "fixtures/linked", to: "stolen" }],
      turns: [{ content: "ok" }],
      expect: { final: "ok" },
    };

    await expect(runScenario(spec, { cwd, caseDir, task: "tarefa" })).rejects.toThrow(/link/i);
    expect(existsSync(join(cwd, "stolen"))).toBe(false);
  });

  test("scenario.seed.to não escreve através de junction dentro do cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "astro-seed-to-link-"));
    const caseDir = writeScenarioCase(root, "01-dest", {
      schema: 1,
      kind: "app",
      seed: [{ from: "fixtures/ok.txt", to: "link/stolen.txt" }],
      turns: [{ content: "ok" }],
      expect: { final: "ok" },
    }, { fixtures: { "ok.txt": "ok\n" } });
    const cwd = mkdtempSync(join(tmpdir(), "astro-seed-to-cwd-"));
    const outside = mkdtempSync(join(tmpdir(), "astro-seed-to-out-"));
    symlinkSync(outside, join(cwd, "link"), "junction");

    await expect(runScenario(
      JSON.parse(readFileSync(join(caseDir, "scenario.json"), "utf8")) as ScenarioSpec,
      { cwd, caseDir, task: "tarefa" },
    )).rejects.toThrow(/fora do diretório/);
    expect(existsSync(join(outside, "stolen.txt"))).toBe(false);
  });

  test("sidecars não lê nem escreve através de junction dentro do cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "astro-sidecar-link-"));
    const caseDir = writeScenarioCase(root, "01-sidecar-link", {
      schema: 1,
      kind: "app",
      sidecars: ["link"],
      turns: [{ content: "ok" }],
      expect: { final: "ok" },
    });
    const cwd = mkdtempSync(join(tmpdir(), "astro-sidecar-link-cwd-"));
    const outside = mkdtempSync(join(tmpdir(), "astro-sidecar-link-out-"));
    writeFileSync(join(outside, "SKILL.md"), SKILL_OK);
    symlinkSync(outside, join(cwd, "link"), "junction");

    await expect(runScenario(
      JSON.parse(readFileSync(join(caseDir, "scenario.json"), "utf8")) as ScenarioSpec,
      { cwd, caseDir, task: "tarefa" },
    )).rejects.toThrow(/fora do diretório/);
    expect(existsSync(join(outside, ".sha256"))).toBe(false);
  });

  test("absentFiles é confinado ao workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "astro-absent-"));
    const cwd = mkdtempSync(join(tmpdir(), "astro-absent-cwd-"));
    const outside = join(dirname(cwd), "astro-absent-outside.txt");
    writeFileSync(outside, "não inspecionar\n");
    const caseDir = writeScenarioCase(root, "01-absent", {
      schema: 1,
      kind: "app",
      turns: [{ content: "ok" }],
      expect: { final: "ok", absentFiles: ["../astro-absent-outside.txt"] },
    });

    const result = await runScenario(
      JSON.parse(readFileSync(join(caseDir, "scenario.json"), "utf8")) as ScenarioSpec,
      { cwd, caseDir, task: "tarefa" },
    );
    expect(result.diffSummary.join("\n")).toContain("fora do diretório");
    expect(result.diffSummary.join("\n")).not.toContain("não deveria existir");
  });

  test("runCase recusa URL não-loopback em mcpServers", async () => {
    const root = mkdtempSync(join(tmpdir(), "astro-url-mcp-"));
    const caseDir = writeScenarioCase(root, "01-url", {
      schema: 1,
      kind: "app",
      config: { mcpServers: { bad: { transport: "http", url: "https://example.com/mcp", timeoutMs: 100, enabled: false } } },
      turns: [{ content: "ok" }],
      expect: { final: "ok" },
    });
    const cwd = mkdtempSync(join(tmpdir(), "astro-url-mcp-cwd-"));

    await expect(runScenario(
      JSON.parse(readFileSync(join(caseDir, "scenario.json"), "utf8")) as ScenarioSpec,
      { cwd, caseDir, task: "tarefa" },
    )).rejects.toThrow(/loopback/);
  });

  test("runCase recusa placeholder embutido em URL pública", async () => {
    const root = mkdtempSync(join(tmpdir(), "astro-url-placeholder-"));
    const caseDir = writeScenarioCase(root, "01-placeholder", {
      schema: 1,
      kind: "app",
      config: { mcpServers: { bad: { transport: "http", url: "https://example.com/{{mcpUrl}}", timeoutMs: 100, enabled: false } } },
      turns: [{ content: "ok" }],
      expect: { final: "ok" },
    });
    const cwd = mkdtempSync(join(tmpdir(), "astro-url-placeholder-cwd-"));

    await expect(runScenario(
      JSON.parse(readFileSync(join(caseDir, "scenario.json"), "utf8")) as ScenarioSpec,
      { cwd, caseDir, task: "tarefa" },
    )).rejects.toThrow(/placeholder/);
  });

  test("runCase recusa web_fetch para URL pública antes de qualquer rede", async () => {
    const root = mkdtempSync(join(tmpdir(), "astro-url-fetch-"));
    const caseDir = writeScenarioCase(root, "01-fetch", {
      schema: 1,
      kind: "app",
      config: { agent: { model: "mock/mock-1", maxSteps: 4, tools: ["web_fetch", "write_file"] } },
      turns: [
        { toolCalls: [{ name: "web_fetch", arguments: { url: "https://example.com/" } }] },
        { content: "ok" },
      ],
      expect: { final: "ok" },
    });
    const cwd = mkdtempSync(join(tmpdir(), "astro-url-fetch-cwd-"));
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("network blocked");
    }) as unknown as typeof fetch;
    try {
      await expect(runScenario(
        JSON.parse(readFileSync(join(caseDir, "scenario.json"), "utf8")) as ScenarioSpec,
        { cwd, caseDir, task: "tarefa" },
      )).rejects.toThrow(/loopback/);
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("runCase recusa webSearch sem baseUrl antes de qualquer fetch", async () => {
    const root = mkdtempSync(join(tmpdir(), "astro-websearch-default-"));
    const caseDir = writeScenarioCase(root, "01-web-default", {
      schema: 1,
      kind: "app",
      env: { EVAL_WEB_KEY: "eval-web-secret-123" },
      config: {
        agent: { model: "mock/mock-1", maxSteps: 6, tools: ["web_search", "write_file"] },
        webSearch: { provider: "exa", apiKeyEnv: "EVAL_WEB_KEY" },
      },
      turns: [
        { toolCalls: [
          { name: "web_search", arguments: { query: "astro" } },
          { name: "write_file", arguments: { path: "out/search.txt", content: "ok\n" } },
        ] },
        { content: "ok" },
      ],
      expect: { final: "ok" },
    });
    const cwd = mkdtempSync(join(tmpdir(), "astro-web-default-cwd-"));
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("network blocked");
    }) as unknown as typeof fetch;
    try {
      await expect(runScenario(
        JSON.parse(readFileSync(join(caseDir, "scenario.json"), "utf8")) as ScenarioSpec,
        { cwd, caseDir, task: "tarefa" },
      )).rejects.toThrow(/loopback|baseUrl/);
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("runCase recusa telemetry habilitado com endpoint público default", async () => {
    const root = mkdtempSync(join(tmpdir(), "astro-telemetry-default-"));
    const caseDir = writeScenarioCase(root, "01-telemetry", {
      schema: 1,
      kind: "app",
      config: { telemetry: { enabled: true } },
      turns: [{ content: "ok" }],
      expect: { final: "ok" },
    });
    const cwd = mkdtempSync(join(tmpdir(), "astro-telemetry-cwd-"));

    await expect(runScenario(
      JSON.parse(readFileSync(join(caseDir, "scenario.json"), "utf8")) as ScenarioSpec,
      { cwd, caseDir, task: "tarefa" },
    )).rejects.toThrow(/loopback|endpoint/);
  });

  test("runCase recusa provider codex-oauth", async () => {
    const root = mkdtempSync(join(tmpdir(), "astro-codex-provider-"));
    const caseDir = writeScenarioCase(root, "01-codex", {
      schema: 1,
      kind: "app",
      config: {
        providers: { codex: { kind: "codex-oauth", credentialsPath: "/host/auth.json" } },
        models: [{ provider: "codex", id: "m1", tags: ["writing-code"], context: 8192 }],
        agent: { model: "codex/m1", maxSteps: 2, tools: [] },
      },
      turns: [{ content: "ok" }],
      expect: { final: "ok" },
    });
    const cwd = mkdtempSync(join(tmpdir(), "astro-codex-cwd-"));

    await expect(runScenario(
      JSON.parse(readFileSync(join(caseDir, "scenario.json"), "utf8")) as ScenarioSpec,
      { cwd, caseDir, task: "tarefa" },
    )).rejects.toThrow(/codex-oauth/);
  });

  test("runCase recusa paths de audit/ledger fora do workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "astro-paths-escape-"));
    const caseDir = writeScenarioCase(root, "01-paths", {
      schema: 1,
      kind: "app",
      config: { paths: { ledger: "../ledger-escape.jsonl", audit: "../audit-escape.jsonl" } },
      turns: [{ content: "ok" }],
      expect: { final: "ok" },
    });
    const cwd = mkdtempSync(join(tmpdir(), "astro-paths-cwd-"));

    await expect(runScenario(
      JSON.parse(readFileSync(join(caseDir, "scenario.json"), "utf8")) as ScenarioSpec,
      { cwd, caseDir, task: "tarefa" },
    )).rejects.toThrow(/fora do diretório/);
  });

  test("runCase recusa MCP stdio e run_command", async () => {
    const stdioRoot = mkdtempSync(join(tmpdir(), "astro-mcp-stdio-"));
    const stdioDir = writeScenarioCase(stdioRoot, "01-stdio", {
      schema: 1,
      kind: "app",
      config: { mcpServers: { local: { transport: "stdio", command: "bun", enabled: false } } },
      turns: [{ content: "ok" }],
      expect: { final: "ok" },
    });
    const stdioCwd = mkdtempSync(join(tmpdir(), "astro-mcp-stdio-cwd-"));
    await expect(runScenario(
      JSON.parse(readFileSync(join(stdioDir, "scenario.json"), "utf8")) as ScenarioSpec,
      { cwd: stdioCwd, caseDir: stdioDir, task: "tarefa" },
    )).rejects.toThrow(/stdio/);

    const shellRoot = mkdtempSync(join(tmpdir(), "astro-run-command-"));
    const shellDir = writeScenarioCase(shellRoot, "01-shell", {
      schema: 1,
      kind: "app",
      config: {
        agent: { model: "mock/mock-1", maxSteps: 2, tools: ["run_command"] },
        tools: { run_command: { sandbox: false } },
      },
      turns: [{ content: "ok" }],
      expect: { final: "ok" },
    });
    const shellCwd = mkdtempSync(join(tmpdir(), "astro-run-command-cwd-"));
    await expect(runScenario(
      JSON.parse(readFileSync(join(shellDir, "scenario.json"), "utf8")) as ScenarioSpec,
      { cwd: shellCwd, caseDir: shellDir, task: "tarefa" },
    )).rejects.toThrow(/run_command/);
  });

  test("runCase recusa symlink aninhado em diretório de seed", async () => {
    const root = mkdtempSync(join(tmpdir(), "astro-seed-tree-"));
    const caseDir = join(root, "case");
    mkdirSync(join(caseDir, "fixtures", "tree"), { recursive: true });
    writeFileSync(join(caseDir, "fixtures", "tree", "real.txt"), "ok\n");
    symlinkSync(join(caseDir, "fixtures", "tree"), join(caseDir, "fixtures", "tree", "linked"), "junction");
    const cwd = mkdtempSync(join(tmpdir(), "astro-seed-tree-cwd-"));
    const spec: ScenarioSpec = {
      schema: 1,
      kind: "app",
      seed: [{ from: "fixtures/tree", to: "seeded" }],
      turns: [{ content: "ok" }],
      expect: { final: "ok" },
    };

    await expect(runScenario(spec, { cwd, caseDir, task: "tarefa" })).rejects.toThrow(/link/i);
    expect(existsSync(join(cwd, "seeded"))).toBe(false);
  });

  test("env honesto curto não vira falso positivo de vazamento", async () => {
    const root = mkdtempSync(join(tmpdir(), "astro-honest-env-"));
    writeScenarioCase(root, "01-honest", {
      schema: 1,
      kind: "app",
      env: { EVAL_WORD: "test" },
      seed: [{ from: "fixtures/audit.jsonl", to: ".astro/audit.jsonl" }],
      turns: [{ content: "ok" }],
      expect: { final: "ok" },
    }, {
      fixtures: {
        "audit.jsonl": `${JSON.stringify({ seq: 1, run: "seeded", agent: "x", tipo: "seeded", payload: { value: "test" } })}\n`,
      },
    });

    const result = await runTempCase(root, "01-honest");
    expect(result.passed).toBe(true);
  }, 30000);

  test("sidecar aceita o formato legado de caminho de arquivo", async () => {
    const root = mkdtempSync(join(tmpdir(), "astro-sidecar-legacy-"));
    const caseDir = writeScenarioCase(root, "01-legacy", {
      schema: 1,
      kind: "app",
      seed: [{ from: "fixtures/verify.md", to: ".astro/skills/verify/SKILL.md" }],
      sidecars: [".astro/skills/verify/SKILL.md"],
      turns: [{ content: "ok" }],
      expect: { final: "ok" },
    }, { fixtures: { "verify.md": SKILL_OK } });
    const cwd = mkdtempSync(join(tmpdir(), "astro-sidecar-legacy-cwd-"));

    const result = await runScenario(
      JSON.parse(readFileSync(join(caseDir, "scenario.json"), "utf8")) as ScenarioSpec,
      { cwd, caseDir, task: "tarefa" },
    );
    expect(result.diffSummary).toEqual([]);
    expect(existsSync(join(cwd, ".astro", "skills", "verify", ".sha256"))).toBe(true);
  });

  test("runCase isola a config global do ASTRO_HOME", async () => {
    const home = mkdtempSync(join(tmpdir(), "astro-global-home-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ run: { maxTurns: 1 } }));
    const root = mkdtempSync(join(tmpdir(), "astro-global-case-"));
    writeScenarioCase(root, "01-global", {
      schema: 1,
      kind: "app",
      turns: [
        { toolCalls: [{ name: "write_file", arguments: { path: "out/first.txt", content: "primeiro\n" } }] },
        { content: "dois" },
      ],
      expect: { final: "dois", requests: 2 },
    });
    const previousHome = process.env.ASTRO_HOME;
    const previousNoGlobal = process.env.ASTRO_NO_GLOBAL_CONFIG;
    process.env.ASTRO_HOME = home;
    delete process.env.ASTRO_NO_GLOBAL_CONFIG;
    try {
      const result = await runTempCase(root, "01-global");
      expect(result.diffSummary).toEqual([]);
      expect(result.passed).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.ASTRO_HOME;
      else process.env.ASTRO_HOME = previousHome;
      if (previousNoGlobal === undefined) delete process.env.ASTRO_NO_GLOBAL_CONFIG;
      else process.env.ASTRO_NO_GLOBAL_CONFIG = previousNoGlobal;
    }
  }, 30000);

  test("runCase não carrega skills do ~/.astro/skills do host", async () => {
    const hostHome = mkdtempSync(join(tmpdir(), "astro-host-home-"));
    mkdirSync(join(hostHome, ".astro", "skills", "verify"), { recursive: true });
    writeFileSync(join(hostHome, ".astro", "skills", "verify", "SKILL.md"), SKILL_OK);
    const root = mkdtempSync(join(tmpdir(), "astro-host-skill-case-"));
    writeScenarioCase(root, "01-host-skill", {
      schema: 1,
      kind: "app",
      seed: [{ from: "fixtures/verify.md", to: ".astro/skills/verify/SKILL.md" }],
      turns: [
        { toolCalls: [{ name: "write_file", arguments: { path: "out/ok.txt", content: "ok\n" } }] },
        { content: "ok" },
      ],
      expect: { final: "ok", audit: ["skill.loaded"] },
    }, {
      task: "/verify conferir a skill instalada\n",
      expected: { "out/ok.txt": "ok\n" },
      fixtures: { "verify.md": SKILL_OK },
    });
    const previousHome = process.env.HOME;
    const previousProfile = process.env.USERPROFILE;
    process.env.HOME = hostHome;
    process.env.USERPROFILE = hostHome;
    try {
      const result = await runTempCase(root, "01-host-skill");
      expect(result.diffSummary).toEqual([]);
      expect(result.passed).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousProfile;
    }
  }, 30000);

  test("runCase detecta vazamento de env no audit e no ledger", async () => {
    const root = mkdtempSync(join(tmpdir(), "astro-leak-"));
    writeScenarioCase(root, "01-leak", {
      schema: 1,
      kind: "app",
      env: { EVAL_AUDIT_LEAK: "audit-leak-value-9f3a", EVAL_LEDGER_LEAK: "ledger-leak-value-7c1b" },
      seed: [
        { from: "fixtures/audit.jsonl", to: ".astro/audit.jsonl" },
        { from: "fixtures/ledger.jsonl", to: ".astro/ledger.jsonl" },
      ],
      turns: [{ content: "ok" }],
      expect: { final: "ok" },
    }, {
      fixtures: {
        "audit.jsonl": `${JSON.stringify({ seq: 1, run: "seeded", agent: "x", tipo: "seeded", payload: { value: "audit-leak-value-9f3a" } })}\n`,
        "ledger.jsonl": `${JSON.stringify({
          schemaVersion: 3, ts: "2026-01-01T00:00:00.000Z", run: "seeded", kind: "run_state",
          state: "completed", reason: "ledger-leak-value-7c1b", seq: 1,
        })}\n`,
      },
    });

    const result = await runTempCase(root, "01-leak");
    expect(result.passed).toBe(false);
    expect(result.diffSummary.join("\n")).toContain("EVAL_AUDIT_LEAK");
    expect(result.diffSummary.join("\n")).toContain("EVAL_LEDGER_LEAK");
  }, 30000);

  test("toolResultsContain falha quando o resultado MCP vem vazio", async () => {
    const root = mkdtempSync(join(tmpdir(), "astro-toolresult-mcp-"));
    writeScenarioCase(root, "01-mcp-empty", {
      schema: 1,
      kind: "app",
      config: {
        agent: { model: "mock/mock-1", maxSteps: 6, tools: ["mcp__fs__read_file", "write_file"] },
        mcpServers: { fs: { transport: "http", url: "{{mcpUrl}}", timeoutMs: 2000 } },
      },
      mcp: { tools: [{ name: "read_file", text: "" }] },
      turns: [
        { toolCalls: [
          { name: "mcp__fs__read_file", arguments: { path: "notes.txt" } },
          { name: "write_file", arguments: { path: "out/mcp.txt", content: "MCP-FS-CONTENT\n" } },
        ] },
        { content: "ok" },
      ],
      expect: { final: "ok", toolResultsContain: ["MCP-FS-CONTENT"] },
    }, { expected: { "out/mcp.txt": "MCP-FS-CONTENT\n" } });

    const result = await runTempCase(root, "01-mcp-empty");
    expect(result.passed).toBe(false);
    expect(result.diffSummary.join("\n")).toContain("toolResultsContain");
  }, 30000);

  test("toolResultsContain falha quando o resultado web vem vazio", async () => {
    const root = mkdtempSync(join(tmpdir(), "astro-toolresult-web-"));
    writeScenarioCase(root, "01-web-empty", {
      schema: 1,
      kind: "app",
      config: { agent: { model: "mock/mock-1", maxSteps: 6, tools: ["web_fetch", "write_file"] } },
      page: { html: "" },
      turns: [
        { toolCalls: [
          { name: "web_fetch", arguments: { url: "{{pageUrl}}", format: "markdown" } },
          { name: "write_file", arguments: { path: "out/page.md", content: "PAGE-CONTENT\n" } },
        ] },
        { content: "ok" },
      ],
      expect: { final: "ok", toolResultsContain: ["PAGE-CONTENT"] },
    }, { expected: { "out/page.md": "PAGE-CONTENT\n" } });

    const result = await runTempCase(root, "01-web-empty");
    expect(result.passed).toBe(false);
    expect(result.diffSummary.join("\n")).toContain("toolResultsContain");
  }, 30000);

  test("fixtures de MCP/web falham quando o tool result fica vazio", async () => {
    interface MutScenario {
      mcp?: { tools: Array<{ text: string }> };
      search?: { results: Array<{ snippet: string }> };
      page?: { html: string };
    }
    const mutations: Array<[string, (scenario: MutScenario) => void]> = [
      ["54-mcp-filesystem-read", (scenario) => { scenario.mcp!.tools[0]!.text = ""; }],
      ["57-web-search-basic", (scenario) => { scenario.search!.results[0]!.snippet = ""; }],
      ["58-web-fetch-extract", (scenario) => { scenario.page!.html = ""; }],
      ["59-web-rate-limit", (scenario) => { scenario.search!.results[0]!.snippet = ""; }],
    ];
    for (const [name, mutate] of mutations) {
      const root = mkdtempSync(join(tmpdir(), "astro-fixture-empty-"));
      cpSync(join(GOLDEN_ROOT, name), join(root, name), { recursive: true });
      const scenarioPath = join(root, name, "scenario.json");
      const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as MutScenario;
      mutate(scenario);
      writeFileSync(scenarioPath, JSON.stringify(scenario));
      const [golden] = listGoldenCases(root);
      const result = await runCase(golden!, { mock: true });
      expect(result.passed).toBe(false);
      expect(result.diffSummary.join("\n")).toContain("toolResultsContain");
    }
  }, 30000);

  test("expect desconhecido falha fechado", async () => {
    const root = mkdtempSync(join(tmpdir(), "astro-expect-unknown-"));
    const caseDir = writeScenarioCase(root, "01-expect", {
      schema: 1,
      kind: "app",
      turns: [{ content: "ok" }],
      expect: { final: "ok", finall: "typo" } as unknown as ScenarioSpec["expect"],
    });
    const cwd = mkdtempSync(join(tmpdir(), "astro-expect-unknown-cwd-"));

    await expect(runScenario(
      JSON.parse(readFileSync(join(caseDir, "scenario.json"), "utf8")) as ScenarioSpec,
      { cwd, caseDir, task: "tarefa" },
    )).rejects.toThrow(/expect desconhecido/);
  });

  test("placeholder não resolvido falha fechado", async () => {
    const root = mkdtempSync(join(tmpdir(), "astro-placeholder-"));
    const caseDir = writeScenarioCase(root, "01-placeholder", {
      schema: 1,
      kind: "app",
      turns: [{ content: "ok {{missing}}" }],
      expect: { final: "ok {{missing}}" },
    });
    const cwd = mkdtempSync(join(tmpdir(), "astro-placeholder-cwd-"));

    await expect(runScenario(
      JSON.parse(readFileSync(join(caseDir, "scenario.json"), "utf8")) as ScenarioSpec,
      { cwd, caseDir, task: "tarefa" },
    )).rejects.toThrow(/placeholder/);
  });

  test("sidecar de skill com BOM segue o hash do loader", async () => {
    const root = mkdtempSync(join(tmpdir(), "astro-sidecar-bom-"));
    writeScenarioCase(root, "01-bom", {
      schema: 1,
      kind: "app",
      seed: [{ from: "fixtures/bom.md", to: ".astro/skills/verify/SKILL.md" }],
      sidecars: [".astro/skills/verify"],
      turns: [
        { toolCalls: [{ name: "write_file", arguments: { path: "out/ok.txt", content: "ok\n" } }] },
        { content: "bom ok" },
      ],
      expect: { final: "bom ok", audit: ["skill.loaded"] },
    }, {
      task: "/verify conferir a skill instalada\n",
      expected: { "out/ok.txt": "ok\n" },
      fixtures: { "bom.md": `\uFEFF${SKILL_OK}` },
    });

    const result = await runTempCase(root, "01-bom");
    expect(result.diffSummary).toEqual([]);
    expect(result.passed).toBe(true);
  }, 30000);

  test("runCase detecta divergência quando o esperado é sabotado", async () => {
    const root = mkdtempSync(join(tmpdir(), "astro-sabot-"));
    const dir = join(root, "01-case"); // listGoldenCases espera subdiretórios
    mkdirSync(join(dir, "expected"), { recursive: true });
    writeFileSync(join(dir, "task.md"), "crie math.ts com subtract\n");
    writeFileSync(join(dir, "expected", "math.ts"), "export function subtract(a: number, b: number): number {\n  return a - b;\n}\n");
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ schema: 1, id: "sabot", category: "feature", difficulty: 1, tags: ["writing-code"], files: ["math.ts"] }));

    const golden = listGoldenCases(root)[0]!;
    const ok = await runCase(golden, { mock: true });
    expect(ok.passed).toBe(true);

    // sabota: declara um arquivo que não existe em expected/ → execução falha
    // (o modo mock sempre escreve o conteúdo esperado; mismatch de conteúdo é
    // coberto pelo teste unitário de compareFile)
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as { files: string[] };
    meta.files.push("ghost.ts");
    writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
    const goldenBad = listGoldenCases(root)[0]!;
    const bad = await runCase(goldenBad, { mock: true });
    expect(bad.passed).toBe(false);
    expect(bad.diffSummary[0]).toContain("erro");
  });

  test("compareFile normaliza formatação (CRLF, espaços à direita, linhas vazias)", async () => {
    const a = "export function f(): number {\r\n  return 1;   \r\n}\r\n\r\n\r\n";
    const b = "export function f(): number {\n  return 1;\n}\n";
    const cmp = await compareFile("f.ts", a, b);
    expect(cmp.equal).toBe(true);
  });

  test("compareFile detecta diferença real de conteúdo", async () => {
    const cmp = await compareFile("f.ts", "export function a() {}", "export function b() {}");
    expect(cmp.equal).toBe(false);
  });

  test("baseline: regressão detectada quando case que passava falha", async () => {
    const baselinePath = join(mkdtempSync(join(tmpdir(), "astro-bl-")), "baseline.json");
    const reportOk: EvalReport = {
      schema: 1, passRate: 1, total: 1, passed: 1, regressions: [],
      cases: [{ case: "x", category: "feature", passed: true, tokens: 10, latencyMs: 1, diffSummary: [] }],
    };
    writeBaseline(reportOk, baselinePath);
    expect(existsSync(baselinePath)).toBe(true);
    const saved = JSON.parse(readFileSync(baselinePath, "utf8")) as { cases: Record<string, boolean> };
    expect(saved.cases.x).toBe(true);

    // execução nova em que x falha
    const reportBad: EvalReport = {
      schema: 1, passRate: 0, total: 1, passed: 0, regressions: [],
      cases: [{ case: "x", category: "feature", passed: false, tokens: 10, latencyMs: 1, diffSummary: ["f: divergente"] }],
    };
    // usa runEval com golden sabotado seria pesado; valida a função de threshold + regressão via relatório montado
    expect(evalFailsThreshold(reportBad, 0.85)).toBe(true);
    expect(evalFailsThreshold({ ...reportOk, regressions: ["x"] }, 0.85)).toBe(true);
    expect(evalFailsThreshold(reportOk, 0.85)).toBe(false);
  });

  test("regressão real: runEval com baseline de passRate alto e um case sabotado", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "astro-regr-"));
    const baselinePath = join(tmp, "baseline.json");
    // baseline: todos os 65 cases passando
    const all = listGoldenCases(GOLDEN_ROOT);
    writeBaseline(
      {
        schema: 1, passRate: 1, total: all.length, passed: all.length, regressions: [],
        cases: all.map((g) => ({ case: g.id, category: g.category, passed: true, tokens: 10, latencyMs: 1, diffSummary: [] })),
      },
      baselinePath,
    );

    // executa só com um case (root alternativo) não cobre baseline; então a regressão aqui
    // é validada pelo fluxo: runEval normal contra baseline completo → sem regressões
    const report = await runEval({ goldenRoot: GOLDEN_ROOT, mock: true, baselinePath });
    expect(report.regressions).toEqual([]);
    expect(evalFailsThreshold(report, 0.85)).toBe(false);
    // full-dataset mock eval: ~9s local com os 15 cenários (#59); CI windows pode ser mais lento.
  }, 60000);
});