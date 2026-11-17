/**
 * Gate de permissão por chamada de tool (PERM-01, I-01).
 *
 * O allowlist do agente continua sendo a primeira barreira; este gate roda
 * depois dele e decide, por classe de ação, se a chamada segue (`allow`), se
 * precisa de aprovação humana (`ask`) ou se é negada (`deny`).
 *
 * Piso fixo: nenhum modo relaxa escrita em `.astro/`/`protectedPaths`, redação
 * de segredo ou confinamento no `cwd` — isso é aplicado pelas próprias tools e
 * continua valendo em `bypass`. O hard-block de path (ADR-0027, `classifyPath`)
 * é aplicado no gate de dispatch e também não é relaxado por modo.
 */
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { ToolError, isToolClass, type SideEffects, type Tool, type ToolClass, type ToolManifest } from "./tools/types";

export type PermissionMode = "bypass" | "allow-edits" | "ask";

/** Perfil de permissão do agente (#58, D-28): compõe com a allowlist (I-01). */
export type AgentPermission = "read-only" | "write" | "execute" | "full";

export const AGENT_PERMISSIONS: readonly AgentPermission[] = ["read-only", "write", "execute", "full"];

export function isAgentPermission(value: unknown): value is AgentPermission {
  return typeof value === "string" && (AGENT_PERMISSIONS as readonly string[]).includes(value);
}

const PERMISSION_RANK: Record<AgentPermission, number> = {
  "read-only": 0,
  write: 1,
  execute: 2,
  full: 3,
};

const PERMISSION_BY_CLASS: Record<ToolClass, AgentPermission> = {
  read_common: "read-only",
  read_critical: "read-only",
  edit: "write",
  delete: "write",
  shell: "execute",
  identity_swap: "full",
};

const PERMISSION_BY_NAME: Record<string, AgentPermission> = {
  read: "read-only",
  write: "write",
  execute: "execute",
  handoff: "full",
  spawn_agent: "execute",
};

/** Efeito externo eleva a permissão mesmo quando a classe declara leitura. */
const PERMISSION_BY_EFFECT: Record<SideEffects, AgentPermission> = {
  none: "read-only",
  filesystem: "write",
  network: "execute",
  process: "execute",
};

/** A mais permissiva entre duas (usada para compor os sinais do manifesto). */
export function highestPermission(a: AgentPermission, b: AgentPermission): AgentPermission {
  return PERMISSION_RANK[a] >= PERMISSION_RANK[b] ? a : b;
}

/** A mais restritiva entre duas (composição com allowlist/base executor). */
export function mostRestrictive(a: AgentPermission, b: AgentPermission): AgentPermission {
  return PERMISSION_RANK[a] <= PERMISSION_RANK[b] ? a : b;
}

/**
 * Permissão mínima exigida por uma tool: classe + nome de permissão +
 * `sideEffects`. Uma tool MCP `read_common` com `sideEffects: "network"` exige
 * `execute`; classe desconhecida exige `full` (falha fechada).
 */
export function requiredPermission(
  manifest: Pick<ToolManifest, "class" | "permission" | "sideEffects">,
): AgentPermission {
  const byClass = PERMISSION_BY_CLASS[manifest.class] ?? "full";
  const byName = PERMISSION_BY_NAME[manifest.permission] ?? "read-only";
  const byEffect = PERMISSION_BY_EFFECT[manifest.sideEffects] ?? "full";
  return [byClass, byName, byEffect].reduce(highestPermission);
}

export function permissionAllows(granted: AgentPermission, required: AgentPermission): boolean {
  return PERMISSION_RANK[granted] >= PERMISSION_RANK[required];
}

/** Classes de ação que o gate distingue (PERM-02 formaliza no manifesto). */
export type ActionClass =
  | "read_common"
  | "read_critical"
  | "edit"
  | "critical_write"
  | "delete"
  | "shell"
  | "identity";

export type PermissionDecision = "allow" | "ask" | "deny";

/** Escopo de uma aprovação humana (PERM-05, #266). */
export type PermissionGrant = "once" | "session";

/** Resposta do aprovador: `true`/`"once"` valem para a chamada; `"session"` até o fim. */
export type PermissionApproval = boolean | PermissionGrant;

/**
 * Grants em memória por sessão (PERM-05): nada vai para o disco. `once` não é
 * registrado; `session` fica até `clear()` (fim da sessão/run).
 */
export class PermissionGrants {
  readonly #session = new Set<string>();

  static key(action: ActionClass, name: string): string {
    return `${action}:${name}`;
  }

  has(key: string): boolean {
    return this.#session.has(key);
  }

  grant(key: string): void {
    this.#session.add(key);
  }

  /** Fecha a sessão: grants de sessão deixam de valer. */
  clear(): void {
    this.#session.clear();
  }
}

