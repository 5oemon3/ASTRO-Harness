import { describe, expect, test } from "bun:test";
import {
  AttachmentError,
  MAX_ATTACHMENT_BYTES,
  MAX_TURN_BYTES,
  assertAttachmentSize,
  assertTurnSize,
  dedupeKey,
  detectKind,
  parseRange,
} from "../src/attachments/model";

const bytes = (...parts: number[]) => Uint8Array.from(parts);

describe("detectKind", () => {
  test("reconhece PNG, JPEG, GIF e WEBP por assinatura", () => {
    expect(detectKind(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toEqual({
      kind: "image",
      mediaType: "image/png",
    });
    expect(detectKind(bytes(0xff, 0xd8, 0xff, 0xe0))).toEqual({ kind: "image", mediaType: "image/jpeg" });
    expect(detectKind(new TextEncoder().encode("GIF89a"))).toEqual({ kind: "image", mediaType: "image/gif" });
    expect(detectKind(new TextEncoder().encode("RIFF....WEBPVP8 "))).toEqual({
      kind: "image",
      mediaType: "image/webp",
    });
  });

  test("texto UTF-8 sem NUL é text/plain; SVG é texto", () => {
    expect(detectKind(new TextEncoder().encode("olá, mundo"))).toEqual({ kind: "text", mediaType: "text/plain" });
    expect(detectKind(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toEqual({
      kind: "text",
      mediaType: "text/plain",
    });
  });

  test("binário e UTF-8 inválido retornam null", () => {
    expect(detectKind(bytes(0x00, 0x01, 0x02))).toBeNull();
    expect(detectKind(bytes(0xff, 0xfe, 0x00))).toBeNull();
  });

  test("header truncado falha fechado", () => {
    expect(detectKind(bytes(0x89, 0x50))).toBeNull();
  });
});

describe("parseRange", () => {
  test("1-based inclusivo", () => {
    expect(parseRange("10:40", 100)).toEqual({ start: 10, end: 40 });
    expect(parseRange("10", 100)).toEqual({ start: 10, end: 10 });
  });

  test("fim além do EOF clampa", () => {
    expect(parseRange("1:999", 3)).toEqual({ start: 1, end: 3 });
    expect(parseRange("2:999", 3)).toEqual({ start: 2, end: 3 });
  });

  test("inválido lança attachment_range_invalid", () => {
    for (const spec of ["0:5", "5:3", "101:102", "a:b", ":"]) {
      expect(() => parseRange(spec, 100)).toThrow(AttachmentError);
      try {
        parseRange(spec, 100);
      } catch (error) {
        expect((error as AttachmentError).code).toBe("attachment_range_invalid");
      }
    }
  });
});

describe("dedupeKey", () => {
  test("texto usa path+range; imagem usa hash", () => {
    expect(dedupeKey({ kind: "text", path: "/a", range: { start: 1, end: 2 } })).toBe("text:/a:1-2");
    expect(dedupeKey({ kind: "image", hash: "abc" })).toBe("image:abc");
  });
});

describe("limites", () => {
  test("20 MiB por anexo", () => {
    expect(() => assertAttachmentSize(MAX_ATTACHMENT_BYTES, "a")).not.toThrow();
    expect(() => assertAttachmentSize(MAX_ATTACHMENT_BYTES + 1, "a")).toThrow(AttachmentError);
  });

  test("40 MiB por turno", () => {
    const ok = [{ sizeBytes: MAX_TURN_BYTES - 1 }, { sizeBytes: 1 }];
    expect(() => assertTurnSize(ok)).not.toThrow();
    expect(() => assertTurnSize([...ok, { sizeBytes: 1 }])).toThrow(AttachmentError);
  });
});
