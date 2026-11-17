/**
 * Gate local de release: roda qualidade opcional (typecheck + bun test), build,
 * smoke, `npm pack`, instala o tarball em um diretório temporário limpo e valida
 * o binário instalado com `--help`. O pacote sob teste é local, mas as
 * dependências de runtime (`ink`, `react`, `bun`) ainda são resolvidas pelo
 * registry. Nunca publica, nunca imprime saída sem redigir segredos e falha
 * fechado em qualquer erro, inclusive na limpeza.
 *
 * Uso: bun scripts/release-check.ts [--skip-tests] [--json]
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { redactSecrets } from "../src/sanitize-external";
import { sanitizedEnv } from "../src/tools/run-command";

export const EXPECTED_PACKAGE = "@umtioai/astro-harness";

export type StepId =
  | "typecheck"
  | "test"
  | "build"
  | "smoke"
  | "pack"
  | "install"
  | "identity"
  | "help";
export type StepStatus = "passed" | "failed" | "skipped";

export interface PlannedStep {
  id: StepId;
  label: string;
  /** Executável lógico; resolvido com `Bun.which` na execução. */
  bin: string;
  args: string[];
  cwd: string;
  /** `sanitized` remove segredos do ambiente antes de rodar npm/npx. */
  envMode: "inherit" | "sanitized";
  /** Linha exibida ao usuário; nunca contém segredo. */
  display: string;
}

export interface ReleasePlan {
  root: string;
  tempRoot: string;
  tempDir: string;
  tarball: string;
  packageName: string;
  version: string;
  skipTests: boolean;
  steps: PlannedStep[];
}

export interface StepResult {
  id: StepId;
  status: StepStatus;
  exitCode: number | null;
}

export interface Failure {
  step: StepId | "setup" | "cleanup";
  message: string;
}

export interface ReleaseSummary {
  ok: boolean;
  packageName: string;
  version: string;
  skippedTests: boolean;
  tempDir: string;
  tarball: string;
  steps: Array<{ id: StepId; command: string; status: StepStatus; exitCode: number | null }>;
  failure: Failure | null;
}

export interface CliOptions {
  skipTests: boolean;
  json: boolean;
  help: boolean;
}

export interface PackageMeta {
  name: string;
  version: string;
}

export interface PlanInput {
  root: string;
  tempRoot: string;
  tempDir: string;
  packageName: string;
  version: string;
  skipTests?: boolean;
}

export interface StepOutcome {
  exitCode: number | null;
  output?: string;
  error?: string;
}

export interface ExecuteOptions {
  spawn?: (step: PlannedStep) => StepOutcome;
  removeTemp?: (dir: string) => void;
  log?: (line: string) => void;
}

const TEMP_PREFIX = "astro-release-check-";
const STEP_TIMEOUT_MS = 15 * 60_000;
const MAX_OUTPUT_CHARS = 8_000;

const USAGE = `Uso: bun scripts/release-check.ts [--skip-tests] [--json]

Gate local de release. Não publica nada.
O pacote sob teste é local; dependências de runtime vêm do registry.
  --skip-tests  pula typecheck e bun test; build, smoke, pack e instalação continuam
  --json        imprime só o resumo JSON ao final
  --help        mostra esta ajuda

Passos manuais fora do gate (TUI e provider não são automatizáveis headless):
  1. npm install -g @umtioai/astro-harness@alpha
  2. astro tui`;

/** Nome de arquivo que o `npm pack` gera para nome+versão do pacote. */
export function packageSlug(name: string): string {
  const slug = name
    .replace(/^@/, "")
    .replace(/[\\/]+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  if (slug === "") throw new Error("nome de pacote inválido para o tarball");
  return slug;
}

export function tarballFileName(name: string, version: string): string {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version) || version.includes("..")) {
    throw new Error("versão de pacote inválida para o tarball");
  }
  return `${packageSlug(name)}-${version}.tgz`;
}

export function tempDirPrefix(name: string): string {
  return `${TEMP_PREFIX}${packageSlug(name)}-`;
}

/** Binário criado pelo npm dentro do pacote instalado (nunca um `astro` global). */
export function installedAstroBin(
  tempDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return join(tempDir, "node_modules", ".bin", platform === "win32" ? "astro.cmd" : "astro");
}

const BASE_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP",
  "COMSPEC",
  "PATHEXT",
]);

