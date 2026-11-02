/** Comandos de barra compartilhados pelo REPL e pela TUI: puro, sem React. */
import { HELP_TEXT, modeListText, resolveModeCommand, unknownCommandMessage, type ReplCommand } from "../chat/commands";
import { detailsLines, providerLine, type ChatSession } from "../chat/repl";
import { DEFAULT_PERMISSION_MODE, PERMISSION_MODES } from "../permissions";
import { sessionSummaryLine, type SessionStore, type SessionSummary } from "../chat/store";
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
  sessions?: SessionSummary[];
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
}

type SlashCommand = Exclude<ReplCommand, { kind: "prompt" } | { kind: "empty" }>;

function messageOf(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

/** Executa um comando que não é turno; devolve entradas para a UI renderizar. */
export async function runCommand(
  command: SlashCommand,
  session: ChatSession,
  state: CommandState,
  store?: SessionStore,
  cwd = process.cwd(),
): Promise<CommandOutcome> {
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
      if (store === undefined) {
        return { entries: [{ kind: "info", text: "sem persistência configurada" }] };
      }
      const sessions = store.list();
      state.sessions = sessions;
      return {
        entries: [{
          kind: "info",
          text: sessions.length === 0
            ? "nenhuma sessão salva"
            : sessions.map((item, index) => sessionSummaryLine(item, index)).join("\n"),
        }],
      };
    }
    case "resume": {
      if (store === undefined) {
        return { entries: [{ kind: "info", text: "sem persistência configurada" }] };
      }
      if (command.ref === undefined) {
        return { entries: [{ kind: "info", text: "uso: /resume <número|id> (veja /sessions)" }] };
      }
      try {
        let chosen: SessionSummary | undefined;
        if (/^\d+$/.test(command.ref)) {
          if (state.sessions === undefined || state.sessions.length === 0) state.sessions = store.list();
          chosen = state.sessions[Number(command.ref) - 1];
          if (chosen === undefined) {
            return { entries: [{ kind: "info", text: "índice fora da lista; use /sessions" }] };
          }
        } else {
          chosen = state.sessions?.find((item) => item.id === command.ref);
        }
        const loaded = chosen === undefined ? store.load(command.ref) : store.load(chosen.id);
        session.resume(loaded.record);
        state.lastFile = loaded.path;
        return {
          entries: [{ kind: "info", text: `sessão retomada: ${loaded.record.id} (${loaded.record.turns} turnos)` }],
          lastFile: loaded.path,
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
      if (store === undefined) lines[lines.length - 1] = "arquivo: sem persistência";
      return { entries: [{ kind: "info", text: lines.join("\n") }] };
    }
    case "save": {
      if (store === undefined) {
        return { entries: [{ kind: "info", text: "sem persistência configurada" }] };
      }
      try {
        const path = store.write(session.snapshot());
        return { entries: [{ kind: "info", text: `sessão salva em ${path}` }], lastFile: path };
      } catch (error) {
        return { entries: [{ kind: "error", text: `erro: ${messageOf(error)}` }], lastFile: null };
      }
    }
  }
}

