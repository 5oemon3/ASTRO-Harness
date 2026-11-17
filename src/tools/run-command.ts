import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLexicalHardBlockPrefilter, createPathClassifier, type PathClassifier } from "../path-class";
import { resolveArtifactRoot, resolveAstroHome } from "../permissions";
import { redactSecrets } from "../sanitize-external";
import { realpathPreservingDots } from "./paths";
import { ToolError, type Tool, type ToolResult } from "./types";

const MAX_OUTPUT = 10_000;

/**
 * Nomes de variáveis que podem carregar segredos. O `run_command` recebe uma
 * cópia sanitizada do ambiente: o filho mantém PATH/HOME/etc., mas nunca vê
 * chaves de API, tokens, senhas ou credenciais.
 */
const SECRET_ENV =
  /(^|_)[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PASSPHRASE|PEM|AUTH|CREDENTIAL|PRIVATE|COOKIE|SESSION)[A-Z0-9_]*$/i;

/**
 * Nomes que casam com `SECRET_ENV` (contêm AUTH) mas não são segredo:
 * identidade git. Exceção explícita para não regredir I-03 em AUTHORIZATION.
 */
const NON_SECRET_ENV = new Set([
  "GIT_AUTHOR_NAME",
  "GIT_COMMITTER_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_EMAIL",
]);

function secretKey(name: string): string {
  return process.platform === "win32" ? name.toLowerCase() : name;
}

export function sanitizedEnv(
  source: NodeJS.ProcessEnv,
  secretEnvNames: readonly string[] = [],
): Record<string, string> {
  const exactSecrets = new Set(secretEnvNames.map(secretKey));
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (
      value === undefined ||
      exactSecrets.has(secretKey(name)) ||
      (SECRET_ENV.test(name) && !NON_SECRET_ENV.has(name.toUpperCase()))
    ) continue;
    env[name] = value;
  }
  return env;
}
/** Imagem default do sandbox (ADR-0027); override `ASTRO_DOCKER_IMAGE` (produção: fixar por digest). */
const DEFAULT_DOCKER_IMAGE = "oven/bun:1.4.2";

export function resolveDockerImage(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ASTRO_DOCKER_IMAGE?.trim();
  return override === undefined || override === "" ? DEFAULT_DOCKER_IMAGE : override;
}

function failure(message: string): ToolResult {
  return { output: redactSecrets(message), isError: true };
}

function commandInput(input: unknown): string {
  if (typeof input !== "object" || input === null) {
    throw new ToolError("entrada inválida: esperado objeto com { command }");
  }
  const command = (input as { command?: unknown }).command;
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new ToolError("entrada inválida: \"command\" deve ser uma string não vazia");
  }
  return command;
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) : text;
}

/**
 * ADR-0027 (redação): toda saída do comando redige padrões de segredo ANTES
 * de qualquer truncamento — o cap nunca devolve texto cru (I-03).
 */
function redactThenTruncate(text: string): string {
  return truncate(redactSecrets(text));
}