/** Pedido de aprovação entregue ao prompt (PERM-04). */
export interface ToolPermissionRequest {
  name: string;
  action: ActionClass;
  mode: PermissionMode;
  /**
   * Anexo estruturado para a UI revisar antes de aprovar (ex.: diff da tool
   * `edit`, #64). Deve chegar aqui JÁ redacted (I-03) e nunca é auditado.
   */
  diff?: { path: string; content: string };
}

/** Pedido de aprovação sem canal humano (sem TTY/approver): nega e para (I-08/I-19). */
export class PermissionPendingError extends Error {
  readonly code = "permission_pending";
  constructor(readonly request: { name: string; action: ActionClass; mode: PermissionMode }) {
    super(`permissão pendente para a tool "${request.name}" (modo ${request.mode}, ação ${request.action}): sem TTY não há aprovação`);
    this.name = "PermissionPendingError";
  }
}

export const DEFAULT_PERMISSION_MODE: PermissionMode = "ask";

export const PERMISSION_MODES: readonly PermissionMode[] = ["bypass", "allow-edits", "ask"];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

const MATRIX: Record<PermissionMode, Record<ActionClass, PermissionDecision>> = {
  bypass: {
    read_common: "allow", read_critical: "allow", edit: "allow", critical_write: "allow", delete: "allow", shell: "allow", identity: "ask",
  },
  "allow-edits": {
    read_common: "allow", read_critical: "ask", edit: "allow", critical_write: "ask", delete: "ask", shell: "ask", identity: "ask",
  },
  ask: {
    read_common: "allow", read_critical: "ask", edit: "ask", critical_write: "ask", delete: "ask", shell: "ask", identity: "ask",
  },
};

/** Aprovação impossível no momento (sem TTY): nega e para (I-08/I-19). */
export function nonInteractiveApprover(): (request: {
  name: string;
  action: ActionClass;
  mode: PermissionMode;
}) => never {
  return (request) => {
    throw new PermissionPendingError(request);
  };
}

/** Decisão do modo para a classe de ação; classe fora do vocabulário nega (#264). */
export function permissionDecision(mode: PermissionMode, action: ActionClass): PermissionDecision {
  const row = MATRIX[mode] as Record<string, PermissionDecision> | undefined;
  return row?.[action] ?? "deny";
}

/** Precedência do modo: explícito (CLI) > config > `ask` (CLI-01 liga a flag). */
export function resolvePermissionMode(explicit: unknown, configured: unknown): PermissionMode {
  if (isPermissionMode(explicit)) return explicit;
  if (isPermissionMode(configured)) return configured;
  return DEFAULT_PERMISSION_MODE;
}

/**
 * Lista única de caminhos críticos (PERM-03, I-03/I-11): estado do harness,
 * credenciais e config. Escrita nesses caminhos pede aprovação fora do
 * `bypass`; a leitura é `read_critical`. O piso de `.astro/`/`protectedPaths`
 * continua sendo bloqueio duro nas próprias tools.
 */
export const CRITICAL_PATH_SEGMENTS: readonly string[] = [".astro", ".git"];
export const CRITICAL_PATH_NAMES: readonly string[] = [".env", "astro.config.json", "auth.json", "vault.json"];
export const CRITICAL_PATH_PATTERN = /(^|[._-])(secret|secrets|token|tokens|key|keys|password|passwd|credential|credentials)([._-]|$)/i;

/** Caminho que casa com `CRITICAL_PATHS` (leitura crítica e escrita crítica). */
export function isCriticalPath(path: string): boolean {
  const segments = path.replace(/\\/g, "/").split("/").filter((part) => part.length > 0);
  const base = segments.at(-1) ?? "";
  if (CRITICAL_PATH_SEGMENTS.some((segment) => segments.includes(segment))) return true;
  if (segments.some((segment) => CRITICAL_PATH_NAMES.includes(segment))) return true;
  if (segments.some((segment) => CRITICAL_PATH_PATTERN.test(segment))) return true;
  return base.startsWith(".env.");
}

/** Compat: leitura crítica é o mesmo classificador de `isCriticalPath`. */
export function isCriticalReadPath(path: string): boolean {
  return isCriticalPath(path);
}

export interface ToolCallLike {
  name: string;
  input: unknown;
}

/** Classe da ação: manifesto (`class`) refinado por caminho crítico (PERM-02/#264); `sensitive` eleva escrita. */
export function actionClassOf(
  tool: Tool,
  call: ToolCallLike,
  pathClassOf?: (path: string) => "hard-block" | "sensitive" | "normal",
): ActionClass {
  const candidates = pathCandidatesOf(call);
  const critical = candidates.some((path) => isCriticalPath(path));
  const declared = tool.manifest.class;
  // Plugin não passa pelo typechecker: class ausente/desconhecida falha fechado (#264).
  if (!isToolClass(declared)) {
    throw new ToolError(`manifesto da tool "${call.name}" sem class válida: ausente ou fora do vocabulário`);
  }

  if (declared === "read_common" || declared === "read_critical") {
    // O manifesto só pode elevar, nunca rebaixar: read_critical declarado
    // permanece read_critical mesmo sem `path` no input.
    return declared === "read_critical" || critical ? "read_critical" : "read_common";
  }
  if (declared === "edit") {
    const sensitive = pathClassOf !== undefined && candidates.some((path) => pathClassOf(path) === "sensitive");
    return critical || sensitive ? "critical_write" : "edit";
  }
  if (declared === "identity_swap") return "identity";
  return declared; // delete | shell
}

