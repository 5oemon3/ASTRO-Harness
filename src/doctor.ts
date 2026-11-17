/**
 * Diagnóstico local do ambiente, sem rede: versões, dependências, artefatos,
 * config, credenciais por NOME e ASTRO_HOME. Nunca imprime valor de segredo (I-03).
 */
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DEFAULT_ATTACHMENTS, loadConfig, loadConfigRaw, type MCPServerConfig } from "./core/config";
import { loadEffectiveConfig } from "./providers/profiles";
import { readGcMarker, resolveArtifactRoot, validateArtifactRoot } from "./attachments/store";
import { headerEnvNames } from "./mcp/headers";
import { resolveAstroHome } from "./permissions";
import { redactSecrets } from "./sanitize-external";
import { isVaultCredentialRef, isVaultRef } from "./secrets";
import { loadSkillsFromRoot } from "./skills/loader";

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
  kind?: string;
  /** `codex-oauth`: o arquivo de credenciais está legível no disco. */
  credentialsReadable?: boolean;
}

/** Seção `mcpServers` já validada pela config; só nomes de env, nunca valores (I-03). */
export interface McpFact {
  servers: number;
  enabled: number;
  missingHeaderEnv: string[];
}

/** Skills carregadas das raízes `project`/`user`; avisos do loader já redigidos. */
export interface SkillsFact {
  project: number;
  user: number;
  warnings: string[];
}

/** Fatos de disco: escrita no cwd (ledger/audit) e espaço livre no volume do estado. */
export interface DiskFact {
  cwd: string;
  writable: boolean;
  freeBytes?: number;
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
    mcp?: McpFact;
    /** Camada global (`$ASTRO_HOME/config.json`), validada só como JSON objeto. */
    global?: { path: string; present: boolean; error?: string };
  };
  astroHome: {
    path: string;
    exists: boolean;
    writable: boolean;
    /** Declaração inválida (relativo/`..`): falha fechada. */
    error?: string;
    /** Forma incomum aceita na leitura (link sem destino, destino não-diretório). */
    warning?: string;
    /** Observação informativa (link simbólico resolvido), sem mudar o nível. */
    note?: string;
  };
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
  skills?: SkillsFact;
  disk?: DiskFact;
  env: Record<string, string | undefined>;
}

/** Ações aplicadas por `--fix` e falhas encontradas; nunca inclui valor de segredo. */
export interface FixReport {
  applied: string[];
  errors: string[];
}

export interface DoctorSummary {
  ok: number;
  warn: number;
  fail: number;
}

/** Payload estável de `astro doctor --json`. */
export interface DoctorJson {
  schema: "doctor/v1";
  checks: Check[];
  summary: DoctorSummary;
  fixes?: FixReport;
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
    if (provider.credentialsReadable !== undefined) {
      return provider.credentialsReadable
        ? { level: "ok", label, detail: "arquivo de credenciais legível" } satisfies Check
        : { level: "warn", label, detail: "arquivo de credenciais ausente ou ilegível" } satisfies Check;
    }
    if (provider.credentialRef === undefined) return { level: "ok", label, detail: "sem chave" } satisfies Check;
    if (isVaultRef(provider.credentialRef)) {
      return isVaultCredentialRef(provider.credentialRef)
        ? { level: "ok", label, detail: "credencial no cofre local" } satisfies Check
        : { level: "warn", label, detail: "referência de cofre inválida" } satisfies Check;
    }
    const present = (env[provider.credentialRef] ?? "").length > 0;
    return present
      ? { level: "ok", label, detail: `${provider.credentialRef} presente` } satisfies Check
      : { level: "warn", label, detail: `${provider.credentialRef} ausente no ambiente` } satisfies Check;
  });
}

function mcpCheck(fact: McpFact | undefined): Check | undefined {
  if (fact === undefined) return undefined;
  const detail = fact.servers === 0
    ? "nenhum servidor configurado"
    : `${fact.servers} servidor${fact.servers === 1 ? "" : "es"} · ${fact.enabled} habilitado${fact.enabled === 1 ? "" : "s"}`;
  return fact.missingHeaderEnv.length === 0
    ? { level: "ok", label: "mcp", detail }
    : { level: "warn", label: "mcp", detail: `${detail} · header env ausente: ${fact.missingHeaderEnv.join(", ")}` };
}

function skillsCheck(fact: SkillsFact | undefined): Check | undefined {
  if (fact === undefined) return undefined;
  const total = fact.project + fact.user;
  if (fact.warnings.length > 0) {
    return { level: "warn", label: "skills", detail: fact.warnings.join("; ") };
  }
  if (total === 0) return { level: "ok", label: "skills", detail: "nenhuma skill instalada (opcional)" };
  return {
    level: "ok",
    label: "skills",
    detail: `${total} válida${total === 1 ? "" : "s"} (${fact.project} no projeto, ${fact.user} do usuário)`,
  };
}

