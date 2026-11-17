/** Helpers dos fluxos de integração (#59): provider mock loopback e leitura de artefatos. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize, isWithin } from "../../src/tools/paths";

export interface TurnToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface Turn {
  content?: string;
  toolCalls?: TurnToolCall[];
}

export interface TestServer {
  port?: number;
  hostname?: string;
  url: URL;
  stop(force?: boolean): void;
}

export interface MockProviderState {
  calls: number;
  bodies: unknown[];
  models: string[];
  toolsPerCall: string[][];
}

export interface MockProvider {
  server: TestServer;
  state: MockProviderState;
  baseUrl: string;
}

/** Provider OpenAI-compat determinístico: uma resposta por turno (400 quando acabar). */
export function startMockProvider(turns: Turn[]): MockProvider {
  const state: MockProviderState = { calls: 0, bodies: [], models: [], toolsPerCall: [] };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.method === "GET") return Response.json({ data: [{ id: "mock-1" }] });
      const body = (await req.json()) as {
        model?: string;
        tools?: Array<{ function?: { name?: string } }>;
      };
      state.bodies.push(body);
      state.models.push(body.model ?? "");
      state.toolsPerCall.push((body.tools ?? []).flatMap((tool) => (tool.function?.name === undefined ? [] : [tool.function.name])));
      const turn = turns[state.calls];
      state.calls += 1;
      if (turn === undefined) {
        return Response.json({ error: { message: "integração sem turno declarado" } }, { status: 400 });
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
  return { server, state, baseUrl: `http://127.0.0.1:${server.port}/v1` };
}

/** Servidor que sempre falha (provider primário em outage). */
export function startDownProvider(): TestServer {
  return Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("outage", { status: 500 }) });
}

export function newWorkspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `astro-${prefix}-`));
}

/** Remove apenas workspaces sob o tmpdir real; nunca um caminho arbitrário. */
export function removeWorkspace(dir: string): void {
  const root = canonicalize(tmpdir());
  const target = canonicalize(dir);
  if (target !== root && isWithin(root, target)) rmSync(dir, { recursive: true, force: true });
}

export function writeConfig(dir: string, config: Record<string, unknown>): string {
  const path = join(dir, "astro.config.json");
  writeFileSync(path, JSON.stringify(config, null, 2), "utf8");
  return path;
}

export interface AuditEvent {
  run: string;
  agent?: string;
  tipo: string;
  payload: Record<string, unknown>;
}

function isAuditEvent(value: unknown): value is AuditEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as { run?: unknown; tipo?: unknown; payload?: unknown };
  return typeof event.run === "string" && typeof event.tipo === "string"
    && typeof event.payload === "object" && event.payload !== null;
}

export function readAudit(dir: string): { text: string; events: AuditEvent[] } {
  const text = readFileSync(join(dir, ".astro", "audit.jsonl"), "utf8");
  const events = text.trim() === ""
    ? []
    : text.trim().split("\n")
      .map((line) => JSON.parse(line) as unknown)
      .filter(isAuditEvent);
  return { text, events };
}

/** Mensagens de um request mock sem cast cego; entradas fora do shape são descartadas. */
export function requestMessages(body: unknown): Array<{ role: string; content: string }> {
  if (typeof body !== "object" || body === null) return [];
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message) => {
    if (typeof message !== "object" || message === null) return [];
    const { role, content } = message as { role?: unknown; content?: unknown };
    return typeof role === "string" && typeof content === "string" ? [{ role, content }] : [];
  });
}
