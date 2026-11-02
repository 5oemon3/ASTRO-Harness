/** Configuração da TUI (T2): tema e último modelo em `.astro/tui.json`. */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { ConfigError } from "../config";

export type Theme = "dark" | "light" | "contrast";

/** Temas na ordem em que `/theme` lista e o keybind alterna (#64). */
export const THEMES: readonly Theme[] = ["dark", "light", "contrast"];

/** Guarda de tema para o argumento de `/theme` (puro). */
export function isTheme(value: string): value is Theme {
  return THEMES.some((theme) => theme === value);
}

export interface TuiConfig {
  theme: Theme;
  lastModel?: string;
  favoriteModels?: string[];
  recentModels?: string[];
}

export type ThemeColors = { accent: string; warning: string; error: string };

const DEFAULT_CONFIG: TuiConfig = { theme: "dark" };

function configPath(cwd: string): string {
  return join(cwd, ".astro", "tui.json");
}

/** Garante que o alvo existente fica dentro do cwd canônico, seguindo links (I-11). */
function assertInside(cwd: string, path: string): void {
  const rel = relative(realpathSync(cwd), realpathSync(path));
  if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) throw new ConfigError("config da TUI fora do cwd");
}

function normalizeList(value: unknown, max = Number.POSITIVE_INFINITY): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "" || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

/** Lê a configuração; arquivo ausente, inválido ou fora do cwd cai no default. */
export function loadTuiConfig(cwd: string): TuiConfig {
  try {
    const file = configPath(cwd);
    if (existsSync(file)) assertInside(cwd, file);
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (parsed === null || typeof parsed !== "object") return { ...DEFAULT_CONFIG };
    const record = parsed as Record<string, unknown>;
    const theme: Theme = typeof record.theme === "string" && isTheme(record.theme) ? record.theme : "dark";
    const lastModel = typeof record.lastModel === "string" && record.lastModel !== "" ? record.lastModel : undefined;
    const favoriteModels = normalizeList(record.favoriteModels);
    const recentModels = normalizeList(record.recentModels, 10);
    return {
      theme,
      ...(lastModel === undefined ? {} : { lastModel }),
      ...(favoriteModels.length === 0 ? {} : { favoriteModels }),
      ...(recentModels.length === 0 ? {} : { recentModels }),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Grava a configuração mesclando com o que já existe (tema + preferências). */
export function saveTuiConfig(cwd: string, config: Partial<TuiConfig>): void {
  const current = loadTuiConfig(cwd);
  const lastModel = config.lastModel ?? current.lastModel;
  const favoriteModels = config.favoriteModels === undefined
    ? current.favoriteModels
    : normalizeList(config.favoriteModels);
  const recentModels = config.recentModels === undefined
    ? current.recentModels
    : normalizeList(config.recentModels, 10);
  const merged: TuiConfig = {
    theme: config.theme ?? current.theme,
    ...(lastModel === undefined ? {} : { lastModel }),
    ...(favoriteModels === undefined || favoriteModels.length === 0 ? {} : { favoriteModels }),
    ...(recentModels === undefined || recentModels.length === 0 ? {} : { recentModels }),
  };
  const dir = join(cwd, ".astro");
  mkdirSync(dir, { recursive: true });
  assertInside(cwd, dir);
  const file = configPath(cwd);
  if (existsSync(file)) assertInside(cwd, file);
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(merged, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Próximo tema do ciclo (`ctrl+x t`): dark -> light -> contrast -> dark. */
export function nextTheme(theme: Theme): Theme {
  const index = THEMES.indexOf(theme);
  return THEMES[(index + 1) % THEMES.length]!;
}

/** Cores por tema; o fundo do terminal não é alterado. */
export function getThemeColors(theme: Theme): ThemeColors {
  if (theme === "contrast") return { accent: "whiteBright", warning: "yellowBright", error: "redBright" };
  return { accent: theme === "light" ? "blue" : "cyan", warning: "yellow", error: "red" };
}
