#!/usr/bin/env bun
import { runTask, type RunReport, createProvider } from "./app";
import { installCancellation } from "./signal";
import { isPermissionMode, nonInteractiveApprover, type PermissionMode } from "./permissions";
import { defaultArgs, isInteractive } from "./cli-default";
import { existsSync } from "node:fs";
import { loadConfig, validateConfig } from "./config";
import { loadEffectiveConfig } from "./provider/profiles";
import { ProfileManager } from "./provider/profile-manager";
import { formatVaultImport, importVaultCredential } from "./provider/vault-import";
import { Ledger } from "./ledger";
import { formatHandoffShow } from "./handoff/lifecycle";
import { formatCostByAgent } from "./team";
import { Registry } from "./registry";
import { formatPoolList } from "./pool";
import { formatAgentsList } from "./agent-manager";
import { buildModelCatalog, formatModelCatalog, formatSeedList } from "./model-catalog";
import { PROVIDER_CATALOG } from "./provider/catalog";
import { evalFailsThreshold, runEval, writeBaseline, type EvalReport } from "./eval/harness";
import { runBenchmark, type BenchReport } from "./eval/bench";
import { Metrics, startMetricsServer } from "./metrics";
import { formatBudgetEstimate } from "./budget";
import { replayRun } from "./replay";
import { AgentSession } from "./chat/agent-session";
import { SessionStore } from "./chat/store";
import { runRepl } from "./chat/repl";
import { chatApprovers } from "./chat/approvers";
import { nodeReplIO } from "./chat/node-io";
import { runHealthCheck, runPoolHealthCheck, formatProvidersList, testProvider } from "./health";
import { GitHubConfigRegistry, prepareConfigForPush, preparePulledConfig } from "./config-share";
import { runSkillsCommand } from "./skills/cli";
import { runMcpCommand } from "./mcp/cli";
import { redactSecrets } from "./sanitize-external";
import { resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { SwapApprover } from "./approval";
import type { BudgetChoice, BudgetDecider, BudgetStatus } from "./budget";
import { trustChoice, trustPrompt, type TrustAsk } from "./trust";
import { continueTask, findCheckpointAgents, loadCheckpoint, type NoProgressDecider } from "./loop-guard";

/** Aprovação interativa de troca (F-19); sem TTY retorna undefined (runtime nega/pending). */
function ttyApprover(): SwapApprover | undefined {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return undefined;
  return async (request) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const from = `${request.from.provider}/${request.from.model ?? "?"}`;
      const to = `${request.to.provider}/${request.to.model ?? "?"}`;
      const cost = request.costDeltaUsd === undefined || request.costDeltaUsd === null
        ? ""
        : `; custo Δ US$${request.costDeltaUsd.toFixed(2)}/1M`;
      const caps = request.capabilityDelta === undefined || request.capabilityDelta.length === 0
        ? ""
        : `; capacidades ${request.capabilityDelta.join(",")}`;
      const answer = await new Promise<boolean>((resolve) => {
        // Stream encerrado sem resposta (EOF/Ctrl-D) nega em vez de pendurar
        rl.once("close", () => resolve(false));
        rl.question(`troca de identidade: ${from} → ${to} (motivo: ${request.reason}${cost}${caps}). aprovar? [s/N] `,
          (input) => resolve(/^(s|sim|y|yes)$/i.test(input.trim())));
      });
      return answer;
    } finally {
      rl.close();
    }
  };
}

/** Decisor interativo de budget (B4, D-30); sem TTY retorna undefined (não interativo). */
function ttyBudgetDecider(): BudgetDecider | undefined {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return undefined;
  return async (status, context) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const limit = status.limitUsd === null ? "sem limite" : `US$ ${status.limitUsd}`;
      const answer = await new Promise<string>((resolve) => {
        rl.once("close", () => resolve("p")); // EOF nega/para
        rl.question(`budget esgotado (${status.estimate} / ${limit}). [c] continuar, [l] baixar esforço, [a] aumentar limite, [p] parar? `, resolve);
      });
      const choice = answer.trim().toLowerCase();
      if (choice.startsWith("a")) {
        return askBudgetRaise(rl, status, context?.committedUsd ?? status.spentUsd ?? 0);
      }
      return choice.startsWith("c") ? "continue_same" : choice.startsWith("l") ? "lower_effort" : "stop";
    } finally {
      rl.close();
    }
  };
}

/** Pergunta uma linha; EOF resolve vazio (o chamador trata como parar). */
function askBudgetLine(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise<string>((resolve) => {
    rl.once("close", () => resolve(""));
    rl.question(question, resolve);
  });
}

/**
 * Aumento aprovado (D-30): pede valor absoluto acima do gasto e do limite;
 * acima do teto exige `CONFIRMAR` e um novo teto maior. Inválido repete.
 */
async function askBudgetRaise(
  rl: ReturnType<typeof createInterface>,
  status: BudgetStatus,
  committedUsd: number,
): Promise<BudgetChoice> {
  const committed = committedUsd;
  const ceiling = status.hardCeilingUsd ?? null;
  const oldLimit = status.limitUsd === null ? "sem limite" : `US$ ${status.limitUsd}`;
  for (;;) {
    const raw = (await askBudgetLine(rl,
      `novo limite absoluto em US$ (gasto + reserva atual US$ ${committed.toFixed(6)}, limite atual ${oldLimit}): `)).trim();
    if (raw === "") return "stop";
    const value = Number(raw.replace(",", "."));
    if (!Number.isFinite(value) || value <= committed || (status.limitUsd !== null && value <= status.limitUsd)) {
      process.stdout.write("o valor precisa ser maior que o gasto + reserva atual e que o limite atual\n");
      continue;
    }
    if (ceiling === null || value <= ceiling) {
      return { choice: "raise", limitUsd: value };
    }
    const confirmed = (await askBudgetLine(rl,
      `o valor excede o teto físico US$ ${ceiling}; digite CONFIRMAR para elevar o teto: `)).trim();
    if (confirmed !== "CONFIRMAR") return "stop";
    for (;;) {
      const rawCeiling = (await askBudgetLine(rl,
        `novo teto absoluto em US$ (maior que US$ ${ceiling} e >= ao novo limite): `)).trim();
      if (rawCeiling === "") return "stop";
      const nextCeiling = Number(rawCeiling.replace(",", "."));
      if (!Number.isFinite(nextCeiling) || nextCeiling <= ceiling || nextCeiling < value || nextCeiling <= committed) {
        process.stdout.write("o teto precisa ser maior que o atual e pelo menos o novo limite\n");
        continue;
      }
      return { choice: "raise", limitUsd: value, hardCeilingUsd: nextCeiling, confirmedCeiling: true };
    }
  }
}

