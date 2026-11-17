import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, sep } from "node:path";
import { AllowlistInvalidError, classifyPath, createPathClassifier } from "../src/path-class";
import type { ClassifyPathInput } from "../src/path-class";

const dir = () => mkdtempSync(join(tmpdir(), "astro-pathclass-"));
const cwd = dir();
const astroHome = dir();

const cls = (realPath: string, extra: Partial<ClassifyPathInput> = {}) =>
  classifyPath({ cwd, astroHome, realPath, ...extra });

test("hard-block imutável: .env e .env.* exceto templates", () => {
  expect(cls(join(cwd, ".env"))).toBe("hard-block");
  expect(cls(join(cwd, "sub", ".env.local"))).toBe("hard-block");
  expect(cls(join(cwd, ".env.example"))).toBe("sensitive"); // template: não é hard-block
});

test("hard-block imutável: chaves, certificados e diretórios de segredo", () => {
  const items = [
    "id_rsa", "id_ed25519", "cert.pem", "tls.key", "bundle.p12", "cert.pfx",
    "store.jks", "db.kdbx", ".ssh/config", ".gnupg/pubring.kbx",
    ".aws/credentials", ".kube/config",
  ];
  for (const item of items) expect(cls(join(cwd, item))).toBe("hard-block");
});

test("hard-block imutável: configs nomeados", () => {
  for (const name of ["vault.json", "auth.json", "astro.config.json"]) {
    expect(cls(join(cwd, name))).toBe("hard-block");
  }
});

test("hard-block imutável: dotfiles da home e expansão de ~", () => {
  for (const rel of [".netrc", ".npmrc", join(".docker", "config.json"), join(".config", "gh", "hosts.yml")]) {
    expect(cls(join(homedir(), rel))).toBe("hard-block");
  }
  expect(cls("~/.netrc")).toBe("hard-block");
  expect(cls("~/.npmrc")).toBe("hard-block");
});

test("hard-block imutável: .astro do cwd e .git (qualquer profundidade)", () => {
  expect(cls(join(cwd, ".astro"))).toBe("hard-block");
  expect(cls(join(cwd, ".astro", "audit.jsonl"))).toBe("hard-block");
  expect(cls(join(cwd, ".git", "HEAD"))).toBe("hard-block");
  expect(cls(join(cwd, "sub", ".git", "HEAD"))).toBe("hard-block");
});

test("hard-block imutável: protectedPaths relativos ao cwd", () => {
  expect(cls(join(cwd, "ledger.jsonl"), { protectedPaths: ["ledger.jsonl"] })).toBe("hard-block");
  expect(cls(join(cwd, "audit", "x.jsonl"), { protectedPaths: ["audit"] })).toBe("hard-block");
  expect(cls(join(cwd, "ok.txt"), { protectedPaths: ["ledger.jsonl"] })).toBe("normal");
});

test("hard-block imutável: $ASTRO_HOME fora do artifactRoot; artifactRoot isento", () => {
  const artifactRoot = join(astroHome, "artifacts");
  expect(cls(join(astroHome, "vault", "x"))).toBe("hard-block");
  expect(cls(join(astroHome, "keys", "k"))).toBe("hard-block");
  expect(cls(join(astroHome, "artifacts", "out.txt"), { artifactRoot })).toBe("normal");
  expect(cls(join(astroHome, "other", "x"), { artifactRoot })).toBe("hard-block");
});

test("hard-block configurável: CRITICAL_PATH_PATTERN fora do tier imutável", () => {
  expect(cls(join(cwd, "config", "api_token.txt"))).toBe("hard-block");
  expect(cls(join(cwd, "aws_secret_access_key"))).toBe("hard-block");
});

test("hard-block configurável: termo contido no nome, sem bloquear palavra comum (#263)", () => {
  for (const item of ["mysecret.txt", "apikey.txt", "my-token.txt", "credentials.json", "id_rsa"]) {
    expect(cls(join(cwd, item))).toBe("hard-block");
  }
  for (const item of ["keyboard.ts", "monkey.ts", "tokenizer.ts"]) {
    expect(cls(join(cwd, item))).toBe("normal");
  }
});

