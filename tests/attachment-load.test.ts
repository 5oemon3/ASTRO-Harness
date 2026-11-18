import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAttachment, loadPastedText } from "../src/attachments/load";
import { MAX_ATTACHMENT_BYTES } from "../src/attachments/model";
import { canonicalize } from "../src/tools/paths";

const roots: string[] = [];

function sandbox(): { cwd: string; astroHome: string } {
  const root = mkdtempSync(join(tmpdir(), "astro-att-"));
  roots.push(root);
  const cwd = join(root, "work");
  const astroHome = join(root, "home");
  mkdirSync(cwd);
  mkdirSync(astroHome);
  return { cwd, astroHome };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const base = (cwd: string, astroHome: string) => ({ cwd, astroHome });

/** Marcadores PEM exatos, montados em runtime: o literal completo não entra no repo (I-03). */
const PEM_BEGIN = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
const PEM_END = ["-----END", "PRIVATE KEY-----"].join(" ");
const PEM_BODY = [
  "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun",
  "VTLw5Zs5DDnbqZ6rJ1QxJw9pQ0l0l0l0l0l0l0l0l0l0l0l0l0l0l0l0l0l0l0l0l0l",
  "Q2h1Y2sxMjM0NTY3ODkwYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo",
];
/** Marcador com label longo (acima de qualquer bound antigo): detecção por faixa é por prefixo. */
const PEM_LONG_LABEL = ["-----BEGIN", `${"A".repeat(40)} PRIVATE KEY BLOCK-----`].join(" ");
const PEM_LONG_END = ["-----END", `${"A".repeat(40)} PRIVATE KEY BLOCK-----`].join(" ");

/** Header PNG mínimo com IHDR: suficiente para magic bytes e dimensões (não é PNG completo). */
function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

describe("loadAttachment", () => {
  test("texto: conteúdo, tamanho UTF-8 e redação", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "a.txt"), "linha1\nlinha2\nlinha3\n");
    const attachment = await loadAttachment({ ...base(cwd, astroHome), path: "a.txt" });
    expect(attachment.kind).toBe("text");
    expect(attachment.mediaType).toBe("text/plain");
    expect(attachment.data).toContain("linha2");
    expect(attachment.sizeBytes).toBe(Buffer.byteLength(attachment.data, "utf8"));
  });

  test("segredo é redigido antes de virar payload", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "a.txt"), "chave sk-abcdefghijklmnop123456 aqui");
    const attachment = await loadAttachment({ ...base(cwd, astroHome), path: "a.txt" });
    expect(attachment.data).not.toContain("sk-abcdefghijklmnop123456");
    expect(attachment.data).toContain("[REDACTED]");
  });

  test("range 2:3 devolve só essas linhas", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "a.txt"), "um\ndois\ntres\n");
    const attachment = await loadAttachment({ ...base(cwd, astroHome), path: "a.txt", range: "2:3" });
    expect(attachment.data).toBe("dois\ntres");
    expect(attachment.range).toEqual({ start: 2, end: 3 });
  });

  test("range 1:999 clampa no EOF", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "a.txt"), "um\ndois\ntres");
    const attachment = await loadAttachment({ ...base(cwd, astroHome), path: "a.txt", range: "1:999" });
    expect(attachment.data).toBe("um\ndois\ntres");
    expect(attachment.range).toEqual({ start: 1, end: 3 });
  });

  test("range de arquivo pequeno é aplicado antes da redação (numeração preservada)", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "chave.txt"), [
      PEM_BEGIN,
      PEM_BODY[0]!,
      "linha-interna-3",
      PEM_END,
      "alvo-5",
      "alvo-6",
      "alvo-7",
    ].join("\n"));
    const attachment = await loadAttachment({ ...base(cwd, astroHome), path: "chave.txt", range: "5:6" });
    expect(attachment.data).toBe("alvo-5\nalvo-6");
    expect(attachment.range).toEqual({ start: 5, end: 6 });
    expect(attachment.data).not.toContain("PRIVATE KEY");
  });

  test("range no interior de um PEM não vaza o corpo da chave", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "notas.txt"), [
      PEM_BEGIN,
      PEM_BODY[0]!,
      PEM_BODY[1]!,
      "Q2h1Y2stdGVyY2VpcmEtZGUtbGlu",
      PEM_BODY[2]!,
      PEM_END,
      "alvo-7",
    ].join("\n"));
    const interior = await loadAttachment({ ...base(cwd, astroHome), path: "notas.txt", range: "2:5" });
    expect(interior.data).toBe("[REDACTED]\n[REDACTED]\n[REDACTED]\n[REDACTED]");
    expect(interior.range).toEqual({ start: 2, end: 5 });
    expect(interior.data).not.toContain("MIIEow");

    // Faixa que atravessa o END: as linhas do span seguem numeradas e redigidas.
    const throughEnd = await loadAttachment({ ...base(cwd, astroHome), path: "notas.txt", range: "5:7" });
    expect(throughEnd.data).toBe("[REDACTED]\n[REDACTED]\nalvo-7");
    expect(throughEnd.range).toEqual({ start: 5, end: 7 });
  });

  test("range no interior de um PEM no caminho de streaming não vaza", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "grande-notas.txt"), [
      PEM_BEGIN,
      PEM_BODY[0]!,
      PEM_BODY[1]!,
      PEM_END,
      "resto ".repeat(200),
    ].join("\n"));
    const attachment = await loadAttachment({
      ...base(cwd, astroHome),
      path: "grande-notas.txt",
      range: "2:3",
      maxBytes: 512,
    });
    expect(attachment.data).toBe("[REDACTED]\n[REDACTED]");
    expect(attachment.range).toEqual({ start: 2, end: 3 });
    expect(attachment.data).not.toContain("MIIEow");
  });

  test("última linha sem newline no caminho de streaming entra na faixa", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "sem-nl.txt"), "um\ndois\ntres");
    const attachment = await loadAttachment({
      ...base(cwd, astroHome),
      path: "sem-nl.txt",
      range: "3:3",
      maxBytes: 8,
    });
    expect(attachment.data).toBe("tres");
    expect(attachment.range).toEqual({ start: 3, end: 3 });
  });

  test("marcador no meio da linha não escapa (offset 60 e 70)", async () => {
    for (const offset of [60, 70]) {
      const { cwd, astroHome } = sandbox();
      writeFileSync(join(cwd, "meio.txt"), [
        `${"x".repeat(offset)}${PEM_BEGIN}`,
        PEM_BODY[0]!,
        PEM_BODY[1]!,
        PEM_END,
        "z".repeat(5_000),
      ].join("\n"));
      const attachment = await loadAttachment({
        ...base(cwd, astroHome),
        path: "meio.txt",
        range: "2:3",
        maxBytes: 4_096,
      });
      expect(attachment.data).toBe("[REDACTED]\n[REDACTED]");
      expect(attachment.data).not.toContain("MIIEow");
    }
  });

  test("bloco PEM em uma linha só fecha o span e preserva a linha seguinte", async () => {
    const { cwd, astroHome } = sandbox();
    const oneLine = `${PEM_BEGIN} ${PEM_BODY[0]} ${PEM_BODY[1]} ${PEM_END}`;
    expect(oneLine.length).toBeGreaterThan(64);
    writeFileSync(join(cwd, "uma-linha.txt"), [oneLine, "alvo-2", "z".repeat(5_000)].join("\n"));
    const attachment = await loadAttachment({
      ...base(cwd, astroHome),
      path: "uma-linha.txt",
      range: "1:2",
      maxBytes: 4_096,
    });
    expect(attachment.data).toBe("[REDACTED]\nalvo-2");
  });

  test("linha maior que o teto mas com forma redigida cabível não estoura", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "linha-grande.txt"),
      `${"x".repeat(1_500)}${PEM_BEGIN} ${PEM_BODY[0]} ${PEM_END}\n`);
    const attachment = await loadAttachment({
      ...base(cwd, astroHome),
      path: "linha-grande.txt",
      range: "1:1",
      maxBytes: 1_000,
    });
    expect(attachment.data).toBe("[REDACTED]");
    expect(attachment.range).toEqual({ start: 1, end: 1 });
  });

  test("marcador com label no limite não escapa em nenhuma posição da fronteira", async () => {
    for (const pre of [47, 48, 49, 55, 59, 63, 64]) {
      const { cwd, astroHome } = sandbox();
      writeFileSync(join(cwd, "fronteira-label.txt"), [
        `${"x".repeat(65_536 - pre)}${PEM_LONG_LABEL}`,
        PEM_BODY[0]!,
        PEM_BODY[1]!,
        PEM_LONG_END,
        "z".repeat(5_000),
      ].join("\n"));
      const attachment = await loadAttachment({
        ...base(cwd, astroHome),
        path: "fronteira-label.txt",
        range: "2:3",
        maxBytes: 70_000,
      });
      expect(attachment.data).toBe("[REDACTED]\n[REDACTED]");
      expect(attachment.data).not.toContain("MIIEow");
    }
  });

  test("label acima do bound antigo redige no range e no texto inteiro", async () => {
    for (const size of [33, 70]) {
      const { cwd, astroHome } = sandbox();
      const begin = ["-----BEGIN", `${"A".repeat(size)} PRIVATE KEY-----`].join(" ");
      const end = ["-----END", `${"A".repeat(size)} PRIVATE KEY-----`].join(" ");
      writeFileSync(join(cwd, "label-longo.txt"), [
        begin,
        PEM_BODY[0]!,
        PEM_BODY[1]!,
        end,
        "alvo-5",
      ].join("\n"));
      const whole = await loadAttachment({ ...base(cwd, astroHome), path: "label-longo.txt" });
      expect(whole.data).not.toContain("MIIEow");
      expect(whole.data).toContain("[REDACTED]");
      const ranged = await loadAttachment({
        ...base(cwd, astroHome),
        path: "label-longo.txt",
        range: "2:3",
        maxBytes: 128,
      });
      expect(ranged.data).toBe("[REDACTED]\n[REDACTED]");
      expect(ranged.data).not.toContain("MIIEow");
    }
  });

  test("BEGIN sem END no caminho de streaming redige até o EOF", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "sem-end.txt"), [PEM_BEGIN, PEM_BODY[0]!, "final-sem-end"].join("\n"));
    const attachment = await loadAttachment({
      ...base(cwd, astroHome),
      path: "sem-end.txt",
      range: "2:3",
      maxBytes: 40,
    });
    expect(attachment.data).toBe("[REDACTED]\n[REDACTED]");
    expect(attachment.data).not.toContain("MIIEow");
  });

  test("marcador PEM cortado pela fronteira do chunk não vaza o corpo", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "fronteira.txt"), [
      "a".repeat(65_532), // linha 1 termina 3 bytes antes do chunk de 64 KiB
      PEM_BEGIN, // linha 2: só "---" cabe no primeiro chunk
      PEM_BODY[0]!, // linha 3
      PEM_BODY[1]!, // linha 4
      PEM_END,
      "z".repeat(5_000),
    ].join("\n"));
    const attachment = await loadAttachment({
      ...base(cwd, astroHome),
      path: "fronteira.txt",
      range: "3:4",
      maxBytes: 70_000,
    });
    expect(attachment.data).toBe("[REDACTED]\n[REDACTED]");
    expect(attachment.range).toEqual({ start: 3, end: 4 });
    expect(attachment.data).not.toContain("MIIEow");
  });

  test("hard-block em .env sem override", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, ".env"), "KEY=1");
    await expect(loadAttachment({ ...base(cwd, astroHome), path: ".env" })).rejects.toMatchObject({
      code: "attachment_hard_blocked",
    });
  });

  test("hard-block em vault, .astro do cwd e .git/config mesmo com confirmação", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(astroHome, "vault.json"), "{}");
    mkdirSync(join(cwd, ".astro"));
    writeFileSync(join(cwd, ".astro", "state.json"), "{}");
    mkdirSync(join(cwd, ".git"));
    writeFileSync(join(cwd, ".git", "config"), "[core]\n");
    for (const path of [join(astroHome, "vault.json"), ".astro/state.json", ".git/config"]) {
      await expect(
        loadAttachment({ ...base(cwd, astroHome), path, confirmOutsideCwd: () => true }),
      ).rejects.toMatchObject({ code: "attachment_hard_blocked" });
    }
  });

  test("symlink no cwd que escapa entrega o realpath externo à confirmação", async () => {
    const { cwd, astroHome } = sandbox();
    const outside = join(cwd, "..", "fora");
    mkdirSync(outside);
    writeFileSync(join(outside, "x.txt"), "x");
    symlinkSync(outside, join(cwd, "link"), process.platform === "win32" ? "junction" : "dir");
    const seen: string[] = [];
    await expect(loadAttachment({
      ...base(cwd, astroHome),
      path: "link/x.txt",
      confirmOutsideCwd: (absolute) => {
        seen.push(absolute);
        return false;
      },
    })).rejects.toMatchObject({ code: "attachment_outside_denied" });
    expect(seen).toEqual([canonicalize(join(outside, "x.txt"))]);
  });

  test("fora do cwd pede confirmação; negado para", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "..", "outside.txt"), "x");
    await expect(
      loadAttachment({ ...base(cwd, astroHome), path: "../outside.txt", confirmOutsideCwd: () => false }),
    ).rejects.toMatchObject({ code: "attachment_outside_denied" });
    const ok = await loadAttachment({
      ...base(cwd, astroHome),
      path: "../outside.txt",
      confirmOutsideCwd: () => true,
    });
    expect(ok.kind).toBe("text");
  });

  test("sem confirmOutsideCwd fora do cwd falha fechado", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "..", "outside2.txt"), "x");
    await expect(loadAttachment({ ...base(cwd, astroHome), path: "../outside2.txt" })).rejects.toMatchObject({
      code: "attachment_outside_denied",
    });
  });

  test("diretório lista e rejeita acima de 500 entradas", async () => {
    const { cwd, astroHome } = sandbox();
    mkdirSync(join(cwd, "dir"));
    for (let index = 0; index < 3; index++) writeFileSync(join(cwd, "dir", `f${index}.txt`), "x");
    const attachment = await loadAttachment({ ...base(cwd, astroHome), path: "dir" });
    expect(attachment.kind).toBe("directory");
    expect(attachment.mediaType).toBe("inode/directory");
    expect(attachment.data.split("\n")).toHaveLength(3);
    const big = join(cwd, "big");
    mkdirSync(big);
    for (let index = 0; index < 501; index++) writeFileSync(join(big, `f${index}.txt`), "");
    await expect(loadAttachment({ ...base(cwd, astroHome), path: "big" })).rejects.toMatchObject({
      code: "attachment_directory_too_large",
    });
  });

  test("diretório omite ocultos sem showHidden", async () => {
    const { cwd, astroHome } = sandbox();
    mkdirSync(join(cwd, "d"));
    writeFileSync(join(cwd, "d", "visivel.txt"), "x");
    writeFileSync(join(cwd, "d", ".oculto"), "x");
    const sem = await loadAttachment({ ...base(cwd, astroHome), path: "d" });
    expect(sem.data).toContain("visivel.txt");
    expect(sem.data).not.toContain(".oculto");
    const com = await loadAttachment({ ...base(cwd, astroHome), path: "d", showHidden: true });
    expect(com.data).toContain(".oculto");
  });

  test("0 byte texto ok; binário rejeita", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "empty.txt"), "");
    expect((await loadAttachment({ ...base(cwd, astroHome), path: "empty.txt" })).sizeBytes).toBe(0);
    writeFileSync(join(cwd, "bin"), Buffer.from([0, 1, 2]));
    await expect(loadAttachment({ ...base(cwd, astroHome), path: "bin" })).rejects.toMatchObject({
      code: "attachment_unsupported_binary",
    });
  });

  test("imagem com header ilegível rejeita", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "i.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await expect(loadAttachment({ ...base(cwd, astroHome), path: "i.png" })).rejects.toMatchObject({
      code: "attachment_image_invalid",
    });
  });

  test("imagem usa bytes decodificados (RGBA), não o tamanho comprimido", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "i.png"), pngHeader(100, 100));
    const attachment = await loadAttachment({ ...base(cwd, astroHome), path: "i.png" });
    expect(attachment.sizeBytes).toBe(100 * 100 * 4);
    expect(attachment.sizeBytes).toBeGreaterThan(Buffer.from(attachment.data, "base64").length);
  });

  test("imagem comprimida pequena acima de 20 MiB decodificados rejeita", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "big.png"), pngHeader(3000, 3000));
    await expect(loadAttachment({ ...base(cwd, astroHome), path: "big.png" })).rejects.toMatchObject({
      code: "attachment_image_invalid",
    });
  });

  test("arquivo maior que o teto rejeita sem ler", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "grande.txt"), Buffer.alloc(64));
    await expect(
      loadAttachment({ ...base(cwd, astroHome), path: "grande.txt", maxBytes: 16 }),
    ).rejects.toMatchObject({ code: "attachment_too_large" });
  });

  test("arquivo acima do teto com range lê só a faixa", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "grande.txt"), Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, "linha\n"));
    const attachment = await loadAttachment({
      ...base(cwd, astroHome),
      path: "grande.txt",
      range: "1:2",
    });
    expect(attachment.data).toBe("linha\nlinha");
    expect(attachment.range).toEqual({ start: 1, end: 2 });
    expect(attachment.sizeBytes).toBe(Buffer.byteLength("linha\nlinha", "utf8"));
  });

  test("range que pula além do teto de leitura falha tipado", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "linhas.txt"), "a\n".repeat(100));
    await expect(
      loadAttachment({ ...base(cwd, astroHome), path: "linhas.txt", range: "100:100", maxBytes: 16 }),
    ).rejects.toThrow(/faixa.*teto de leitura/);
  });

  test("última linha da faixa exatamente no teto não cobra o newline final", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "abc.txt"), "abc\ndef\n");
    const attachment = await loadAttachment({
      ...base(cwd, astroHome),
      path: "abc.txt",
      range: "1:1",
      maxBytes: 3,
    });
    expect(attachment.data).toBe("abc");
    expect(attachment.range).toEqual({ start: 1, end: 1 });
    expect(attachment.sizeBytes).toBe(3);
  });

  test("linha selecionada acima do teto rejeita", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "abcd.txt"), "abcd\nef\n");
    await expect(
      loadAttachment({ ...base(cwd, astroHome), path: "abcd.txt", range: "1:1", maxBytes: 3 }),
    ).rejects.toMatchObject({ code: "attachment_too_large" });
  });

  test("start além do EOF em arquivo pequeno é range inválido", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "curto.txt"), "a\nb\n");
    await expect(
      loadAttachment({ ...base(cwd, astroHome), path: "curto.txt", range: "5:5" }),
    ).rejects.toMatchObject({ code: "attachment_range_invalid" });
  });

  test("start além do EOF em arquivo acima do teto é range inválido com a contagem real", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "longo.txt"), "a\n".repeat(50));
    await expect(
      loadAttachment({ ...base(cwd, astroHome), path: "longo.txt", range: "999:999", maxBytes: 50 }),
    ).rejects.toThrow(/faixa fora do arquivo.*51 linha/i);
  });

  test("start existente com offset acima do teto continua sendo erro de teto", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "longo.txt"), "a\n".repeat(50));
    await expect(
      loadAttachment({ ...base(cwd, astroHome), path: "longo.txt", range: "30:30", maxBytes: 50 }),
    ).rejects.toThrow(/teto de leitura/);
  });

  test("end além do EOF no streaming clampa na última linha", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "longo.txt"), "a\n".repeat(50));
    const attachment = await loadAttachment({
      ...base(cwd, astroHome),
      path: "longo.txt",
      range: "21:999",
      maxBytes: 60,
    });
    expect(attachment.data).toBe("a\n".repeat(30));
    expect(attachment.range).toEqual({ start: 21, end: 51 });
  });

  test("range de arquivo grande rejeita binário na faixa selecionada", async () => {
    const { cwd, astroHome } = sandbox();
    const target = 100_000;
    for (const [name, byte] of [["nul.txt", 0x00], ["utf8.txt", 0xff]] as const) {
      const content = Buffer.alloc(200_000, "linha\n");
      content[target] = byte;
      writeFileSync(join(cwd, name), content);
      const line = Math.floor(target / 6) + 1;
      await expect(
        loadAttachment({ ...base(cwd, astroHome), path: name, range: `${line}:${line}`, maxBytes: target }),
      ).rejects.toMatchObject({ code: "attachment_unsupported_binary" });
    }
  });
});

describe("loadPastedText", () => {
  test("texto vira anexo com hash e sem path", () => {
    const attachment = loadPastedText("colado");
    expect(attachment.kind).toBe("text");
    expect(attachment.path).toBeUndefined();
    expect(attachment.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(attachment.sizeBytes).toBe(Buffer.byteLength("colado", "utf8"));
  });
});
