import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  applyFixes,
  collectFacts,
  doctorJson,
  exitCode,
  renderReport,
  runChecks,
  satisfiesMinimum,
  type DoctorFacts,
} from "../src/doctor";

const VALID_SKILL = `---\nname: ok\ndescription: ok\nversion: 1.0.0\n---\nPrompt\n`;

function writeSkill(root: string, name: string, content: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), content, "utf8");
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "astro-doctor-unit-"));
  dirs.push(dir);
  return dir;
}

const SENTINEL = "sentinel-xyz-do-not-print";

function facts(over: Partial<DoctorFacts> = {}): DoctorFacts {
  return {
    bunVersion: "1.4.2",
    nodeVersion: "22.1.0",
    engines: { bun: ">=1.4.0", node: ">=18" },
    missingModules: [],
    artifacts: [{ path: "dist/cli.js", exists: true }, { path: "dist/launcher.js", exists: true }],
    config: { path: "astro.config.json", present: false },
    astroHome: { path: "~/.astro", exists: true, writable: true },
    attachments: { root: "~/.astro/attachments", exists: true, ttlDays: 7, maxBytes: 1024 ** 3, usageBytes: 0, artifacts: 0 },
    env: {},
    ...over,
  };
}

function lines(report: ReturnType<typeof runChecks>): string {
  const out: string[] = [];
  renderReport(report, (line) => out.push(line));
  return out.join("\n");
}

test("ambiente completo passa com exit 0", () => {
  const report = runChecks(facts());
  expect(exitCode(report)).toBe(0);
  expect(report.checks.some((check) => check.level === "fail")).toBe(false);
  expect(lines(report)).toContain("bun 1.4.2");
});

test("bun abaixo do mínimo falha", () => {
  const report = runChecks(facts({ bunVersion: "1.3.9" }));
  expect(exitCode(report)).toBe(1);
  expect(report.checks.some((check) => check.level === "fail" && check.label === "bun")).toBe(true);
});

test("node ausente falha", () => {
  const report = runChecks(facts({ nodeVersion: undefined }));
  expect(exitCode(report)).toBe(1);
  expect(report.checks.some((check) => check.level === "fail" && check.label === "node")).toBe(true);
});

test("módulo de runtime ausente falha apontando bun install", () => {
  const report = runChecks(facts({ missingModules: ["ink"] }));
  const check = report.checks.find((item) => item.label === "dependências");
  expect(check?.level).toBe("fail");
  expect(check?.detail).toContain("bun install");
});

test("dist ausente é warn, não fail", () => {
  const report = runChecks(facts({
    artifacts: [
      { path: "dist/cli.js", exists: false },
      { path: "dist/launcher.js", exists: false },
    ],
  }));
  const check = report.checks.find((item) => item.label === "dist");
  expect(check?.level).toBe("warn");
  expect(check?.detail).toContain("bun run build");
  expect(exitCode(report)).toBe(0);
});

test("config ausente é ok (TUI abre o setup de provider)", () => {
  const report = runChecks(facts());
  const check = report.checks.find((item) => item.label === "config");
  expect(check?.level).toBe("ok");
  expect(check?.detail).toContain("setup");
});

test("config inválida é fail", () => {
  const report = runChecks(facts({
    config: { path: "astro.config.json", present: true, error: "configuração não é JSON válido" },
  }));
  expect(exitCode(report)).toBe(1);
  expect(report.checks.some((check) => check.level === "fail" && check.label === "config")).toBe(true);
});

test("credencial aparece só pelo nome; o valor nunca é impresso", () => {
  const report = runChecks(facts({
    config: {
      path: "astro.config.json",
      present: true,
      providers: [{ id: "nvidia", credentialRef: "NVIDIA_API_KEY" }],
    },
    env: { NVIDIA_API_KEY: SENTINEL },
  }));
  const out = lines(report);
  expect(out).toContain("NVIDIA_API_KEY");
  expect(out).toContain("presente");
  expect(out).not.toContain(SENTINEL);
});

test("credencial ausente no ambiente é warn", () => {
  const report = runChecks(facts({
    config: {
      path: "astro.config.json",
      present: true,
      providers: [{ id: "nvidia", credentialRef: "NVIDIA_API_KEY" }],
    },
  }));
  const check = report.checks.find((item) => item.label.startsWith("credencial"));
  expect(check?.level).toBe("warn");
  expect(check?.detail).toContain("NVIDIA_API_KEY");
  expect(exitCode(report)).toBe(0);
});

