/**
 * Gate de permissão por chamada de tool (PERM-01, I-01).
 *
 * O allowlist do agente continua sendo a primeira barreira; este gate roda
 * depois dele e decide, por classe de ação, se a chamada segue (`allow`), se
 * precisa de aprovação humana (`ask`) ou se é negada (`deny`).
 *
 * Piso fixo: nenhum modo relaxa escrita em `.astro/`/`protectedPaths`, redação
 * de segredo ou confinamento no `cwd` — isso é aplicado pelas próprias tools e
 * continua valendo em `bypass`.
 */
import type { SideEffects, Tool, ToolClass, ToolManifest } from "./tools/types";

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

/** Decisão do modo para a classe de ação. */
export function permissionDecision(mode: PermissionMode, action: ActionClass): PermissionDecision {
  return MATRIX[mode][action];
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

/** Classe da ação: manifesto (`class`) refinado por caminho crítico (PERM-02/#264). */
export function actionClassOf(tool: Tool, call: ToolCallLike): ActionClass {
  const path = (call.input as { path?: unknown } | null)?.path;
  const critical = typeof path === "string" && isCriticalPath(path);
  const declared = tool.manifest.class;

  if (declared === "read_common" || declared === "read_critical") {
    // O manifesto só pode elevar, nunca rebaixar: read_critical declarado
    // permanece read_critical mesmo sem `path` no input.
    return declared === "read_critical" || critical ? "read_critical" : "read_common";
  }
  if (declared === "edit") return critical ? "critical_write" : "edit";
  if (declared === "identity_swap") return "identity";
  return declared; // delete | shell
}
