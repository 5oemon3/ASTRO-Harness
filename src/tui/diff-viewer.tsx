/** Overlay full-screen de diff da TUI (#64): revisa o patch da tool `edit` antes de aprovar. */
import { Box, Text, useInput } from "ink";
import { useMemo, useRef, useState, type ReactElement } from "react";
import { redactSecrets } from "../sanitize-external";
import { diffLineColor, diffStats, parseDiffLines } from "./diff";
import type { ThemeColors } from "./theme";

export interface DiffViewerProps {
  path: string;
  diff: string;
  colors: ThemeColors;
  onClose(): void;
  /** Linhas visíveis por vez (janela de rolagem); testes usam viewport pequeno. */
  viewport?: number;
}

const DEFAULT_VIEWPORT = 20;

export function DiffViewer({ path, diff, colors, onClose, viewport = DEFAULT_VIEWPORT }: DiffViewerProps): ReactElement {
  // I-03: o diff é conteúdo do modelo (não confiável); a redação acontece na
  // fronteira de render, então nenhum chamador consegue vazar segredo na tela
  const lines = useMemo(() => parseDiffLines(redactSecrets(diff)), [diff]);
  const safePath = useMemo(() => redactSecrets(path), [path]);
  const stats = useMemo(() => diffStats(lines), [lines]);
  // Ref espelha o offset: o handler do ink pode rodar antes do estado novo (mesmo padrão do app)
  const offsetRef = useRef(0);
  const [offset, setOffsetState] = useState(0);
  const setOffset = (next: number): void => {
    const max = Math.max(lines.length - viewport, 0);
    const clamped = Math.min(Math.max(next, 0), max);
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
    if (key.pageUp) setOffset(offsetRef.current - viewport);
    if (key.pageDown) setOffset(offsetRef.current + viewport);
  });

  const visible = lines.slice(offset, offset + viewport);
  const last = Math.min(offset + viewport, lines.length);
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
        {`↑↓/jk rolar · pgup/pgdn página · esc/q voltar · linha ${lines.length === 0 ? 0 : offset + 1}-${last}/${lines.length}`}
      </Text>
    </Box>
  );
}