test("anexos inválidos falham, ausentes avisam e válidos reportam uso", () => {
  const base = facts().attachments;
  const invalid = runChecks(facts({ attachments: { ...base, invalidReason: "raiz dentro do cwd" } }));
  expect(invalid.checks.find((item) => item.label === "anexos")?.level).toBe("fail");
  expect(exitCode(invalid)).toBe(1);

  const missing = runChecks(facts({ attachments: { ...base, exists: false } }));
  const missingCheck = missing.checks.find((item) => item.label === "anexos");
  expect(missingCheck?.level).toBe("warn");
  expect(missingCheck?.detail).toContain("ausente");

  const valid = runChecks(facts({ attachments: {
    ...base, realpath: "/real/attachments", usageBytes: 3, artifacts: 1, lastGc: "2026-11-16T12:00:00.000Z",
  } }));
  const validCheck = valid.checks.find((item) => item.label === "anexos");
  expect(validCheck?.level).toBe("ok");
  expect(validCheck?.detail).toContain("1 artefato");
  expect(validCheck?.detail).toContain("3 B");
  expect(validCheck?.detail).toContain("TTL 7d");
  expect(validCheck?.detail).toContain("2026-11-16T12:00:00.000Z");
});

test("ASTRO_HOME existente e não gravável falha", () => {
  const report = runChecks(facts({
    astroHome: { path: "~/.astro", exists: true, writable: false },
  }));
  expect(exitCode(report)).toBe(1);
  expect(report.checks.some((check) => check.level === "fail" && check.label === "astro home")).toBe(true);
});

test("satisfiesMinimum compara versões com e sem range", () => {
  expect(satisfiesMinimum("1.4.2", ">=1.4.0")).toBe(true);
  expect(satisfiesMinimum("1.3.9", ">=1.4.0")).toBe(false);
  expect(satisfiesMinimum("22.1.0", "18")).toBe(true);
  expect(satisfiesMinimum("16.20.0", ">=18")).toBe(false);
});

test("codex-oauth sem arquivo de credenciais é warn", () => {
  const report = runChecks(facts({
    config: {
      path: "astro.config.json",
      present: true,
      providers: [{ id: "codex", kind: "codex-oauth", credentialsReadable: false }],
    },
  }));
  const check = report.checks.find((item) => item.label === "credencial codex");
  expect(check?.level).toBe("warn");
  expect(check?.detail).toContain("credenciais");
  expect(exitCode(report)).toBe(0);
});

test("MCP com header env ausente é warn e cita só o nome", () => {
  const report = runChecks(facts({
    config: {
      path: "astro.config.json",
      present: true,
      mcp: { servers: 2, enabled: 1, missingHeaderEnv: ["MCP_TOKEN"] },
    },
  }));
  const check = report.checks.find((item) => item.label === "mcp");
  expect(check?.level).toBe("warn");
  expect(check?.detail).toContain("MCP_TOKEN");
  expect(exitCode(report)).toBe(0);
});

test("MCP sem servidor configurado é ok", () => {
  const report = runChecks(facts({
    config: { path: "astro.config.json", present: true, mcp: { servers: 0, enabled: 0, missingHeaderEnv: [] } },
  }));
  const check = report.checks.find((item) => item.label === "mcp");
  expect(check?.level).toBe("ok");
  expect(check?.detail).toContain("nenhum servidor");
});

test("skills válidas contam por fonte e inválidas viram warn", () => {
  const valid = runChecks(facts({ skills: { project: 1, user: 2, warnings: [] } }));
  const validCheck = valid.checks.find((item) => item.label === "skills");
  expect(validCheck?.level).toBe("ok");
  expect(validCheck?.detail).toContain("1 no projeto");
  expect(validCheck?.detail).toContain("2 do usuário");

  const invalid = runChecks(facts({
    skills: { project: 0, user: 0, warnings: ['skill "broken" ignorada: frontmatter inválido'] },
  }));
  const invalidCheck = invalid.checks.find((item) => item.label === "skills");
  expect(invalidCheck?.level).toBe("warn");
  expect(invalidCheck?.detail).toContain("broken");
  expect(exitCode(invalid)).toBe(0);
});