/** Pergunta de trust da pasta (I-11, #267); sem TTY retorna undefined (run prossegue sem persistir). */
function ttyTrustAsk(): TrustAsk | undefined {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return undefined;
  return async (cwd) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      // EOF (Ctrl-D) = não confiar
      return trustChoice(await new Promise<string>((resolve) => {
        rl.once("close", () => resolve(""));
        rl.question(trustPrompt(cwd), resolve);
      }));
    } finally {
      rl.close();
    }
  };
}

/** Decisor TTY de não-progresso do loop (L6, #135); sem TTY retorna undefined (para seguro). */
function ttyNoProgressDecider(): NoProgressDecider | undefined {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return undefined;
  return async (info) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      // EOF (Ctrl-D) = não continuar
      const answer = await new Promise<string>((resolve) => {
        rl.once("close", () => resolve(""));
        rl.question(`sem progresso por ${info.segments} segmentos (turno ${info.step}). continuar? [s/N] `, resolve);
      });
      return /^(s|sim|y|yes)$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  };
}

/** Agente dono do checkpoint a continuar; exige --agent quando há mais de um. */
function resolveContinueAgent(cwd: string, run: string): string {
  const agents = findCheckpointAgents(cwd, run);
  if (agents.length === 0) throw new Error(`checkpoint não encontrado para o run "${run}"`);
  if (agents.length > 1) {
    throw new Error(`run "${run}" tem checkpoints de vários agentes (${agents.join(", ")}); use --agent`);
  }
  return agents[0]!;
}

const USAGE = `Uso:
  astro run "<pedido>" [--config <path>] [--cwd <dir>] [--provider <name>] [--permission-mode <modo>]
  astro eval [--threshold <0..1>] [--golden <dir>] [--report <path>] [--baseline <path>] [--write-baseline]
  astro bench [--config <path>] [--models <filtro>] [--runs <n>] [--out <dir>]
  astro serve [--port <n>]
  astro replay <run-id> --task "<pedido>" [--config <path>] [--cwd <dir>]
  astro chat [--config <path>] [--cwd <dir>] [--provider <name>] [--permission-mode <modo>]
  astro tui [--config <path>] [--cwd <dir>] [--provider <name>] [--permission-mode <modo>]
  astro resume <run-id> --task "<pedido>" [--config <path>] [--cwd <dir>]
  astro continue <run-id> [--task "<pedido>"] [--agent <name>] [--config <path>] [--cwd <dir>]
  astro health [--config <path>]
  astro providers <health|list|test|vault-import> [--config <path>] [--apply] [--allow-plain]
  astro handoff show <handoff_id> [--config <path>]
  astro cost --by-agent [--config <path>]
  astro pool <list|health> [--config <path>]
  astro agents list [--config <path>]
  astro models list [--config <path>] [--seeds] [--json]
  astro config <push|pull> <org/projeto> [--registry <owner/repo>] [--config <path>] [--token <t>] [--allow-plugins]
  astro skills <list|show|validate|install|remove|verify> [--user] [--force]
  astro mcp <list|test <server> <tool>> [--args <json>] [--config <path>]
  astro --help

Opções:
  --config <path>  configuração do Astro (default: astro.config.json)
  --provider <name> provider ativo (default: store/env/agent.model)
  --cwd <dir>      diretório de trabalho do agente (default: diretório atual)
  --permission-mode <bypass|allow-edits|ask>  modo do gate de tool (vence permissions.mode)
  --help           mostra este texto

Eval:
  --threshold <0..1>   mínimo de pass rate (default: 0.85)
  --golden <dir>       diretório do golden dataset (default: eval/golden)
  --report <path>      escreve o relatório JSON no caminho
  --baseline <path>    baseline para detecção de regressões (default: eval/baseline.json)
  --write-baseline     grava baseline a partir desta execução

Bench:
  --models <filtro>    filtra modelos por substring (vírgula separa vários)
  --runs <n>           repetições da suite (default: 1)
  --out <dir>          diretório dos relatórios (default: eval)`;

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

interface RunCommand {
  task: string;
  configPath: string;
  cwd?: string;
  provider?: string;
  /** `--permission-mode`: vence a config (CLI > config > ask). */
  permissionMode?: PermissionMode;
}

interface EvalCommand {
  threshold: number;
  goldenRoot: string;
  reportPath?: string;
  baselinePath: string;
  writeBaseline: boolean;
}

interface BenchCommand {
  configPath: string;
  models?: string;
  runs: number;
  outDir: string;
}

interface ServeCommand {
  port: number;
}

interface ReplayCommand {
  runId: string;
  task: string;
  configPath: string;
  cwd?: string;
}

interface ResumeCommand extends ReplayCommand {}

interface ContinueCommand {
  runId: string;
  configPath: string;
  cwd?: string;
  task?: string;
  agent?: string;
}

interface ChatCommand {
  configPath: string;
  cwd?: string;
  provider?: string;
  configExplicit: boolean;
  permissionMode?: PermissionMode;
}