function diskCheck(fact: DiskFact | undefined): Check | undefined {
  if (fact === undefined) return undefined;
  if (!fact.writable) {
    return { level: "fail", label: "disco", detail: `${fact.cwd} atributo de escrita do SO negado; ledger/audit podem não gravar` };
  }
  const free = fact.freeBytes === undefined ? "" : ` · ${formatBytes(fact.freeBytes)} livres`;
  // `accessSync` vê o atributo do SO, não prova escrita (ACL do Windows pode negar).
  return { level: "ok", label: "disco", detail: `${fact.cwd} atributo de escrita do SO presente${free} (não é prova de escrita)` };
}

/** Redação central de label e detalhe: segredo em nome/caminho nunca chega à saída (I-03). */
function sanitizeCheck(check: Check): Check {
  return {
    ...check,
    label: redactSecrets(check.label),
    ...(check.detail === undefined ? {} : { detail: redactSecrets(check.detail) }),
  };
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
    const mcp = mcpCheck(facts.config.mcp);
    if (mcp !== undefined) checks.push(mcp);
  }

  const globalConfig = facts.config.global;
  if (globalConfig !== undefined && globalConfig.present) {
    checks.push(globalConfig.error === undefined
      ? { level: "ok", label: "config global", detail: `${globalConfig.path} válida` }
      : { level: "fail", label: "config global", detail: globalConfig.error });
  }

  if (facts.astroHome.error !== undefined) {
    checks.push({ level: "fail", label: "astro home", detail: facts.astroHome.error });
  } else if (facts.astroHome.warning !== undefined) {
    checks.push({ level: "warn", label: "astro home", detail: `${facts.astroHome.path} ${facts.astroHome.warning}` });
  } else if (!facts.astroHome.exists) {
    checks.push({ level: "warn", label: "astro home", detail: `${facts.astroHome.path} ausente; será criado no primeiro uso` });
  } else if (!facts.astroHome.writable) {
    checks.push({ level: "fail", label: "astro home", detail: `${facts.astroHome.path} sem permissão de escrita` });
  } else {
    const note = facts.astroHome.note === undefined ? "" : ` · ${facts.astroHome.note}`;
    checks.push({ level: "ok", label: "astro home", detail: `${facts.astroHome.path} gravável${note}` });
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

  const skills = skillsCheck(facts.skills);
  if (skills !== undefined) checks.push(skills);
  const disk = diskCheck(facts.disk);
  if (disk !== undefined) checks.push(disk);

  return { checks: checks.map(sanitizeCheck) };
}

/** Contagem por nível, na ordem estável do payload JSON. */
export function summarize(report: DoctorReport): DoctorSummary {
  const count = (level: CheckLevel): number => report.checks.filter((check) => check.level === level).length;
  return { ok: count("ok"), warn: count("warn"), fail: count("fail") };
}

/** Payload de `--json`; `fixes` só aparece quando `--fix` foi pedido. */
export function doctorJson(report: DoctorReport, fixes?: FixReport): DoctorJson {
  return {
    schema: "doctor/v1",
    checks: report.checks,
    summary: summarize(report),
    ...(fixes === undefined ? {} : { fixes }),
  };
}

/** Imprime uma linha por check e o resumo. */
export function renderReport(report: DoctorReport, write: (line: string) => void): void {
  for (const check of report.checks) {
    write(`[${check.level}] ${check.label}${check.detail === undefined ? "" : ` ${check.detail}`}`);
  }
  const count = summarize(report);
  write(`Resumo: ${count.ok} ok, ${count.warn} warn, ${count.fail} fail`);
}

export function exitCode(report: DoctorReport): 0 | 1 {
  return report.checks.some((check) => check.level === "fail") ? 1 : 0;
}

/** `$ASTRO_HOME` validado: `path` é o absoluto resolvido; `error` é fail-closed. */
interface AstroHomeValidation {
  path: string;
  error?: string;
}

/**
 * Validação de escrita: `$ASTRO_HOME` só aceita absoluto, sem segmento `..` e
 * sem link no destino final. Qualquer desvio é fail-closed — nenhuma escrita
 * acontece com caminho relativo, que resolveria contra o cwd.
 */
