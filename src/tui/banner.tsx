/** Banner da TUI (T3): versão do pacote, provider, modelo, endpoint e estado; usa theme. */
import { Box, Text } from "ink";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";
import type { ThemeColors } from "./theme";

let cachedVersion: string | undefined;

/** Versão do pacote lida de package.json (cacheada em módulo); "desconhecida" se ilegível. */
export function packageVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8")) as { version?: unknown };
    cachedVersion = typeof manifest.version === "string" && manifest.version !== "" ? manifest.version : "desconhecida";
  } catch {
    cachedVersion = "desconhecida";
  }
  return cachedVersion;
}

export interface BannerData {
  provider: string;
  model: string;
  endpoint: string;
  state: string;
  /** Modo de permissão ativo (#270); ausente não aparece. */
  mode?: string;
  /** Injetável em testes; default lê package.json. */
  version?: string;
}

/** Trecho do modo na linha (` · modo: <modo>`); compartilhado por bannerLine e o componente. */
export function modeSegment(mode: string): string {
  return ` · modo: ${mode}`;
}

/** Cor do indicador de modo: só `bypass` usa alerta (error); demais ficam na cor normal (#270). */
export function modeColor(mode: string | undefined, colors: ThemeColors): string | undefined {
  return mode === "bypass" ? colors.error : undefined;
}

/** Linha única do banner (pura, testável). */
export function bannerLine(data: BannerData): string {
  const base = `ASTRO v${data.version ?? packageVersion()} · ${data.provider} · ${data.model} · ${data.endpoint} · estado: ${data.state}`;
  return data.mode === undefined ? base : base + modeSegment(data.mode);
}

export function Banner({ colors, ...data }: BannerData & { colors: ThemeColors }): ReactElement {
  const lineColor = data.state === "ok" ? colors.accent : data.state === "down" ? colors.error : undefined;
  return (
    <Box borderStyle="round" borderColor={colors.accent} paddingX={1}>
      <Text color={lineColor}>{bannerLine({ ...data, mode: undefined })}</Text>
      {data.mode === undefined ? null : <Text color={modeColor(data.mode, colors)}>{modeSegment(data.mode)}</Text>}
    </Box>
  );
}