interface TuiCommand {
  configPath: string;
  cwd?: string;
  provider?: string;
  configExplicit: boolean;
  permissionMode?: PermissionMode;
}

interface HealthCommand {
  configPath: string;
}

interface ProvidersCommand {
  action: "health" | "list" | "test" | "vault-import";
  name?: string;
  configPath: string;
  apply?: boolean;
  allowPlain?: boolean;
}

interface PoolCommand {
  action: "list" | "health";
  configPath: string;
}

interface AgentsCommand {
  action: "list";
  configPath: string;
}

interface ModelsCommand {
  action: "list";
  configPath: string;
  seeds: boolean;
  json: boolean;
}

interface HandoffShowCommand {
  handoffId: string;
  configPath: string;
}

interface CostCommand {
  configPath: string;
}

interface ConfigShareCommand {
  action: "push" | "pull";
  name: string;
  registry?: string;
  configPath: string;
  token?: string;
  allowPlugins?: boolean;
}

type ParsedCommand =
  | { kind: "help" }
  | { kind: "run"; options: RunCommand }
  | { kind: "eval"; options: EvalCommand }
  | { kind: "bench"; options: BenchCommand }
  | { kind: "serve"; options: ServeCommand }
  | { kind: "replay"; options: ReplayCommand }
  | { kind: "resume"; options: ResumeCommand }
  | { kind: "continue"; options: ContinueCommand }
  | { kind: "chat"; options: ChatCommand }
  | { kind: "tui"; options: TuiCommand }
  | { kind: "health"; options: HealthCommand }
  | { kind: "providers"; options: ProvidersCommand }
  | { kind: "pool"; options: PoolCommand }
  | { kind: "agents"; options: AgentsCommand }
  | { kind: "models"; options: ModelsCommand }
  | { kind: "handoff"; options: HandoffShowCommand }
  | { kind: "cost"; options: CostCommand }
  | { kind: "config"; options: ConfigShareCommand }
  | { kind: "skills"; args: string[] }
  | { kind: "mcp"; args: string[] };

/** Parser comum de `replay`/`resume` (run-id posicional + --task/--config/--cwd). */
function parseReplayLike(command: "replay" | "resume", rest: string[]): ReplayCommand {
  let configPath = "astro.config.json";
  let cwd: string | undefined;
  let runId: string | undefined;
  let task: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg === "--config" || arg === "--cwd" || arg === "--task") {
      if (seen.has(arg)) throw new UsageError(`${arg} duplicado`);
      seen.add(arg);
      const value = rest.at(i + 1);
      if (value === undefined || value.startsWith("-")) throw new UsageError(`falta o valor de ${arg}`);
      i++;
      if (arg === "--config") configPath = value;
      else if (arg === "--cwd") cwd = value;
      else task = value;
      continue;
    }
    if (arg.startsWith("-")) throw new UsageError(`opção desconhecida: "${arg}"`);
    if (runId !== undefined) throw new UsageError(`argumento inesperado: "${arg}"`);
    runId = arg;
  }
  if (runId === undefined) throw new UsageError(`falta o run-id; use: ${command} <run-id> --task "<pedido>"`);
  if (task === undefined) throw new UsageError(`falta a tarefa; use: ${command} <run-id> --task "<pedido>"`);
  return { runId, task, configPath, ...(cwd === undefined ? {} : { cwd }) };
}

/** Parser de `continue`: run-id posicional, task opcional, agent opcional. */
function parseContinue(rest: string[]): ContinueCommand {
  let configPath = "astro.config.json";
  let cwd: string | undefined;
  let runId: string | undefined;
  let task: string | undefined;
  let agent: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg === "--config" || arg === "--cwd" || arg === "--task" || arg === "--agent") {
      if (seen.has(arg)) throw new UsageError(`${arg} duplicado`);
      seen.add(arg);
      const value = rest.at(i + 1);
      if (value === undefined || value.startsWith("-")) throw new UsageError(`falta o valor de ${arg}`);
      i++;
      if (arg === "--config") configPath = value;
      else if (arg === "--cwd") cwd = value;
      else if (arg === "--task") task = value;
      else agent = value;
      continue;
    }
    if (arg.startsWith("-")) throw new UsageError(`opção desconhecida: "${arg}"`);
    if (runId !== undefined) throw new UsageError(`argumento inesperado: "${arg}"`);
    runId = arg;
  }
  if (runId === undefined) {
    throw new UsageError(`falta o run-id; use: continue <run-id> [--task "<pedido>"]`);
  }
  return {
    runId,
    configPath,
    ...(cwd === undefined ? {} : { cwd }),
    ...(task === undefined ? {} : { task }),
    ...(agent === undefined ? {} : { agent }),
  };
}

/** Valor de `--permission-mode` validado; vence a config (CLI > config > ask). */
function permissionModeValue(arg: string, value: string | undefined): PermissionMode {
  if (value === undefined || value.startsWith("-")) throw new UsageError(`falta o valor de ${arg}`);
  if (!isPermissionMode(value)) {
    throw new UsageError(`--permission-mode aceita "bypass", "allow-edits" ou "ask"`);
  }
  return value;
}

