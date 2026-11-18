/**
 * Falhas de fs que não dá para provocar de forma portátil (ENOSPC, EPERM): o
 * `node:fs` é mockado antes de carregar `src/core/config` (#470). EACCES real
 * fica em `config.test.ts` (só POSIX).
 */
import { afterAll, describe, expect, mock, test } from "bun:test";
import * as realFs from "node:fs";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigError as ConfigErrorInstance } from "../src/core/config";

// Capturados antes do mock: `realFs.x` depois do mock poderia voltar ao shim.
const realReadFileSync = realFs.readFileSync;
const realWriteFileSync = realFs.writeFileSync;

let failure: { op: "read" | "write"; error: unknown } | null = null;

function errno(code: string, syscall: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${syscall} '${path}'`), { code, errno: -1, syscall, path });
}

const shim = {
  ...realFs,
  readFileSync: ((...args: Parameters<typeof realReadFileSync>) => {
    if (failure?.op === "read") throw failure.error;
    return realReadFileSync(...args);
  }) as typeof realFs.readFileSync,
  writeFileSync: ((...args: Parameters<typeof realWriteFileSync>) => {
    if (failure?.op === "write") throw failure.error;
    return realWriteFileSync(...args);
  }) as typeof realFs.writeFileSync,
};

mock.module("node:fs", () => shim);

afterAll(() => {
  failure = null;
  mock.module("node:fs", () => realFs);
});

const { ConfigError, updateConfigPermissionsMode } = await import("../src/core/config");

const minimal = {
  providers: { openai: { kind: "openai-compat", baseUrl: "https://api.openai.com/v1", credentialRef: "OPENAI_API_KEY" } },
  models: [{ provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000 }],
  agent: { model: "openai/gpt-4o-mini", maxSteps: 12, tools: [] },
  paths: { ledger: "l", audit: "a" },
};

describe("falhas de fs no save do /config (#470)", () => {
  const noTmp = (dir: string): void => {
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  };
  const capture = (fn: () => void): ConfigErrorInstance => {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return error as ConfigErrorInstance;
    }
    throw new Error("esperava ConfigError");
  };
  const seed = (): { dir: string; path: string; original: string } => {
    const dir = mkdtempSync(join(tmpdir(), "astro-config-470-fs-"));
    const path = join(dir, "astro.config.json");
    const original = JSON.stringify(minimal);
    writeFileSync(path, original);
    return { dir, path, original };
  };

  test("ENOSPC na gravação: config_write_failed nomeia caminho e código; original intacto", () => {
    const { dir, path, original } = seed();
    failure = { op: "write", error: errno("ENOSPC", "write", path) };
    try {
      const err = capture(() => updateConfigPermissionsMode(path, "allow-edits"));
      expect(err.code).toBe("config_write_failed");
      expect(err.message).toContain("não foi possível gravar");
      expect(err.message).toContain(path);
      expect(err.message).toContain("ENOSPC");
      expect(err.message).toContain("original não foi alterado");
      expect(readFileSync(path, "utf8")).toBe(original);
      noTmp(dir);
    } finally {
      failure = null;
    }
  });

  test("EPERM na gravação: config_write_denied (EPERM fixado, não só EACCES)", () => {
    const { dir, path, original } = seed();
    failure = { op: "write", error: errno("EPERM", "write", path) };
    try {
      const err = capture(() => updateConfigPermissionsMode(path, "allow-edits"));
      expect(err.code).toBe("config_write_denied");
      expect(err.message).toMatch(/sem permissão para gravar/);
      expect(err.message).toContain("EPERM");
      expect(readFileSync(path, "utf8")).toBe(original);
      noTmp(dir);
    } finally {
      failure = null;
    }
  });

  test("EPERM na leitura: config_read_denied (EPERM fixado, não só EACCES)", () => {
    const { path } = seed();
    failure = { op: "read", error: errno("EPERM", "read", path) };
    try {
      const err = capture(() => updateConfigPermissionsMode(path, "ask"));
      expect(err.code).toBe("config_read_denied");
      expect(err.message).toMatch(/sem permissão para ler/);
      expect(err.message).toContain("EPERM");
    } finally {
      failure = null;
    }
  });

  test("erro de fs que não é objeto (null): cai em config_read_failed sem explodir", () => {
    const { path } = seed();
    failure = { op: "read", error: null };
    try {
      const err = capture(() => updateConfigPermissionsMode(path, "ask"));
      expect(err.code).toBe("config_read_failed");
      expect(err.message).toContain("não foi possível ler");
    } finally {
      failure = null;
    }
  });
});
