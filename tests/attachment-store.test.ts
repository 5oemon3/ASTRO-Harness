import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalTrustee, hardenWindowsAcl, inspectWindowsAcl, type WindowsAcl } from "../src/attachments/acl";
import {
  ArtifactStore,
  readGcMarker,
  resolveArtifactRoot,
  validateArtifactRoot,
} from "../src/attachments/store";
import { AttachmentError } from "../src/attachments/model";
import { FAKE_PRIVATE_ACL } from "./setup";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox(): { root: string; cwd: string; astroHome: string } {
  const base = mkdtempSync(join(tmpdir(), "astro-art-"));
  dirs.push(base);
  const cwd = join(base, "work");
  const astroHome = join(base, "home");
  const root = join(astroHome, "attachments");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(astroHome, { recursive: true });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return { root, cwd, astroHome };
}

const context = (cwd: string, astroHome: string) => ({
  cwd,
  astroHome,
  checkPrivate: () => true,
});

describe("resolveArtifactRoot", () => {
  test("flag > env > default do ASTRO_HOME", () => {
    expect(resolveArtifactRoot({ flag: "/f", env: { ASTRO_ARTIFACT_ROOT: "/e" }, astroHome: "/h" })).toBe("/f");
    expect(resolveArtifactRoot({ env: { ASTRO_ARTIFACT_ROOT: "/e" }, astroHome: "/h" })).toBe("/e");
    expect(resolveArtifactRoot({ env: { ASTRO_ARTIFACT_ROOT: "   " }, astroHome: "/h" })).toBe(join("/h", "attachments"));
    expect(resolveArtifactRoot({ env: {}, astroHome: "/h" })).toBe(join("/h", "attachments"));
  });

  test("expande ~", () => {
    expect(resolveArtifactRoot({ flag: "~/att", env: {}, astroHome: "/h" })).toContain("att");
  });
});