test("sensitive: .example/.sample/.template/.dist e .env.example", () => {
  for (const name of [".env.example", "config.sample", "app.template", "settings.dist", "README.example"]) {
    expect(cls(join(cwd, name))).toBe("sensitive");
  }
});

test("normal: todo o resto", () => {
  expect(cls(join(cwd, "src", "index.ts"))).toBe("normal");
});

test("createPathClassifier: fábrica reutiliza contexto e mantém a semântica de classifyPath", () => {
  const classify = createPathClassifier({ cwd, astroHome });
  const samples = [
    ".env", ".env.example", join(".ssh", "config"), join(".git", "HEAD"),
    "api_token.txt", "notes.txt",
  ].map((p) => join(cwd, p)).concat(join(astroHome, "vault", "x"));
  for (const p of samples) expect(classify(p)).toBe(cls(p));
});

test("allow-sensitive promove normal a sensitive, nunca hard-block", () => {
  mkdirSync(join(cwd, "docs"), { recursive: true });
  writeFileSync(join(cwd, "docs", "guide.md"), "x");
  expect(cls(join(cwd, "docs", "guide.md"))).toBe("normal");
  expect(cls(join(cwd, "docs", "guide.md"), { allowSensitive: ["docs/*.md"] })).toBe("sensitive");
  expect(cls(join(cwd, ".env"), { allowSensitive: ["*"] })).toBe("hard-block");
  expect(cls(join(cwd, "src", "a.ts"), { allowSensitive: ["docs/*.md"] })).toBe("normal");
});

test("precedência hard-block > sensitive > normal", () => {
  expect(cls(join(cwd, "secret_token.pem"))).toBe("hard-block"); // imutável vence o padrão
  expect(cls(join(cwd, ".env.example"))).toBe("sensitive"); // template não é hard-block
  expect(cls(join(cwd, "notes.txt"))).toBe("normal");
});

test("case-fold em win32/darwin", () => {
  if (process.platform === "win32" || process.platform === "darwin") {
    expect(cls(join(cwd, "CERT.PEM"))).toBe("hard-block");
    expect(cls(join(cwd, ".ENV"))).toBe("hard-block");
  } else {
    expect(cls(join(cwd, "CERT.PEM"))).toBe("normal");
  }
});

test("symlink é resolvido antes de classificar", () => {
  const real = join(cwd, "real");
  mkdirSync(real);
  writeFileSync(join(real, "api_token.txt"), "x");
  writeFileSync(join(real, "ok.txt"), "y");
  symlinkSync(real, join(cwd, "atalho"), process.platform === "win32" ? "junction" : "dir");
  expect(cls(join(cwd, "atalho", "api_token.txt"))).toBe("hard-block");
  expect(cls(join(cwd, "atalho", "ok.txt"))).toBe("normal");
});

test("allow-critical válido reclassifica hard-block configurável para normal", () => {
  const p = join(cwd, "tokens", "api_token.txt");
  expect(cls(p)).toBe("hard-block");
  expect(cls(p, { allowCritical: [p] })).toBe("normal");
});

test("allow-critical que não casa o tier configurável é ignorada", () => {
  expect(cls(join(cwd, "ok.txt"), { allowCritical: [join(cwd, "other.txt")] })).toBe("normal");
});

test("allow-critical no tier imutável → AllowlistInvalidError (allow_invalid)", () => {
  for (const entry of [join(cwd, ".env"), join(cwd, "k.pem"), join(astroHome, "x")]) {
    try {
      cls(join(cwd, "ok.txt"), { allowCritical: [entry] });
      expect.unreachable("deveria ter rejeitado");
    } catch (error) {
      expect(error).toBeInstanceOf(AllowlistInvalidError);
      expect((error as AllowlistInvalidError).code).toBe("allow_invalid");
      expect((error as Error).message).toContain("allow-critical");
    }
  }
});