/**
 * Reason code do hard-block de path no gate (ADR-0027, #391 slice 1): a
 * classe `hard-block` de `classifyPath` é DENY antes da MATRIX em TODOS os
 * modos, inclusive `bypass`. A negação cita path + classe, nunca conteúdo (I-03).
 */
export const PATH_HARD_BLOCKED = "path_hard_blocked";

/** Erro tipado do hard-block (ADR-0027): mensagem cita path/classe, nunca conteúdo (I-03). */
export class PathHardBlockedError extends Error {
  readonly code = PATH_HARD_BLOCKED;
  constructor(readonly displayPath: string, detail?: string) {
    super(detail ?? `caminho bloqueado (hard-block): ${displayPath} — negado em todos os modos, inclusive bypass (${PATH_HARD_BLOCKED})`);
    this.name = "PathHardBlockedError";
  }
}

/** `$ASTRO_HOME` do processo (ADR-0019/ADR-0027): env `ASTRO_HOME` ou default `~/.astro`. */
export function resolveAstroHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.ASTRO_HOME?.trim();
  return home === undefined || home === "" ? join(homedir(), ".astro") : home;
}

/** Raiz de artefatos, único subtree isento do hard-block em `$ASTRO_HOME` (ADR-0026): env `ASTRO_ARTIFACT_ROOT`. */
export function resolveArtifactRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const root = env.ASTRO_ARTIFACT_ROOT?.trim();
  return root === undefined || root === "" ? null : root;
}

/**
 * Exibição do caminho na negação (ADR-0027 Erros): path relativo dentro do
 * cwd, `<fora do cwd>` para path externo (`~` expandido); nunca conteúdo (I-03).
 */
export function denyDisplayPath(cwd: string, raw: string): string {
  let abs: string;
  if (raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")) {
    abs = join(homedir(), raw.slice(1));
  } else if (raw.startsWith("~")) {
    return "<fora do cwd>"; // `~outro-usuario` não resolve para a home atual
  } else {
    abs = raw;
  }
  abs = resolve(cwd, abs);
  const root = resolve(cwd);
  const rel = relative(root, abs);
  if (rel === "") return ".";
  if (rel.startsWith("..") || isAbsolute(rel)) return "<fora do cwd>";
  return rel;
}

/** Token path-like de comando shell: separador, `~`/`.` inicial, drive/UNC absoluto ou nome com extensão. */
function isPathLikeToken(token: string): boolean {
  if (token.length === 0) return false;
  if (token.includes("/") || token.includes("\\")) return true;
  if (token.startsWith("~") || token.startsWith(".")) return true;
  if (/^[a-zA-Z]:/.test(token) || token.startsWith("\\\\")) return true;
  return /\.[A-Za-z0-9]+$/.test(token);
}

/** Campos de path por tool (default `["path"]`; `lsp` declara `file`) e tools com default de `path` para o cwd (`grep`/`list_dir`: "."). */
const PATH_FIELDS: Record<string, readonly string[]> = { lsp: ["file"] };
const DEFAULT_PATH_FIELDS: readonly string[] = ["path"];
const CWD_DEFAULT_TOOLS: ReadonlySet<string> = new Set(["grep", "list_dir"]);
/** Candidatos a path do input (ADR-0027, #391 slice 1): `PATH_FIELDS` + default `path`; `CWD_DEFAULT_TOOLS` sem `path` ganha "."; `run_command` soma tokens path-like de `command` (token nu: slice 4). */
export function pathCandidatesOf(call: ToolCallLike): string[] {
  if (typeof call.input !== "object" || call.input === null) return [];
  const input = call.input as Record<string, unknown>;
  const candidates: string[] = [];
  for (const field of [...DEFAULT_PATH_FIELDS, ...(PATH_FIELDS[call.name] ?? [])]) {
    const value = input[field];
    if (typeof value === "string" && value.length > 0) candidates.push(value);
  }
  if (CWD_DEFAULT_TOOLS.has(call.name) && (typeof input.path !== "string" || input.path.length === 0)) candidates.push(".");
  if (call.name === "run_command" && typeof input.command === "string") {
    for (const token of input.command.split(/[\s'"]+/)) {
      if (isPathLikeToken(token)) candidates.push(token);
    }
  }
  return candidates;
}