function validateAstroHomeForWrite(env: NodeJS.ProcessEnv): AstroHomeValidation {
  const raw = env.ASTRO_HOME?.trim();
  const declared = raw === undefined || raw === "" ? join(homedir(), ".astro") : raw;
  if (!isAbsolute(declared)) {
    return { path: declared, error: `ASTRO_HOME precisa ser um caminho absoluto: ${declared}` };
  }
  if (declared.split(/[\\/]+/).includes("..")) {
    return { path: declared, error: `ASTRO_HOME não pode conter "..": ${declared}` };
  }
  const resolved = resolve(declared);
  try {
    const stats = lstatSync(resolved);
    if (stats.isSymbolicLink()) {
      return { path: resolved, error: `ASTRO_HOME não pode ser link simbólico: ${resolved}` };
    }
    if (!stats.isDirectory()) {
      return { path: resolved, error: `${resolved} existe e não é um diretório` };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const detail = error instanceof Error ? error.message : String(error);
      return { path: resolved, error: `não foi possível inspecionar ${resolved}: ${detail}` };
    }
  }
  return { path: resolved };
}

/** Leitura de `$ASTRO_HOME`: aceita link no destino final, como o runtime. */
interface AstroHomeRead {
  path: string;
  error?: string;
  warning?: string;
  note?: string;
}

function realpathOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Resolve `$ASTRO_HOME` para leitura: relativo/`..` continuam fail-closed,
 * mas um link simbólico é resolvido para o alvo real (o runtime aceita link).
 * Link sem destino ou alvo que não é diretório vira warn, nunca fail.
 */
function resolveAstroHomeForRead(env: NodeJS.ProcessEnv): AstroHomeRead {
  const raw = env.ASTRO_HOME?.trim();
  const declared = raw === undefined || raw === "" ? join(homedir(), ".astro") : raw;
  if (!isAbsolute(declared)) {
    return { path: declared, error: `ASTRO_HOME precisa ser um caminho absoluto: ${declared}` };
  }
  if (declared.split(/[\\/]+/).includes("..")) {
    return { path: declared, error: `ASTRO_HOME não pode conter "..": ${declared}` };
  }
  const resolved = resolve(declared);
  let link = false;
  try {
    link = lstatSync(resolved).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const detail = error instanceof Error ? error.message : String(error);
      return { path: resolved, error: `não foi possível inspecionar ${resolved}: ${detail}` };
    }
    return { path: resolved };
  }
  if (!link) {
    try {
      if (!statSync(resolved).isDirectory()) return { path: resolved, warning: "não é um diretório" };
    } catch {
      return { path: resolved };
    }
    return { path: resolved };
  }
  const target = realpathOrUndefined(resolved);
  if (target === undefined) {
    return { path: resolved, warning: "link simbólico sem destino; será criado no primeiro uso" };
  }
  try {
    if (!statSync(target).isDirectory()) return { path: target, warning: "link simbólico não aponta para um diretório" };
  } catch {
    return { path: target, warning: "link simbólico sem destino" };
  }
  return { path: target, note: "link simbólico" };
}

/**
 * `--fix`: só estado local seguro e idempotente. Cria `$ASTRO_HOME` (0700)
 * quando ausente; nunca cria a raiz de artefatos, o `.astro` do projeto nem
 * toca em credenciais. Erros saem redigidos e sem derrubar o processo.
 */
export function applyFixes(env: NodeJS.ProcessEnv = process.env): FixReport {
  const home = validateAstroHomeForWrite(env);
  if (home.error !== undefined) return { applied: [], errors: [redactSecrets(home.error)] };
  const applied: string[] = [];
  const errors: string[] = [];
  try {
    if (!existsSync(home.path)) {
      mkdirSync(home.path, { recursive: true, mode: 0o700 });
      applied.push(redactSecrets(`criado ${home.path}`));
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    errors.push(redactSecrets(`não foi possível criar ${home.path}: ${detail}`));
  }
  return { applied, errors };
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

/** `~`/`~/x` para o home do usuário; nunca resolve `~outro`. */
function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) return join(homedir(), input.slice(2));
  return input;
}