/** Mata o processo e os filhos (taskkill /T no Windows; grupo no POSIX). */
function killProcessTree(proc: { pid: number; kill: () => void }): void {
  if (process.platform === "win32") {
    try {
      Bun.spawnSync(["taskkill", "/pid", String(proc.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
    } catch {
      try {
        proc.kill();
      } catch {
        // já saiu
      }
    }
    return;
  }
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    try {
      proc.kill();
    } catch {
      // já saiu
    }
  }
}

// --- Sandbox (F4-6) ---

let sandboxEnabled = false;
let dockerProbe: Promise<boolean> | undefined;

/**
 * Só aceita engine Linux: no Windows o Docker Desktop pode estar em modo
 * Windows containers, que não roda `alpine` nem suporta `--read-only`.
 */
export function dockerInfoSupportsLinuxContainers(output: string): boolean {
  const [version, osType] = output.trim().split("|");
  return (version?.trim().length ?? 0) > 0 && osType?.trim().toLowerCase() === "linux";
}

/**
 * Verifica se o binário `docker` existe, o daemon responde (`docker info`) e o
 * engine roda containers Linux. Resultado cacheado por processo.
 */
export function detectDockerAvailable(): Promise<boolean> {
  if (dockerProbe === undefined) {
    dockerProbe = (async () => {
      try {
        const proc = Bun.spawn({
          cmd: ["docker", "info", "--format", "{{.ServerVersion}}|{{.OSType}}"],
          stdout: "pipe",
          stderr: "pipe",
          env: minimalHostEnv(),
        });
        const timer = setTimeout(() => proc.kill(), 5_000);
        try {
          const code = await proc.exited;
          if (code !== 0) return false;
          return dockerInfoSupportsLinuxContainers(await new Response(proc.stdout).text());
        } finally {
          clearTimeout(timer);
        }
      } catch {
        return false;
      }
    })();
  }
  return dockerProbe;
}

/** Env mínimo para spawnar o docker CLI: sem credenciais do host. */
function minimalHostEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  if (process.env.SYSTEMROOT !== undefined) env.SYSTEMROOT = process.env.SYSTEMROOT;
  return env;
}

/** Configura o modo sandbox de run_command (chamado pelo app ao carregar a config). */
export function configureRunCommand(opts: { sandbox?: boolean }): void {
  sandboxEnabled = opts.sandbox === true;
}

/** Estado atual do sandbox do run_command (diagnóstico e testes). */
export function isRunCommandSandboxEnabled(): boolean {
  return sandboxEnabled;
}

/**
 * Sandbox ligado salvo opt-out explícito (`sandbox: false`), que NÃO roda no host:
 * recusa com `sandbox_required_for_shell` (I-19, slice 4b). Sem Docker, recusa (I-11).
 */
export function resolveSandboxSetting(configured: boolean | undefined): boolean {
  return configured !== false;
}

/** Aviso de boot/banner (ADR-0027): `sandbox:false` desliga o shell, sem afetar file tools. */
export const SANDBOX_DISABLED_WARNING =
  "run_command desligado (sandbox:false): shell não executa; file tools mantêm hard-block e redação";

/** Erro tipado da recusa de shell sem sandbox (ADR-0027): não ecoa o comando (I-03). */
export class SandboxRequiredForShellError extends Error {
  readonly code = "sandbox_required_for_shell";
  constructor(readonly mode = "sandbox:false") {
    super(`sandbox_required_for_shell: run_command não executa no host (modo ${mode}); ative tools.run_command.sandbox com Docker`);
    this.name = "SandboxRequiredForShellError";
  }
}

/** Texto do aviso de boot quando o sandbox está desligado. */
export function sandboxWarning(enabled: boolean): string | undefined {
  return enabled ? undefined : SANDBOX_DISABLED_WARNING;
}

/** Teto de entradas da varredura de máscaras (ADR-0027); excedido = recusa fail-closed. */
const MASK_MAX_ENTRIES = 200_000;

/** Contexto mínimo para montar o argv do sandbox (subconjunto de `ToolContext`). */
export interface DockerSandboxContext {
  cwd: string;
  env?: Record<string, string | undefined>;
  protectedPaths?: readonly string[];
  /** `allow-critical` da CLI (slice 5a): path liberado não vira máscara. */
  allowCritical?: readonly string[];
}

interface MaskTarget {
  /** Caminho no host (== caminho no container, o cwd é bindado 1:1) a mascarar. */
  target: string;
  isDirectory: boolean;
}

/** Fail-closed (ADR-0027): erro do classificador vira hard-block (mascara o que não inspecionou). */
function classifyForMask(classify: PathClassifier, realPath: string): boolean {
  try {
    return classify(realPath) === "hard-block";
  } catch {
    return true; // fail-closed
  }
}

/** `stat` do alvo; fail-closed: erro que não seja "não existe" vira máscara de diretório. */
function maskTargetOf(path: string): MaskTarget | null {
  try {
    return { target: path, isDirectory: statSync(path).isDirectory() };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null; // não existe: nada a encobrir
    return { target: path, isDirectory: true };
  }
}

/**
 * Alvos de máscara (ADR-0027): `<cwd>/.git` sempre, o artifactRoot pelo
 * realpath e todo hard-block existente no cwd. Varredura recursiva sem descer
 * em symlink nem em diretório já mascarado; teto/readdir falho = recusa fail-closed.
 */
function collectMaskTargets(ctx: DockerSandboxContext, env: NodeJS.ProcessEnv): MaskTarget[] {
  const cwd = resolve(ctx.cwd);
  const astroHome = resolveAstroHome(env);
  const artifactRoot = resolveArtifactRoot(env);
  // Classificador e prefiltro montados UMA vez; só symlink/candidato léxico vai ao classify.
  const classify = createPathClassifier({
    cwd,
    astroHome,
    artifactRoot,
    protectedPaths: ctx.protectedPaths,
    allowCritical: ctx.allowCritical ?? [],
  });
  const isCandidate = createLexicalHardBlockPrefilter({ cwd, astroHome, protectedPaths: ctx.protectedPaths });
  const targets = new Map<string, MaskTarget>();
  const add = (path: string): void => {
    const target = maskTargetOf(path);
    if (target !== null) targets.set(target.target, target);
  };

  add(join(cwd, ".git"));
  if (artifactRoot !== null) add(realpathPreservingDots(artifactRoot, cwd));

  let entries = 0;
  const pending: string[] = [cwd];
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    let names: Dirent[];
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      throw new ToolError("sandbox: falha ao varrer o diretório de trabalho para máscaras de hard-block");
    }
    for (const entry of names) {
      entries += 1;
      if (entries > MASK_MAX_ENTRIES) {
        throw new ToolError(`sandbox: varredura de máscaras excedeu o teto de ${MASK_MAX_ENTRIES} entradas`);
      }
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink() || isCandidate(full)) {
        if (classifyForMask(classify, full)) {
          add(full);
          continue;
        }
      }
      if (!entry.isSymbolicLink() && entry.isDirectory()) {
        pending.push(full);
      }
    }
  }
  return [...targets.values()];
}

