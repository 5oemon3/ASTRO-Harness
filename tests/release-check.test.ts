import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  EXPECTED_PACKAGE,
  buildSummary,
  cleanupOnSignal,
  createPlan,
  executePlan,
  installedAstroBin,
  parseArgs,
  prepareTempDir,
  removeTempDir,
  resolveStepBinary,
  runPlannedStep,
  stepEnv,
  tailForFailure,
  tarballFileName,
  tempDirPrefix,
  verifyInstalledPackage,
  type StepResult,
} from "../scripts/release-check";

const root = resolve(import.meta.dir, "..");
const tempRoot = join(root, ".tmp-release-check");
const tempDir = join(tempRoot, `${tempDirPrefix("@umtioai/astro-harness")}abc123`);
const base = {
  root,
  tempRoot,
  tempDir,
  packageName: "@umtioai/astro-harness",
  version: "0.1.0-alpha.3",
};

test("tarball npm usa o nome sanitizado do pacote", () => {
  expect(tarballFileName("@umtioai/astro-harness", "0.1.0-alpha.3")).toBe(
    "umtioai-astro-harness-0.1.0-alpha.3.tgz",
  );
  expect(tarballFileName("astro-harness", "1.0.0")).toBe("astro-harness-1.0.0.tgz");
  expect(tempDirPrefix("@umtioai/astro-harness")).toBe(
    "astro-release-check-umtioai-astro-harness-",
  );
}, 5000);

test("PEM que cruza a janela de corte ainda é redigido", () => {
  const body = "SENTINEL-PEM-BODY".repeat(1200);
  const begin = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
  const end = ["-----END ", "PRIVATE KEY-----"].join("");
  const output = `${"x".repeat(20_000)}${begin}\n${body}\n${end}`;

  const tail = tailForFailure(output);

  expect(tail).toContain("[REDACTED]");
  expect(tail).not.toContain("SENTINEL-PEM-BODY");
}, 5000);

test("plano padrão roda qualidade, build, smoke, pack, instalação, identidade e help", () => {
  const plan = createPlan(base);

  expect(plan.steps.map((step) => step.id)).toEqual([
    "typecheck",
    "test",
    "build",
    "smoke",
    "pack",
    "install",
    "identity",
    "help",
  ]);
  expect(plan.steps.map((step) => step.display)).toEqual([
    "bun run typecheck",
    "bun test",
    "bun run build",
    "bun run smoke",
    `npm pack --pack-destination ${plan.tempDir}`,
    `npm install --no-save --no-audit --no-fund ${plan.tarball}`,
    `verificar identidade de ${EXPECTED_PACKAGE}`,
    `${installedAstroBin(plan.tempDir)} --help`,
  ]);
  expect(plan.tarball).toBe(
    join(plan.tempDir, "umtioai-astro-harness-0.1.0-alpha.3.tgz"),
  );
  expect(plan.steps.find((step) => step.id === "install")?.cwd).toBe(plan.tempDir);
  expect(plan.steps.find((step) => step.id === "identity")?.cwd).toBe(plan.tempDir);
  expect(plan.steps.find((step) => step.id === "help")?.cwd).toBe(plan.tempDir);
  expect(plan.steps.find((step) => step.id === "help")?.bin).toBe(installedAstroBin(plan.tempDir));
  expect(plan.steps.some((step) => /publish/.test(`${step.bin} ${step.args.join(" ")}`))).toBe(false);
}, 5000);

test("--skip-tests remove typecheck e bun test do plano", () => {
  const plan = createPlan({ ...base, skipTests: true });

  expect(plan.skipTests).toBe(true);
  expect(plan.steps.map((step) => step.id)).toEqual([
    "build",
    "smoke",
    "pack",
    "install",
    "identity",
    "help",
  ]);
}, 5000);

test("createPlan recusa tempDir fora da raiz e irmão com prefixo", () => {
  expect(() => createPlan({ ...base, tempDir: join(root, "..", "victim") })).toThrow("fora da raiz");
  expect(() => createPlan({ ...base, tempDir: join(root, "astro-release-check-sibling") })).toThrow(
    "fora da raiz",
  );
}, 5000);

test("pack, install e help usam ambiente sanitizado; bun e identidade herdam", () => {
  const plan = createPlan(base);

  expect(plan.steps.filter((step) => step.envMode === "sanitized").map((step) => step.id)).toEqual([
    "pack",
    "install",
    "help",
  ]);
  expect(plan.steps.filter((step) => step.envMode === "inherit").map((step) => step.id)).toEqual([
    "typecheck",
    "test",
    "build",
    "smoke",
    "identity",
  ]);
}, 5000);