const NPM_CONFIG_ALLOW = new Set([
  "NPM_CONFIG_REGISTRY",
  "NPM_CONFIG_CACHE",
  "NPM_CONFIG_USERCONFIG",
  "NPM_CONFIG_GLOBALCONFIG",
  "NPM_CONFIG_PREFIX",
  "NPM_CONFIG_PROXY",
  "NPM_CONFIG_HTTPS_PROXY",
  "NPM_CONFIG_NOPROXY",
  "NPM_CONFIG_STRICT_SSL",
  "NPM_CONFIG_CAFILE",
  "NPM_CONFIG_FETCH_RETRIES",
  "NPM_CONFIG_FETCH_TIMEOUT",
  "NPM_CONFIG_LOGLEVEL",
  "NPM_CONFIG_PREFER_OFFLINE",
  "NPM_CONFIG_OFFLINE",
  "NPM_CONFIG_AUDIT",
  "NPM_CONFIG_FUND",
  "NPM_CONFIG_YES",
  "NPM_CONFIG_SCRIPT_SHELL",
]);

/**
 * Ambiente das etapas npm/npx: preserva PATH/HOME/APPDATA/etc. e apenas
 * `npm_config_*` não secreto. Tokens de npm e chaves de provider não passam
 * para os lifecycle scripts do `npm install` (I-03).
 */
export function stepEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(sanitizedEnv(source))) {
    const upper = name.toUpperCase();
    if (BASE_ENV_KEYS.has(upper) || NPM_CONFIG_ALLOW.has(upper)) env[name] = value;
  }
  return env;
}

export function quoteDisplay(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function createPlan(input: PlanInput): ReleasePlan {
  if (!isInside(input.tempRoot, input.tempDir)) {
    throw new Error(`diretório temporário fora da raiz permitida: ${input.tempDir}`);
  }
  if (!basename(input.tempDir).startsWith(TEMP_PREFIX)) {
    throw new Error(`diretório temporário sem o prefixo ${TEMP_PREFIX}: ${input.tempDir}`);
  }

  const tarball = join(input.tempDir, tarballFileName(input.packageName, input.version));
  const steps: PlannedStep[] = [];

  if (input.skipTests !== true) {
    steps.push({
      id: "typecheck",
      label: "typecheck",
      bin: "bun",
      args: ["run", "typecheck"],
      cwd: input.root,
      envMode: "inherit",
      display: "bun run typecheck",
    });
    steps.push({
      id: "test",
      label: "testes",
      bin: "bun",
      args: ["test"],
      cwd: input.root,
      envMode: "inherit",
      display: "bun test",
    });
  }

  steps.push({
    id: "build",
    label: "build",
    bin: "bun",
    args: ["run", "build"],
    cwd: input.root,
    envMode: "inherit",
    display: "bun run build",
  });
  steps.push({
    id: "smoke",
    label: "smoke",
    bin: "bun",
    args: ["run", "smoke"],
    cwd: input.root,
    envMode: "inherit",
    display: "bun run smoke",
  });
  steps.push({
    id: "pack",
    label: "empacotar",
    bin: "npm",
    args: ["pack", "--pack-destination", input.tempDir],
    cwd: input.root,
    envMode: "sanitized",
    display: `npm pack --pack-destination ${quoteDisplay(input.tempDir)}`,
  });
  steps.push({
    id: "install",
    label: "instalar tarball em diretório limpo",
    bin: "npm",
    args: ["install", "--no-save", "--no-audit", "--no-fund", tarball],
    cwd: input.tempDir,
    envMode: "sanitized",
    display: `npm install --no-save --no-audit --no-fund ${quoteDisplay(tarball)}`,
  });
  steps.push({
    id: "identity",
    label: "identidade do pacote instalado",
    bin: "internal",
    args: [input.packageName, EXPECTED_PACKAGE],
    cwd: input.tempDir,
    envMode: "inherit",
    display: `verificar identidade de ${EXPECTED_PACKAGE}`,
  });
  const astroBin = installedAstroBin(input.tempDir);
  steps.push({
    id: "help",
    label: "astro --help no pacote instalado",
    bin: astroBin,
    args: ["--help"],
    cwd: input.tempDir,
    envMode: "sanitized",
    display: `${quoteDisplay(astroBin)} --help`,
  });

  return {
    root: input.root,
    tempRoot: input.tempRoot,
    tempDir: input.tempDir,
    tarball,
    packageName: input.packageName,
    version: input.version,
    skipTests: input.skipTests === true,
    steps,
  };
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { skipTests: false, json: false, help: false };
  for (const arg of argv) {
    if (arg === "--skip-tests") options.skipTests = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`argumento desconhecido: ${arg}`);
  }
  return options;
}

export function readPackageMeta(root: string): PackageMeta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    throw new Error("package.json ausente ou inválido");
  }
  const manifest = parsed as { name?: unknown; version?: unknown };
  if (typeof manifest.name !== "string" || !/^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(manifest.name)) {
    throw new Error("package.json sem nome de pacote válido");
  }
  if (typeof manifest.version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(manifest.version)) {
    throw new Error("package.json sem versão válida");
  }
  return { name: manifest.name, version: manifest.version };
}