test("allow-critical com glob, diretório ou relativo → allow_invalid", () => {
  mkdirSync(join(cwd, "dir"));
  for (const entry of [join(cwd, "*.txt"), join(cwd, "dir"), "relativo.txt"]) {
    expect(() => cls(join(cwd, "ok.txt"), { allowCritical: [entry] })).toThrow(AllowlistInvalidError);
  }
});

test("allow-critical acima de 64 entradas → allow_invalid", () => {
  const entries = Array.from({ length: 65 }, (_, i) => join(cwd, `f${i}.txt`));
  expect(() => cls(join(cwd, "ok.txt"), { allowCritical: entries })).toThrow(AllowlistInvalidError);
  expect(cls(join(cwd, "ok.txt"), { allowCritical: entries.slice(0, 64) })).toBe("normal");
});

test("review blockers: symlink+.., home junction, ADS, ~user fail-closed", () => {
  const home = dir();
  writeFileSync(join(home, ".netrc"), "sintetico");
  const work = dir();
  const link = process.platform === "win32" ? "junction" : "dir";
  mkdirSync(join(astroHome, "sub"), { recursive: true });
  symlinkSync(join(astroHome, "sub"), join(work, "x"), link); // x -> filho de $ASTRO_HOME
  symlinkSync(home, join(work, "hl"), link);
  expect(cls(work + sep + "x/../plain.txt", { cwd: work })).toBe("hard-block"); // B1: `..` após realpath (I-11)
  expect(cls(join(work, "plain.txt"), { cwd: work })).toBe("normal"); // B1: controle
  const key = process.platform === "win32" ? "USERPROFILE" : "HOME";
  const saved = process.env[key];
  process.env[key] = join(work, "hl"); // A1: home via junction
  expect(cls("~/.netrc")).toBe("hard-block"); // A1
  if (saved === undefined) delete process.env[key]; else process.env[key] = saved;
  expect(cls(`~${userInfo().username}/.netrc`)).toBe("hard-block"); // B2: ~usuario atual resolve
  expect(cls("~nao-existe-xyz/a.txt")).toBe("hard-block"); // B2: inexistente falha fechado
  if (process.platform === "win32") {
    writeFileSync(join(work, ".env") + ":hidden", "SEGREDO-SINTETICO");
    expect(cls(join(work, ".env") + ":hidden", { cwd: work })).toBe("hard-block"); // A2: ADS NTFS
    expect(() => cls(join(work, "ok.txt"), { cwd: work, allowCritical: [join(work, ".env") + ":hidden"] })).toThrow(AllowlistInvalidError); // A2
  }
});

test("review minors: edges, no-leak, stat EACCES fail-closed", () => {
  expect(cls(join(cwd, "api_token.sample"))).toBe("hard-block"); // B4: configurável > sensitive
  mkdirSync(join(cwd, "wt"), { recursive: true });
  writeFileSync(join(cwd, "wt", ".git"), "gitdir: x");
  expect(cls(join(cwd, "wt", ".git"))).toBe("hard-block"); // B4: .git como arquivo (worktree)
  if (process.platform === "win32") expect(() => cls("\\\\server\\share\\.git")).toThrow(); else expect(cls("\\\\server\\share\\.git")).toBe("hard-block"); // B4: UNC
  const segredo = "SEGREDO-SINTETICO-9f8e";
  writeFileSync(join(cwd, "arq.txt"), segredo);
  try {
    cls(join(cwd, "ok.txt"), { allowCritical: [join(cwd, "arq.txt") + "/*"] });
    expect.unreachable("allow_invalid esperado");
  } catch (error) {
    expect((error as Error).message).not.toContain(segredo); // B3: sem vazar conteúdo (I-03)
  }
  const spy = spyOn(fs, "statSync").mockImplementation(() => {
    throw Object.assign(new Error("negado"), { code: "EACCES" });
  });
  try {
    expect(() => cls(join(cwd, "ok.txt"), { allowCritical: [join(cwd, "api_token.txt")] })).toThrow(AllowlistInvalidError); // B5
  } finally {
    spy.mockRestore();
  }
});
