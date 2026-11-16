/** Comandos de barra compartilhados pelo REPL e pela TUI: puro, sem React. */
import { HELP_TEXT, modeListText, resolveModeCommand, unknownCommandMessage, type ReplCommand } from "../chat/commands";
import { detailsLines, providerLine, type ChatSession } from "../chat/repl";
import { DEFAULT_PERMISSION_MODE, PERMISSION_MODES } from "../permissions";
import { toSessionRecord } from "../chat/store";
import type { SessionApi, SessionSummary as ApiSessionSummary } from "../chat/session-api";
import { redactSecrets } from "../sanitize-external";
import { exportSession } from "../chat/export";
import { initAgents } from "../chat/init";
import { usageLines } from "../chat/usage";
import { THEMES, isTheme, type Theme } from "./theme";

export type EntryKind = "user" | "assistant" | "info" | "error";

export interface Entry {
  kind: EntryKind;
  text: string;
}

export interface CommandState {
  lastFile?: string;
  /** Tema ativo e aplicador (persiste + troca ao vivo) para `/theme` (#64). */
  theme?: Theme;
  setTheme?(theme: Theme): void;
}

export interface CommandOutcome {
  entries: Entry[];
  exit?: boolean;
  /** Caminho gravado; `null` quando a gravação falhou (limpa o anterior). */
  lastFile?: string | null;
  /** Abre a tela de providers com o modo inicial. */
  openProviders?: { mode: "list" | "add" | "edit" | "remove"; target?: string };
  /** Abre a tela de configuração (`/config`, #273). */
  openConfig?: boolean;
  /** Abre o modal de sessões (`/sessions`, #64). */
  openSessions?: boolean;
}

type SlashCommand = Exclude<ReplCommand, { kind: "prompt" } | { kind: "empty" }>;

export interface RunCommandOptions {
  sessionApi?: SessionApi;
  cwd?: string;
  resumeId?: string;
}

