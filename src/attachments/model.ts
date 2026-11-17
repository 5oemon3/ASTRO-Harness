/**
 * Modelo de anexo (ADR-0026, #392): tipos, detecção por magic bytes, limites e
 * dedupe. Puro — sem I/O; `load.ts` e `store.ts` consomem este módulo.
 */

/** Tipo do anexo; `kind` vem de magic bytes, nunca da extensão. */
export type AttachmentKind = "text" | "image" | "directory";

/** Faixa de linhas 1-based inclusiva de um anexo de texto. */
export interface AttachmentRange {
  start: number;
  end: number;
}

/** Descritor de anexo; `sizeBytes` é o payload que entra no prompt. */
export interface Attachment {
  kind: AttachmentKind;
  /** realpath canônico; ausente só para imagem reidratada por `ref`. */
  path?: string;
  name: string;
  sizeBytes: number;
  mediaType: string;
  range?: AttachmentRange;
  /** Ref opaco do artifact store, só imagem persistida. */
  ref?: string;
  /** SHA-256 dos bytes gravados, só imagem com `ref`. */
  hash?: string;
}

/** Metadado persistível: o descritor sem o payload em memória. */
export type AttachmentMeta = Pick<
  Attachment,
  "kind" | "name" | "sizeBytes" | "mediaType" | "range" | "ref" | "hash"
>;

/** Anexo carregado; `data` (texto redigido, base64 ou listagem) nunca é persistido. */
export interface LoadedAttachment extends Attachment {
  data: string;
}

/** Resultado da detecção por magic bytes; `null` = binário fora do whitelist. */
export interface DetectedKind {
  kind: "text" | "image";
  mediaType: string;
}

/** Códigos tipados de anexo (mensagem cita caminho, nunca conteúdo — I-03). */
export type AttachmentErrorCode =
  | "attachment_hard_blocked"
  | "attachment_outside_denied"
  | "attachment_too_large"
  | "attachment_turn_too_large"
  | "attachment_unsupported_binary"
  | "attachment_image_invalid"
  | "attachment_image_denied"
  | "attachment_range_invalid"
  | "attachment_directory_too_large"
  | "attachment_root_invalid";

/** Falha de anexo; o `code` é estável para superfícies e testes. */
export class AttachmentError extends Error {
  readonly code: AttachmentErrorCode;
  readonly path?: string;

  constructor(code: AttachmentErrorCode, message: string, path?: string) {
    super(message);
    this.name = "AttachmentError";
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}

/** 20 MiB por anexo (ADR-0026). */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** 40 MiB somados por turno (ADR-0026). */
export const MAX_TURN_BYTES = 40 * 1024 * 1024;
/** 500 entradas por listagem de diretório (ADR-0026). */
export const MAX_DIRECTORY_ENTRIES = 500;
/** 25 MPx por imagem (ADR-0026). */
export const MAX_IMAGE_PIXELS = 25_000_000;
/** 8192 px no lado maior da imagem (ADR-0026). */
export const MAX_IMAGE_SIDE = 8192;
/** 20 MiB decodificados por imagem (ADR-0026). */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}

/** Detecta o kind por assinatura; texto exige UTF-8 válido sem NUL. */
export function detectKind(header: Uint8Array): DetectedKind | null {
  if (startsWith(header, PNG_SIGNATURE)) return { kind: "image", mediaType: "image/png" };
  if (startsWith(header, [0xff, 0xd8, 0xff])) return { kind: "image", mediaType: "image/jpeg" };
  if (ascii(header, 0, 6) === "GIF87a" || ascii(header, 0, 6) === "GIF89a") {
    return { kind: "image", mediaType: "image/gif" };
  }
  if (header.length >= 12 && ascii(header, 0, 4) === "RIFF" && ascii(header, 8, 12) === "WEBP") {
    return { kind: "image", mediaType: "image/webp" };
  }
  if (header.includes(0)) return null;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(header);
    return { kind: "text", mediaType: "text/plain" };
  } catch {
    return null;
  }
}

/** Converte `a:b`/`a` em faixa 1-based; `end` além do EOF clampa (ADR-0026). */
export function parseRange(spec: string, totalLines: number): AttachmentRange {
  const match = /^(\d+)(?::(\d+))?$/.exec(spec.trim());
  if (!match) {
    throw new AttachmentError("attachment_range_invalid", `faixa inválida: "${spec}" (use início:fim, 1-based)`);
  }
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  if (start < 1 || end < start || start > totalLines) {
    throw new AttachmentError(
      "attachment_range_invalid",
      `faixa fora do arquivo: "${spec}" (o arquivo tem ${totalLines} linha(s))`,
    );
  }
  return { start, end: Math.min(end, totalLines) };
}

/** Chave de dedupe: texto/diretório por path+range, imagem/clipboard por hash. */
export function dedupeKey(attachment: Pick<Attachment, "kind" | "path" | "range" | "hash">): string {
  if (attachment.kind === "image") return `image:${attachment.hash ?? ""}`;
  if (attachment.kind === "directory") return `directory:${attachment.path ?? ""}`;
  if (attachment.path === undefined) return `text:clipboard:${attachment.hash ?? ""}`;
  const range = attachment.range === undefined ? "" : `${attachment.range.start}-${attachment.range.end}`;
  return `text:${attachment.path}:${range}`;
}