test("ambiente das etapas npm não leva token nem chave de provider", () => {
  const env = stepEnv({
    Path: "C:\\Windows\\System32",
    PATH: "/usr/bin",
    HOME: "/home/dev",
    USERPROFILE: "C:\\Users\\dev",
    APPDATA: "C:\\Users\\dev\\AppData\\Roaming",
    SYSTEMROOT: "C:\\Windows",
    TEMP: "C:\\Temp",
    NPM_TOKEN: "sentinel-npm-token",
    NODE_AUTH_TOKEN: "sentinel-node-token",
    OPENAI_API_KEY: "sentinel-provider-key",
    ASTRO_HOME: "/home/dev/.astro",
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_cache: "C:\\npm-cache",
    npm_config__authToken: "sentinel-npm-auth",
    UNRELATED: "drop",
  });

  expect(env.Path).toBe("C:\\Windows\\System32");
  expect(env.PATH).toBe("/usr/bin");
  expect(env.HOME).toBe("/home/dev");
  expect(env.USERPROFILE).toBe("C:\\Users\\dev");
  expect(env.APPDATA).toBe("C:\\Users\\dev\\AppData\\Roaming");
  expect(env.SYSTEMROOT).toBe("C:\\Windows");
  expect(env.TEMP).toBe("C:\\Temp");
  expect(env.npm_config_registry).toBe("https://registry.npmjs.org/");
  expect(env.npm_config_cache).toBe("C:\\npm-cache");
  expect(env.NPM_TOKEN).toBeUndefined();
  expect(env.NODE_AUTH_TOKEN).toBeUndefined();
  expect(env.OPENAI_API_KEY).toBeUndefined();
  expect(env.npm_config__authToken).toBeUndefined();
  expect(env.ASTRO_HOME).toBeUndefined();
  expect(env.UNRELATED).toBeUndefined();
}, 5000);

test("help usa o binário local e falha sem ele mesmo com astro global no PATH", () => {
  const plan = createPlan(base);
  const help = plan.steps.find((step) => step.id === "help")!;
  const fakeGlobal = process.platform === "win32" ? "C:\\fake\\astro.cmd" : "/fake/astro";

  expect(help.bin).toBe(installedAstroBin(base.tempDir));
  expect(resolveStepBinary(help, { exists: () => false, which: () => fakeGlobal })).toBeNull();

  const outcome = runPlannedStep(help, { exists: () => false, which: () => fakeGlobal });
  expect(outcome.exitCode).toBeNull();
  expect(outcome.error).toContain("não encontrado");
}, 5000);