test("disco sem escrita no cwd falha e reporta espaço livre", () => {
  const failing = runChecks(facts({ disk: { cwd: "/proj", writable: false, freeBytes: 1024 ** 3 } }));
  const failCheck = failing.checks.find((item) => item.label === "disco");
  expect(failCheck?.level).toBe("fail");
  expect(exitCode(failing)).toBe(1);

  const valid = runChecks(facts({ disk: { cwd: "/proj", writable: true, freeBytes: 2 * 1024 ** 3 } }));
  const okCheck = valid.checks.find((item) => item.label === "disco");
  expect(okCheck?.level).toBe("ok");
  expect(okCheck?.detail).toContain("2.0 GiB");
  expect(okCheck?.detail).toContain("atributo");
  expect(okCheck?.detail).not.toContain("gravável");
});

test("checks redigem padrão de segredo no detalhe", () => {
  const secret = ["sk", "-", "live", "-", "SECRET", "123456789"].join("");
  const report = runChecks(facts({ astroHome: { path: join("/tmp", secret), exists: false, writable: false } }));
  const text = lines(report);
  expect(text).toContain("[REDACTED]");
  expect(text).not.toContain(secret);
});

test("doctorJson tem schema, resumo e fixes opcional", () => {
  const report = runChecks(facts());
  const json = doctorJson(report);
  expect(json.schema).toBe("doctor/v1");
  expect(json.summary).toEqual({ ok: report.checks.length, warn: 0, fail: 0 });
  expect(json).not.toHaveProperty("fixes");

  const withFix = doctorJson(report, { applied: ["criado /tmp/home"], errors: [] });
  expect(withFix.fixes).toEqual({ applied: ["criado /tmp/home"], errors: [] });
});

test("applyFixes cria ASTRO_HOME, é idempotente e não cria a raiz de artefatos", () => {
  const base = sandbox();
  const home = join(base, "nested", "home");
  const env = { ...process.env, ASTRO_HOME: home };

  const first = applyFixes(env);
  expect(first.applied).toHaveLength(1);
  expect(first.errors).toEqual([]);
  expect(existsSync(home)).toBe(true);
  expect(existsSync(join(home, "attachments"))).toBe(false);

  const second = applyFixes(env);
  expect(second.applied).toEqual([]);
  expect(second.errors).toEqual([]);
});

test("applyFixes não sobrescreve ASTRO_HOME que é arquivo", () => {
  const base = sandbox();
  const home = join(base, "file-home");
  writeFileSync(home, "x", "utf8");
  const result = applyFixes({ ...process.env, ASTRO_HOME: home });
  expect(result.applied).toEqual([]);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain("diretório");
});

test("applyFixes recusa ASTRO_HOME relativo sem criar nada", () => {
  const base = sandbox();
  const relative = `.astro-doctor-${process.pid}-${Date.now()}`;
  const result = applyFixes({ ...process.env, ASTRO_HOME: relative });
  expect(result.applied).toEqual([]);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain("absoluto");
  expect(existsSync(join(base, relative))).toBe(false);
  expect(existsSync(join(process.cwd(), relative))).toBe(false);
});

test("applyFixes recusa ASTRO_HOME absoluto com .. sem criar o destino resolvido", () => {
  const base = sandbox();
  // `..` literal: `join` normalizaria o segmento e o teste não exercitaria a guarda.
  const escape = `${base}${sep}..${sep}astro-doctor-escape-${process.pid}-${Date.now()}`;
  dirs.push(escape);
  const result = applyFixes({ ...process.env, ASTRO_HOME: escape });
  expect(result.applied).toEqual([]);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain("..");
  expect(existsSync(escape)).toBe(false);
});

test("applyFixes aceita ASTRO_HOME absoluto dentro do cwd, uma vez e idempotente", () => {
  const base = sandbox();
  const home = join(base, "state", "home");
  const env = { ...process.env, ASTRO_HOME: home };

  const first = applyFixes(env);
  expect(first.errors).toEqual([]);
  expect(first.applied).toHaveLength(1);
  expect(existsSync(home)).toBe(true);
  if (process.platform !== "win32") {
    expect(statSync(home).mode & 0o777).toBe(0o700);
  }

  const second = applyFixes(env);
  expect(second.errors).toEqual([]);
  expect(second.applied).toEqual([]);
});

test("applyFixes recusa ASTRO_HOME que é link simbólico e não escreve pelo link", () => {
  const base = sandbox();
  const target = join(base, "missing-target");
  const home = join(base, "linked-home");
  symlinkSync(target, home, process.platform === "win32" ? "junction" : "dir");

  const result = applyFixes({ ...process.env, ASTRO_HOME: home });
  expect(result.applied).toEqual([]);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain("link");
});

