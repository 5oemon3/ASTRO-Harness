import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  canonicalFolder,
  ensureTrustedCwd,
  loadTrustedStore,
  saveTrustedStore,
  TrustedFolders,
  TrustDeniedError,
  trustStatePath,
  trustChoice,
  trustPrompt,
  validateTrustedStore,
} from "../src/trust";
function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), "astro-trust-"));
  return { dir, path: join(dir, "trusted.json") };
}
// Fixture de segredo construído em runtime para não disparar o gate de segredos.
const FAKE_SECRET = ["s", "k", "-"].join("") + "live-abcdef12345";
function errOf(fn: () => void): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("esperava erro");
}
describe("store de trust (#267)", () => {
  test("trustStatePath: $ASTRO_HOME ou ~/.astro/state.json; arquivo ausente → vazio", () => {
    expect(trustStatePath({ ASTRO_HOME: join("C:", "x") } as NodeJS.ProcessEnv)).toBe(join("C:", "x", "state.json"));
    const env = { ...process.env } as NodeJS.ProcessEnv;
    delete env.ASTRO_HOME;
    expect(trustStatePath(env)).toBe(join(homedir(), ".astro", "state.json"));
    const { path } = tmpStore();
    expect(loadTrustedStore(path)).toEqual({ version: 1, folders: [] });
  });
  test("migrates trusted.json into state.json and preserves the legacy file", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-trust-migration-"));
    const path = join(dir, "state.json");
    const legacy = join(dir, "trusted.json");
    writeFileSync(legacy, JSON.stringify({ version: 1, folders: ["/legacy/project"] }));

    expect(loadTrustedStore(path)).toEqual({ version: 1, folders: ["/legacy/project"] });
    expect(existsSync(legacy)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      version: 1,
      trust: { folders: ["/legacy/project"] },
      migrations: { providers: false, trust: true },
    });
  });
  test("caminho injetado: basename state.json usa o home state; trusted.json usa o store legado", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-trust-kind-"));
    const stateFile = join(dir, "state.json");
    const legacyFile = join(dir, "trusted.json");

    saveTrustedStore({ version: 1, folders: ["/novo"] }, stateFile);
    expect(JSON.parse(readFileSync(stateFile, "utf8"))).toEqual({
      version: 1,
      trust: { folders: ["/novo"] },
      migrations: { providers: false, trust: false },
    });

    saveTrustedStore({ version: 1, folders: ["/legado"] }, legacyFile);
    expect(JSON.parse(readFileSync(legacyFile, "utf8"))).toEqual({ version: 1, folders: ["/legado"] });
    expect(loadTrustedStore(legacyFile)).toEqual({ version: 1, folders: ["/legado"] });
  });
  test("roundtrip: grava atômico (0600 no POSIX) e relê igual", () => {
    const { path } = tmpStore();
    saveTrustedStore({ version: 1, folders: ["/a", "/b"] }, path);
    expect(loadTrustedStore(path)).toEqual({ version: 1, folders: ["/a", "/b"] });
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  test("store inválido → erro cita o caminho e nunca ecoa conteúdo/valor (I-03)", () => {
    const { path } = tmpStore();
    writeFileSync(path, `{"version":1,"folders":["${FAKE_SECRET}"]`); // JSON inválido + segredo
    const corrupt = errOf(() => loadTrustedStore(path));
    expect(corrupt.message).toContain(path);
    expect(corrupt.message).not.toContain(FAKE_SECRET);
    writeFileSync(path, JSON.stringify({ version: 1, folders: [], surprise: FAKE_SECRET }));
    const unknown = errOf(() => loadTrustedStore(path));
    expect(unknown.message).toMatch(/campo desconhecido/);
    expect(unknown.message).not.toContain(FAKE_SECRET);
    // segredo como NOME de chave também não pode vazar na mensagem (I-03)
    writeFileSync(path, JSON.stringify({ version: 1, folders: [], [FAKE_SECRET]: 1 }));
    const keySecret = errOf(() => loadTrustedStore(path));
    expect(keySecret.message).toMatch(/campo desconhecido/);
    expect(keySecret.message).not.toContain(FAKE_SECRET);
    // segredo como entrada de folders é recusado sem ecoar o valor (I-03)
    const folderSecret = errOf(() => validateTrustedStore({ version: 1, folders: [FAKE_SECRET] }));
    expect(folderSecret.message).not.toContain(FAKE_SECRET);
    expect(errOf(() => validateTrustedStore({ version: 2, folders: [] })).message).toMatch(/version/);
    expect(errOf(() => validateTrustedStore({ version: 1, folders: ["x", 42] })).message).toMatch(/folders/);
    expect(errOf(() => validateTrustedStore("x"))).toBeDefined();
  });
});
describe("TrustedFolders (#267)", () => {
  test("trust persiste, relê em outra instância e canonicaliza (realpath); subpasta herda", () => {
    const { dir, path } = tmpStore();
    const folders = new TrustedFolders(path);
    folders.trust(dir);
    expect(existsSync(path)).toBe(true);
    expect(folders.list()).toEqual([realpathSync(resolve(dir))]);
    const reloaded = new TrustedFolders(path);
    expect(reloaded.isTrusted(dir)).toBe(true);
    expect(reloaded.isTrusted(join(dir, "sub"))).toBe(true);
    expect(reloaded.isTrusted(resolve(dir, "..", "..", "etc"))).toBe(false);
  });
  test("revoke remove e persiste; revogar o que não existe é no-op sem gravar", () => {
    const { dir, path } = tmpStore();
    const folders = new TrustedFolders(path);
    expect(folders.revoke(dir)).toBe(false);
    expect(existsSync(path)).toBe(false);
    folders.trust(dir);
    expect(folders.revoke(dir)).toBe(true);
    expect(new TrustedFolders(path).isTrusted(dir)).toBe(false);
  });
});
describe("ensureTrustedCwd (#267, I-11)", () => {
  test("primeiro open pergunta; aprovar persiste + audita allow", async () => {
    const { dir, path } = tmpStore();
    const asked: string[] = [];
    const events: Array<{ folder: string; decision: string }> = [];
    await ensureTrustedCwd(dir, {
      path,
      ask: async (cwd) => {
        asked.push(cwd);
        return true;
      },
      onDecision: (folder, decision) => events.push({ folder, decision }),
    });
    expect(asked).toEqual([canonicalFolder(dir)]);
    expect(events).toEqual([{ folder: canonicalFolder(dir), decision: "allow" }]);
    expect(new TrustedFolders(path).isTrusted(dir)).toBe(true);
  });
  test("pasta já confiável não pergunta de novo", async () => {
    const { dir, path } = tmpStore();
    new TrustedFolders(path).trust(dir);
    let asked = 0;
    const trusted = await ensureTrustedCwd(dir, {
      path,
      ask: async () => {
        asked++;
        return false;
      },
    });
    expect(trusted).toBe(true);
    expect(asked).toBe(0);
  });
  test("negar joga TrustDeniedError (trust_denied), audita deny e não persiste", async () => {
    const { dir, path } = tmpStore();
    const events: Array<{ folder: string; decision: string }> = [];
    const err = await ensureTrustedCwd(dir, {
      path,
      ask: async () => false,
      onDecision: (folder, decision) => events.push({ folder, decision }),
    }).catch((e) => e as Error);
    expect(err).toBeInstanceOf(TrustDeniedError);
    expect((err as TrustDeniedError).code).toBe("trust_denied");
    expect(events).toEqual([{ folder: canonicalFolder(dir), decision: "deny" }]);
    expect(existsSync(path)).toBe(false);
  });
  test("sem ask (não-TTY/eval) prossegue em silêncio e não persiste", async () => {
    const { dir, path } = tmpStore();
    expect(await ensureTrustedCwd(dir, { path })).toBe(false); // não confiável: plugin local não carrega
    expect(existsSync(path)).toBe(false);
  });
  test("trustPrompt cita a pasta; trustChoice aceita s/sim/y/yes e nega o resto (incl. EOF)", () => {
    expect(trustPrompt("/tmp/x")).toContain("/tmp/x");
    for (const yes of ["s", "S", "sim", "yes", " y "]) expect(trustChoice(yes)).toBe(true);
    for (const no of ["n", "", "talvez", null, undefined]) expect(trustChoice(no)).toBe(false);
  });
});
