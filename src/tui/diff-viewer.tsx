/** Overlay full-screen de diff da TUI (#64): revisa o patch da tool `edit` antes de aprovar. */
import { Box, Text, useInput, useWindowSize } from "ink";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { redactSecrets } from "../sanitize-external";
import { diffLineColor, diffStats, parseDiffLines } from "./diff";
import type { ThemeColors } from "./theme";
import { listRows } from "./viewport";

export interface DiffViewerProps {
  path: string;
  diff: string;
  colors: ThemeColors;
  onClose(): void;
  /** Linhas visíveis por vez (janela de rolagem); default derivado do terminal. */
  viewport?: number;
}

/** Borda (2) + título + rodapé. */
const DIFF_CHROME = 4;

export function DiffViewer({ path, diff, colors, onClose, viewport }: DiffViewerProps): ReactElement {
  // I-03: o diff é conteúdo do modelo (não confiável); a redação acontece na
  // fronteira de render, então nenhum chamador consegue vazar segredo na tela
  const lines = useMemo(() => parseDiffLines(redactSecrets(diff)), [diff]);
  const safePath = useMemo(() => redactSecrets(path), [path]);
  const stats = useMemo(() => diffStats(lines), [lines]);
  // Sem viewport explícito, a janela acompanha a altura do terminal (#64)
  const { rows } = useWindowSize();
  const viewportRows = viewport ?? listRows(rows, DIFF_CHROME, { cap: 20 });
  const maxOffset = Math.max(lines.length - viewportRows, 0);
  // Ref espelha o offset: o handler do ink pode rodar antes do estado novo (mesmo padrão do app)
  const offsetRef = useRef(0);
  const [offset, setOffsetState] = useState(0);
  const displayOffset = Math.min(offset, maxOffset);
  useEffect(() => {
    if (offset === displayOffset) return;
    offsetRef.current = displayOffset;
    setOffsetState(displayOffset);
  }, [offset, displayOffset]);
  const setOffset = (next: number): void => {
    const clamped = Math.min(Math.max(next, 0), maxOffset);
    offsetRef.current = clamped;
    setOffsetState(clamped);
  };

  useInput((value, key) => {
    if (key.escape || value === "q" || (key.ctrl === true && (value === "c" || value === "d"))) {
      onClose();
      return;
    }
    if (key.upArrow || (value === "k" && !key.ctrl && !key.meta)) {
      setOffset(offsetRef.current - 1);
      return;
    }
    if (key.downArrow || (value === "j" && !key.ctrl && !key.meta)) {
      setOffset(offsetRef.current + 1);
      return;
    }
    if (key.pageUp) setOffset(offsetRef.current - viewportRows);
    if (key.pageDown) setOffset(offsetRef.current + viewportRows);
  });

  const visible = lines.slice(displayOffset, displayOffset + viewportRows);
  const last = Math.min(displayOffset + viewportRows, lines.length);
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>
        {"diff · "}{safePath}{" · "}
        <Text color="green">+{stats.adds}</Text>{" "}
        <Text color={colors.error}>-{stats.removes}</Text>
      </Text>
      {visible.map((line, index) => (
        <Text
          key={offset + index}
          color={diffLineColor(line, colors)}
          dimColor={line.type === "context" || line.type === "meta"}
        >
          {line.text}
        </Text>
      ))}
      <Text dimColor>
        {`↑↓/jk rolar · pgup/pgdn página · esc/q voltar · linha ${lines.length === 0 ? 0 : displayOffset + 1}-${last}/${lines.length}`}
      </Text>
    </Box>
  );
}
