/**
 * Runner de cenários do golden dataset (#59): cases multi-step que precisam de
 * tool events, MCP/web mock e configuração de app, sem rede real. O mock de
 * provider consome `turns` declarados no `scenario.json`; o app roda de verdade
 * (allowlist, ledger, audit, fallback, multi-agent) contra servidores loopback.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { runTask } from "../app";
import { validateConfig, type AstroConfig } from "../config";
import { runHealthCheck, type HealthReport } from "../health";
import { looksLikeSecret } from "../secrets";
import { parseSkill } from "../skills/loader";
import { resolveWithin } from "../tools/paths";

export interface ScenarioToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ScenarioTurn {
  content?: string;
  toolCalls?: ScenarioToolCall[];
}

export interface ScenarioMcpServer {
  tools: Array<{ name: string; description?: string; text: string }>;
  /** Responde 500 em `tools/call` (transporte cai e o run não aborta). */
  failCall?: boolean;
}

export interface ScenarioSearchServer {
  results: Array<{ title: string; url: string; snippet: string }>;
  /** Primeira chamada responde 429 com `Retry-After: 0` (retry determinístico). */
  retryOnce?: boolean;
}

export interface ScenarioPageServer {
  html: string;
}

export interface ScenarioExpectations {
  /** Texto final exato do run. */
  final?: string;
  /** Mensagem que o run deve lançar (case de falha esperada). */
  error?: string;
  /** Tipos de evento de audit que precisam existir. */
  audit?: string[];
  /** Substrings que precisam existir no audit bruto. */
  auditText?: string[];
  /** Tipos de evento que não podem existir. */
  auditAbsent?: string[];
  /** Substrings que não podem existir no audit bruto. */
  auditTextAbsent?: string[];
  /** Número exato de chamadas ao provider. */
  requests?: number;
  /** Modelos enviados ao provider, na ordem. */
  models?: string[];
  /** Substrings em qualquer request ao provider (prompt, tool_calls ou tool results). */
  requestsContain?: string[];
  /** Substrings que precisam existir apenas em mensagens `role:"tool"` (resultado real da tool). */
  toolResultsContain?: string[];
  /** Eventos de audit com payload parcial obrigatório. */
  auditEvents?: Array<{ tipo: string; payload?: Record<string, unknown> }>;
  /** Tools que não podem ser expostas ao modelo (allowlist). */
  toolsAbsent?: string[];
  /** Número exato de chamadas ao backend de web_search. */
  searchRequests?: number;
  /** Agentes que precisam aparecer no run. */
  agents?: string[];
  /** Arquivos que não podem existir no workspace. */
  absentFiles?: string[];
  /** Resultado de `runHealthCheck` (kind=health). */
  health?: { status: string; checks?: Record<string, string> };
}

export interface ScenarioSpec {
  schema: 1;
  kind?: "app" | "health";
  /** Overrides profundos sobre a config base (placeholders inclusos). */
  config?: Record<string, unknown>;
  env?: Record<string, string>;
  /** Arquivos do case copiados para o cwd antes do run (`.astro/` é gitignored). */
  seed?: Array<{ from: string; to: string }>;
  /** Diretórios de skill cujo `.sha256` é calculado dos bytes de `SKILL.md`; schema 1 aceita também o caminho legado `<dir>/SKILL.md`. */
  sidecars?: string[];
  turns?: ScenarioTurn[];
  mcp?: ScenarioMcpServer;
  search?: ScenarioSearchServer;
  page?: ScenarioPageServer;
  expect?: ScenarioExpectations;
}

export interface ScenarioResult {
  tokens: number;
  diffSummary: string[];
}

interface MockServer {
  stop(force?: boolean): void;
}

type LoopbackServer = ReturnType<typeof Bun.serve>;

/** Único ponto de criação dos mocks: sempre 127.0.0.1, nunca todas as interfaces. */
function serveLoopback(options: { fetch: (request: Request) => Response | Promise<Response> }): LoopbackServer {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: options.fetch });
  if (server.hostname !== "127.0.0.1") {
    server.stop(true);
    throw new Error(`mock de cenário ligou em "${server.hostname}" em vez de 127.0.0.1`);
  }
  return server;
}

