/**
 * Sonda de conexão MCP para `astro doctor --online` (C2, #61): reusa o
 * `MCPClient`, aplica o orçamento no transporte e nunca lança. Servidor hostil
 * pode ecoar credencial no erro: os valores do servidor viram `[REDACTED]` (I-03).
 */
import { MCP_TRANSPORTS, type MCPServerConfig } from "../core/config";
import { redactSecrets } from "../sanitize-external";
import { MCPClient } from "./client";
import { headerEnvNames } from "./headers";

export interface McpProbeResult {
  /** Slug estável do contrato JSON: `mcp:<servidor>`. */
  name: string;
  level: "ok" | "error";
  message: string;
}

/** Só o necessário do cliente: stub nos testes não abre processo nem socket. */
export interface McpProbeClient {
  readonly serverInfo: { name: string };
  close(): void;
}

export type McpConnector = (
  server: MCPServerConfig,
  env: NodeJS.ProcessEnv,
  secretEnvNames: readonly string[],
) => Promise<McpProbeClient>;

export interface McpProbeOptions {
  env?: NodeJS.ProcessEnv;
  /** Teto por servidor (default 5s). `--online` usa um orçamento só: health + MCP. */
  timeoutMs?: number;
  connect?: McpConnector;
}

export const DEFAULT_MCP_PROBE_TIMEOUT_MS = 5_000;

/** Credenciais do servidor: header `env:NOME` resolvido no env + `env` explícito. */
function serverSecrets(server: MCPServerConfig, env: NodeJS.ProcessEnv): string[] {
  const fromHeaders = headerEnvNames(server.headers).map((name) => env[name] ?? "");
  return [...fromHeaders, ...Object.values(server.env ?? {})]
    .filter((value) => value.length > 0)
    .sort((a, b) => b.length - a.length); // maior primeiro: não sobra pedaço do valor
}

/** Motivo seguro: segredo conhecido, redação genérica e URL (query pode ter chave) fora. */
function safeReason(error: unknown, secrets: readonly string[]): string {
  let text = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) text = text.split(secret).join("[REDACTED]");
  return redactSecrets(text).replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]").trim();
}
/** Corrida externa: defesa para transporte que ignore o próprio `timeoutMs`. */
function withTimeout(work: Promise<McpProbeClient>, timeoutMs: number): Promise<McpProbeClient> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout de ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/** Fechar transporte hostil não pode derrubar o check. */
function closeQuietly(client: McpProbeClient | undefined): void {
  try {
    client?.close();
  } catch {
    // transporte já quebrado: o check vale pelo handshake
  }
}

/** Um servidor: `ok` no handshake, `error` em recusa/timeout. `undefined` = desabilitado. */
export async function probeMcpServer(
  name: string,
  server: MCPServerConfig,
  options: McpProbeOptions = {},
): Promise<McpProbeResult | undefined> {
  if (!server.enabled) return undefined; // o doctor também filtra; aqui é a garantia da API
  const slug = `mcp:${name}`;
  // Defesa em profundidade: `validateMcpServers` já recusa transporte fora da lista.
  if (!MCP_TRANSPORTS.includes(server.transport)) {
    return { name: slug, level: "error", message: `transporte "${String(server.transport)}" não suportado; conexão não tentada` };
  }
  const env = options.env ?? process.env;
  const secrets = serverSecrets(server, env);
  const reason = (error: unknown): string => safeReason(error, secrets);
  const timeoutMs = options.timeoutMs ?? DEFAULT_MCP_PROBE_TIMEOUT_MS;
  // O transporte é quem espera de fato (spawn/fetch): o orçamento tem de chegar
  // nele, senão um servidor travado segura o processo pelos 30s da config. O
  // timeout do próprio servidor vale quando for menor.
  const budget = Math.min(server.timeoutMs, timeoutMs);
  let pending: Promise<McpProbeClient>;
  try {
    pending = (options.connect ?? MCPClient.connect)({ ...server, timeoutMs: budget }, env, headerEnvNames(server.headers));
  } catch (error) {
    return { name: slug, level: "error", message: reason(error) };
  }
  let client: McpProbeClient | undefined;
  try {
    client = await withTimeout(pending, timeoutMs);
    return { name: slug, level: "ok", message: `conectado via ${server.transport}` };
  } catch (error) {
    void pending.then((late) => closeQuietly(late)).catch(() => undefined); // cliente tardio não fica aberto
    return { name: slug, level: "error", message: reason(error) };
  } finally {
    closeQuietly(client);
  }
}
