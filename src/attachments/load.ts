/**
 * Carregamento de anexo a partir de path ou clipboard (ADR-0026, #392).
 * Faz I/O: canonicaliza, classifica (ADR-0027) e aplica hard-block sem override,
 * confirmação fora do cwd e limites. Consome `model.ts` (puro).
 */
import { createHash } from "node:crypto";
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { classifyPath, createPathClassifier, type PathClassifierContext } from "../path-class";
import { redactSecrets } from "../sanitize-external";
import { canonicalize, realpathPreservingDots } from "../tools/paths";
import {
  assertAttachmentSize,
  assertImageLimits,
  detectKind,
  MAX_ATTACHMENT_BYTES,
  MAX_DIRECTORY_ENTRIES,
  parseRange,
  AttachmentError,
  type AttachmentRange,
  type DetectedKind,
  type LoadedAttachment,
} from "./model";

export { AttachmentError };

/** Chunk de leitura do range em arquivo acima do teto (ADR-0026). */
const READ_CHUNK_BYTES = 64 * 1024;

/** Entrada de `loadAttachment`; `confirmOutsideCwd` é injetado pela superfície. */
export interface LoadAttachmentInput {
  path: string;
  /** Faixa 1-based opcional, só para texto (`início:fim` ou `linha`). */
  range?: string;
  cwd: string;
  astroHome: string;
  protectedPaths?: readonly string[];
  /** `attachments.directory.showHidden`. */
  showHidden?: boolean;
  /** Fora do cwd pede confirmação; ausente ou `false` falha fechado (I-19). */
  confirmOutsideCwd?: (absolutePath: string) => Promise<boolean> | boolean;
  /** Teto de leitura em bytes; default 20 MiB. */
  maxBytes?: number;
}

/** Case-fold em win32/darwin (ADR-0026); demais plataformas preservam case. */
function fold(path: string): string {
  return process.platform === "win32" || process.platform === "darwin" ? path.toLowerCase() : path;
}

/** `real` dentro de `cwd` (comparação por realpath, case-fold nas plataformas do ADR). */
function withinCwd(cwd: string, real: string): boolean {
  const rel = relative(fold(canonicalize(cwd)), fold(real));
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return rel.split(sep)[0] !== "..";
}