interface ProviderState {
  bodies: unknown[];
  models: string[];
  calls: number;
}

interface SearchState {
  requests: number;
}

interface AuditEventLike {
  tipo?: unknown;
  payload?: unknown;
}

/** Chaves aceitas em `expect`; typo falha fechado em vez de virar assertion ignorada. */
const EXPECT_KEYS: ReadonlySet<string> = new Set([
  "final", "error", "audit", "auditText", "auditAbsent", "auditTextAbsent",
  "requests", "models", "requestsContain", "toolResultsContain", "auditEvents",
  "toolsAbsent", "searchRequests", "agents", "absentFiles", "health",
]);

const BASE_CONFIG: Record<string, unknown> = {
  providers: {
    mock: { kind: "openai-compat", baseUrl: "{{providerUrl}}", credentialRef: "EVAL_KEY" },
  },
  models: [{
    provider: "mock", id: "mock-1", tags: ["writing-code", "tools"], context: 8192,
    capabilities: { tools: true },
  }],
  agent: { model: "mock/mock-1", maxSteps: 8, tools: ["read_file", "write_file"] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
};

const PLACEHOLDER = /\{\{([A-Za-z0-9_]+)\}\}/g;

function substituteString(value: string, vars: Record<string, string>): string {
  return value.replace(PLACEHOLDER, (match, name: string) => vars[name] ?? match);
}

function substitute<T>(value: T, vars: Record<string, string>): T {
  if (typeof value === "string") return substituteString(value, vars) as T;
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, vars)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, substitute(entry, vars)]),
    ) as T;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Merge profundo: objetos combinam, listas e escalares substituem. */
function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    out[key] = isRecord(current) && isRecord(value) ? deepMerge(current, value) : value;
  }
  return out;
}

/** Placeholders de URL que o runner resolve para servidores loopback próprios. */
const URL_PLACEHOLDERS = new Set(["providerUrl", "providerDownUrl", "mcpUrl", "searchUrl", "pageUrl"]);

/** URL de fixture só aponta para loopback; o resto da rede fica fora do golden. */
function assertLoopbackUrl(raw: string, field: string): void {
  const placeholder = /^\{\{([A-Za-z0-9_]+)\}\}$/.exec(raw);
  if (placeholder !== null) {
    if (!URL_PLACEHOLDERS.has(placeholder[1]!)) {
      throw new Error(`cenário com placeholder de URL desconhecido em ${field}: ${raw}`);
    }
    return; // resolvido para 127.0.0.1 pelo próprio runner
  }
  if (raw.includes("{{")) {
    throw new Error(`cenário com placeholder de URL não suportado em ${field}: ${raw}`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`cenário com URL inválida em ${field}: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`cenário com URL não-http em ${field}: ${raw}`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (!loopback) throw new Error(`cenário com URL não-loopback em ${field}: ${raw}`);
}

function configUrls(config: Record<string, unknown> | undefined): Array<{ field: string; url: string }> {
  if (config === undefined) return [];
  const urls: Array<{ field: string; url: string }> = [];
  const add = (field: string, value: unknown): void => {
    if (typeof value === "string") urls.push({ field, url: value });
  };
  if (isRecord(config.providers)) {
    for (const [name, provider] of Object.entries(config.providers)) {
      if (isRecord(provider)) add(`providers.${name}.baseUrl`, provider.baseUrl);
    }
  }
  if (isRecord(config.mcpServers)) {
    for (const [name, server] of Object.entries(config.mcpServers)) {
      if (isRecord(server)) add(`mcpServers.${name}.url`, server.url);
    }
  }
  if (isRecord(config.webSearch)) add("webSearch.baseUrl", config.webSearch.baseUrl);
  if (isRecord(config.team)) add("team.auditWebhook", config.team.auditWebhook);
  if (isRecord(config.telemetry)) add("telemetry.endpoint", config.telemetry.endpoint);
  return urls;
}

/** Recusa qualquer URL de fixture que não seja loopback (I-11, sem rede real). */
function assertLoopbackFixtures(spec: ScenarioSpec): void {
  for (const { field, url } of configUrls(spec.config)) assertLoopbackUrl(url, field);
  for (const [index, turn] of (spec.turns ?? []).entries()) {
    for (const [callIndex, call] of (turn.toolCalls ?? []).entries()) {
      const raw = call.arguments.url;
      if (raw === undefined) continue;
      const field = `turns[${index}].toolCalls[${callIndex}].url`;
      if (typeof raw !== "string") throw new Error(`cenário com URL inválida em ${field}`);
      assertLoopbackUrl(raw, field);
    }
  }
}

/** Nomes de env cujo valor aparece no texto observado (audit/ledger). */
function leakedEnvNames(env: Record<string, string>, texts: readonly string[]): string[] {
  const combined = texts.join("\n");
  const leaked: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value.length === 0) continue;
    // Valor honesto curto não é segredo; só nomes de credencial ou valores com cara de segredo.
    if (value.length < 8 && !/KEY$/i.test(name) && !looksLikeSecret(value)) continue;
    // Valor curto só casa como token JSON exato; evita falso positivo em números/booleanos.
    const found = value.length >= 4
      ? combined.includes(value)
      : combined.includes(JSON.stringify(value));
    if (found) leaked.push(name);
  }
  return leaked;
}

function assertKnownExpectKeys(expect: ScenarioExpectations | undefined): void {
  for (const key of Object.keys(expect ?? {})) {
    if (!EXPECT_KEYS.has(key)) throw new Error(`cenário com expect desconhecido: ${key}`);
  }
}

const UNRESOLVED_PLACEHOLDER = /\{\{[A-Za-z0-9_]+\}\}/;

/** Depois da substituição, placeholder restante é erro (nunca vira texto literal). */
function assertNoUnresolvedPlaceholders(value: unknown, field: string): void {
  if (typeof value === "string") {
    if (UNRESOLVED_PLACEHOLDER.test(value)) {
      throw new Error(`cenário com placeholder não resolvido em ${field}: ${value}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) assertNoUnresolvedPlaceholders(entry, `${field}[${index}]`);
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) assertNoUnresolvedPlaceholders(entry, `${field}.${key}`);
  }
}