/** Dimensões em pixels; `null` quando o header é curto ou o formato não é reconhecido. */
export function imageDimensions(
  header: Uint8Array,
  mediaType: string,
): { width: number; height: number } | null {
  try {
    if (mediaType === "image/png") {
      if (header.length < 24) return null;
      const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
      return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (mediaType === "image/gif") {
      if (header.length < 10) return null;
      return {
        width: header[6]! | (header[7]! << 8),
        height: header[8]! | (header[9]! << 8),
      };
    }
    if (mediaType === "image/jpeg") return jpegDimensions(header);
    if (mediaType === "image/webp") return webpDimensions(header);
  } catch {
    return null;
  }
  return null;
}

/** Varre marcadores JPEG até o primeiro SOF (exceto C4/C8/CC) e lê altura/largura. */
function jpegDimensions(header: Uint8Array): { width: number; height: number } | null {
  let index = 2;
  while (index + 8 < header.length) {
    if (header[index] !== 0xff) {
      index += 1;
      continue;
    }
    let marker = header[index + 1]!;
    while (marker === 0xff) {
      index += 1;
      marker = header[index + 1]!;
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      index += 2;
      continue;
    }
    const length = (header[index + 2]! << 8) | header[index + 3]!;
    if (length < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (index + 9 >= header.length) return null;
      return {
        height: (header[index + 5]! << 8) | header[index + 6]!,
        width: (header[index + 7]! << 8) | header[index + 8]!,
      };
    }
    index += 2 + length;
  }
  return null;
}

/** Lê dimensões de WEBP nas variantes VP8X (estendida), VP8L (lossless) e VP8 (lossy). */
function webpDimensions(header: Uint8Array): { width: number; height: number } | null {
  if (header.length < 30) return null;
  const chunk = ascii(header, 12, 16);
  if (chunk === "VP8X") {
    return {
      width: (header[24]! | (header[25]! << 8) | (header[26]! << 16)) + 1,
      height: (header[27]! | (header[28]! << 8) | (header[29]! << 16)) + 1,
    };
  }
  if (chunk === "VP8L") {
    if (header[20] !== 0x2f) return null;
    const bits = header[21]! | (header[22]! << 8) | (header[23]! << 16) | (header[24]! << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8 ") {
    if (header[23] !== 0x9d || header[24] !== 0x01 || header[25] !== 0x2a) return null;
    return {
      width: (header[26]! | (header[27]! << 8)) & 0x3fff,
      height: (header[28]! | (header[29]! << 8)) & 0x3fff,
    };
  }
  return null;
}

/** Bytes decodificados estimados: 4 por pixel (RGBA), o formato comum aos tipos suportados. */
export function decodedImageBytes(dimensions: { width: number; height: number }): number {
  return dimensions.width * dimensions.height * 4;
}

/** Valida MPx, lado maior e bytes decodificados antes de qualquer decodificação; devolve os bytes decodificados. */
export function assertImageLimits(header: Uint8Array, mediaType: string): number {
  const dimensions = imageDimensions(header, mediaType);
  if (dimensions === null || dimensions.width <= 0 || dimensions.height <= 0) {
    throw new AttachmentError("attachment_image_invalid", `header de imagem ilegível (${mediaType})`);
  }
  if (dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
    throw new AttachmentError(
      "attachment_image_invalid",
      `imagem excede ${MAX_IMAGE_PIXELS} pixels (${dimensions.width}x${dimensions.height})`,
    );
  }
  if (dimensions.width > MAX_IMAGE_SIDE || dimensions.height > MAX_IMAGE_SIDE) {
    throw new AttachmentError(
      "attachment_image_invalid",
      `imagem excede ${MAX_IMAGE_SIDE} px no lado maior (${dimensions.width}x${dimensions.height})`,
    );
  }
  const decodedBytes = decodedImageBytes(dimensions);
  if (decodedBytes > MAX_IMAGE_BYTES) {
    throw new AttachmentError(
      "attachment_image_invalid",
      `imagem excede ${MAX_IMAGE_BYTES} bytes decodificados (${decodedBytes})`,
    );
  }
  return decodedBytes;
}

/** Garante o teto de 20 MiB por anexo. */
export function assertAttachmentSize(sizeBytes: number, name: string): void {
  if (sizeBytes > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError(
      "attachment_too_large",
      `anexo "${name}" excede ${MAX_ATTACHMENT_BYTES} bytes (${sizeBytes})`,
    );
  }
}

/** Garante o teto de 40 MiB somados no turno. */
export function assertTurnSize(attachments: readonly Pick<Attachment, "sizeBytes">[]): void {
  const total = attachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0);
  if (total > MAX_TURN_BYTES) {
    throw new AttachmentError(
      "attachment_turn_too_large",
      `anexos do turno excedem ${MAX_TURN_BYTES} bytes (${total})`,
    );
  }
}
