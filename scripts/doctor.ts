/**
 * Diagnóstico local do ambiente, sem rede: versões, dependências, artefatos,
 * config, credenciais por NOME e ASTRO_HOME. Nunca imprime valor de segredo (I-03).
 */
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_ATTACHMENTS, loadConfig } from "../src/config";
import { loadEffectiveConfig } from "../src/provider/profiles";
import { readGcMarker, resolveArtifactRoot, validateArtifactRoot } from "../src/attachments/store";
import { resolveAstroHome } from "../src/permissions";
import { redactSecrets } from "../src/sanitize-external";

export type CheckLevel = "ok" | "warn" | "fail";

export interface Check {
  level: CheckLevel;
  label: string;
  detail?: string;
}

export interface DoctorReport {
  checks: Check[];
}

export interface ProviderFact {
  id: string;
  credentialRef?: string;
}

export interface DoctorFacts {
  bunVersion: string;
  nodeVersion: string | undefined;
  engines: { bun?: string; node?: string };
  missingModules: string[];
  artifacts: Array<{ path: string; exists: boolean }>;
  config: {
    path: string;
    present: boolean;
    error?: string;
    providers?: ProviderFact[];
  };
  astroHome: { path: string; exists: boolean; writable: boolean };
  attachments: {
    root: string;
    realpath?: string;
    exists: boolean;
    invalidReason?: string;
    ttlDays: number;
    maxBytes: number;
    usageBytes?: number;
    artifacts?: number;
    lastGc?: string;
  };
  env: Record<string, string | undefined>;
}

const REQUIRED_MODULES = ["ink", "react", "bun"] as const;
const ARTIFACTS = ["dist/cli.js", "dist/launcher.js"] as const;

function parseVersion(value: string): [number, number, number] | undefined {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(value.trim().replace(/^v/, ""));
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/** Compara com o mínimo declarado em `engines` (aceita `>=1.4.0` ou `1.4.0`). */
export function satisfiesMinimum(actual: string, range: string): boolean {
  const minimum = range.trim().replace(/^[><=^~]+/, "");
  const a = parseVersion(actual);
  const b = parseVersion(minimum);
  if (a === undefined || b === undefined) return false;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! > b[index]!;
  }
  return true;
}

function versionCheck(
  label: string,
  actual: string | undefined,
  range: string | undefined,
  missingDetail: string,
): Check {
  if (actual === undefined) return { level: "fail", label, detail: missingDetail };
  if (range === undefined) return { level: "ok", label, detail: actual };
  return satisfiesMinimum(actual, range)
    ? { level: "ok", label, detail: `${actual} (mínimo ${range})` }
    : { level: "fail", label, detail: `${actual} abaixo do mínimo ${range}` };
}