function parseArgs(argv: string[]): ParsedCommand {
  if (argv.length === 0) {
    throw new UsageError("nenhum argumento informado");
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    return { kind: "help" };
  }

  const [command, ...rest] = argv;
  const commands = ["run", "eval", "bench", "serve", "replay", "resume", "continue", "chat", "tui", "health", "providers", "handoff", "cost", "pool", "agents", "models", "config", "skills", "mcp"];
  if (command !== undefined && !commands.includes(command)) {
    throw new UsageError(`comando desconhecido: "${command}"`);
  }

  if (command === "providers") {
    let configPath = "astro.config.json";
    let action: "health" | "list" | "test" | "vault-import" | undefined;
    let name: string | undefined;
    let apply = false;
    let allowPlain = false;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i] as string;
      if (arg === "--config") {
        const value = rest.at(i + 1);
        if (value === undefined || value.startsWith("-")) {
          throw new UsageError("falta o valor de --config");
        }
        i++;
        configPath = value;
        continue;
      }
      if (arg === "--apply") {
        apply = true;
        continue;
      }
      if (arg === "--allow-plain") {
        allowPlain = true;
        continue;
      }
      if (arg.startsWith("-")) {
        throw new UsageError(`opção desconhecida: "${arg}"`);
      }
      if (action === undefined && (arg === "health" || arg === "list" || arg === "test" || arg === "vault-import")) {
        action = arg;
        continue;
      }
      if ((action === "test" || action === "vault-import") && name === undefined) {
        name = arg;
        continue;
      }
      throw new UsageError(`argumento inesperado: "${arg}"`);
    }
    if (action === undefined) {
      throw new UsageError("use: providers <health|list|test|vault-import> [--config <path>]");
    }
    if (action === "test" && name === undefined) {
      throw new UsageError("use: providers test <provider> [--config <path>]");
    }
    if (action === "vault-import" && name === undefined) {
      throw new UsageError("use: providers vault-import <provider> [--apply] [--allow-plain] [--config <path>]");
    }
    if ((apply || allowPlain) && action !== "vault-import") {
      throw new UsageError("--apply e --allow-plain só valem para providers vault-import");
    }
    return {
      kind: "providers",
      options: {
        action,
        ...(name === undefined ? {} : { name }),
        configPath,
        ...(apply ? { apply: true } : {}),
        ...(allowPlain ? { allowPlain: true } : {}),
      },
    };
  }

  if (command === "cost") {
    let configPath = "astro.config.json";
    let byAgent = false;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i] as string;
      if (arg === "--config") {
        const value = rest.at(i + 1);
        if (value === undefined || value.startsWith("-")) {
          throw new UsageError("falta o valor de --config");
        }
        i++;
        configPath = value;
        continue;
      }
      if (arg === "--by-agent") {
        byAgent = true;
        continue;
      }
      throw new UsageError(`opção desconhecida: "${arg}"`);
    }
    if (!byAgent) {
      throw new UsageError("use: cost --by-agent [--config <path>]");
    }
    return { kind: "cost", options: { configPath } };
  }

  if (command === "handoff") {
    let configPath = "astro.config.json";
    let handoffId: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i] as string;
      if (arg === "--config") {
        const value = rest.at(i + 1);
        if (value === undefined || value.startsWith("-")) {
          throw new UsageError("falta o valor de --config");
        }
        i++;
        configPath = value;
        continue;
      }
      if (arg.startsWith("-")) {
        throw new UsageError(`opção desconhecida: "${arg}"`);
      }
      if (arg === "show") continue;
      if (handoffId !== undefined) {
        throw new UsageError(`argumento inesperado: "${arg}"`);
      }
      handoffId = arg;
    }
    if (handoffId === undefined) {
      throw new UsageError("use: handoff show <handoff_id> [--config <path>]");
    }
    return { kind: "handoff", options: { handoffId, configPath } };
  }

  if (command === "config") {
    let action: "push" | "pull" | undefined;
    let name: string | undefined;
    let registry: string | undefined;
    let configPath = "astro.config.json";
    let token: string | undefined;
    let allowPlugins = false;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i] as string;
      if (arg === "--allow-plugins") {
        allowPlugins = true;
        continue;
      }
      if (arg === "--registry" || arg === "--config" || arg === "--token") {
        const value = rest.at(i + 1);
        if (value === undefined || value.startsWith("-")) {
          throw new UsageError(`falta o valor de ${arg}`);
        }
        i++;
        if (arg === "--registry") registry = value;
        else if (arg === "--config") configPath = value;
        else token = value;
        continue;
      }
      if (arg.startsWith("-")) {
        throw new UsageError(`opção desconhecida: "${arg}"`);
      }
      if (action === undefined && (arg === "push" || arg === "pull")) {
        action = arg;
        continue;
      }
      if (name !== undefined) {
        throw new UsageError(`argumento inesperado: "${arg}"`);
      }
      name = arg;
    }
    if (action === undefined || name === undefined) {
      throw new UsageError('use: config <push|pull> <org/projeto> [--registry <owner/repo>] [--allow-plugins]');
    }
    return {
      kind: "config",
      options: {
        action, name, configPath,
        ...(registry === undefined ? {} : { registry }),
        ...(token === undefined ? {} : { token }),
        ...(allowPlugins ? { allowPlugins } : {}),
      },
    };
  }

  if (command === "health") {
    let configPath = "astro.config.json";
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i] as string;
      if (arg === "--config") {
        const value = rest.at(i + 1);
        if (value === undefined || value.startsWith("-")) {
          throw new UsageError("falta o valor de --config");
        }
        i++;
        configPath = value;
        continue;
      }
      throw new UsageError(`opção desconhecida: "${arg}"`);
    }
    return { kind: "health", options: { configPath } };
  }

  if (command === "pool") {
    let configPath = "astro.config.json";
    let action: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i] as string;
      if (arg === "--config") {
        const value = rest.at(i + 1);
        if (value === undefined || value.startsWith("-")) {
          throw new UsageError("falta o valor de --config");
        }
        i++;
        configPath = value;
        continue;
      }
      if (arg.startsWith("-")) {
        throw new UsageError(`opção desconhecida: "${arg}"`);
      }
      if (action !== undefined) {
        throw new UsageError(`argumento inesperado: "${arg}"`);
      }
      action = arg;
    }
    if (action !== "list" && action !== "health") {
      throw new UsageError("use: pool <list|health> [--config <path>]");
    }
    return { kind: "pool", options: { action, configPath } };
  }

  if (command === "agents") {
    let configPath = "astro.config.json";
    let action: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i] as string;
      if (arg === "--config") {
        const value = rest.at(i + 1);
        if (value === undefined || value.startsWith("-")) {
          throw new UsageError("falta o valor de --config");
        }
        i++;
        configPath = value;
        continue;
      }
      if (arg.startsWith("-")) {
        throw new UsageError(`opção desconhecida: "${arg}"`);
      }
      if (action !== undefined) {
        throw new UsageError(`argumento inesperado: "${arg}"`);
      }
      action = arg;
    }
    if (action !== "list") {
      throw new UsageError("use: agents list [--config <path>]");
    }
    return { kind: "agents", options: { action: "list", configPath } };
  }

  if (command === "models") {
    let configPath = "astro.config.json";
    let action: "list" | undefined;
    let seeds = false;
    let json = false;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i] as string;
      if (arg === "--config") {
        const value = rest.at(i + 1);
        if (value === undefined || value.startsWith("-")) {
          throw new UsageError("falta o valor de --config");
        }
        i++;
        configPath = value;
        continue;
      }
      if (arg === "--seeds") {
        seeds = true;
        continue;
      }
      if (arg === "--json") {
        json = true;
        continue;
      }
      if (arg === "list" && action === undefined) {
        action = "list";
        continue;
      }
      throw new UsageError(`opção desconhecida: "${arg}"`);
    }
    if (action !== "list") {
      throw new UsageError("use: models list [--config <path>] [--seeds] [--json]");
    }
    return { kind: "models", options: { action, configPath, seeds, json } };
  }

  if (command === "mcp") {
    return { kind: "mcp", args: rest };
  }

  // Skills (C1b): subcomandos e flags são validados em src/skills/cli.ts.
  if (command === "skills") {
    return { kind: "skills", args: rest };
  }

  if (command === "replay" || command === "resume") {
    const options = parseReplayLike(command, rest);
    return command === "replay" ? { kind: "replay", options } : { kind: "resume", options };
  }

  if (command === "continue") {
    return { kind: "continue", options: parseContinue(rest) };
  }

  if (command === "chat" || command === "tui") {
    let configPath = "astro.config.json";
    let cwd: string | undefined;
    let provider: string | undefined;
    let permissionMode: PermissionMode | undefined;
    let configExplicit = false;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i] as string;
      if (arg === "--config" || arg === "--cwd" || arg === "--provider" || arg === "--permission-mode") {
        const value = rest.at(i + 1);
        if (value === undefined || value.startsWith("-")) throw new UsageError(`falta o valor de ${arg}`);
        i++;
        if (arg === "--config") { configPath = value; configExplicit = true; }
        else if (arg === "--cwd") cwd = value;
        else if (arg === "--permission-mode") permissionMode = permissionModeValue(arg, value);
        else provider = value;
        continue;
      }
      throw new UsageError(`opção desconhecida: "${arg}"`);
    }
    const options = {
      configPath,
      configExplicit,
      ...(cwd === undefined ? {} : { cwd }),
      ...(provider === undefined ? {} : { provider }),
      ...(permissionMode === undefined ? {} : { permissionMode }),
    };
    return command === "chat" ? { kind: "chat", options } : { kind: "tui", options };
  }

  if (command === "serve") {
    let port = 9090;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i] as string;
      if (arg === "--port") {
        const value = rest.at(i + 1);
        if (value === undefined || value.startsWith("-")) {
          throw new UsageError("falta o valor de --port");
        }
        i++;
        port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new UsageError(`--port deve ser inteiro 1..65535 (recebido: ${value})`);
        }
        continue;
      }
      throw new UsageError(`opção desconhecida: "${arg}"`);
    }
    return { kind: "serve", options: { port } };
  }

  if (command === "bench") {
    let configPath = "astro.config.json";
    let models: string | undefined;
    let runs = 1;
    let outDir = "eval";
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i] as string;
      if (arg === "--config" || arg === "--models" || arg === "--runs" || arg === "--out") {
        const value = rest.at(i + 1);
        if (value === undefined || value.startsWith("-")) {
          throw new UsageError(`falta o valor de ${arg}`);
        }
        i++;
        if (arg === "--config") configPath = value;
        else if (arg === "--models") models = value;
        else if (arg === "--runs") {
          runs = Number(value);
          if (!Number.isInteger(runs) || runs < 1) {
            throw new UsageError(`--runs deve ser inteiro >= 1 (recebido: ${value})`);
          }
        } else outDir = value;
        continue;
      }
      throw new UsageError(`opção desconhecida: "${arg}"`);
    }
    return {
      kind: "bench",
      options: { configPath, ...(models === undefined ? {} : { models }), runs, outDir },
    };
  }

  let configPath = "astro.config.json";
  let cwd: string | undefined;
  let task: string | undefined;
  let provider: string | undefined;
  let permissionMode: PermissionMode | undefined;

  if (command === "eval") {
    let threshold = 0.85;
    let goldenRoot = "eval/golden";
    let reportPath: string | undefined;
    let baselinePath = "eval/baseline.json";
    let writeBaselineFlag = false;

    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i] as string;
      if (arg === "--threshold" || arg === "--golden" || arg === "--report" || arg === "--baseline") {
        const value = rest.at(i + 1);
        if (value === undefined || value.startsWith("-")) {
          throw new UsageError(`falta o valor de ${arg}`);
        }
        i++;
        if (arg === "--threshold") {
          threshold = Number(value);
          if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
            throw new UsageError(`--threshold deve ser entre 0 e 1 (recebido: ${value})`);
          }
        } else if (arg === "--golden") {
          goldenRoot = value;
        } else if (arg === "--report") {
          reportPath = value;
        } else {
          baselinePath = value;
        }
        continue;
      }
      if (arg === "--write-baseline") {
        writeBaselineFlag = true;
        continue;
      }
      throw new UsageError(`opção desconhecida: "${arg}"`);
    }
    return {
      kind: "eval",
      options: { threshold, goldenRoot, ...(reportPath === undefined ? {} : { reportPath }), baselinePath, writeBaseline: writeBaselineFlag },
    };
  }

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;

    if (arg === "--config" || arg === "--cwd" || arg === "--provider" || arg === "--permission-mode") {
      const value = rest.at(i + 1);
      if (value === undefined || value.startsWith("-")) {
        throw new UsageError(`falta o valor de ${arg}`);
      }
      i++;
      if (arg === "--config") {
        configPath = value;
      } else if (arg === "--cwd") {
        cwd = value;
      } else if (arg === "--permission-mode") {
        permissionMode = permissionModeValue(arg, value);
      } else {
        provider = value;
      }
      continue;
    }

    if (arg.startsWith("-")) {
      throw new UsageError(`opção desconhecida: "${arg}"`);
    }

    if (task !== undefined) {
      throw new UsageError(`argumento inesperado: "${arg}"`);
    }
    task = arg;
  }

  if (task === undefined) {
    throw new UsageError('falta o pedido; use: run "<pedido>"');
  }

  return {
    kind: "run",
    options: {
      task,
      configPath,
      ...(cwd === undefined ? {} : { cwd }),
      ...(provider === undefined ? {} : { provider }),
      ...(permissionMode === undefined ? {} : { permissionMode }),
    },
  };
}