function messageOf(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

/** Executa um comando que não é turno; devolve entradas para a UI renderizar. */
export async function runCommand(
  command: SlashCommand,
  session: ChatSession,
  state: CommandState,
  options: RunCommandOptions = {},
): Promise<CommandOutcome> {
  const { sessionApi, resumeId, cwd = process.cwd() } = options;
  switch (command.kind) {
    case "help":
      return { entries: [{ kind: "info", text: HELP_TEXT }] };
    case "clear":
      session.clear();
      return { entries: [{ kind: "info", text: "contexto limpo" }] };
    case "exit":
      return { entries: [], exit: true };
    case "unknown":
      return { entries: [{ kind: "info", text: unknownCommandMessage(command.raw) }] };
    case "attach":
    case "paste":
    case "detach":
      return { entries: [{ kind: "info", text: "anexos: use /attach, /paste ou /detach" }] };
    case "model": {
      if (command.model === undefined) {
        return { entries: [{ kind: "info", text: session.listModels().join("\n") }] };
      }
      try {
        return { entries: [{ kind: "info", text: `modelo: ${session.setModel(command.model)}` }] };
      } catch (error) {
        return { entries: [{ kind: "error", text: `erro: ${messageOf(error)}` }] };
      }
    }
    case "mode": {
      const current = session.permissionMode?.() ?? DEFAULT_PERMISSION_MODE;
      const action = resolveModeCommand(command, current, session.setPermissionMode !== undefined);
      if (action.kind === "list") {
        return { entries: [{ kind: "info", text: modeListText(action.current) }] };
      }
      if (action.kind === "invalid") {
        return { entries: [{ kind: "error", text: `modo inválido: ${action.mode} (use ${PERMISSION_MODES.join(", ")})` }] };
      }
      if (action.kind === "needs-confirm") {
        return { entries: [{ kind: "error", text: "modo bypass não ativado: tools executariam sem aprovação — confirme com /mode bypass confirm" }] };
      }
      if (action.kind === "unsupported" || session.setPermissionMode === undefined) {
        return { entries: [{ kind: "error", text: "esta sessão não aceita trocar o modo de permissão" }] };
      }
      try {
        return { entries: [{ kind: "info", text: `modo: ${session.setPermissionMode(action.mode)}` }] };
      } catch (error) {
        return { entries: [{ kind: "error", text: `erro: ${messageOf(error)}` }] };
      }
    }
    case "config":
      return { entries: [], openConfig: true };
    case "theme": {
      const current = state.theme ?? "dark";
      if (command.theme === undefined) {
        const lines = THEMES.map((theme) => `${theme === current ? "→" : " "} ${theme}`);
        return { entries: [{ kind: "info", text: `${lines.join("\n")}\nativo: ${current}` }] };
      }
      if (!isTheme(command.theme)) {
        // não ecoa o argumento: ele pode ser um segredo colado por engano (I-03)
        return { entries: [{ kind: "error", text: `tema inválido (use ${THEMES.join(", ")})` }] };
      }
      if (state.setTheme === undefined) {
        return { entries: [{ kind: "error", text: "tema indisponível nesta sessão" }] };
      }
      try {
        state.setTheme(command.theme);
        return { entries: [{ kind: "info", text: `tema: ${command.theme}` }] };
      } catch (error) {
        return { entries: [{ kind: "error", text: `erro: ${messageOf(error)}` }] };
      }
    }
    case "usage": {
      try {
        return { entries: [{ kind: "info", text: usageLines(session.snapshot(), session.budgetStatus?.()).join("\n") }] };
      } catch (error) {
        return { entries: [{ kind: "error", text: `erro: ${messageOf(error)}` }] };
      }
    }
    case "providers":
      return { entries: [], openProviders: { mode: "list" } };
    case "provider": {
      if (command.action === "use") {
        if (command.target === undefined) {
          return { entries: [], openProviders: { mode: "list" } };
        }
        try {
          return { entries: [{ kind: "info", text: `provider: ${session.setProvider(command.target)}` }] };
        } catch (error) {
          return { entries: [{ kind: "error", text: `erro: ${messageOf(error)}` }] };
        }
      }
      if (command.action === "list") {
        return { entries: [], openProviders: { mode: "list" } };
      }
      if (command.target === undefined) {
        return { entries: [], openProviders: { mode: command.action } };
      }
      return { entries: [], openProviders: { mode: command.action, target: command.target } };
    }
    case "sessions": {
      if (sessionApi === undefined) {
        return { entries: [{ kind: "info", text: "sem persistência configurada" }] };
      }
      // na TUI o modal lista/renomeia/retoma; o REPL mantém a listagem em texto (#64)
      return { entries: [], openSessions: true };
    }
    case "resume": {
      if (sessionApi === undefined) {
        return { entries: [{ kind: "info", text: "sem persistência configurada" }] };
      }
      if (command.ref === undefined) {
        return { entries: [{ kind: "info", text: "uso: /resume <número|id> (veja /sessions)" }] };
      }
      try {
        let chosen: ApiSessionSummary | undefined;
        if (resumeId === undefined && /^\d+$/.test(command.ref)) {
          chosen = sessionApi.list()[Number(command.ref) - 1]; // sempre relê a lista (#64)
          if (chosen === undefined) {
            return { entries: [{ kind: "info", text: "índice fora da lista; use /sessions" }] };
          }
        }
        const loaded = sessionApi.load(resumeId ?? chosen?.id ?? command.ref);
        session.resume(loaded);
        state.lastFile = undefined;
        return {
          entries: [{ kind: "info", text: `sessão retomada: ${loaded.id} (${loaded.turns} turnos)` }],
          lastFile: null,
        };
      } catch (error) {
        return { entries: [{ kind: "error", text: `erro: ${messageOf(error)}` }] };
      }
    }
    case "compact": {
      try {
        const summary = await session.compact(command.force === true);
        return { entries: [{ kind: "info", text: summary }] };
      } catch (error) {
        return { entries: [{ kind: "error", text: `erro: ${messageOf(error)}` }] };
      }
    }
    case "export": {
      try {
        const path = exportSession(session.snapshot(), cwd, command.path);
        return { entries: [{ kind: "info", text: `sessão exportada em ${path}` }] };
      } catch (error) {
        return { entries: [{ kind: "error", text: `erro: ${messageOf(error)}` }] };
      }
    }
    case "init": {
      try {
        const path = initAgents(cwd);
        return { entries: [{ kind: "info", text: `AGENTS.md criado em ${path}` }] };
      } catch (error) {
        return { entries: [{ kind: "error", text: `erro: ${messageOf(error)}` }] };
      }
    }
    case "session":
    case "details": {
      const lines = detailsLines(session.snapshot(), state.lastFile);
      if (sessionApi === undefined) lines[lines.length - 1] = "arquivo: sem persistência";
      return { entries: [{ kind: "info", text: lines.join("\n") }] };
    }
    case "save": {
      if (sessionApi === undefined) {
        return { entries: [{ kind: "info", text: "sem persistência configurada" }] };
      }
      try {
        sessionApi.save(toSessionRecord(session.snapshot()));
        return {
          entries: [{ kind: "info", text: `sessão salva em ${sessionApi.databasePath}` }],
          lastFile: sessionApi.databasePath,
        };
      } catch (error) {
        return { entries: [{ kind: "error", text: `erro: ${messageOf(error)}` }], lastFile: null };
      }
    }
  }
}