/** Confere o pacote realmente instalado, não só o nome lido do repositório. */
export function verifyInstalledPackage(
  tempDir: string,
  packageName: string,
  expected: string = EXPECTED_PACKAGE,
): void {
  if (!/^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(packageName)) {
    throw new Error("nome de pacote instalado inválido");
  }
  const manifestPath = join(tempDir, "node_modules", ...packageName.split("/"), "package.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error(`pacote instalado não encontrado: ${packageName}`);
  }
  const installed = (parsed as { name?: unknown }).name;
  if (installed !== expected) {
    throw new Error(
      `identidade do pacote instalado divergente: esperado ${expected}, encontrado ${String(installed)}`,
    );
  }
}

export type TempWriter = (path: string, content: string) => void;

export function prepareTempDir(
  tempRoot: string,
  packageName: string,
  write: TempWriter = (path, content) => writeFileSync(path, content, "utf8"),
): string {
  const dir = mkdtempSync(join(tempRoot, tempDirPrefix(packageName)));
  try {
    write(
      join(dir, "package.json"),
      `${JSON.stringify({ name: "astro-release-check", private: true }, null, 2)}\n`,
    );
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return dir;
}

export function removeTempDir(tempRoot: string, tempDir: string): void {
  const root = resolve(tempRoot);
  const dir = resolve(tempDir);
  if (!isInside(root, dir) || !basename(dir).startsWith(TEMP_PREFIX)) {
    throw new Error(`recusando remover diretório temporário fora do padrão: ${tempDir}`);
  }
  if (existsSync(dir)) {
    let realRoot: string;
    let realDir: string;
    try {
      realRoot = realpathSync(root);
      realDir = realpathSync(dir);
    } catch {
      throw new Error(`recusando remover diretório temporário não resolvido: ${tempDir}`);
    }
    if (!isInside(realRoot, realDir) || !basename(realDir).startsWith(TEMP_PREFIX)) {
      throw new Error(`recusando remover diretório temporário que resolve para fora: ${tempDir}`);
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

/** Últimas linhas da saída, com segredos redigidos e tamanho limitado. */
export function tailForFailure(output: string, maxLines = 40): string {
  const redacted = redactSecrets(output);
  const clipped = redacted.length > MAX_OUTPUT_CHARS ? redacted.slice(-MAX_OUTPUT_CHARS) : redacted;
  return clipped.trimEnd().split(/\r?\n/).slice(-maxLines).join("\n");
}

/** Limpeza de melhor esforço em Ctrl-C/SIGTERM; sempre encerra com código convencional. */
export function cleanupOnSignal(
  tempRoot: string,
  tempDir: string,
  signal: "SIGINT" | "SIGTERM",
  deps: {
    remove?: (root: string, dir: string) => void;
    exit?: (code: number) => void;
  } = {},
): void {
  try {
    (deps.remove ?? removeTempDir)(tempRoot, tempDir);
  } catch {
    // O sinal já encerra o processo; não mascarar o motivo original.
  }
  (deps.exit ?? ((code: number) => process.exit(code)))(signal === "SIGINT" ? 130 : 143);
}

function commandFor(plan: ReleasePlan, id: StepId): string {
  return plan.steps.find((step) => step.id === id)?.display ?? "";
}

export function buildSummary(
  plan: ReleasePlan,
  results: readonly StepResult[],
  failure: Failure | null,
): ReleaseSummary {
  return {
    ok: failure === null,
    packageName: plan.packageName,
    version: plan.version,
    skippedTests: plan.skipTests,
    tempDir: plan.tempDir,
    tarball: plan.tarball,
    steps: results.map((result) => ({
      id: result.id,
      command: commandFor(plan, result.id),
      status: result.status,
      exitCode: result.exitCode,
    })),
    failure,
  };
}

export interface BinaryDeps {
  which?: (name: string) => string | null;
  exists?: (path: string) => boolean;
}

/** Resolve só o binário local quando o caminho é absoluto; nunca cai para o PATH. */
export function resolveStepBinary(step: PlannedStep, deps: BinaryDeps = {}): string | null {
  const exists = deps.exists ?? existsSync;
  if (isAbsolute(step.bin)) return exists(step.bin) ? step.bin : null;
  return (deps.which ?? Bun.which)(step.bin);
}

export function runPlannedStep(step: PlannedStep, deps: BinaryDeps = {}): StepOutcome {
  if (step.id === "identity") {
    try {
      verifyInstalledPackage(step.cwd, step.args[0] ?? "", step.args[1]);
      return { exitCode: 0, output: "" };
    } catch (error) {
      return {
        exitCode: 1,
        output: "",
        error: redactSecrets(error instanceof Error ? error.message : String(error)),
      };
    }
  }

  const bin = resolveStepBinary(step, deps);
  if (bin === null) {
    return { exitCode: null, output: "", error: `binário não encontrado: ${step.bin}` };
  }
  const env = step.envMode === "sanitized" ? stepEnv(process.env) : process.env;
  try {
    const proc = Bun.spawnSync({
      cmd: [bin, ...step.args],
      cwd: step.cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: STEP_TIMEOUT_MS,
    });
    return {
      exitCode: proc.exitCode,
      output: `${proc.stdout.toString()}\n${proc.stderr.toString()}`,
    };
  } catch (error) {
    return {
      exitCode: null,
      output: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Executa o plano em ordem, para na primeira falha e sempre tenta limpar. */
export function executePlan(plan: ReleasePlan, options: ExecuteOptions = {}): ReleaseSummary {
  const spawn = options.spawn ?? runPlannedStep;
  const removeTemp = options.removeTemp
    ?? ((dir: string) => removeTempDir(plan.tempRoot, dir));
  const log = options.log ?? (() => {});

  const results: StepResult[] = [];
  let failure: Failure | null = null;

  plan.steps.forEach((step, index) => {
    if (failure !== null) {
      results.push({ id: step.id, status: "skipped", exitCode: null });
      log(`[${index + 1}/${plan.steps.length}] ${step.display} ... pulado`);
      return;
    }

    log(`[${index + 1}/${plan.steps.length}] ${step.display}`);
    let outcome: StepOutcome;
    try {
      outcome = spawn(step);
    } catch (error) {
      outcome = {
        exitCode: null,
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (outcome.exitCode === 0) {
      results.push({ id: step.id, status: "passed", exitCode: 0 });
      log("  ok");
      return;
    }

    const message = outcome.error !== undefined
      ? redactSecrets(outcome.error)
      : outcome.exitCode === null
        ? `${step.display} terminou sem código de saída (timeout ou sinal)`
        : `${step.display} saiu com código ${outcome.exitCode}`;
    results.push({ id: step.id, status: "failed", exitCode: outcome.exitCode });
    failure = { step: step.id, message };
    log(`  falhou: ${message}`);

    const tail = tailForFailure(outcome.output ?? "");
    if (tail !== "") log(tail.split("\n").map((line) => `  ${line}`).join("\n"));
  });

  try {
    removeTemp(plan.tempDir);
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    if (failure === null) failure = { step: "cleanup", message };
    else log(`  aviso: falha ao limpar ${plan.tempDir}: ${message}`);
  }

  return buildSummary(plan, results, failure);
}

function main(): number {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    console.error(`release-check: ${message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const root = resolve(import.meta.dir, "..");
  let meta: PackageMeta | undefined;
  let tempDir: string | undefined;
  try {
    meta = readPackageMeta(root);
    const tempRoot = tmpdir();
    const created = prepareTempDir(tempRoot, meta.name);
    tempDir = created;
    const onSigint = () => cleanupOnSignal(tempRoot, created, "SIGINT");
    const onSigterm = () => cleanupOnSignal(tempRoot, created, "SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);

    try {
      const plan = createPlan({
        root,
        tempRoot,
        tempDir: created,
        packageName: meta.name,
        version: meta.version,
        skipTests: options.skipTests,
      });

      if (!options.json) {
        console.log(`release-check: ${meta.name}@${meta.version}`);
        console.log(`release-check: temporário ${created}`);
      }

      const summary = executePlan(plan, {
        log: options.json ? () => {} : (line) => console.log(line),
      });

      if (options.json) {
        console.log(JSON.stringify(summary, null, 2));
      } else if (summary.ok) {
        console.log(`release-check: ok (${summary.steps.length} etapas)`);
      } else {
        console.error(`release-check: falhou em ${summary.failure?.step ?? "etapa desconhecida"}`);
      }
      return summary.ok ? 0 : 1;
    } finally {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    }
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    if (tempDir !== undefined) {
      try {
        removeTempDir(tmpdir(), tempDir);
      } catch {
        // A falha principal já fecha o gate; não esconder a causa original.
      }
    }
    if (options.json) {
      console.log(JSON.stringify({
        ok: false,
        packageName: meta?.name ?? "",
        version: meta?.version ?? "",
        skippedTests: options.skipTests,
        tempDir: tempDir ?? "",
        tarball: "",
        steps: [],
        failure: { step: "setup", message },
      }, null, 2));
    } else {
      console.error(`release-check: ${message}`);
    }
    return 1;
  }
}

if (import.meta.main) process.exit(main());