test("identidade instalada precisa ser @umtioai/astro-harness", () => {
  const temp = mkdtempSync(join(tmpdir(), "astro-release-identity-"));
  const pkgDir = join(temp, "node_modules", "@umtioai", "astro-harness");
  const manifest = join(pkgDir, "package.json");
  mkdirSync(pkgDir, { recursive: true });

  try {
    writeFileSync(manifest, JSON.stringify({ name: EXPECTED_PACKAGE }));
    expect(() => verifyInstalledPackage(temp, EXPECTED_PACKAGE)).not.toThrow();

    writeFileSync(manifest, JSON.stringify({ name: "@umtioaii/astro-harness" }));
    expect(() => verifyInstalledPackage(temp, "@umtioai/astro-harness")).toThrow("identidade");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}, 5000);

test("CLI redige argumento desconhecido e sai 2", () => {
  const fakeKey = `${["s", "k", "-"].join("")}sentinel-release-check-key`;
  const proc = Bun.spawnSync({
    cmd: [process.execPath, join(root, "scripts", "release-check.ts"), `--api-key=${fakeKey}`],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = proc.stderr.toString();

  expect(proc.exitCode).toBe(2);
  expect(stderr).toContain("--api-key=[REDACTED]");
  expect(stderr).not.toContain(fakeKey);
}, 5000);

test("argumentos desconhecidos falham em vez de ignorar", () => {
  expect(parseArgs([])).toEqual({ skipTests: false, json: false, help: false });
  expect(parseArgs(["--skip-tests", "--json"])).toEqual({
    skipTests: true,
    json: true,
    help: false,
  });
  expect(parseArgs(["--help"])).toEqual({ skipTests: false, json: false, help: true });
  expect(() => parseArgs(["--publish"])).toThrow("--publish");
}, 5000);

test("resumo JSON tem forma estável e não carrega saída dos comandos", () => {
  const plan = createPlan(base);
  const results: StepResult[] = [
    { id: "typecheck", status: "passed", exitCode: 0 },
    { id: "test", status: "failed", exitCode: 1 },
    ...plan.steps.slice(2).map((step) => ({ id: step.id, status: "skipped" as const, exitCode: null })),
  ];
  const summary = buildSummary(plan, results, { step: "test", message: "bun test saiu com código 1" });

  expect(Object.keys(summary)).toEqual([
    "ok",
    "packageName",
    "version",
    "skippedTests",
    "tempDir",
    "tarball",
    "steps",
    "failure",
  ]);
  expect(summary.ok).toBe(false);
  expect(summary.steps[1]?.status).toBe("failed");
  expect(summary.steps[2]?.status).toBe("skipped");
  expect(summary.failure?.step).toBe("test");
  expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
}, 5000);

test("falha fecha o gate, marca o resto como skipped e sempre limpa o temporário", () => {
  const plan = createPlan({ ...base, skipTests: true });
  const calls: string[] = [];
  let removed = "";

  const summary = executePlan(plan, {
    spawn: (step) => {
      calls.push(step.id);
      return step.id === "smoke"
        ? { exitCode: 1, output: "SENTINEL-NAO-PODE-VAZAR" }
        : { exitCode: 0, output: "" };
    },
    removeTemp: (dir) => {
      removed = dir;
    },
    log: () => {},
  });

  expect(calls).toEqual(["build", "smoke"]);
  expect(summary.ok).toBe(false);
  expect(summary.failure?.step).toBe("smoke");
  expect(summary.steps.map((step) => step.status)).toEqual([
    "passed",
    "failed",
    "skipped",
    "skipped",
    "skipped",
    "skipped",
  ]);
  expect(removed).toBe(plan.tempDir);
  expect(JSON.stringify(summary)).not.toContain("SENTINEL-NAO-PODE-VAZAR");
}, 5000);

test("sucesso também limpa o temporário", () => {
  const plan = createPlan({ ...base, skipTests: true });
  let removed = "";

  const summary = executePlan(plan, {
    spawn: () => ({ exitCode: 0, output: "" }),
    removeTemp: (dir) => {
      removed = dir;
    },
    log: () => {},
  });

  expect(summary.ok).toBe(true);
  expect(summary.steps.map((step) => step.status)).toEqual([
    "passed",
    "passed",
    "passed",
    "passed",
    "passed",
    "passed",
  ]);
  expect(removed).toBe(plan.tempDir);
}, 5000);

test("falha na limpeza também fecha o gate", () => {
  const plan = createPlan({ ...base, skipTests: true });
  const summary = executePlan(plan, {
    spawn: () => ({ exitCode: 0, output: "" }),
    removeTemp: () => {
      throw new Error("sem permissão");
    },
    log: () => {},
  });

  expect(summary.ok).toBe(false);
  expect(summary.failure?.step).toBe("cleanup");
  expect(summary.failure?.message).toContain("sem permissão");
}, 5000);

test("limpeza recusa `..` e irmão com prefixo sem apagar os alvos", () => {
  const parent = mkdtempSync(join(tmpdir(), "astro-release-guard-"));
  const tempRoot = join(parent, "root");
  const victim = join(parent, "victim");
  const sibling = join(parent, `${tempDirPrefix("@umtioai/astro-harness")}sibling`);
  mkdirSync(tempRoot);
  mkdirSync(victim);
  mkdirSync(sibling);

  try {
    expect(() => removeTempDir(tempRoot, join(tempRoot, "..", "victim"))).toThrow("recusando");
    expect(() => removeTempDir(tempRoot, sibling)).toThrow("recusando");
    expect(existsSync(victim)).toBe(true);
    expect(existsSync(sibling)).toBe(true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}, 5000);

test("limpeza recusa junction/symlink que aponta para fora", () => {
  const parent = mkdtempSync(join(tmpdir(), "astro-release-guard-"));
  const tempRoot = join(parent, "root");
  const victim = join(parent, "victim");
  mkdirSync(tempRoot);
  mkdirSync(victim);
  const link = join(tempRoot, `${tempDirPrefix("@umtioai/astro-harness")}link`);

  try {
    try {
      symlinkSync(victim, link, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return; // Ambiente sem permissão para criar link; coberto pelo caso lexical.
    }

    expect(() => removeTempDir(tempRoot, link)).toThrow("recusando");
    expect(existsSync(victim)).toBe(true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}, 5000);

test("prepareTempDir limpa o diretório se escrever o manifesto falhar", () => {
  const parent = mkdtempSync(join(tmpdir(), "astro-release-prepare-"));

  try {
    expect(() => prepareTempDir(parent, "@umtioai/astro-harness", () => {
      throw new Error("sem espaço");
    })).toThrow("sem espaço");
    expect(readdirSync(parent)).toEqual([]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}, 5000);

test("SIGINT e SIGTERM limpam o temporário antes de sair", () => {
  const rootDir = join(tempRoot, "signals");
  const target = join(rootDir, "astro-release-check-signal");
  let removed = "";
  let code = 0;

  cleanupOnSignal(rootDir, target, "SIGINT", {
    remove: (_root, dir) => {
      removed = dir;
    },
    exit: (value) => {
      code = value;
    },
  });
  expect(removed).toBe(target);
  expect(code).toBe(130);

  cleanupOnSignal(rootDir, target, "SIGTERM", {
    remove: (_root, dir) => {
      removed = dir;
    },
    exit: (value) => {
      code = value;
    },
  });
  expect(code).toBe(143);
}, 5000);