describe("validateArtifactRoot", () => {
  test("aceita raiz dedicada fora do cwd", () => {
    const { root, cwd, astroHome } = sandbox();
    expect(() => validateArtifactRoot(root, context(cwd, astroHome))).not.toThrow();
  });

  test("rejeita o próprio ASTRO_HOME e a raiz dentro do cwd", () => {
    const { cwd, astroHome, root } = sandbox();
    expect(() => validateArtifactRoot(astroHome, context(cwd, astroHome))).toThrow(/attachment_root_invalid|raiz/i);
    const inside = join(cwd, "attachments");
    mkdirSync(inside, { recursive: true });
    expect(() => validateArtifactRoot(inside, context(cwd, astroHome))).toThrow(/attachment_root_invalid|fora do cwd/i);
    expect(astroHome).not.toBe(root);
  });

  test("rejeita raiz que contém estado do harness", () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(astroHome, "vault.json"), "{}");
    expect(() => validateArtifactRoot(astroHome, context(cwd, astroHome))).toThrow();
  });

  test("rejeita quando a checagem de privacidade falha", () => {
    const { root, cwd, astroHome } = sandbox();
    expect(() => validateArtifactRoot(root, { ...context(cwd, astroHome), checkPrivate: () => false })).toThrow(/privad/i);
  });

  test("aceita raiz ainda inexistente e a cria com 0700", () => {
    const { cwd, astroHome } = sandbox();
    const root = join(astroHome, "artifacts-missing");
    expect(() => validateArtifactRoot(root, { cwd, astroHome })).not.toThrow();
    new ArtifactStore(root, { cwd, astroHome });
    expect(existsSync(root)).toBe(true);
    if (process.platform !== "win32") expect(statSync(root).mode & 0o777).toBe(0o700);
  }, 120_000);

  test.skipIf(process.platform !== "win32")("rejeita raiz com ACE Everyone usando a checagem real", () => {
    const { cwd, astroHome } = sandbox();
    const root = join(astroHome, "public-artifacts");
    mkdirSync(root, { recursive: true });
    try {
      execFileSync("icacls", [root, "/grant", "*S-1-1-0:(OI)(CI)(R)"], { stdio: "ignore" });
      expect(() => validateArtifactRoot(root, { cwd, astroHome })).toThrow(/privad/i);
    } finally {
      execFileSync("icacls", [root, "/remove", "*S-1-1-0"], { stdio: "ignore" });
    }
  }, 120_000);

  test.skipIf(process.platform !== "win32")("store endurece a raiz criada e remove a ACE herdada do pai", () => {
    const { cwd, astroHome } = sandbox();
    const parent = join(astroHome, "public-parent");
    const root = join(parent, "artifacts");
    mkdirSync(parent, { recursive: true });
    try {
      execFileSync("icacls", [parent, "/grant", "*S-1-1-0:(OI)(CI)(R)"], { stdio: "ignore" });
      new ArtifactStore(root, { cwd, astroHome });
      const acl = inspectWindowsAcl(root);
      expect(acl).toBeDefined();
      const trustees = [...acl!.sddl.matchAll(/\(([^)]*)\)/g)].map(([, body]) =>
        canonicalTrustee(body.split(";")[5]!, acl!.userSid),
      );
      expect([...new Set(trustees)].sort()).toEqual(["BA", "SY", acl!.userSid.toUpperCase()].sort());
      expect(() => validateArtifactRoot(root, { cwd, astroHome })).not.toThrow();
    } finally {
      execFileSync("icacls", [parent, "/remove", "*S-1-1-0"], { stdio: "ignore" });
    }
  }, 120_000);

  // Regressão do CI Windows: `/inheritance:r` remove só ACEs herdadas; uma ACE explícita
  // já na raiz sobrevive e mantém um trustee fora de dono/SY/BA.
  test.skipIf(process.platform !== "win32")("endurecimento troca a DACL explícita por uma nova protegida", () => {
    const { cwd, astroHome } = sandbox();
    const root = join(astroHome, "explicit-ace-artifacts");
    mkdirSync(root, { recursive: true });
    execFileSync("icacls", [root, "/grant", "*S-1-5-32-546:(OI)(CI)(R)"], { stdio: "ignore" });
    const acl = hardenWindowsAcl(root);
    const trustees = [...acl.sddl.matchAll(/\(([^)]*)\)/g)].map(([, body]) =>
      canonicalTrustee(body.split(";")[5]!, acl.userSid),
    );
    expect([...new Set(trustees)].sort()).toEqual(["BA", "SY", acl.userSid.toUpperCase()].sort());
    expect(() => validateArtifactRoot(root, { cwd, astroHome })).not.toThrow();
  }, 120_000);

  test("raiz recém-criada que não fica privada é removida e falha tipada", () => {
    const { cwd, astroHome } = sandbox();
    const root = join(astroHome, "artifacts-unchecked");
    let calls = 0;
    let thrown: unknown;
    try {
      new ArtifactStore(root, {
        cwd,
        astroHome,
        // Pré-check passa (raiz ausente); a revalidação pós-mkdir falha.
        checkPrivate: () => ++calls === 1,
      });
    } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ name: "AttachmentError", code: "attachment_root_invalid" });
    expect(existsSync(root)).toBe(false);
  }, 120_000);

  test.skipIf(process.platform !== "win32")("store endurece a raiz criada e a checagem real aprova", () => {
    const { cwd, astroHome } = sandbox();
    const root = join(astroHome, "hardened-artifacts");
    new ArtifactStore(root, { cwd, astroHome });
    const acl = inspectWindowsAcl(root);
    expect(acl).toBeDefined();
    const trustees = [...acl!.sddl.matchAll(/\(([^)]*)\)/g)].map(([, body]) =>
      canonicalTrustee(body.split(";")[5]!, acl!.userSid),
    );
    expect([...new Set(trustees)].sort()).toEqual(["BA", "SY", acl!.userSid.toUpperCase()].sort());
    expect(() => validateArtifactRoot(root, { cwd, astroHome })).not.toThrow();
  }, 120_000);

  test.skipIf(process.platform !== "win32")("rejeita raiz pré-existente com ACE de Guests", () => {
    const { cwd, astroHome } = sandbox();
    const root = join(astroHome, "guests-artifacts");
    mkdirSync(root, { recursive: true });
    try {
      execFileSync("icacls", [root, "/grant", "*S-1-5-32-546:(OI)(CI)(R)"], { stdio: "ignore" });
      expect(() => validateArtifactRoot(root, { cwd, astroHome })).toThrow(/privad/i);
    } finally {
      execFileSync("icacls", [root, "/remove", "*S-1-5-32-546"], { stdio: "ignore" });
    }
  }, 120_000);

  // Injeção de `hardenPrivate`: os testes e2e (REPL/TUI/agent-session) não podem
  // spawnar PowerShell real no runner windows do CI (cold start > 15 s por chamada).
  test.skipIf(process.platform !== "win32")("hardenPrivate injetado substitui o subprocesso real e falha fechado", () => {
    const { cwd, astroHome } = sandbox();
    const root = join(astroHome, "injected-harden");
    const calls: string[] = [];
    const notPrivate: WindowsAcl = {
      userSid: "S-1-5-21-0-0-0-1000",
      sddl: "O:S-1-5-21-0-0-0-1000G:S-1-5-21-0-0-0-513D:PAI(A;OICI;FA;;;S-1-5-32-546)",
    };
    let thrown: unknown;
    try {
      new ArtifactStore(root, {
        cwd,
        astroHome,
        checkPrivate: () => true,
        hardenPrivate: (path) => {
          calls.push(path);
          return notPrivate;
        },
      });
    } catch (error) { thrown = error; }
    expect(calls).toHaveLength(1);
    expect(thrown).toMatchObject({ name: "AttachmentError", code: "attachment_root_invalid" });
    expect(existsSync(root)).toBe(false);
  });

  test.skipIf(process.platform !== "win32")("hardenPrivate injetado privado aprova a raiz sem subprocesso", () => {
    const { cwd, astroHome } = sandbox();
    const root = join(astroHome, "injected-harden-ok");
    const calls: string[] = [];
    const store = new ArtifactStore(root, {
      cwd,
      astroHome,
      checkPrivate: () => true,
      hardenPrivate: (path) => {
        calls.push(path);
        return FAKE_PRIVATE_ACL;
      },
    });
    expect(calls).toEqual([store.root]);
    expect(existsSync(root)).toBe(true);
  });

  test("raiz cujo pai é arquivo falha tipada e não grava", () => {
    const { cwd, astroHome } = sandbox();
    const parent = join(astroHome, "arquivo");
    writeFileSync(parent, "x");
    let thrown: unknown;
    try { new ArtifactStore(join(parent, "artifacts"), context(cwd, astroHome)); } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ name: "AttachmentError", code: "attachment_root_invalid" });
    expect(existsSync(join(parent, "artifacts"))).toBe(false);
  });
});

