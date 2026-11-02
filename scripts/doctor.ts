/**
 * Diagnóstico local do ambiente, sem rede: versões, dependências, artefatos,
 * config, credenciais por NOME e ASTRO_HOME. Nunca imprime valor de segredo (I-03).
 */
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config";
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

/** Coleta fatos reais do checkout e do ambiente atual. */
export function collectFacts(root: string): DoctorFacts {
  const env = process.env;
  return {
    bunVersion: Bun.version,
    nodeVersion: readNodeVersion(),
    engines: readEngines(root),
    missingModules: REQUIRED_MODULES.filter((name) => !resolvesModule(name)),
    artifacts: ARTIFACTS.map((path) => ({ path, exists: existsSync(join(root, path)) })),
    config: readConfig(),
    astroHome: readAstroHome(env),
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
