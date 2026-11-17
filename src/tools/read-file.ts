import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveEntropyThreshold } from "../core/config";
import { shannonEntropyBitsPerChar } from "../entropy";
import { classifyPath } from "../path-class";
import { redactSecrets } from "../sanitize-external";
import { estimateTokens } from "../tokens";
import { resolveWithin } from "./paths";
import { ToolError, type Tool, type ToolResult } from "./types";

const PAGE_LINES = 350;
const OVERLAP_LINES = 10;
const MIN_STEP = 50;

function failure(message: string): ToolResult {
  return { output: message, isError: true };
}

interface ReadInput {
  path: string;
  offset?: number;
}

function readInput(input: unknown): ReadInput {
  if (typeof input !== "object" || input === null) {
    throw new ToolError("entrada inválida: esperado objeto com { path }");
  }
  const raw = input as { path?: unknown; offset?: unknown };
  if (typeof raw.path !== "string" || raw.path.length === 0) {
    throw new ToolError("entrada inválida: \"path\" deve ser uma string não vazia");
  }
  if (
    raw.offset !== undefined &&
    (typeof raw.offset !== "number" || !Number.isInteger(raw.offset) || raw.offset < 1)
  ) {
    throw new ToolError('"offset" deve ser um inteiro >= 1 (linha inicial, 1-based)');
  }
  return { path: raw.path, ...(raw.offset === undefined ? {} : { offset: raw.offset }) };
}

/** Linhas do arquivo, sem o elemento vazio produzido pela quebra final. */
function fileLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * Página de leitura (CMP-11): 350 linhas, overlap 10, cabeçalho com o próximo
 * offset. Acima do cap da saída, encolhe em passos de 50 linhas (até 50).
 */
function page(lines: string[], offset: number | undefined, capTokens: number | undefined): string {
  const total = lines.length;
  const start = offset ?? 1;
  if (total === 0) return "linhas 0-0 de 0";
  if (start > total) return `fim do arquivo (${total} linhas)`;

  let size = PAGE_LINES;
  for (;;) {
    const end = Math.min(start + size - 1, total);
    const next = end < total ? Math.max(start + 1, end - (OVERLAP_LINES - 1)) : undefined;
    const header = next === undefined
      ? `linhas ${start}-${end} de ${total}`
      : `linhas ${start}-${end} de ${total}; para continuar, offset ${next}`;
    const text = [header, ...lines.slice(start - 1, end)].join("\n");
    if (capTokens === undefined || estimateTokens(text) <= capTokens || size <= MIN_STEP) return text;
    size = Math.max(MIN_STEP, size - MIN_STEP);
  }
}

/**
 * Negativa fail-closed do tier `sensitive` (ADR-0027, #391 slice 3b): cita o
 * path informado e a classe, nunca o conteúdo (I-03).
 */
function sensitiveDeny(path: string, reason: string): ToolResult {
  return failure(`leitura negada (classe sensitive): "${path}" — ${reason}; conteúdo não devolvido (fail-closed, ADR-0027)`);
}

/** Lê um arquivo de texto confinado ao diretório de trabalho, com paginação. */
export const readFileTool: Tool = {
  manifest: {
    name: "read_file",
    description: "Lê um arquivo de texto do diretório de trabalho, em páginas de até 350 linhas.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Caminho do arquivo, relativo ao diretório de trabalho.",
        },
        offset: {
          type: "integer",
          minimum: 1,
          description: "Linha inicial (1-based) para continuar a leitura; default 1.",
        },
      },
      required: ["path"],
    },
    risk: "low",
    permission: "read",
    class: "read_common",
    timeoutMs: 5_000,
    retryable: true,
    idempotent: true,
    sideEffects: "none",
  },

  async execute(input, ctx): Promise<ToolResult> {
    try {
      const { path, offset } = readInput(input);
      const resolved = resolveWithin(ctx.cwd, path);
      const env = ctx.env ?? process.env;
      // ADR-0027: classifica sobre o realpath. Neste slice só o tier
      // `sensitive` passa pelo gate de entropia (`hard-block` é do slice 1;
      // `normal` não aplica entropia).
      const pathClass = classifyPath({
        realPath: resolved,
        cwd: ctx.cwd,
        astroHome: env.ASTRO_HOME?.trim() || join(homedir(), ".astro"),
        ...(ctx.protectedPaths === undefined ? {} : { protectedPaths: ctx.protectedPaths }),
        ...(ctx.allowCritical === undefined ? {} : { allowCritical: ctx.allowCritical }),
        ...(ctx.allowSensitive === undefined ? {} : { allowSensitive: ctx.allowSensitive }),
      });
      if (pathClass === "sensitive") {
        let raw: string;
        try {
          raw = readFileSync(resolved, "utf8");
        } catch {
          // Sem conteúdo inspecionável a entropia é inconclusiva: nega (fail-closed).
          return sensitiveDeny(path, "conteúdo ilegível");
        }
        // Entropia é calculada no conteúdo CRU, antes de redigir, só para decidir;
        // a saída devolvida segue sempre redigida (I-03).
        const threshold = resolveEntropyThreshold({ env });
        if (threshold === null) {
          return sensitiveDeny(path, "limiar de entropia configurado inválido");
        }
        if (shannonEntropyBitsPerChar(raw) >= threshold) {
          return sensitiveDeny(path, "entropia do conteúdo acima do limiar (possível segredo)");
        }
        return { output: page(fileLines(redactSecrets(raw)), offset, ctx.outputLimitTokens) };
      }
      // ADR-0027: redige o arquivo INTEIRO antes de paginar — segredo não entra
      // no contexto mesmo que esteja no disco (I-03), um bloco cortado na borda
      // da página não vaza, e o teto de tokens de `page` conta o texto redigido.
      const lines = fileLines(redactSecrets(readFileSync(resolved, "utf8")));
      return { output: page(lines, offset, ctx.outputLimitTokens) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(`erro ao ler arquivo: ${message}`);
    }
  },
};