describe("ArtifactStore", () => {
  const owner = { sessionId: "s1", runId: "r1", lineage: ["s0"] };

  test("save/read round-trip com hash no nome e metadado da sessão", () => {
    const { root, cwd, astroHome } = sandbox();
    const store = new ArtifactStore(root, context(cwd, astroHome));
    const bytes = new TextEncoder().encode("imagem");
    const saved = store.save(owner, bytes, "image/png");
    expect(saved.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(saved.ref.startsWith("session-")).toBe(true);
    expect(Array.from(store.read(saved.ref))).toEqual(Array.from(bytes));
    const meta = JSON.parse(readFileSync(join(root, saved.ref.split("/")[0]!, `${saved.hash}.json`), "utf8"));
    expect(meta).toMatchObject({ sessionId: "s1", lineage: ["s0"], mediaType: "image/png" });
    if (process.platform !== "win32") {
      expect(statSync(join(root, saved.ref.split("/")[0]!, saved.hash)).mode & 0o777).toBe(0o600);
    }
  });

  test("read de ref inválido ou adulterado falha tipado", () => {
    const { root, cwd, astroHome } = sandbox();
    const store = new ArtifactStore(root, context(cwd, astroHome));
    expect(() => store.read("session-abc/def")).toThrow(/attachment_image_invalid|ref/i);
    const saved = store.save(owner, new TextEncoder().encode("x"), "image/png");
    const [dir, file] = saved.ref.split("/");
    writeFileSync(join(root, dir!, file!), "adulterado");
    expect(() => store.read(saved.ref)).toThrow(/attachment_image_invalid|hash/i);
  });

  test("artefato/sidecar ausente usa attachment_artifact_missing", () => {
    const { root, cwd, astroHome } = sandbox();
    const store = new ArtifactStore(root, context(cwd, astroHome));
    const saved = store.save(owner, new TextEncoder().encode("x"), "image/png");
    const [dir, hash] = saved.ref.split("/");
    unlinkSync(join(root, dir!, hash!));
    const readErr = (() => { try { store.read(saved.ref); } catch (error) { return error as AttachmentError; } })();
    expect(readErr?.code).toBe("attachment_artifact_missing");

    unlinkSync(join(root, dir!, `${hash!}.json`));
    const metaErr = (() => { try { store.meta(saved.ref); } catch (error) { return error as AttachmentError; } })();
    expect(metaErr?.code).toBe("attachment_artifact_missing");
  });

  test("sidecar ilegível e diretório no hash são attachment_image_invalid", () => {
    const { root, cwd, astroHome } = sandbox();
    const store = new ArtifactStore(root, context(cwd, astroHome));
    const corrupted = store.save(owner, new TextEncoder().encode("x"), "image/png");
    const [dir, hash] = corrupted.ref.split("/");
    writeFileSync(join(root, dir!, `${hash!}.json`), "{", "utf8");
    const metaErr = (() => { try { store.meta(corrupted.ref); } catch (error) { return error as AttachmentError; } })();
    expect(metaErr?.code).toBe("attachment_image_invalid");
    expect(metaErr?.message).toMatch(/ilegível/i);

    const replaced = store.save(owner, new TextEncoder().encode("y"), "image/png");
    const [dir2, hash2] = replaced.ref.split("/");
    unlinkSync(join(root, dir2!, hash2!));
    mkdirSync(join(root, dir2!, hash2!));
    const readErr = (() => { try { store.read(replaced.ref); } catch (error) { return error as AttachmentError; } })();
    expect(readErr?.code).toBe("attachment_image_invalid");
    expect(readErr?.message).toMatch(/ilegível/i);
  });

  test("rejeita ref com traversal", () => {
    const { root, cwd, astroHome } = sandbox();
    const store = new ArtifactStore(root, context(cwd, astroHome));
    for (const ref of ["../x", "/abs/path", "session-abc/../../x", "outro/abc"]) {
      expect(() => store.read(ref)).toThrow();
    }
  });

  test("teto de bytes rejeita o novo anexo", () => {
    const { root, cwd, astroHome } = sandbox();
    const store = new ArtifactStore(root, { ...context(cwd, astroHome), maxBytes: 4 });
    expect(() => store.save(owner, new TextEncoder().encode("12345"), "image/png")).toThrow(/attachment_too_large|teto/i);
  });

  test("gc remove expirado do harness e preserva o ref atual e arquivo alheio", () => {
    const { root, cwd, astroHome } = sandbox();
    let now = 1_000_000_000_000;
    const store = new ArtifactStore(root, { ...context(cwd, astroHome), ttlDays: 7, now: () => now });
    const old = store.save({ sessionId: "s-old", runId: "r1" }, new TextEncoder().encode("a"), "image/png");
    const current = store.save(owner, new TextEncoder().encode("b"), "image/png");
    const [oldDir, oldFile] = old.ref.split("/");
    const oldPath = join(root, oldDir!, oldFile!);
    utimesSync(oldPath, new Date(now - 8 * 24 * 60 * 60 * 1000), new Date(now - 8 * 24 * 24 * 60 * 60 * 1000));
    writeFileSync(join(root, "alheio.txt"), "x");
    const removed = store.gc([current.ref]);
    expect(removed).toEqual([old.ref]);
    expect(() => store.read(old.ref)).toThrow();
    expect(() => store.read(current.ref)).not.toThrow();
  });

  test("save idempotente mantém o uso e não deixa .tmp", () => {
    const { root, cwd, astroHome } = sandbox();
    const store = new ArtifactStore(root, context(cwd, astroHome));
    const bytes = new TextEncoder().encode("imagem idempotente");
    const first = store.save(owner, bytes, "image/png");
    const usage = store.usageBytes();
    const second = store.save(owner, bytes, "image/png");
    expect(second).toEqual(first);
    expect(store.usageBytes()).toBe(usage);
    expect(readdirSync(join(root, first.ref.split("/")[0]!)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("meta lê o sidecar e rejeita ref ausente ou adulterado", () => {
    const { root, cwd, astroHome } = sandbox();
    const store = new ArtifactStore(root, context(cwd, astroHome));
    const bytes = new TextEncoder().encode("meta");
    const saved = store.save(owner, bytes, "image/png");
    const good = store.meta(saved.ref);
    expect(good).toMatchObject({ schema: "artifact/v1", ref: saved.ref, hash: saved.hash, bytes: bytes.length,
      mediaType: "image/png", sessionId: "s1", runId: "r1", lineage: ["s0"] });
    expect(() => store.meta("session-abc/def")).toThrow(/attachment_image_invalid|ref/i);
    const [dir, hash] = saved.ref.split("/");
    const metaPath = join(root, dir!, `${hash}.json`);
    writeFileSync(metaPath, JSON.stringify({ schema: "artifact/v1", ref: "outro/ref", hash }));
    expect(() => store.meta(saved.ref)).toThrow(/attachment_image_invalid|metadado|ref/i);
    writeFileSync(metaPath, JSON.stringify({ ...good, lineage: "s0" }));
    expect(() => store.meta(saved.ref)).toThrow(/attachment_image_invalid|metadado/i);
    unlinkSync(metaPath);
    expect(() => store.meta(saved.ref)).toThrow(/attachment_image_invalid|ausente|metadado/i);
  });

  test("gc grava marcador atômico e lastGc/readGcMarker leem", () => {
    const { root, cwd, astroHome } = sandbox();
    const store = new ArtifactStore(root, { ...context(cwd, astroHome), now: () => 1_000_000_000_000 });
    expect(store.lastGc()).toBeUndefined();
    expect(readGcMarker(root)).toBeUndefined();
    expect(store.gc()).toEqual([]);
    const marker = store.lastGc();
    expect(marker).toMatchObject({ removed: 0 });
    expect(Date.parse(marker!.at)).not.toBeNaN();
    expect(JSON.parse(readFileSync(join(root, "gc.json"), "utf8"))).toEqual(marker);
    if (process.platform !== "win32") expect(statSync(join(root, "gc.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
