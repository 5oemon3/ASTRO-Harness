/**
 * Plugin system (F7-1): carrega tools e provider factories de plugins via
 * dynamic import, sem tocar no core. Plugin é um módulo (arquivo .ts ou
 * pacote npm) que exporta `definePlugin()`. Falha de load é isolada: warn no
 * console e o ASTRO segue sem o plugin.
 */
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Provider } from "./providers/types";
import { validateManifest } from "./sdk/tool";
import type { Tool } from "./tools/types";

/** Fábrica de provider registrada por plugin, keyed por `kind` da config. */
export interface PluginProviderFactory {
  kind: string;
  create(rawConfig: Record<string, unknown>, env: Record<string, string | undefined>): Provider;
}

/** Contrato do que um plugin pode registrar. */
export interface PluginDefinition {
  name: string;
  tools?: Tool[];
  providers?: PluginProviderFactory[];
}

/** Identidade para DX: plugins exportam `definePlugin({...})`. */
export function definePlugin(definition: PluginDefinition): PluginDefinition {
  return definition;
}

/** Resultado do carregamento: tools e factories registradas. */
export interface LoadedPlugins {
  tools: Tool[];
  providerFactories: Map<string, PluginProviderFactory>;
}

/** Entrada local (path) é confiável; pacote remoto exige allowlist explícita (I-13). */
function isLocalEntry(entry: string): boolean {
  return entry.startsWith(".") || isAbsolute(entry);
}

/** Opções do carregamento de plugins. */
export interface LoadPluginsOptions {
  warn?: (msg: string) => void;
  /** Allowlist de pacotes remotos (`ASTRO_PLUGIN_ALLOWLIST`). */
  allowlist?: ReadonlySet<string>;
  /**
   * Caminho local só carrega depois do trust do cwd (#255). Default `false`
   * (fail closed): o app passa o resultado de `ensureTrustedCwd`.
   */
  localTrusted?: boolean;
  /** Base dos caminhos relativos; default `process.cwd()` (o app passa o cwd do run). */
  baseDir?: string;
}

/** Allowlist de plugins remotos; vem do env, nunca da config (que pode ser puxada de registry). */
export function pluginAllowlistFromEnv(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env.ASTRO_PLUGIN_ALLOWLIST ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

/** Importa o caminho canônico já validado; remoto segue a entrada original. */
async function importPlugin(entry: string, localPath?: string): Promise<unknown> {
  return import(localPath ?? entry);
}

/** Realpath quando o caminho existe; inexistente segue lexical (import falha depois). */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Caminho local coberto pelo trust do cwd: dentro de `baseDir`, inclusive
 * depois de resolver symlink. Fora da pasta, o trust não cobre o código (#255).
 */
function localPluginPath(baseDir: string, entry: string): string | undefined {
  const base = canonicalPath(resolve(baseDir));
  const real = canonicalPath(resolve(base, entry));
  const rel = relative(base, real);
  if (rel === "" || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return undefined;
  return real;
}

/** Extrai a definição do módulo importado (export default ou nomeado). */
function extractDefinition(mod: unknown): PluginDefinition | null {
  const record = mod as Record<string, unknown>;
  const candidates = [record.plugin, record.default, record.definePlugin];
  for (const candidate of candidates) {
    if (typeof candidate === "function") {
      const result = (candidate as () => unknown)();
      if (isPluginDefinition(result)) return result;
    }
    if (isPluginDefinition(candidate)) return candidate;
  }
  return null;
}

function isPluginDefinition(value: unknown): value is PluginDefinition {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.name === "string";
}

/** Carrega os plugins declarados; falhas isoladas (warn e segue). */
export async function loadPlugins(
  entries: readonly string[],
  opts: LoadPluginsOptions = {},
): Promise<LoadedPlugins> {
  const warn = opts.warn ?? ((msg) => console.warn(msg));
  const allowlist = opts.allowlist ?? new Set<string>();
  const baseDir = opts.baseDir ?? process.cwd();
  const tools: Tool[] = [];
  const providerFactories = new Map<string, PluginProviderFactory>();

  for (const entry of entries) {
    const local = isLocalEntry(entry);
    if (!local && !allowlist.has(entry)) {
      // fail closed: pacote remoto só carrega com aprovação local explícita
      warn(`plugin remoto "${entry}" não está em ASTRO_PLUGIN_ALLOWLIST; ignorado`);
      continue;
    }
    let localPath: string | undefined;
    if (local) {
      if (opts.localTrusted !== true) {
        // #255: importar executaria código do projeto ANTES do trust. Sem TTY e
        // pasta não confiável, o plugin local não carrega.
        warn(`plugin local "${entry}" não carrega: pasta do projeto não confiável (trust pendente); ignorado`);
        continue;
      }
      localPath = localPluginPath(baseDir, entry);
      if (localPath === undefined) {
        // #255: trust da pasta não cobre `../` nem absoluto fora do cwd (symlink incluso).
        warn(`plugin local "${entry}" fora do cwd do projeto; ignorado`);
        continue;
      }
    }
    try {
      const mod = await importPlugin(entry, localPath);
      const definition = extractDefinition(mod);
      if (definition === null) {
        warn(`plugin "${entry}" não exporta definePlugin/plugin válido; ignorado`);
        continue;
      }
      for (const tool of definition.tools ?? []) {
        if (typeof tool !== "object" || tool === null) {
          warn(`plugin "${definition.name}" registrou tool inválida; ignorada`);
          continue;
        }
        try {
          // #264: plugin não passa pelo typechecker; valida o manifesto no load.
          validateManifest(tool.manifest);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          warn(`plugin "${definition.name}" registrou tool inválida: ${detail}; ignorada`);
          continue;
        }
        tools.push(tool);
      }
      for (const factory of definition.providers ?? []) {
        if (typeof factory.kind !== "string" || typeof factory.create !== "function") {
          warn(`plugin "${definition.name}" registrou provider factory inválido; ignorado`);
          continue;
        }
        providerFactories.set(factory.kind, factory);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warn(`falha ao carregar o plugin "${entry}": ${detail}; seguindo sem ele`);
    }
  }

  return { tools, providerFactories };
}