function credentialChecks(
  providers: ProviderFact[] | undefined,
  env: Record<string, string | undefined>,
): Check[] {
  if (providers === undefined || providers.length === 0) return [];
  return providers.map((provider) => {
    const label = `credencial ${provider.id}`;
    if (provider.credentialRef === undefined) return { level: "ok", label, detail: "sem chave" } satisfies Check;
    const present = (env[provider.credentialRef] ?? "").length > 0;
    return present
      ? { level: "ok", label, detail: `${provider.credentialRef} presente` } satisfies Check
      : { level: "warn", label, detail: `${provider.credentialRef} ausente no ambiente` } satisfies Check;
  });
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

/** Avalia fatos coletados. Puro: não lê fs, env nem rede. */
export function runChecks(facts: DoctorFacts): DoctorReport {
  const checks: Check[] = [];
  checks.push(versionCheck("bun", facts.bunVersion, facts.engines.bun, "versão do Bun indisponível"));
  checks.push(versionCheck("node", facts.nodeVersion, facts.engines.node, "node não encontrado no PATH"));

  checks.push(facts.missingModules.length === 0
    ? { level: "ok", label: "dependências", detail: REQUIRED_MODULES.join(", ") }
    : { level: "fail", label: "dependências", detail: `não resolvem: ${facts.missingModules.join(", ")}; rode bun install` });

  const missingArtifacts = facts.artifacts.filter((artifact) => !artifact.exists);
  checks.push(missingArtifacts.length === 0
    ? { level: "ok", label: "dist", detail: facts.artifacts.map((artifact) => artifact.path).join(", ") }
    : { level: "warn", label: "dist", detail: `${missingArtifacts.map((artifact) => artifact.path).join(", ")} ausente; rode bun run build` });

  if (!facts.config.present) {
    checks.push({ level: "ok", label: "config", detail: `${facts.config.path} ausente; a TUI abre o setup de provider` });
  } else if (facts.config.error !== undefined) {
    checks.push({ level: "fail", label: "config", detail: redactSecrets(facts.config.error) });
  } else {
    const count = facts.config.providers?.length ?? 0;
    checks.push({
      level: "ok",
      label: "config",
      detail: `${facts.config.path} válida (${count} provider${count === 1 ? "" : "s"})`,
    });
    checks.push(...credentialChecks(facts.config.providers, facts.env));
  }

  if (!facts.astroHome.exists) {
    checks.push({ level: "warn", label: "astro home", detail: `${facts.astroHome.path} ausente; será criado no primeiro uso` });
  } else if (!facts.astroHome.writable) {
    checks.push({ level: "fail", label: "astro home", detail: `${facts.astroHome.path} sem permissão de escrita` });
  } else {
    checks.push({ level: "ok", label: "astro home", detail: `${facts.astroHome.path} gravável` });
  }

  const attachments = facts.attachments;
  if (attachments.invalidReason !== undefined) {
    checks.push({ level: "fail", label: "anexos", detail: redactSecrets(attachments.invalidReason) });
  } else if (!attachments.exists) {
    checks.push({ level: "warn", label: "anexos", detail: `${attachments.root} ausente; criada no primeiro anexo de imagem` });
  } else {
    const count = attachments.artifacts ?? 0;
    checks.push({
      level: "ok",
      label: "anexos",
      detail: `${attachments.realpath ?? attachments.root} · ${count} artefato${count === 1 ? "" : "s"} · `
        + `${formatBytes(attachments.usageBytes ?? 0)}/${formatBytes(attachments.maxBytes)} · `
        + `TTL ${attachments.ttlDays}d · último GC ${attachments.lastGc ?? "nunca"}`,
    });
  }

  return { checks };
}

/** Imprime uma linha por check e o resumo. */
export function renderReport(report: DoctorReport, write: (line: string) => void): void {
  for (const check of report.checks) {
    write(`[${check.level}] ${check.label}${check.detail === undefined ? "" : ` ${check.detail}`}`);
  }
  const count = (level: CheckLevel): number => report.checks.filter((check) => check.level === level).length;
  write(`Resumo: ${count("ok")} ok, ${count("warn")} warn, ${count("fail")} fail`);
}

export function exitCode(report: DoctorReport): 0 | 1 {
  return report.checks.some((check) => check.level === "fail") ? 1 : 0;
}

function readEngines(root: string): { bun?: string; node?: string } {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      engines?: { bun?: string; node?: string };
    };
    return pkg.engines ?? {};
  } catch {
    return {};
  }
}

function resolvesModule(name: string): boolean {
  try {
    createRequire(import.meta.url).resolve(`${name}/package.json`);
    return true;
  } catch {
    return false;
  }
}

function readNodeVersion(): string | undefined {
  const node = Bun.which("node");
  if (node === null) return undefined;
  try {
    const proc = Bun.spawnSync({ cmd: [node, "--version"], stdout: "pipe", stderr: "ignore" });
    if ((proc.exitCode ?? -1) !== 0) return undefined;
    return proc.stdout.toString().trim().replace(/^v/, "");
  } catch {
    return undefined;
  }
}

function readConfig(): DoctorFacts["config"] {
  const path = join(process.cwd(), "astro.config.json");
  if (!existsSync(path)) return { path, present: false };
  try {
    const config = loadConfig(path);
    const providers = Object.entries(config.providers).map(([id, provider]) => ({
      id,
      ...("credentialRef" in provider && typeof provider.credentialRef === "string"
        ? { credentialRef: provider.credentialRef }
        : {}),
    }));
    return { path, present: true, providers };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { path, present: true, error: redactSecrets(detail) };
  }
}

function readAstroHome(env: Record<string, string | undefined>): DoctorFacts["astroHome"] {
  const configured = env.ASTRO_HOME;
  const path = configured === undefined || configured === "" ? join(homedir(), ".astro") : configured;
  if (!existsSync(path)) return { path, exists: false, writable: false };
  try {
    accessSync(path, constants.W_OK);
    return { path, exists: true, writable: true };
  } catch {
    return { path, exists: true, writable: false };
  }
}

function readAttachmentConfig(env: NodeJS.ProcessEnv): { ttlDays: number; maxBytes: number } {
  try {
    const effective = loadEffectiveConfig(join(process.cwd(), "astro.config.json"), { env, allowMissing: true });
    return {
      ttlDays: effective.config.attachments.artifactTtlDays,
      maxBytes: effective.config.attachments.artifactMaxBytes,
    };
  } catch {
    return { ttlDays: DEFAULT_ATTACHMENTS.artifactTtlDays, maxBytes: DEFAULT_ATTACHMENTS.artifactMaxBytes };
  }
}