/** Texto apenas das mensagens `role:"tool"` enviadas ao provider. */
function toolResultsText(bodies: unknown[]): string {
  const parts: string[] = [];
  for (const body of bodies) {
    if (!isRecord(body) || !Array.isArray(body.messages)) continue;
    for (const message of body.messages) {
      if (!isRecord(message) || message.role !== "tool") continue;
      if (typeof message.content === "string") parts.push(message.content);
      else if (message.content !== undefined) parts.push(JSON.stringify(message.content));
    }
  }
  return parts.join("\n");
}

function payloadMatches(actual: unknown, expected: Record<string, unknown> | undefined): boolean {
  if (expected === undefined) return true;
  if (!isRecord(actual)) return false;
  return Object.entries(expected).every(([key, value]) =>
    isRecord(value) && isRecord(actual[key])
      ? payloadMatches(actual[key], value)
      : JSON.stringify(actual[key]) === JSON.stringify(value));
}

/** Provider OpenAI-compat determinístico: uma resposta por turno declarado. */
function startProvider(turns: ScenarioTurn[], state: ProviderState): { server: MockServer; url: string } {
  const server = serveLoopback({
    async fetch(req) {
      if (req.method === "GET") {
        // health check (F6-6): GET /models
        return Response.json({ data: [{ id: "mock-1" }] });
      }
      const body = (await req.json()) as { model?: string };
      state.bodies.push(body);
      state.models.push(body.model ?? "");
      const turn = turns[state.calls];
      state.calls += 1;
      if (turn === undefined) {
        return Response.json({ error: { message: "cenário sem turno declarado" } }, { status: 400 });
      }
      const toolCalls = (turn.toolCalls ?? []).map((call, index) => ({
        id: `c${state.calls}_${index}`,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      }));
      return Response.json({
        choices: [{
          message: {
            content: turn.content ?? "",
            ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    },
  });
  return { server, url: `http://127.0.0.1:${server.port}/v1` };
}

/** Servidor primário em outage (fallback C6). */
function startDownServer(): { server: MockServer; url: string } {
  const server = serveLoopback({ fetch: () => new Response("outage", { status: 500 }) });
  return { server, url: `http://127.0.0.1:${server.port}/v1` };
}

/** Servidor MCP streamable HTTP mínimo (initialize, tools/list, tools/call). */
function startMcp(spec: ScenarioMcpServer): { server: MockServer; url: string } {
  const server = serveLoopback({
    async fetch(req) {
      const body = (await req.json()) as {
        id?: number | string;
        method?: string;
        params?: { name?: string };
      };
      if (body.method === "initialize") {
        return Response.json({
          jsonrpc: "2.0", id: body.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "eval-mcp", version: "1" },
          },
        });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/list") {
        return Response.json({
          jsonrpc: "2.0", id: body.id,
          result: {
            tools: spec.tools.map((tool) => ({
              name: tool.name,
              description: tool.description ?? tool.name,
              inputSchema: { type: "object" },
            })),
          },
        });
      }
      if (body.method === "tools/call") {
        if (spec.failCall === true) return new Response("mcp disconnected", { status: 500 });
        const tool = spec.tools.find((entry) => entry.name === body.params?.name);
        return Response.json({
          jsonrpc: "2.0", id: body.id,
          result: { content: [{ type: "text", text: tool?.text ?? "" }] },
        });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, error: { message: "método desconhecido" } }, { status: 400 });
    },
  });
  return { server, url: `http://127.0.0.1:${server.port}/mcp` };
}

/** Backend web_search mock (formato Exa) com 429 opcional na primeira chamada. */
function startSearch(spec: ScenarioSearchServer, state: SearchState): { server: MockServer; url: string } {
  const server = serveLoopback({
    fetch() {
      state.requests += 1;
      if (spec.retryOnce === true && state.requests === 1) {
        return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
      }
      return Response.json({
        results: spec.results.map((result) => ({ title: result.title, url: result.url, text: result.snippet })),
      });
    },
  });
  return { server, url: `http://127.0.0.1:${server.port}` };
}

/** Página HTML para web_fetch. */
function startPage(spec: ScenarioPageServer): { server: MockServer; url: string } {
  const server = serveLoopback({
    fetch: () => new Response(spec.html, { headers: { "content-type": "text/html; charset=utf-8" } }),
  });
  return { server, url: `http://127.0.0.1:${server.port}/page` };
}

function readAudit(path: string): { text: string; events: AuditEventLike[] } {
  if (!existsSync(path)) return { text: "", events: [] };
  const text = readFileSync(path, "utf8");
  const events = text.trim() === ""
    ? []
    : text.trim().split("\n").map((line) => JSON.parse(line) as AuditEventLike);
  return { text, events };
}

interface Observation {
  cwd: string;
  final?: string;
  error?: string;
  auditText: string;
  auditEvents: AuditEventLike[];
  models: string[];
  bodies: unknown[];
  searchRequests: number;
  toolResultsText: string;
  agents: string[];
  health?: HealthReport;
}

function checkExpectations(expect: ScenarioExpectations, obs: Observation): string[] {
  const diff: string[] = [];
  if (expect.error !== undefined) {
    if (obs.error === undefined) diff.push(`erro esperado não ocorreu: ${expect.error}`);
    else if (!obs.error.includes(expect.error)) diff.push(`erro "${obs.error}" não contém "${expect.error}"`);
  } else if (obs.error !== undefined) {
    diff.push(`erro na execução: ${obs.error}`);
  }
  if (expect.final !== undefined && obs.final !== expect.final) {
    diff.push(`final divergente: esperado "${expect.final}", recebido "${obs.final ?? "(sem final)"}"`);
  }
  const types = new Set(obs.auditEvents.map((event) => (typeof event.tipo === "string" ? event.tipo : "")));
  for (const tipo of expect.audit ?? []) {
    if (!types.has(tipo)) diff.push(`audit sem evento "${tipo}"`);
  }
  for (const tipo of expect.auditAbsent ?? []) {
    if (types.has(tipo)) diff.push(`audit contém evento proibido "${tipo}"`);
  }
  for (const needle of expect.auditText ?? []) {
    if (!obs.auditText.includes(needle)) diff.push(`audit sem "${needle}"`);
  }
  for (const needle of expect.auditTextAbsent ?? []) {
    if (obs.auditText.includes(needle)) diff.push(`audit contém "${needle}"`);
  }
  if (expect.requests !== undefined && obs.bodies.length !== expect.requests) {
    diff.push(`requests: esperado ${expect.requests}, recebido ${obs.bodies.length}`);
  }
  if (expect.models !== undefined && JSON.stringify(obs.models) !== JSON.stringify(expect.models)) {
    diff.push(`models: esperado ${JSON.stringify(expect.models)}, recebido ${JSON.stringify(obs.models)}`);
  }
  const bodiesText = JSON.stringify(obs.bodies);
  for (const needle of expect.requestsContain ?? []) {
    if (!bodiesText.includes(needle)) diff.push(`requests sem "${needle}"`);
  }
  for (const needle of expect.toolResultsContain ?? []) {
    if (!obs.toolResultsText.includes(needle)) diff.push(`toolResultsContain: nenhum resultado de tool contém "${needle}"`);
  }
  for (const expected of expect.auditEvents ?? []) {
    const found = obs.auditEvents.some((event) =>
      event.tipo === expected.tipo && payloadMatches(event.payload, expected.payload));
    if (!found) diff.push(`audit sem evento "${expected.tipo}" com payload esperado`);
  }
  const exposedTools = obs.bodies.flatMap((body) => {
    if (!isRecord(body) || !Array.isArray(body.tools)) return [];
    return body.tools.flatMap((tool) => {
      if (!isRecord(tool) || !isRecord(tool.function)) return [];
      return typeof tool.function.name === "string" ? [tool.function.name] : [];
    });
  });
  for (const name of expect.toolsAbsent ?? []) {
    if (exposedTools.includes(name)) diff.push(`tool "${name}" não deveria ser exposta ao modelo`);
  }
  if (expect.searchRequests !== undefined && obs.searchRequests !== expect.searchRequests) {
    diff.push(`web_search requests: esperado ${expect.searchRequests}, recebido ${obs.searchRequests}`);
  }
  for (const agent of expect.agents ?? []) {
    if (!obs.agents.includes(agent)) diff.push(`agente "${agent}" ausente (${obs.agents.join(", ")})`);
  }
  for (const file of expect.absentFiles ?? []) {
    try {
      if (existsSync(resolveWithin(obs.cwd, file))) diff.push(`${file}: não deveria existir`);
    } catch (error) {
      diff.push(`absentFiles: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (expect.health !== undefined) {
    if (obs.health === undefined) diff.push("health: relatório ausente");
    else {
      if (obs.health.status !== expect.health.status) {
        diff.push(`health.status: esperado "${expect.health.status}", recebido "${obs.health.status}"`);
      }
      for (const [name, status] of Object.entries(expect.health.checks ?? {})) {
        const check = obs.health.checks.find((entry) => entry.name === name);
        if (check === undefined) diff.push(`health sem check "${name}"`);
        else if (check.status !== status) diff.push(`health check "${name}": esperado ${status}, recebido ${check.status}`);
      }
    }
  }
  return diff;
}

/** Defaults de backend de web_search quando `baseUrl` não é declarado (espelha src/tools/web-search.ts). */
const WEB_SEARCH_DEFAULT_BASE: Record<string, string> = {
  exa: "https://api.exa.ai",
  brave: "https://api.search.brave.com",
  google: "https://www.googleapis.com/customsearch/v1",
  custom: "",
};

/** Valida a config efetiva (defaults inclusos), não só os overrides do scenario. */
function assertEffectiveLoopback(config: AstroConfig): void {
  for (const [name, provider] of Object.entries(config.providers)) {
    if (provider.kind === "codex-oauth") {
      throw new Error(`cenário não permite provider codex-oauth: ${name}`);
    }
    const baseUrl = (provider as { baseUrl?: unknown }).baseUrl;
    if (typeof baseUrl === "string") assertLoopbackUrl(baseUrl, `providers.${name}.baseUrl`);
  }
  for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
    if (server.transport === "stdio" || server.command !== undefined) {
      throw new Error(`cenário não permite MCP stdio: ${name}`);
    }
    if (typeof server.url === "string") assertLoopbackUrl(server.url, `mcpServers.${name}.url`);
  }
  if (config.webSearch !== undefined) {
    const base = config.webSearch.baseUrl ?? WEB_SEARCH_DEFAULT_BASE[config.webSearch.provider];
    if (base === undefined || base === "") {
      throw new Error(`cenário com webSearch.baseUrl ausente; o endpoint não é loopback`);
    }
    assertLoopbackUrl(base, "webSearch.baseUrl");
  }
  if (config.team?.auditWebhook !== undefined) {
    assertLoopbackUrl(config.team.auditWebhook, "team.auditWebhook");
  }
  if (config.telemetry?.enabled === true) {
    assertLoopbackUrl(config.telemetry.endpoint, "telemetry.endpoint");
  }
  const toolLists = [config.agent.tools, ...Object.values(config.agents ?? {}).map((agent) => agent.tools ?? [])];
  if (config.tools?.run_command !== undefined || toolLists.some((tools) => tools.includes("run_command"))) {
    throw new Error("cenário não permite run_command");
  }
}

/** Recusa link em qualquer nível da árvore de seed antes de copiar. */
function assertSeedTree(path: string, field: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`cenário seed com link: ${field}`);
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(path)) assertSeedTree(join(path, entry), `${field}/${entry}`);
}

/** Executa um `scenario.json`; o harness compara os arquivos esperados depois. */
export async function runScenario(
  spec: ScenarioSpec,
  opts: { cwd: string; caseDir: string; task: string },
): Promise<ScenarioResult> {
  if (spec.schema !== 1) throw new Error(`scenario schema inválido: ${String(spec.schema)}`);
  const kind = spec.kind ?? "app";
  if (kind !== "app" && kind !== "health") throw new Error(`scenario kind inválido: ${String(kind)}`);
  if (kind === "app" && !Array.isArray(spec.turns)) throw new Error("scenario app exige turns[]");
  assertKnownExpectKeys(spec.expect);
  assertLoopbackFixtures(spec);

  const servers: MockServer[] = [];
  const providerState: ProviderState = { bodies: [], models: [], calls: 0 };
  const searchState: SearchState = { requests: 0 };
  const vars: Record<string, string> = {};
  const scenarioEnv: Record<string, string> = { EVAL_KEY: "eval-provider-secret", ...spec.env };
  const evalHome = join(opts.cwd, ".astro", "eval-home");
  const env: Record<string, string> = {
    ...scenarioEnv,
    ASTRO_HOME: evalHome,
    ASTRO_NO_GLOBAL_CONFIG: "1",
  };
  // Os mocks falam loopback; a config do golden não deve ir à rede pública (I-11).
  const previousPrivate = process.env.ASTRO_ALLOW_PRIVATE_URLS;
  const previousHome = process.env.ASTRO_HOME;
  const previousNoGlobal = process.env.ASTRO_NO_GLOBAL_CONFIG;
  process.env.ASTRO_ALLOW_PRIVATE_URLS = "1";
  process.env.ASTRO_HOME = evalHome;
  process.env.ASTRO_NO_GLOBAL_CONFIG = "1";
  try {
    for (const entry of spec.seed ?? []) {
      // Fonte: só dentro do caseDir e sem link em nenhum nível da árvore.
      const source = resolveWithin(opts.caseDir, entry.from);
      assertSeedTree(source, entry.from);
      const destination = resolveWithin(opts.cwd, entry.to);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(source, destination, { recursive: lstatSync(source).isDirectory() });
    }
    for (const relativePath of spec.sidecars ?? []) {
      // Schema 1 aceita o diretório da skill e o caminho legado `<dir>/SKILL.md`.
      const relativeDir = basename(relativePath).toLowerCase() === "skill.md"
        ? dirname(relativePath)
        : relativePath;
      const skillDir = resolveWithin(opts.cwd, relativeDir); // recusa junction/symlink antes de ler
      const skillFile = join(skillDir, "SKILL.md");
      const sidecar = resolveWithin(opts.cwd, join(relativeDir, ".sha256"));
      if (lstatSync(skillFile).isSymbolicLink()) {
        throw new Error(`cenário sidecar com SKILL.md link: ${relativeDir}`);
      }
      if (existsSync(sidecar) && lstatSync(sidecar).isSymbolicLink()) {
        throw new Error(`cenário sidecar não pode ser link: ${relativeDir}/.sha256`);
      }
      // Contrato do loader/installer: <skillDir>/.sha256, digest de SKILL.md (BOM removido).
      const sidecarDigest = parseSkill(readFileSync(skillFile, "utf8"), "project", skillFile).manifest.sha256;
      writeFileSync(sidecar, `${sidecarDigest}\n`, "utf8");
    }
    const page = spec.page === undefined ? undefined : startPage(spec.page);
    if (page !== undefined) { servers.push(page.server); vars.pageUrl = page.url; }
    const search = spec.search === undefined ? undefined : startSearch(spec.search, searchState);
    if (search !== undefined) { servers.push(search.server); vars.searchUrl = search.url; }
    const mcp = spec.mcp === undefined ? undefined : startMcp(spec.mcp);
    if (mcp !== undefined) { servers.push(mcp.server); vars.mcpUrl = mcp.url; }
    const down = startDownServer();
    servers.push(down.server);
    vars.providerDownUrl = down.url;

    const turns = substitute(spec.turns ?? [], vars);
    assertNoUnresolvedPlaceholders(turns, "turns");
    const provider = startProvider(turns, providerState);
    servers.push(provider.server);
    vars.providerUrl = provider.url;

    const rawConfig = substitute(deepMerge(BASE_CONFIG, spec.config ?? {}), vars);
    assertNoUnresolvedPlaceholders(rawConfig, "config");
    const effectiveConfig = validateConfig(rawConfig);
    assertEffectiveLoopback(effectiveConfig);
    const auditPath = resolveWithin(opts.cwd, effectiveConfig.paths.audit);
    const ledgerPath = resolveWithin(opts.cwd, effectiveConfig.paths.ledger);
    const configPath = join(opts.cwd, "astro.config.json");
    writeFileSync(configPath, JSON.stringify(rawConfig, null, 2), "utf8");

    let report: Awaited<ReturnType<typeof runTask>> | undefined;
    let error: string | undefined;
    let health: HealthReport | undefined;

    if (kind === "health") {
      health = await runHealthCheck(effectiveConfig, env, { timeoutMs: 2_000 });
    } else {
      try {
        report = await runTask({
          configPath,
          task: opts.task,
          cwd: opts.cwd,
          env,
          approveTool: () => true,
          approveSwap: () => true,
          // O golden usa sempre o provider/mock do scenario.json, nunca a seleção salva no ASTRO_HOME.
          ignoreStoredSelection: true,
          // Skills do usuário ficam dentro do case; nunca ~/.astro/skills do host.
          skillsUserRoot: join(opts.cwd, ".astro", "user-skills"),
        });
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
    }

    const audit = readAudit(auditPath);
    const ledgerText = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : "";
    const observation: Observation = {
      cwd: opts.cwd,
      ...(report === undefined ? {} : { final: report.final }),
      ...(error === undefined ? {} : { error }),
      auditText: audit.text,
      auditEvents: audit.events,
      models: providerState.models,
      bodies: providerState.bodies,
      searchRequests: searchState.requests,
      toolResultsText: toolResultsText(providerState.bodies),
      agents: report?.agentsUsed ?? [],
      ...(health === undefined ? {} : { health }),
    };
    const diffSummary = checkExpectations(spec.expect ?? {}, observation);
    // I-03: todo valor de env do cenário, no audit e no ledger.
    for (const name of leakedEnvNames(scenarioEnv, [audit.text, ledgerText])) {
      diffSummary.push(`segredo de "${name}" apareceu no audit/ledger`);
    }
    return { tokens: report === undefined ? 0 : report.tokensIn + report.tokensOut, diffSummary };
  } finally {
    for (const server of servers.reverse()) {
      try { server.stop(true); } catch { /* servidor já parado */ }
    }
    if (previousPrivate === undefined) delete process.env.ASTRO_ALLOW_PRIVATE_URLS;
    else process.env.ASTRO_ALLOW_PRIVATE_URLS = previousPrivate;
    if (previousHome === undefined) delete process.env.ASTRO_HOME;
    else process.env.ASTRO_HOME = previousHome;
    if (previousNoGlobal === undefined) delete process.env.ASTRO_NO_GLOBAL_CONFIG;
    else process.env.ASTRO_NO_GLOBAL_CONFIG = previousNoGlobal;
  }
}
