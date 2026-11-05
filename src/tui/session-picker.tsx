/** Modal de sessões da TUI (#64): listar, renomear e retomar. */
import { Box, Text, useInput, useWindowSize } from "ink";
import { useRef, useState, type ReactElement } from "react";
import { sessionSummaryLine } from "../chat/store";
import type { SessionSummary } from "../chat/session-api";
import type { ThemeColors } from "./theme";
import { listRows, listWindow } from "./viewport";

/** Borda (2) + título + dica + marcadores (2). */
const PICKER_CHROME = 6;

export interface SessionPickerProps {
  sessions: readonly SessionSummary[];
  colors: ThemeColors;
  onClose(): void;
  onExit?(): void;
  onResume(session: SessionSummary): void;
  /** Aplica o nome à sessão escolhida (por path, seguro a ids duplicados). */
  onRename(session: SessionSummary, name: string): string | undefined;
  /** Linhas visíveis da lista; default derivado da altura do terminal. */
  maxRows?: number;
}

export function SessionPicker({
  sessions, colors, onClose, onExit, onResume, onRename, maxRows,
}: SessionPickerProps): ReactElement {
  // Refs espelham o estado: o handler do ink pode rodar antes do efeito do
  // useEffectEvent ver o render novo (mesmo padrão do inputRef do app)
  const { rows } = useWindowSize();
  const windowRows = maxRows ?? listRows(rows, PICKER_CHROME);
  const selectedRef = useRef(0);
  const renamingRef = useRef(false);
  const draftRef = useRef("");
  const resumeRequestedRef = useRef(false); // um enter por sessão: repeat no mesmo chunk não duplica
  const [selected, setSelectedState] = useState(0);
  const [renaming, setRenamingState] = useState(false);
  const [draft, setDraftState] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const index = Math.min(selected, Math.max(sessions.length - 1, 0));
  const visible = listWindow(sessions.length, index, windowRows);

  const move = (delta: number): void => {
    if (sessions.length === 0) return;
    const currentIndex = Math.min(selectedRef.current, Math.max(sessions.length - 1, 0));
    selectedRef.current = (currentIndex + delta + sessions.length) % sessions.length;
    setSelectedState(selectedRef.current);
  };
  const startRename = (): void => {
    renamingRef.current = true;
    setRenamingState(true);
    draftRef.current = "";
    setDraftState("");
    setError(undefined);
  };
  const cancelRename = (): void => {
    renamingRef.current = false;
    setRenamingState(false);
    draftRef.current = "";
    setDraftState("");
    setError(undefined);
  };
  const current = (): SessionSummary | undefined => sessions[Math.min(selectedRef.current, Math.max(sessions.length - 1, 0))];

  useInput((value, key) => {
    if (key.ctrl && (value === "c" || value === "d")) {
      (onExit ?? onClose)();
      return;
    }
    if (key.escape) {
      if (renamingRef.current) cancelRename();
      else onClose();
      return;
    }
    if (renamingRef.current) {
      if (key.return && !key.meta && !key.ctrl) {
        const chosen = current();
        if (chosen === undefined) return;
        const failure = onRename(chosen, draftRef.current);
        setError(failure);
        if (failure === undefined) cancelRename();
        return;
      }
      if (key.backspace || key.delete) {
        draftRef.current = draftRef.current.slice(0, -1);
        setDraftState(draftRef.current);
        return;
      }
      if (!key.ctrl && !key.meta && value !== "") {
        // descarta controles/invisíveis (menos ZWJ/ZWNJ legítimos): nada de ESC/CSI no rascunho
        draftRef.current += value
          .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "")
          .replace(/\p{Cf}/gu, (char) => (char === "\u200c" || char === "\u200d" ? char : ""));
        setDraftState(draftRef.current);
      }
      return;
    }
    if (key.upArrow) {
      move(-1);
      return;
    }
    if (key.downArrow || key.tab) {
      move(1);
      return;
    }
    if (key.return && !key.meta && !key.ctrl) {
      const chosen = current();
      if (chosen !== undefined && !resumeRequestedRef.current) {
        resumeRequestedRef.current = true;
        onResume(chosen);
      }
      return;
    }
    if (value === "r" && !key.ctrl && !key.meta && current() !== undefined) startRename();
  });

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Sessões</Text>
      {sessions.length === 0 ? <Text dimColor>nenhuma sessão salva</Text> : null}
      {visible.start > 0 ? <Text dimColor>{`… ${visible.start} acima`}</Text> : null}
      {sessions.slice(visible.start, visible.end).map((item, offset) => {
        const position = visible.start + offset;
        return (
          <Text key={item.id} color={position === index ? colors.accent : undefined}>
            {position === index ? "> " : "  "}
            {sessionSummaryLine(item, position)}
          </Text>
        );
      })}
      {visible.end < sessions.length ? <Text dimColor>{`… ${sessions.length - visible.end} abaixo`}</Text> : null}
      {renaming ? <Text>nome: {draft}_</Text> : null}
      {error === undefined ? null : <Text color={colors.error}>{error}</Text>}
      <Text dimColor>{renaming ? "enter salvar · esc cancelar" : "↑↓ mover · enter retomar · r renomear · esc voltar"}</Text>
    </Box>
  );
}