function readableFile(path: string): boolean {
  try {
    const target = expandHome(path);
    accessSync(target, constants.R_OK);
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

/** Só nomes de env referenciados por headers (`env:NOME`); valores nunca entram no fato (I-03). */
function readMcpFact(
  servers: Record<string, MCPServerConfig> | undefined,
  env: NodeJS.ProcessEnv,
): McpFact {
  const list = Object.values(servers ?? {});
  const missing = new Set<string>();
  for (const server of list) {
    if (!server.enabled) continue;
    for (const name of headerEnvNames(server.headers)) {
      if ((env[name] ?? "").length === 0) missing.add(name);
    }
  }
  return {
    servers: list.length,
    enabled: list.filter((server) => server.enabled).length,
    missingHeaderEnv: [...missing].sort(),
  };
}

/** Camada global: só JSON objeto é validado; config parcial é válida por contrato. */
function readGlobalConfig(env: NodeJS.ProcessEnv): DoctorFacts["config"]["global"] {
  const home = resolveAstroHomeForRead(env);
  if (home.error !== undefined) return undefined; // o check de astro home já reporta
  const path = join(home.path, "config.json");
  if (!existsSync(path)) return { path, present: false };
  try {
    loadConfigRaw(path);
    return { path, present: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { path, present: true, error: redactSecrets(detail) };
  }
}

function readConfig(env: NodeJS.ProcessEnv): DoctorFacts["config"] {
  const path = join(process.cwd(), "astro.config.json");
  const global = readGlobalConfig(env);
  const base = { path, ...(global === undefined ? {} : { global }) };
  if (!existsSync(path)) return { ...base, present: false };
  try {
    const config = loadConfig(path);
    const providers = Object.entries(config.providers).map(([id, provider]) => ({
      id,
      kind: provider.kind,
      ...("credentialRef" in provider && typeof provider.credentialRef === "string"
        ? { credentialRef: provider.credentialRef }
        : {}),
      ...("credentialsPath" in provider && typeof provider.credentialsPath === "string"
        ? { credentialsReadable: readableFile(provider.credentialsPath) }
        : {}),
    }));
    return { ...base, present: true, providers, mcp: readMcpFact(config.mcpServers, env) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ...base, present: true, error: redactSecrets(detail) };
  }
}

function readAstroHome(env: Record<string, string | undefined>): DoctorFacts["astroHome"] {
  const home = resolveAstroHomeForRead(env);
  const extra = {
    ...(home.warning === undefined ? {} : { warning: home.warning }),
    ...(home.note === undefined ? {} : { note: home.note }),
  };
  if (home.error !== undefined) {
    return { path: home.path, exists: false, writable: false, error: home.error, ...extra };
  }
  if (!existsSync(home.path)) return { path: home.path, exists: false, writable: false, ...extra };
  try {
    accessSync(home.path, constants.W_OK);
    return { path: home.path, exists: true, writable: true, ...extra };
  } catch {
    return { path: home.path, exists: true, writable: false, ...extra };
  }
}

function loadSkillRoot(
  root: string,
  source: "project" | "user",
  warnings: string[],
): ReturnType<typeof loadSkillsFromRoot> {
  try {
    return loadSkillsFromRoot(root, source, (message) => warnings.push(message));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    warnings.push(`raiz ${source} ilegível: ${detail}`);
    return [];
  }
}

/**
 * Skills opcionais: carrega as raízes reais e converte avisos em fato (sem
 * prompt, I-03). A raiz do usuário é a mesma do runtime (`~/.astro/skills`),
 * independente de `$ASTRO_HOME`; fica injetável para teste não tocar o home real.
 */
function collectSkillFacts(userRoot: string): SkillsFact {
  const warnings: string[] = [];
  const project = loadSkillRoot(join(process.cwd(), ".astro", "skills"), "project", warnings);
  const user = loadSkillRoot(userRoot, "user", warnings);
  return { project: project.length, user: user.length, warnings: warnings.slice(0, 5) };
}

function collectDiskFacts(env: NodeJS.ProcessEnv): DiskFact {
  const cwd = process.cwd();
  let writable = false;
  try {
    accessSync(cwd, constants.W_OK);
    writable = true;
  } catch {
    // sem escrita: ledger/audit não gravam
  }
  let freeBytes: number | undefined;
  try {
    const home = resolveAstroHomeForRead(env);
    const stats = statfsSync(home.error === undefined && existsSync(home.path) ? home.path : cwd);
    const bytes = Number(stats.bavail) * Number(stats.bsize);
    if (Number.isFinite(bytes) && bytes >= 0) freeBytes = bytes;
  } catch {
    // statfs indisponível na plataforma: check segue só com a permissão
  }
  return { cwd, writable, ...(freeBytes === undefined ? {} : { freeBytes }) };
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
    /** Raiz de skills do usuário; default é a do runtime (`~/.astro/skills`). */
    userSkillsRoot?: string;
  } = {},
): DoctorFacts {
  const env = options.env ?? process.env;
  return {
    bunVersion: Bun.version,
    nodeVersion: readNodeVersion(),
    engines: readEngines(root),
    missingModules: REQUIRED_MODULES.filter((name) => !resolvesModule(name)),
    artifacts: ARTIFACTS.map((path) => ({ path, exists: existsSync(join(root, path)) })),
    config: readConfig(env),
    astroHome: readAstroHome(env),
    attachments: collectAttachmentFacts(env, options.checkPrivate, options.probeWritable),
    skills: collectSkillFacts(options.userSkillsRoot ?? join(homedir(), ".astro", "skills")),
    disk: collectDiskFacts(env),
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