function formatCost(costUsd: number | null): string {
  return costUsd === null ? "n/d (sem preço curado)" : `US$ ${costUsd.toFixed(6)}`;
}

/** Uma linha com modelo, tokens, custo e os caminhos de ledger/auditoria. */
function formatSummary(report: RunReport): string {
  const budget = report.budget === undefined
    ? []
    : [`budget ${report.budget.scope} ${formatBudgetEstimate(report.budget.spentUsd)}${report.budget.limitUsd === null ? " (use-as-you-go)" : ` / US$ ${report.budget.limitUsd.toFixed(2)}`}`];
  return [
    report.model,
    `${report.tokensIn} tokens in / ${report.tokensOut} out`,
    `custo ${formatCost(report.costUsd)}`,
    ...budget,
    `ledger ${report.ledgerPath}`,
    `auditoria ${report.auditPath}`,
  ].join(" · ");
}

/** Resumo legível do eval no stdout. */
function formatEval(report: EvalReport): string {
  const lines = [
    `eval: ${report.passed}/${report.total} passaram · pass rate ${(report.passRate * 100).toFixed(1)}%`,
  ];
  if (report.regressions.length > 0) {
    lines.push(`regressões vs baseline: ${report.regressions.join(", ")}`);
  }
  for (const c of report.cases.filter((r) => !r.passed)) {
    lines.push(`  ✗ ${c.case}: ${c.diffSummary.join("; ")}`);
  }
  return lines.join("\n");
}