/** Raízes temporárias das máscaras, por argv; removidas por `releaseDockerArgv`. */
const maskRoots = new WeakMap<string[], string>();

/** Remove as fontes temporárias de máscara criadas por `dockerArgv` (idempotente, best-effort). */
export function releaseDockerArgv(argv: readonly string[]): void {
  const root = maskRoots.get(argv as string[]);
  if (root === undefined) return;
  maskRoots.delete(argv as string[]);
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/** Fontes vazias das máscaras em `os.tmpdir()`, montadas `:ro` no mesmo caminho no container. */
function maskMounts(ctx: DockerSandboxContext, env: NodeJS.ProcessEnv): { mounts: string[]; maskRoot?: string } {
  const targets = collectMaskTargets(ctx, env);
  if (targets.length === 0) return { mounts: [] };
  const maskRoot = mkdtempSync(join(tmpdir(), "astro-sandbox-mask-"));
  try { chmodSync(maskRoot, 0o700); } catch { /* best-effort: 0700 no POSIX, bits ignorados no Windows */ }
  try {
    const mounts: string[] = [];
    let index = 0;
    for (const target of targets) {
      const source = join(maskRoot, `mask-${index++}`);
      if (target.isDirectory) {
        mkdirSync(source, { mode: 0o700 });
      } else {
        writeFileSync(source, "", { mode: 0o600 });
      }
      mounts.push("--volume", `${source}:${target.target}:ro`);
    }
    return { mounts, maskRoot };
  } catch (error) {
    // Falha ao montar o plano não pode deixar lixo em tmpdir (fail-closed).
    try { rmSync(maskRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw error;
  }
}

/**
 * Argv do docker run isolado (ADR-0027, I-11): rede off, rootfs read-only,
 * `/tmp` tmpfs, cwd rw, git neutralizado e máscaras `:ro` dos hard-blocks.
 */
export function dockerArgv(containerName: string, ctx: DockerSandboxContext, command: string): string[] {
  const workdir = resolve(ctx.cwd);
  const env = ctx.env ?? process.env;
  const { mounts, maskRoot } = maskMounts(ctx, env);
  const argv = [
    "docker",
    "run",
    "--rm",
    "--name",
    containerName,
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--env",
    "GIT_DIR=/dev/null",
    "--env",
    "GIT_CONFIG_NOSYSTEM=1",
    "--env",
    "HOME=/tmp",
    "--volume",
    `${workdir}:${workdir}`,
    ...mounts,
    "--workdir",
    workdir,
    resolveDockerImage(env),
    "sh",
    "-c",
    command,
  ];
  if (maskRoot !== undefined) maskRoots.set(argv, maskRoot);
  return argv;
}

/** Executa um comando dentro do container Docker efêmero e libera as máscaras. */
async function runInDocker(command: string, ctx: { cwd: string; signal?: AbortSignal }, timeoutMs: number): Promise<ToolResult> {
  const containerName = `astro-sb-${randomUUID().slice(0, 12)}`;
  const argv = dockerArgv(containerName, ctx, command);
  try {
    return await runDockerProcess(containerName, argv, ctx, timeoutMs);
  } finally {
    releaseDockerArgv(argv);
  }
}

/** Roda o argv já montado; o chamador é dono da limpeza das fontes de máscara. */
async function runDockerProcess(
  containerName: string,
  argv: string[],
  ctx: { cwd: string; signal?: AbortSignal },
  timeoutMs: number,
): Promise<ToolResult> {
  const proc = Bun.spawn({
    cmd: argv,
    cwd: ctx.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: minimalHostEnv(),
    detached: ctx.signal !== undefined && process.platform !== "win32",
  });

  const removeContainer = (): void => {
    try {
      Bun.spawnSync(["docker", "rm", "-f", containerName], {
        stdout: "ignore", stderr: "ignore", env: minimalHostEnv(),
      });
    } catch {
      // best-effort
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol("timeout");
  const aborted = Symbol("aborted");
  const timeout = new Promise<typeof timedOut>((res) => {
    timer = setTimeout(() => {
      killProcessTree(proc);
      res(timedOut);
    }, timeoutMs);
  });
  let onCancel: (() => void) | undefined;
  const cancellation = new Promise<typeof aborted>((resolve) => {
    if (ctx.signal === undefined) return;
    if (ctx.signal.aborted) {
      killProcessTree(proc);
      resolve(aborted);
      return;
    }
    onCancel = (): void => {
      killProcessTree(proc);
      resolve(aborted);
    };
    ctx.signal.addEventListener("abort", onCancel, { once: true });
  });

  let exited: typeof timedOut | typeof aborted | number;
  try {
    exited = await Promise.race([proc.exited, timeout, cancellation]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onCancel !== undefined) ctx.signal?.removeEventListener("abort", onCancel);
  }

  if (exited === aborted) {
    removeContainer();
    return { output: "comando cancelado no sandbox", isError: true };
  }

  if (exited === timedOut) {
    // docker run morto não para o container: limpeza forçada best-effort
    removeContainer();
  }

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const chunks = [stdout.trimEnd(), stderr.trimEnd()].filter((part) => part.length > 0);
  let output = chunks.join("\n");

  if (exited === timedOut) {
    const note = `timeout de ${timeoutMs}ms excedido no sandbox; container interrompido`;
    output = output.length > 0 ? `${output}\n${note}` : note;
    return { output: redactThenTruncate(output), isError: true };
  }
  if (exited !== 0) {
    const note = `comando terminou com código ${exited} (sandbox docker)`;
    output = output.length > 0 ? `${output}\n${note}` : note;
    return { output: redactThenTruncate(output), isError: true };
  }
  return { output: redactThenTruncate(output) };
}

/** Executa um comando de shell no diretório de trabalho, com timeout do manifesto. */
export const runCommandTool: Tool = {
  manifest: {
    name: "run_command",
    description:
      "Executa um comando de shell no diretório de trabalho e devolve a saída. " +
      "Só em container Docker efêmero isolado; sem sandbox recusa (sandbox_required_for_shell).",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Comando a executar no shell do sistema.",
        },
      },
      required: ["command"],
    },
    risk: "high",
    permission: "execute",
    class: "shell",
    timeoutMs: 30_000,
    retryable: false,
    idempotent: false,
    sideEffects: "process",
  },

  async execute(input, ctx): Promise<ToolResult> {
    let command: string;
    try {
      command = commandInput(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(message);
    }

    // Slice 4b (I-19): `sandbox: false` NÃO executa no host — recusa sem spawnar e sem ecoar o comando.
    if (!sandboxEnabled) {
      const error = new SandboxRequiredForShellError("sandbox:false");
      return { ...failure(error.message), code: error.code };
    }

    // Sandbox: container Docker efêmero; sem Docker disponível, recusa (sem downgrade)
    const docker = await detectDockerAvailable();
    if (!docker) {
      return failure(
        "sandbox ativo (tools.run_command.sandbox) mas Docker não está disponível; instale e inicie o Docker",
      );
    }
    try {
      return await runInDocker(command, ctx, runCommandTool.manifest.timeoutMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(`erro no sandbox docker: ${message}`);
    }
  },
};