/** Expande `~` e `~usuario` (só o usuário atual); `~outro` falha fechado (null). */
function expandHome(input: string): string | null {
  const match = /^~([^\\/]*)([\\/][\s\S]*)?$/.exec(input);
  if (!match) return input;
  if (match[1] === "") return match[2] ? join(homedir(), match[2].slice(1)) : homedir();
  const info = userInfo();
  return match[1] === info.username ? join(info.homedir, match[2]?.slice(1) ?? "") : null;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Listagem não recursiva de diretório, com filtros e teto de 500 entradas. */
function listDirectory(
  real: string,
  context: Pick<PathClassifierContext, "cwd" | "astroHome" | "protectedPaths"> & { showHidden: boolean },
): string {
  const classify = createPathClassifier({
    cwd: context.cwd,
    astroHome: context.astroHome,
    protectedPaths: context.protectedPaths,
    artifactRoot: null,
  });
  const lines: string[] = [];
  for (const entry of readdirSync(real, { withFileTypes: true })) {
    if (entry.name === ".astro" || entry.name === ".git") continue;
    if (!context.showHidden && entry.name.startsWith(".")) continue;
    const childReal = realpathPreservingDots(join(real, entry.name), context.cwd);
    if (classify(childReal) === "hard-block") continue;
    let size = "<dir>";
    try {
      const stats = statSync(childReal);
      size = stats.isDirectory() ? "<dir>" : String(stats.size);
    } catch {
      continue;
    }
    lines.push(`${entry.name}\t${size}`);
  }
  if (lines.length > MAX_DIRECTORY_ENTRIES) {
    throw new AttachmentError(
      "attachment_directory_too_large",
      `diretório "${basename(real)}" tem ${lines.length} entradas após filtros (máx ${MAX_DIRECTORY_ENTRIES}); use um filtro`,
      real,
    );
  }
  lines.sort();
  return lines.join("\n");
}

/** Lê até `length` bytes iniciais do arquivo sem carregar o restante. */
function readHeader(real: string, length: number): Uint8Array {
  const fd = openSync(real, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const read = readSync(fd, buffer, offset, length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return buffer.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

/** Header de arquivo grande pode terminar no meio de uma sequência UTF-8; corta até 3 bytes. */
function detectHeaderKind(header: Uint8Array): DetectedKind | null {
  if (header.includes(0)) return null;
  for (let cut = 1; cut <= 3 && cut < header.length; cut += 1) {
    const retry = detectKind(header.subarray(0, header.length - cut));
    if (retry !== null) return retry;
  }
  return null;
}

/** Erro tipado do teto de leitura por anexo (stat ou range). */
function attachmentTooLarge(name: string, limit: number, size: number, real: string): AttachmentError {
  return new AttachmentError("attachment_too_large", `anexo "${name}" excede ${limit} bytes (${size})`, real);
}

/** Erro tipado do teto de leitura durante range (ADR-0026): nunca trunca em silêncio. */
function rangeTooLarge(spec: string, limit: number, real: string): AttachmentError {
  return new AttachmentError("attachment_too_large", `faixa "${spec}" excede o teto de leitura de ${limit} bytes`, real);
}

/**
 * Lê só as linhas de `spec` de um arquivo acima do teto, em chunks, sem carregar
 * o restante. `start` além do EOF é erro, `end` além do EOF clampa; o offset da
 * linha `start` e o payload selecionado são limitados a `limit` (ADR-0026).
 */
function readTextRange(real: string, spec: string, limit: number): { data: string; range: AttachmentRange } {
  const requested = parseRange(spec, Number.MAX_SAFE_INTEGER);
  const fd = openSync(real, "r");
  try {
    const output = Buffer.allocUnsafe(limit);
    let outputBytes = 0;
    let skippedBytes = 0;
    let line = 1;
    let lastLine = 1;
    let done = false;
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    while (!done) {
      const read = readSync(fd, chunk, 0, READ_CHUNK_BYTES, null);
      if (read === 0) break;
      const view = chunk.subarray(0, read);
      let cursor = 0;
      while (cursor < read) {
        // A linha `start` pode existir com offset acima do cap: aí o erro é de teto.
        // Se o arquivo terminar antes dela, o erro é range inválido (checado após o loop).
        if (line === requested.start && skippedBytes > limit) throw rangeTooLarge(spec, limit, real);
        const newline = view.indexOf(0x0a, cursor);
        const end = newline === -1 ? read : newline;
        const length = end - cursor;
        if (line >= requested.start && line <= requested.end) {
          if (outputBytes + length > limit) throw rangeTooLarge(spec, limit, real);
          view.copy(output, outputBytes, cursor, end);
          outputBytes += length;
        } else {
          skippedBytes += length;
        }
        if (newline === -1) break;
        if (line >= requested.start && line <= requested.end) {
          // O newline da última linha selecionada não entra no payload: não cobra o cap.
          if (line < requested.end) {
            if (outputBytes + 1 > limit) throw rangeTooLarge(spec, limit, real);
            output[outputBytes++] = 0x0a;
          }
        } else {
          skippedBytes += 1;
        }
        line += 1;
        lastLine = line;
        cursor = newline + 1;
        if (line > requested.end) {
          done = true;
          break;
        }
      }
    }
    if (lastLine < requested.start) {
      throw new AttachmentError(
        "attachment_range_invalid",
        `faixa fora do arquivo: "${spec}" (o arquivo tem ${lastLine} linha(s))`,
        real,
      );
    }
    if (skippedBytes > limit) throw rangeTooLarge(spec, limit, real);
    const selected = output.subarray(0, outputBytes);
    let text: string;
    try {
      // O header só cobre 64 KiB: valida NUL/UTF-8 na faixa que realmente entra no prompt.
      if (selected.includes(0)) throw new Error("NUL");
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(selected);
    } catch {
      throw new AttachmentError("attachment_unsupported_binary", `tipo não suportado: ${basename(real)}`, real);
    }
    return {
      data: redactSecrets(text),
      range: { start: requested.start, end: Math.min(requested.end, lastLine) },
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * Carrega um anexo de `path`. Ordem: expande `~` → realpath → classify com
 * `artifactRoot: null` (a raiz de artefato é destino, nunca fonte) → hard-block
 * sem override → fora do cwd pede `confirmOutsideCwd` → leitura e limites.
 */
export async function loadAttachment(input: LoadAttachmentInput): Promise<LoadedAttachment> {
  const expanded = expandHome(input.path);
  if (expanded === null) {
    throw new AttachmentError("attachment_hard_blocked", `path não resolvível: ${input.path}`);
  }
  const absolute = isAbsolute(expanded) ? expanded : resolve(input.cwd, expanded);
  const real = realpathPreservingDots(absolute, input.cwd);

  const pathClass = classifyPath({
    realPath: real,
    cwd: input.cwd,
    astroHome: input.astroHome,
    protectedPaths: input.protectedPaths,
    artifactRoot: null,
  });
  if (pathClass === "hard-block") {
    throw new AttachmentError("attachment_hard_blocked", `caminho bloqueado: ${real}`, real);
  }

  if (!withinCwd(input.cwd, real)) {
    const approved = input.confirmOutsideCwd === undefined ? false : await input.confirmOutsideCwd(real);
    if (!approved) {
      throw new AttachmentError(
        "attachment_outside_denied",
        `anexo fora do diretório de trabalho não aprovado: ${real}`,
        real,
      );
    }
  }

  const stats = statSync(real);
  const name = basename(real);

  if (stats.isDirectory()) {
    if (input.range !== undefined) {
      throw new AttachmentError("attachment_range_invalid", "range só vale para anexo de texto", real);
    }
    const listing = listDirectory(real, {
      cwd: input.cwd,
      astroHome: input.astroHome,
      protectedPaths: input.protectedPaths,
      showHidden: input.showHidden === true,
    });
    const sizeBytes = Buffer.byteLength(listing, "utf8");
    assertAttachmentSize(sizeBytes, name);
    return { kind: "directory", path: real, name, sizeBytes, mediaType: "inode/directory", data: listing };
  }

  const limit = input.maxBytes ?? MAX_ATTACHMENT_BYTES;
  const rangeSpec = input.range;
  const oversized = stats.size > limit;
  if (oversized && rangeSpec === undefined) throw attachmentTooLarge(name, limit, stats.size, real);
  const bytes = oversized ? readHeader(real, READ_CHUNK_BYTES) : new Uint8Array(readFileSync(real));
  const detected = detectKind(bytes) ?? (oversized ? detectHeaderKind(bytes) : null);
  if (detected === null) {
    throw new AttachmentError("attachment_unsupported_binary", `tipo não suportado: ${name}`, real);
  }

  if (detected.kind === "image") {
    if (rangeSpec !== undefined) {
      throw new AttachmentError("attachment_range_invalid", "range não vale para imagem", real);
    }
    const decodedBytes = assertImageLimits(bytes, detected.mediaType);
    assertAttachmentSize(decodedBytes, name);
    return {
      kind: "image",
      path: real,
      name,
      sizeBytes: decodedBytes,
      mediaType: detected.mediaType,
      data: Buffer.from(bytes).toString("base64"),
      hash: sha256(bytes),
    };
  }

  if (oversized) {
    // O guard acima já rejeitou arquivo acima do teto sem range; o check explícito
    // mantém o narrowing do TypeScript sem `!`.
    if (rangeSpec === undefined) throw attachmentTooLarge(name, limit, stats.size, real);
    const ranged = readTextRange(real, rangeSpec, limit);
    const sizeBytes = Buffer.byteLength(ranged.data, "utf8");
    assertAttachmentSize(sizeBytes, name);
    return {
      kind: "text",
      path: real,
      name,
      sizeBytes,
      mediaType: detected.mediaType,
      range: ranged.range,
      data: ranged.data,
    };
  }

  let text = redactSecrets(Buffer.from(bytes).toString("utf8"));
  let range: LoadedAttachment["range"];
  if (rangeSpec !== undefined) {
    range = parseRange(rangeSpec, text.split("\n").length);
    text = text
      .split("\n")
      .slice(range.start - 1, range.end)
      .join("\n");
  }
  const sizeBytes = Buffer.byteLength(text, "utf8");
  assertAttachmentSize(sizeBytes, name);
  return {
    kind: "text",
    path: real,
    name,
    sizeBytes,
    mediaType: detected.mediaType,
    ...(range === undefined ? {} : { range }),
    data: text,
  };
}

/** Texto do clipboard: sem path, dedupe por SHA-256 do conteúdo redigido. */
export function loadPastedText(text: string): LoadedAttachment {
  const redacted = redactSecrets(text);
  return {
    kind: "text",
    name: "clipboard",
    sizeBytes: Buffer.byteLength(redacted, "utf8"),
    mediaType: "text/plain",
    data: redacted,
    hash: createHash("sha256").update(redacted, "utf8").digest("hex"),
  };
}
