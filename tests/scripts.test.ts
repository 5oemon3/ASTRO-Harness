import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

test("package.json expõe os quatro comandos principais", () => {
  for (const name of ["dev", "test", "smoke", "doctor"]) expect(pkg.scripts[name]).toBeString();
  expect(pkg.scripts.test).toBe("bun test");
});

test("dev abre a TUI a partir da fonte, sem build", () => {
  expect(pkg.scripts.dev).toBe("bun src/cli.ts tui");
  expect(existsSync(join(root, "src", "cli.ts"))).toBe(true);
});

test("smoke e doctor apontam para scripts existentes", () => {
  expect(pkg.scripts.smoke).toContain("scripts/smoke.ts");
  expect(pkg.scripts.doctor).toBe("bun scripts/doctor.ts");
  expect(existsSync(join(root, "scripts", "smoke.ts"))).toBe(true);
  expect(existsSync(join(root, "scripts", "doctor.ts"))).toBe(true);
});

test("comandos secundários continuam disponíveis", () => {
  for (const name of ["build", "typecheck", "cli", "tui", "dev:launcher", "eval", "bench:providers"]) {
    expect(pkg.scripts[name]).toBeString();
  }
});
