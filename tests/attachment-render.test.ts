import { describe, expect, test } from "bun:test";
import type { LoadedAttachment } from "../src/attachments/model";
import { attachmentSizeLabel, materializePrompt, toMeta } from "../src/attachments/render";

const text = (overrides: Partial<LoadedAttachment> = {}): LoadedAttachment => ({
  kind: "text",
  path: "a.txt",
  name: "a.txt",
  sizeBytes: 8,
  mediaType: "text/plain",
  data: "dois\ntres",
  ...overrides,
});

describe("materializePrompt", () => {
  test("anexa bloco de texto com path e range", () => {
    const out = materializePrompt("resuma", [text({ range: { start: 2, end: 3 } })]);
    expect(out).toBe("resuma\n\n[anexo: a.txt (linhas 2-3)]\ndois\ntres");
  });

  test("sem anexos devolve o prompt intacto", () => {
    expect(materializePrompt("oi", [])).toBe("oi");
  });

  test("prompt vazio começa pelo bloco", () => {
    expect(materializePrompt("", [text()])).toBe("[anexo: a.txt]\ndois\ntres");
  });

  test("diretório usa barra final e não entra como imagem", () => {
    const out = materializePrompt("x", [
      { kind: "directory", path: "dir", name: "dir", sizeBytes: 4, mediaType: "inode/directory", data: "a\t1" },
      { kind: "image", path: "i.png", name: "i.png", sizeBytes: 10, mediaType: "image/png", data: "AAAA" },
    ]);
    expect(out).toBe("x\n\n[anexo: dir/]\na\t1");
  });
});

describe("attachmentSizeLabel", () => {
  test("imagem usa bytes decodificados; texto e diretório usam bytes do payload", () => {
    expect(attachmentSizeLabel({ kind: "image", sizeBytes: 4 })).toBe("4 bytes decodificados");
    expect(attachmentSizeLabel({ kind: "text", sizeBytes: 12 })).toBe("12 bytes");
    expect(attachmentSizeLabel({ kind: "directory", sizeBytes: 42 })).toBe("42 bytes");
  });
});

describe("toMeta", () => {
  test("descarta o payload e mantém hash/ref/range", () => {
    const meta = toMeta(text({ range: { start: 2, end: 3 } }));
    expect(meta).toEqual({ kind: "text", name: "a.txt", sizeBytes: 8, mediaType: "text/plain", range: { start: 2, end: 3 } });
    expect("data" in meta).toBe(false);
  });
});
