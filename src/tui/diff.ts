/** Parse de unified diff em linhas tipadas para o diff viewer da TUI (#64). Puro, sem ink. */
import type { ThemeColors } from "./theme";

export type DiffLineType = "hunk" | "add" | "remove" | "context" | "meta";

export interface DiffLine {
  type: DiffLineType;
  /** Linha crua do diff (com o prefixo +/-/espaço), pronta para exibir. */
  text: string;
}

/**
 * Quebra o diff em linhas classificadas. Linhas antes do primeiro `@@`
 * (diff --git/index/---/+++) viram `meta`; `\ No newline...` também.
 * A última linha vazia é artefato do `\n` final e é descartada.
 */
export function parseDiffLines(diff: string): DiffLine[] {
  const raw = diff.split(/\r?\n/);
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();

  const lines: DiffLine[] = [];
  let inHunk = false;
  for (const line of raw) {
    if (line.startsWith("diff --git")) {
      // diff multi-arquivo: cabeçalho novo reseta o hunk (---/+++ do arquivo seguinte são meta)
      inHunk = false;
      lines.push({ type: "meta", text: line });
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      lines.push({ type: "hunk", text: line });
      continue;
    }
    if (!inHunk) {
      lines.push({ type: "meta", text: line });
      continue;
    }
    if (line.startsWith("+")) lines.push({ type: "add", text: line });
    else if (line.startsWith("-")) lines.push({ type: "remove", text: line });
    else if (line.startsWith("\\")) lines.push({ type: "meta", text: line });
    // contexto vazio vira um espaço para a linha não colapsar no render
    else lines.push({ type: "context", text: line === "" ? " " : line });
  }
  return lines;
}

export interface DiffStats {
  adds: number;
  removes: number;
}

export function diffStats(lines: readonly DiffLine[]): DiffStats {
  let adds = 0;
  let removes = 0;
  for (const line of lines) {
    if (line.type === "add") adds++;
    else if (line.type === "remove") removes++;
  }
  return { adds, removes };
}

/** Cor da linha no viewer: add verde, remove na cor de erro do tema, hunk no accent, resto sem cor (vai dim). */
export function diffLineColor(line: DiffLine, colors: ThemeColors): string | undefined {
  switch (line.type) {
    case "add":
      return "green";
    case "remove":
      return colors.error;
    case "hunk":
      return colors.accent;
    default:
      return undefined;
  }
}