const ARTIFACT_KEY = /^(?:session|run)-[a-f0-9]{64}$/;

function readArtifactUsage(root: string): { usageBytes: number; artifacts: number } {
  let usageBytes = 0;
  let artifacts = 0;
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ARTIFACT_KEY.test(entry.name)) continue;
      const dir = join(root, entry.name);
      try {
        for (const name of readdirSync(dir, { withFileTypes: true })) {
          if (!name.isFile() || !/^[a-f0-9]{64}$/.test(name.name)) continue;
          usageBytes += statSync(join(dir, name.name)).size;
          artifacts += 1;
        }
      } catch {
        // subdiretório removido durante a leitura: o próximo doctor recalcula
      }
    }
  } catch {
    // raiz removida durante a leitura
  }
  return { usageBytes, artifacts };
}

/** `accessSync` não reflete ACL do Windows nem o bit de execução POSIX; prova escrita/leitura/listagem. */
function writableDirectory(root: string): boolean {
  const probe = join(root, `.doctor-${randomUUID()}.tmp`);
  try {
    // O store cria um subdiretório por chave antes de gravar; no Windows AD e WD são direitos distintos.
    mkdirSync(probe, { mode: 0o700 });
    const file = join(probe, "probe");
    writeFileSync(file, "", { flag: "wx", mode: 0o600 });
    if (!readdirSync(root).some((name) => name.startsWith(".doctor-"))) return false;
    readFileSync(file);
    return true;
  } catch {
    return false;
  } finally {
    try { rmSync(probe, { recursive: true, force: true }); } catch { /* melhor esforço */ }
  }
}

function collectAttachmentFacts(
  env: NodeJS.ProcessEnv,
  checkPrivate?: (path: string) => boolean,
  probeWritable?: (path: string) => boolean,
): DoctorFacts["attachments"] {
  const config = readAttachmentConfig(env);
  const astroHome = resolveAstroHome(env);
  const root = resolveArtifactRoot({ env, astroHome });
  const base = { root, ttlDays: config.ttlDays, maxBytes: config.maxBytes };
  try {
    validateArtifactRoot(root, {
      cwd: process.cwd(),
      astroHome,
      ...(checkPrivate === undefined ? {} : { checkPrivate }),
    });
    if (!existsSync(root)) return { ...base, exists: false };
    try {
      if (!statSync(root).isDirectory()) {
        return { ...base, exists: true, invalidReason: `raiz de artefato não é um diretório: ${root}` };
      }
      accessSync(root, constants.R_OK | constants.W_OK | constants.X_OK);
      if (!(probeWritable ?? writableDirectory)(root)) {
        return { ...base, exists: true, invalidReason: `raiz de artefato não é gravável: ${root}` };
      }
    } catch (error) {
      return {
        ...base,
        exists: true,
        invalidReason: redactSecrets(error instanceof Error ? error.message : String(error)),
      };
    }
    const realpath = realpathSync(root);
    const usage = readArtifactUsage(root);
    const marker = readGcMarker(root);
    return { ...base, exists: true, realpath, ...usage, ...(marker === undefined ? {} : { lastGc: marker.at }) };
  } catch (error) {
    return {
      ...base,
      exists: existsSync(root),
      invalidReason: redactSecrets(error instanceof Error ? error.message : String(error)),
    };
  }
}

/** Coleta fatos reais do checkout e do ambiente atual (env/checkPrivate injetáveis). */
export function collectFacts(
  root: string,
  options: {
    env?: NodeJS.ProcessEnv;
    checkPrivate?: (path: string) => boolean;
    probeWritable?: (path: string) => boolean;
  } = {},
): DoctorFacts {
  const env = options.env ?? process.env;
  return {
    bunVersion: Bun.version,
    nodeVersion: readNodeVersion(),
    engines: readEngines(root),
    missingModules: REQUIRED_MODULES.filter((name) => !resolvesModule(name)),
    artifacts: ARTIFACTS.map((path) => ({ path, exists: existsSync(join(root, path)) })),
    config: readConfig(),
    astroHome: readAstroHome(env),
    attachments: collectAttachmentFacts(env, options.checkPrivate, options.probeWritable),
    env,
  };
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  try {
    const report = runChecks(collectFacts(root));
    renderReport(report, (line) => console.log(line));
    process.exit(exitCode(report));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[fail] doctor ${redactSecrets(detail)}`);
    process.exit(1);
  }
}
