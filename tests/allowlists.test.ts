import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_ALLOWLIST_ENTRIES, allowlistLoadEvents, validateAllowlistFlags, type AllowlistLoadEvent } from "../src/allowlists";
import { AllowlistInvalidError } from "../src/path-class";
import { Auditor } from "../src/audit";
import { ToolExecutor } from "../src/tools/executor";
import { readFileTool } from "../src/tools/read-file";
import { dockerArgv, releaseDockerArgv } from "../src/tools/run-command";
const dir = () => mkdtempSync(join(tmpdir(), "astro-allow-"));
const flags = (allowCriticalRaw: string[], iUnderstand: boolean, allowSensitiveRaw: string[] = []) => ({ allowCriticalRaw, allowSensitiveRaw, iUnderstand });
const ev = (entry: string, result: "applied" | "ignored", rule: "allow-critical" | "allow-sensitive"): AllowlistLoadEvent => ({ entry, result, origin: "cli", rule });
describe("validateAllowlistFlags (ADR-0027 #391 s5a): fail-closed antes do run", () => {
  test("sem --i-understand → allow_invalid; válido → applied; sem casar o tier → ignored", () => {
    const cwd = dir();
    const crit = join(cwd, "api_token.txt");
    writeFileSync(crit, "x");
    writeFileSync(join(cwd, "ok.txt"), "x");
    try {
      validateAllowlistFlags(flags([crit], false), cwd);
      expect.unreachable("deveria rejeitar");
    } catch (e) {
      expect(e).toBeInstanceOf(AllowlistInvalidError);
      expect((e as AllowlistInvalidError).code).toBe("allow_invalid");
    }
    const ok = validateAllowlistFlags(flags([crit], true), cwd);
    expect(ok.allowCritical).toHaveLength(1);
    expect(ok.events).toContainEqual(ev(ok.allowCritical[0]!, "applied", "allow-critical"));
    const no = validateAllowlistFlags(flags([join(cwd, "ok.txt")], true), cwd);
    expect(no.events).toContainEqual(ev(no.allowCritical[0]!, "ignored", "allow-critical"));
  });
  test("relativo/glob/dir/inexistente/tier imutável/>64 → allow_invalid", () => {
    const cwd = dir();
    mkdirSync(join(cwd, "dir"));
    writeFileSync(join(cwd, ".env"), "X=1");
    for (const entry of ["rel.txt", join(cwd, "*.txt"), join(cwd, "dir"), join(cwd, "nao_existe.txt"), join(cwd, ".env")])
      expect(() => validateAllowlistFlags(flags([entry], true), cwd)).toThrow(AllowlistInvalidError);
    const many = Array.from({ length: MAX_ALLOWLIST_ENTRIES + 1 }, (_, i) => {
      const f = join(cwd, `api_token_${i}.txt`);
      writeFileSync(f, "x");
      return f;
    });
    expect(() => validateAllowlistFlags(flags(many, true), cwd)).toThrow(AllowlistInvalidError);
  });
  test("allow-sensitive: glob → applied; hard-block/literal inexistente → ignored; >64 → allow_invalid", () => {
    const cwd = dir();
    writeFileSync(join(cwd, ".env"), "X=1");
    const out = validateAllowlistFlags(flags([], false, ["docs/*.md", "*.pem", join(cwd, ".env"), join(cwd, "fantasma.txt")]), cwd);
    expect(out.allowSensitive).toEqual(["docs/*.md"]);
    expect(out.events).toContainEqual(ev("docs/*.md", "applied", "allow-sensitive"));
    for (const entry of ["*.pem", join(cwd, ".env"), join(cwd, "fantasma.txt")]) expect(out.events).toContainEqual(ev(entry, "ignored", "allow-sensitive"));
    const many = Array.from({ length: MAX_ALLOWLIST_ENTRIES + 1 }, (_, i) => `g${i}/*.md`);
    expect(() => validateAllowlistFlags(flags([], false, many), cwd)).toThrow(AllowlistInvalidError);
  });
  test("allowlistLoadEvents deriva applied/ignored sem lançar (audit de load no run)", () => {
    const cwd = dir();
    const file = join(cwd, "api_token.txt");
    writeFileSync(file, "x");
    const events = allowlistLoadEvents({ allowCritical: [file], allowSensitive: ["*.md"] }, cwd);
    expect(events).toContainEqual(ev(file, "applied", "allow-critical"));
    expect(events).toContainEqual(ev("*.md", "applied", "allow-sensitive"));
    expect(allowlistLoadEvents({}, cwd)).toEqual([]);
  });
});
describe("gate de hard-block usa ctx.allowCritical (s5a)", () => {
  const SYNTH = ["s", "k", "-"].join("") + "live-synthetic-9f8e7d6c5b";
  function gate() {
    const cwd = dir();
    writeFileSync(join(cwd, "api_token.txt"), `CHAVE=${SYNTH}\n`);
    writeFileSync(join(cwd, ".env"), `CHAVE=${SYNTH}\n`);
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const executor = new ToolExecutor({ tools: [readFileTool], allow: ["read_file"], audit, permissionMode: "bypass" });
    return { cwd, audit, executor };
  }
  const read = (path: string) => ({ id: "c1", name: "read_file", arguments: JSON.stringify({ path }) });
  test("sem allowCritical segue hard-block; com allowCritical vira normal + audit por match", async () => {
    const { cwd, audit, executor } = gate();
    const blocked = await executor.run({ cwd, run: "r1", agent: "a" }, read("api_token.txt"));
    expect(blocked.isError).toBe(true);
    expect(blocked.output).toContain("path_hard_blocked");
    const ok = await executor.run({ cwd, run: "r1", agent: "a", allowCritical: [join(cwd, "api_token.txt")] }, read("api_token.txt"));
    expect(ok.isError).toBeFalsy();
    const applied = audit.readAll().filter((e) => e.tipo === "security.allowlist_applied");
    expect(applied).toHaveLength(1);
    expect(applied[0]!.payload).toMatchObject({ result: "applied", origin: "cli", rule: "allow-critical", entry: "api_token.txt" });
    expect(JSON.stringify(audit.readAll())).not.toContain(SYNTH); // I-03
  });
  test("allow-sensitive casa cwd via junction/symlink e aplica entropia + audit (review A/B F1)", async () => {
    const real = dir();
    mkdirSync(join(real, "docs"));
    writeFileSync(join(real, "docs", "notes.md"), randomBytes(2048).toString("base64"));
    const link = join(dir(), "proj");
    symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
    const audit = new Auditor(join(real, "audit.jsonl"));
    const executor = new ToolExecutor({ tools: [readFileTool], allow: ["read_file"], audit, permissionMode: "bypass" });
    const call = { id: "c1", name: "read_file", arguments: JSON.stringify({ path: "docs/notes.md" }) };
    for (const allowSensitive of [["docs/*.md"], [join(link, "docs", "*.md")]]) {
      const result = await executor.run({ cwd: link, run: "r1", agent: "a", allowSensitive }, call);
      expect(result.isError).toBe(true);
      expect(result.output).toContain("sensitive");
    }
    expect(audit.readAll().some((e) => e.tipo === "security.allowlist_applied"
      && (e.payload as { rule?: string }).rule === "allow-sensitive")).toBe(true);
  });

  test("allow-sensitive: glob amplo que alcança hard-block é ignorado (review B F2)", () => {
    const cwd = dir();
    writeFileSync(join(cwd, ".env"), "X=1");
    const entries = ["*", "**/*", "docs/*", "*.json"];
    const out = validateAllowlistFlags(flags([], false, entries), cwd);
    expect(out.allowSensitive).toEqual([]);
    for (const entry of entries) expect(out.events).toContainEqual(ev(entry, "ignored", "allow-sensitive"));
  });

  test("allow-sensitive promove normal a sensitive: entropia nega e o match é auditado", async () => {
    const { cwd, audit, executor } = gate();
    writeFileSync(join(cwd, "notes.md"), randomBytes(2048).toString("base64"));
    const call = read("notes.md");
    const normal = await executor.run({ cwd, run: "r1", agent: "a" }, call);
    expect(normal.isError).toBeFalsy();
    const sensitive = await executor.run({ cwd, run: "r1", agent: "a", allowSensitive: ["*.md"] }, call);
    expect(sensitive.isError).toBe(true);
    expect(sensitive.output).toContain("sensitive");
    const applied = audit.readAll().filter((e) => e.tipo === "security.allowlist_applied");
    expect(applied.some((e) => e.payload.rule === "allow-sensitive" && e.payload.entry === "notes.md")).toBe(true);
  });

  test("allowCritical em tier imutável (.env) segue allow_invalid no gate (fail-closed)", async () => {
    const { cwd, executor } = gate();
    const r = await executor.run({ cwd, run: "r1", agent: "a", allowCritical: [join(cwd, ".env")] }, read(".env"));
    expect(r.isError).toBe(true);
    expect(r.code).toBe("allow_invalid");
    expect(r.output).toContain("allow_invalid");
    expect(r.output).not.toContain(SYNTH);
  });
});
describe("sandbox: allowCritical não gera máscara para o path liberado (s5a)", () => {
  test("máscara existe sem allowCritical e some com allowCritical; .env segue mascarado", () => {
    const cwd = dir();
    writeFileSync(join(cwd, "api_token.txt"), "x");
    writeFileSync(join(cwd, ".env"), "X=1");
    const target = join(cwd, "api_token.txt");
    const masked = (argv: string[], t: string) =>
      argv.flatMap((v, i) => (v === "--volume" ? [argv[i + 1] as string] : [])).some((s) => s.endsWith(`:${t}:ro`));
    const argvs = [
      dockerArgv("sb", { cwd }, "echo ok"),
      dockerArgv("sb", { cwd, allowCritical: [target] }, "echo ok"),
      dockerArgv("sb", { cwd, allowCritical: [target] }, "echo ok"),
    ];
    try {
      expect(masked(argvs[0]!, target)).toBe(true);
      expect(masked(argvs[1]!, target)).toBe(false);
      expect(masked(argvs[2]!, join(cwd, ".env"))).toBe(true);
    } finally {
      for (const argv of argvs) releaseDockerArgv(argv);
    }
  });
});
describe("CLI: flags só em run/chat/tui, validadas antes do run", () => {
  const entry = join(import.meta.dir, "..", "src", "cli.ts");
  const spawnCli = async (args: string[], cwd: string) => {
    const proc = Bun.spawn([process.execPath, entry, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    return { code: await proc.exited, stderr: await new Response(proc.stderr).text() };
  };
  test("run --allow-critical sem --i-understand → exit 1 com allow_invalid", async () => {
    const cwd = dir();
    const file = join(cwd, "api_token.txt");
    writeFileSync(file, "x");
    const { code, stderr } = await spawnCli(["run", "tarefa", "--allow-critical", file], cwd);
    expect(code).toBe(1);
    expect(stderr).toContain("allow_invalid");
  });
  test("--i-understand sozinho → UsageError; flag em health → opção desconhecida", async () => {
    const cwd = dir();
    const alone = await spawnCli(["run", "tarefa", "--i-understand"], cwd);
    expect(alone.code).toBe(1);
    expect(alone.stderr).toContain("--i-understand");
    expect(alone.stderr).toContain("Uso:");
    const other = await spawnCli(["health", "--allow-sensitive", "*.md"], cwd);
    expect(other.code).toBe(1);
    expect(other.stderr).toContain("opção desconhecida");
  });
  test("run --allow-critical <arquivo> --i-understand válido passa da validação (para na config ausente)", async () => {
    const cwd = dir();
    const file = join(cwd, "api_token.txt");
    writeFileSync(file, "x");
    const { code, stderr } = await spawnCli(["run", "tarefa", "--allow-critical", file, "--i-understand"], cwd);
    expect(code).toBe(1); // segue até a carga da config, não sai na allowlist
    expect(stderr).toContain("erro:");
    expect(stderr).not.toContain("allow_invalid");
    expect(stderr).not.toContain("Uso:");
  });
});
