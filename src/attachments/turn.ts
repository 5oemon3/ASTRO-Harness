/** Preparo do turno (ADR-0026, #392): dedupe, teto, aprovação, store e auditoria — só ref/hash/bytes/tipo, nunca base64 (I-03). */
import type { ImagePart } from "../providers/types";
import { assertTurnSize, dedupeKey, imageDimensions, AttachmentError, type AttachmentKind, type AttachmentMeta, type AttachmentRange, type LoadedAttachment } from "./model";
import { attachmentSizeLabel, toMeta } from "./render";
import type { ArtifactOwner, ArtifactStore, StoredArtifact } from "./store";

/** Item mostrado ao aprovador; nunca carrega o conteúdo do anexo. */
export interface AttachmentApprovalItem { kind: AttachmentKind; name: string; path?: string; mediaType: string; sizeBytes: number; range?: AttachmentRange; pixels?: { width: number; height: number } }

/** Aprovação explícita do lote quando há imagem; ausente nega (fail closed). */
export type AttachmentApprover = (items: readonly AttachmentApprovalItem[]) => Promise<boolean> | boolean;

export interface PrepareTurnInput { attachments: readonly LoadedAttachment[]; owner: ArtifactOwner; approver?: AttachmentApprover; store?: ArtifactStore | (() => ArtifactStore); audit?: (tipo: string, payload: Record<string, unknown>) => void }

export interface PreparedTurn { images: ImagePart[]; metas: AttachmentMeta[] }

/** Texto do prompt de aprovação: uma linha por anexo, sem conteúdo (ADR-0026). */
export function formatApprovalPrompt(items: readonly AttachmentApprovalItem[]): string {
  const lines = ["anexos deste turno (imagens não redigíveis):"];
  items.forEach((item, index) => {
    const label = item.kind === "image" ? "imagem não redigível" : item.kind === "text" ? "texto" : "diretório";
    const range = item.range === undefined ? "" : ` - linhas ${item.range.start}-${item.range.end}`;
    const pixels = item.pixels === undefined ? "dimensão desconhecida"
      : `${item.pixels.width}x${item.pixels.height} (${((item.pixels.width * item.pixels.height) / 1_000_000).toFixed(1)} MPx)`;
    const detail = item.kind === "image" ? ` - ${pixels}` : "";
    lines.push(`${index + 1}. ${(item.path ?? item.name).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")} - ${label}${range} - ${attachmentSizeLabel(item)}${detail}`);
  });
  return lines.join("\n");
}

function approvalItem(attachment: LoadedAttachment): AttachmentApprovalItem {
  const base = { kind: attachment.kind, name: attachment.name, ...(attachment.path === undefined ? {} : { path: attachment.path }),
    mediaType: attachment.mediaType, sizeBytes: attachment.sizeBytes,
    ...(attachment.range === undefined ? {} : { range: attachment.range }) };
  if (attachment.kind !== "image") return base;
  const pixels = imageDimensions(Buffer.from(attachment.data, "base64"), attachment.mediaType);
  return { ...base, ...(pixels === null ? {} : { pixels }) };
}

/** Deduplica preservando a primeira ocorrência, aplica o teto, exige aprovação quando há imagem, grava no store e devolve `ref`/`hash` + `images`. */
export async function prepareTurnAttachments(input: PrepareTurnInput): Promise<PreparedTurn> {
  const unique = input.attachments.filter((a, i, all) => all.findIndex((b) => dedupeKey(b) === dedupeKey(a)) === i);
  assertTurnSize(unique);

  const images = unique.filter((attachment) => attachment.kind === "image");
  const stored = new Map<LoadedAttachment, StoredArtifact>();
  if (images.length > 0) {
    if (input.approver === undefined) throw new AttachmentError("attachment_image_denied", "imagem anexada exige aprovação explícita; sem aprovador o turno é negado");
    if (!(await input.approver(unique.map(approvalItem)))) throw new AttachmentError("attachment_image_denied", "anexos do turno não aprovados pelo usuário");
    // O store é criado só depois da aprovação: negar não cria raiz nem grava GC.
    const store = typeof input.store === "function" ? input.store() : input.store;
    if (store === undefined) throw new AttachmentError("attachment_root_invalid", "artifact store indisponível para persistir a imagem");
    for (const attachment of images) stored.set(attachment, store.save(input.owner, Buffer.from(attachment.data, "base64"), attachment.mediaType));
  }

  const metas = unique.map((attachment) => {
    const saved = stored.get(attachment);
    return toMeta(saved === undefined ? attachment : { ...attachment, ref: saved.ref, hash: saved.hash });
  });
  if (stored.size > 0) {
    input.audit?.("attachment.approved", { images: [...stored].map(([a, saved]) => ({ ref: saved.ref, hash: saved.hash, bytes: saved.bytes, mediaType: a.mediaType })) });
  }
  return { images: images.map((a) => ({ mediaType: a.mediaType, dataBase64: a.data })), metas };
}