test("check da astro home falha quando o valor resolvido é inválido", () => {
  const report = runChecks(facts({
    astroHome: { path: ".astro", exists: false, writable: false, error: 'ASTRO_HOME precisa ser um caminho absoluto: .astro' },
  }));
  const check = report.checks.find((item) => item.label === "astro home");
  expect(check?.level).toBe("fail");
  expect(check?.detail).toContain("absoluto");
  expect(exitCode(report)).toBe(1);
});

test("sanitizeCheck redige também o label do check", () => {
  const secret = ["sk", "-", "live", "-", "SECRET", "123456789"].join("");
  const report = runChecks(facts({
    config: {
      path: "astro.config.json",
      present: true,
      providers: [{ id: secret, credentialRef: "KEY" }],
    },
    env: { KEY: "present" },
  }));
  const text = lines(report);
  expect(text).toContain("[REDACTED]");
  expect(text).not.toContain(secret);
});

test("leitura aceita ASTRO_HOME que é link simbólico e reporta o caminho real", () => {
  const base = sandbox();
  const real = join(base, "real-home");
  mkdirSync(real, { recursive: true });
  const link = join(base, "linked-home");
  symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");

  const collected = collectFacts(process.cwd(), {
    env: { ...process.env, ASTRO_HOME: link },
    checkPrivate: () => true,
  });
  expect(collected.astroHome.error).toBeUndefined();
  expect(collected.astroHome.exists).toBe(true);
  expect(collected.astroHome.path).toBe(realpathSync(real));

  const report = runChecks(collected);
  const check = report.checks.find((item) => item.label === "astro home");
  expect(check?.level).toBe("ok");
  expect(exitCode(report)).toBe(0);
});

test("skills do usuário vêm da raiz injetada e skill quebrada vira warn", () => {
  const userRoot = join(sandbox(), "skills");
  mkdirSync(userRoot, { recursive: true });
  writeSkill(userRoot, "broken", "sem frontmatter");

  const collected = collectFacts(process.cwd(), {
    env: { ...process.env, ASTRO_HOME: join(sandbox(), "other-home") },
    checkPrivate: () => true,
    userSkillsRoot: userRoot,
  });
  expect(collected.skills?.user).toBe(0);
  expect(collected.skills?.warnings.length).toBeGreaterThan(0);
  const check = runChecks(collected).checks.find((item) => item.label === "skills");
  expect(check?.level).toBe("warn");
  expect(exitCode(runChecks(collected))).toBe(0);
});

test("skills válidas na raiz do usuário são contadas", () => {
  const userRoot = join(sandbox(), "skills");
  mkdirSync(userRoot, { recursive: true });
  writeSkill(userRoot, "ok", VALID_SKILL);

  const collected = collectFacts(process.cwd(), {
    env: { ...process.env, ASTRO_HOME: join(sandbox(), "other-home") },
    checkPrivate: () => true,
    userSkillsRoot: userRoot,
  });
  expect(collected.skills).toEqual({ project: 0, user: 1, warnings: [] });
  const check = runChecks(collected).checks.find((item) => item.label === "skills");
  expect(check?.level).toBe("ok");
  expect(check?.detail).toContain("1 do usuário");
});

test("config global malformada falha mesmo com config de projeto válida", () => {
  const home = sandbox();
  writeFileSync(join(home, "config.json"), "{not json", "utf8");

  const collected = collectFacts(process.cwd(), {
    env: { ...process.env, ASTRO_HOME: home },
    checkPrivate: () => true,
  });
  expect(collected.config.global?.error).toBeString();
  const report = runChecks(collected);
  const check = report.checks.find((item) => item.label === "config global");
  expect(check?.level).toBe("fail");
  expect(exitCode(report)).toBe(1);
});

test("credencial vault:<id> é cofre local, não env ausente", () => {
  const report = runChecks(facts({
    config: {
      path: "astro.config.json",
      present: true,
      providers: [{ id: "p", credentialRef: "vault:cred-12345678" }],
    },
  }));
  const check = report.checks.find((item) => item.label === "credencial p");
  expect(check?.level).toBe("ok");
  expect(check?.detail).toContain("cofre");
  expect(check?.detail).not.toContain("ausente");
});