/** Tabela compacta de bench no stdout. */
function formatBenchTable(report: BenchReport): string {
  const lines = report.results.map(
    (r) =>
      `${r.model} · p50 ${r.latencyMs.p50}ms · ${r.tokensPerSec} tok/s · custo/1k out ` +
      `${r.costPer1kOutUsd === null ? "n/d" : `US$ ${r.costPer1kOutUsd.toFixed(4)}`}`,
  );
  return [`bench: ${report.results.length} modelos · ${report.prompts} prompts`, ...lines].join("\n");
}

async function main(argv: string[]): Promise<number> {
  let parsed: ParsedCommand;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`erro: ${error.message}\n`);
    console.error(USAGE);
    return 1;
  }

  // CLI > config (CLI-01): chat/tui leem o modo do ambiente do processo.
  const modeOption = parsed.kind === "run" || parsed.kind === "chat" || parsed.kind === "tui"
    ? parsed.options.permissionMode
    : undefined;
  if (modeOption !== undefined) process.env.ASTRO_PERMISSION_MODE = modeOption;

  if (parsed.kind === "help") {
    console.log(USAGE);
    return 0;
  }

  if (parsed.kind === "eval") {
    const o = parsed.options;
    const report = await runEval({
      goldenRoot: resolve(o.goldenRoot),
      mock: true,
      threshold: o.threshold,
      baselinePath: resolve(o.baselinePath),
      ...(o.reportPath === undefined ? {} : { reportPath: resolve(o.reportPath) }),
    });
    console.log(formatEval(report));
    if (o.writeBaseline) {
      writeBaseline(report, resolve(o.baselinePath));
      console.log(`baseline gravada em ${o.baselinePath}`);
    }
    if (evalFailsThreshold(report, o.threshold)) {
      console.error(`erro: pass rate abaixo do threshold ${o.threshold} ou regressões detectadas`);
      return 1;
    }
    return 0;
  }

  if (parsed.kind === "serve") {
    const metrics = new Metrics();
    const handle = startMetricsServer(metrics, parsed.options.port);
    console.log(`métricas Prometheus em ${handle.url}/metrics (Ctrl+C para sair)`);
    // Mantém o processo vivo até interrupção; contadores acumulam de runs
    // neste processo (runTask com a mesma instância de Metrics).
    await new Promise<never>(() => {});
    return 0;
  }

  if (parsed.kind === "bench") {
    const o = parsed.options;
    const config = loadEffectiveConfig(resolve(o.configPath)).config;
    const registry = new Registry(config);
    const all = registry.list();
    const models = o.models === undefined
      ? all
      : all.filter((m) => o.models!.split(",").some((f) => `${m.provider}/${m.id}`.includes(f.trim())));
    if (models.length === 0) {
      console.error("erro: nenhum modelo ativo corresponde ao filtro");
      return 1;
    }
    const report = await runBenchmark({
      models,
      runs: o.runs,
      outDir: resolve(o.outDir),
      providerFor: (m) => createProvider(config, m, process.env).provider,
    });
    console.log(formatBenchTable(report));
    console.log(`relatórios gravados em ${o.outDir}/bench-${report.date}.{md,json}`);
    return 0;
  }

  if (parsed.kind === "replay") {
    const o = parsed.options;
    const config = loadEffectiveConfig(resolve(o.configPath)).config;
    const base = o.cwd ?? process.cwd();
    const auditPath = resolve(base, config.paths.audit);
    try {
      const result = await replayRun({
        configPath: resolve(o.configPath),
        auditPath,
        runId: o.runId,
        task: o.task,
        ...(o.cwd === undefined ? {} : { cwd: o.cwd }),
        approveSwap: ttyApprover(), onBudgetExceeded: ttyBudgetDecider(),
        trustAsk: ttyTrustAsk(),
        onNoProgress: ttyNoProgressDecider(),
      });
      const fmtCost = (v: number | null): string => (v === null ? "n/d" : `US$ ${v.toFixed(6)}`);
      console.log(`replay do run ${result.runId}`);
      console.log(`  original: ${result.original.steps} steps · ${result.original.tokensIn}/${result.original.tokensOut} tokens · ${fmtCost(result.original.costUsd)}`);
      console.log(`  replay:   ${result.replay.steps} steps · ${result.replay.tokensIn}/${result.replay.tokensOut} tokens · ${fmtCost(result.replay.costUsd)}`);
      console.log(`  resposta: ${result.replay.final}`);
      console.log(result.identical ? "  ✓ idêntico ao original" : "  ✗ divergente do original");
      return result.identical ? 0 : 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`erro: ${message}`);
      return 1;
    }
  }

  if (parsed.kind === "continue") {
    const o = parsed.options;
    const base = o.cwd ?? process.cwd();
    const cancellation = installCancellation();
    try {
      const agent = o.agent ?? resolveContinueAgent(base, o.runId);
      const checkpoint = loadCheckpoint(base, o.runId, agent);
      const report = await runTask({
        configPath: resolve(o.configPath),
        task: continueTask(checkpoint, o.task),
        cwd: base,
        continuedFrom: { run: o.runId, agent },
        signal: cancellation.signal,
        ...(process.stdin.isTTY === true ? {} : { approveTool: nonInteractiveApprover() }),
        approveSwap: ttyApprover(), onBudgetExceeded: ttyBudgetDecider(),
        trustAsk: ttyTrustAsk(), onNoProgress: ttyNoProgressDecider(),
      });
      console.log(`continuado do run ${o.runId} (agente ${agent}) em ${report.runId}`);
      console.log(report.final);
      console.log("");
      console.log(formatSummary(report));
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`erro: ${redactSecrets(message)}`);
      return 1;
    } finally {
      cancellation.dispose();
    }
  }

  if (parsed.kind === "resume") {
    const o = parsed.options;
    // Ctrl+C/SIGTERM cancelam o run em vez de matar o processo no meio do append.
    const cancellation = installCancellation();
    try {
      const report = await runTask({
        configPath: resolve(o.configPath),
        task: o.task,
        ...(o.cwd === undefined ? {} : { cwd: o.cwd }),
        resume: o.runId,
        signal: cancellation.signal,
        // Sem TTY não há como perguntar: `ask` nega e para (I-08/I-19).
        ...(process.stdin.isTTY === true ? {} : { approveTool: nonInteractiveApprover() }),
        approveSwap: ttyApprover(), onBudgetExceeded: ttyBudgetDecider(),
        trustAsk: ttyTrustAsk(),
        onNoProgress: ttyNoProgressDecider(),
      });
      console.log(`retomado ${report.resumedFrom ?? "?"} do run ${report.runId}`);
      console.log(report.final);
      console.log("");
      console.log(formatSummary(report));
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`erro: ${message}`);
      return 1;
    } finally {
      cancellation.dispose();
    }
  }

  if (parsed.kind === "tui") {
    const o = parsed.options;
    const { runTui } = await import("./tui/run");
    return await runTui({
      configPath: resolve(o.configPath),
      cwd: o.cwd ?? process.cwd(),
      ...(o.provider === undefined ? {} : { provider: o.provider }),
      allowMissingConfig: !o.configExplicit,
    });
  }

  if (parsed.kind === "chat") {
    const o = parsed.options;
    const base = o.cwd ?? process.cwd();
    const io = nodeReplIO();
    let sessionApi: import("./chat/session-api").SessionApi | undefined;
    try {
      const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
      const configPath = resolve(o.configPath);
      const project = existsSync(configPath) ? loadConfig(configPath) : undefined;
      const manager = new ProfileManager({
        project, env: process.env,
        ...(o.provider === undefined ? {} : { provider: o.provider }),
      });
      const session = new AgentSession({
        configPath, cwd: base, env: process.env,
        ...(o.provider === undefined ? {} : { provider: o.provider }),
        allowMissingConfig: !o.configExplicit,
        ...chatApprovers(io, interactive),
      });
      for (const warning of session.warnings) console.error(`aviso: ${warning}`);
      const store = new SessionStore(resolve(base, ".astro", "sessions"));
      const { openSessionApi } = await import("./chat/session-api");
      sessionApi = openSessionApi(resolve(base, ".astro"));
      await runRepl(session, io, { store, sessionApi, signal: io.signal, style: interactive, cwd: base, manager });
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`erro: ${redactSecrets(message)}`);
      return 1;
    } finally {
      sessionApi?.close();
      io.close();
    }
  }

  if (parsed.kind === "cost") {
    const o = parsed.options;
    const config = loadEffectiveConfig(resolve(o.configPath)).config;
    const ledger = new Ledger(resolve(process.cwd(), config.paths.ledger));
    console.log(formatCostByAgent(ledger));
    return 0;
  }

  if (parsed.kind === "handoff") {
    const o = parsed.options;
    try {
      const config = loadEffectiveConfig(resolve(o.configPath)).config;
      const ledger = new Ledger(resolve(process.cwd(), config.paths.ledger));
      console.log(formatHandoffShow(ledger, o.handoffId));
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`erro: ${message}`);
      return 1;
    }
  }

  if (parsed.kind === "config") {
    const o = parsed.options;
    const registrySpec = o.registry ?? process.env.ASTRO_CONFIG_REGISTRY;
    if (registrySpec === undefined || !/^[^/]+\/[^/]+$/.test(registrySpec)) {
      console.error('erro: informe o registry com --registry <owner/repo> (ou ASTRO_CONFIG_REGISTRY)');
      return 1;
    }
    const token = o.token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    if (token === undefined || token.length === 0) {
      console.error("erro: informe o token com --token ou GH_TOKEN no ambiente");
      return 1;
    }
    const [owner, repo] = registrySpec.split("/");
    const registry = new GitHubConfigRegistry({ owner: owner!, repo: repo!, token });

    try {
      if (o.action === "push") {
        const configPath = resolve(o.configPath);
        const raw = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
        validateConfig(raw); // publica só config válida — e sem segredos por construção (D-03)
        const prepared = prepareConfigForPush(raw, registrySpec, o.allowPlugins === true);
        if (!prepared.ok) {
          console.error(`erro: ${prepared.error}`);
          return 1;
        }
        const published = await registry.push(o.name, prepared.json);
        console.log(`config publicada em ${published.path} (${published.created ? "criada" : "atualizada"})`);
        return 0;
      }
      // pull
      const pulled = await registry.pull(o.name);
      const raw = JSON.parse(pulled) as unknown;
      validateConfig(raw); // remota inválida não chega ao disco
      const prepared = preparePulledConfig(raw, registrySpec, o.allowPlugins === true);
      if (prepared.removedPlugins.length > 0) {
        console.warn(`aviso: plugins removidos da config "${o.name}" (publique/puxe com --allow-plugins): ${prepared.removedPlugins.join(", ")}`);
      }
      const configPath = resolve(o.configPath);
      writeFileSync(configPath, prepared.json, "utf8");
      console.log(`config "${o.name}" validada e gravada em ${o.configPath}`);
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`erro: ${message}`);
      return 1;
    }
  }

  if (parsed.kind === "skills") {
    return await runSkillsCommand(parsed.args);
  }

  // MCP (C2f): subcomandos e flags são validados em src/mcp/cli.ts.
  if (parsed.kind === "mcp") {
    return await runMcpCommand(parsed.args);
  }

  if (parsed.kind === "models") {
    const o = parsed.options;
    try {
      const effective = loadEffectiveConfig(resolve(o.configPath));
      const models = buildModelCatalog(effective);
      if (o.json) {
        // Um único payload JSON: com --seeds, as sementes vão no campo `seeds`.
        console.log(JSON.stringify(o.seeds ? { models, seeds: PROVIDER_CATALOG } : { models }, null, 2));
        return 0;
      }
      console.log(formatModelCatalog(models));
      if (o.seeds) {
        console.log("");
        console.log(formatSeedList());
      }
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`erro: ${message}`);
      return 1;
    }
  }

  if (parsed.kind === "agents") {
    try {
      const config = loadEffectiveConfig(resolve(parsed.options.configPath)).config;
      console.log(formatAgentsList(config));
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`erro: ${message}`);
      return 1;
    }
  }

  if (parsed.kind === "pool") {
    try {
      const config = loadEffectiveConfig(resolve(parsed.options.configPath)).config;
      if (parsed.options.action === "health") {
        const report = await runPoolHealthCheck(config, process.env);
        console.log(JSON.stringify(report, null, 2));
        return report.status === "ok" ? 0 : 1;
      }
      console.log(formatPoolList(config));
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`erro: ${message}`);
      return 1;
    }
  }

  if (parsed.kind === "health") {
    try {
      const config = loadEffectiveConfig(resolve(parsed.options.configPath)).config;
      const report = await runHealthCheck(config, process.env);
      console.log(JSON.stringify(report, null, 2));
      return report.status === "ok" ? 0 : 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`erro: ${message}`);
      return 1;
    }
  }

  if (parsed.kind === "providers") {
    const o = parsed.options;
    try {
      if (o.action === "vault-import") {
        const result = importVaultCredential({
          provider: o.name!,
          env: process.env,
          configPath: resolve(o.configPath),
          ...(o.apply === true ? { apply: true } : {}),
          ...(o.allowPlain === true ? { allowPlain: true } : {}),
        });
        console.log(formatVaultImport(result));
        return 0;
      }
      const config = loadEffectiveConfig(resolve(o.configPath)).config;
      if (o.action === "list") {
        console.log(formatProvidersList(config));
        return 0;
      }
      if (o.action === "test") {
        const check = await testProvider(config, o.name!, process.env);
        console.log(JSON.stringify(check, null, 2));
        return check.status === "ok" ? 0 : 1;
      }
      const report = await runHealthCheck(config, process.env);
      console.log(JSON.stringify(report, null, 2));
      return report.status === "ok" ? 0 : 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`erro: ${message}`);
      return 1;
    }
  }

  const cancellation = installCancellation();
  try {
    const report = await runTask({
      ...parsed.options,
      signal: cancellation.signal,
      // Sem TTY não há como perguntar: `ask` nega e para (I-08/I-19).
      ...(process.stdin.isTTY === true ? {} : { approveTool: nonInteractiveApprover() }),
      approveSwap: ttyApprover(), onBudgetExceeded: ttyBudgetDecider(),
      trustAsk: ttyTrustAsk(),
      onNoProgress: ttyNoProgressDecider(),
    });
    console.log(report.final);
    console.log("");
    console.log(formatSummary(report));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`erro: ${message}`);
    return 1;
  } finally {
    cancellation.dispose();
  }
}

const interactive = isInteractive(process.stdin.isTTY, process.stdout.isTTY);
process.exitCode = await main(defaultArgs(process.argv.slice(2), interactive));