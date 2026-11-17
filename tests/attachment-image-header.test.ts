import { describe, expect, test } from "bun:test";
import { AttachmentError, assertImageLimits, decodedImageBytes, imageDimensions } from "../src/attachments/model";

const u8 = (...parts: number[]) => Uint8Array.from(parts);

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function gif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(10);
  bytes.set(new TextEncoder().encode("GIF89a"));
  bytes[6] = width & 0xff;
  bytes[7] = width >> 8;
  bytes[8] = height & 0xff;
  bytes[9] = height >> 8;
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  return u8(
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08,
    height >> 8, height & 0xff,
    width >> 8, width & 0xff,
    3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
  );
}

function webpVp8x(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WEBP"), 8);
  bytes.set(new TextEncoder().encode("VP8X"), 12);
  bytes.set([10, 0, 0, 0], 16);
  const w = width - 1;
  const h = height - 1;
  bytes.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff], 24);
  bytes.set([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 27);
  return bytes;
}

describe("imageDimensions", () => {
  test("PNG, GIF, JPEG e WEBP", () => {
    expect(imageDimensions(png(1, 1), "image/png")).toEqual({ width: 1, height: 1 });
    expect(imageDimensions(gif(10, 20), "image/gif")).toEqual({ width: 10, height: 20 });
    expect(imageDimensions(jpeg(640, 480), "image/jpeg")).toEqual({ width: 640, height: 480 });
    expect(imageDimensions(webpVp8x(1920, 1080), "image/webp")).toEqual({ width: 1920, height: 1080 });
  });

  test("header truncado ou SOF ausente retorna null", () => {
    expect(imageDimensions(png(1, 1).slice(0, 12), "image/png")).toBeNull();
    expect(imageDimensions(u8(0xff, 0xd8, 0xff), "image/jpeg")).toBeNull();
    expect(imageDimensions(u8(1, 2, 3), "image/webp")).toBeNull();
  });
});

describe("assertImageLimits", () => {
  test("bytes decodificados são 4 por pixel (RGBA), não o tamanho comprimido", () => {
    expect(decodedImageBytes({ width: 100, height: 100 })).toBe(40_000);
  });

  test("devolve os bytes decodificados calculados internamente", () => {
    expect(assertImageLimits(png(100, 100), "image/png")).toBe(40_000);
  });

  test("aceita dentro dos limites", () => {
    expect(() => assertImageLimits(png(100, 100), "image/png")).not.toThrow();
  });

  test("rejeita acima de 25 MPx", () => {
    expect(() => assertImageLimits(png(5000, 5001), "image/png")).toThrow(AttachmentError);
  });

  test("rejeita lado maior que 8192", () => {
    expect(() => assertImageLimits(png(9000, 1), "image/png")).toThrow(AttachmentError);
  });

  test("rejeita decodificado acima de 20 MiB", () => {
    expect(() => assertImageLimits(png(2500, 2100), "image/png")).toThrow(AttachmentError);
  });

  test("dimensões ilegíveis falham fechado", () => {
    expect(() => assertImageLimits(u8(0x89, 0x50), "image/png")).toThrow(AttachmentError);
  });
});
