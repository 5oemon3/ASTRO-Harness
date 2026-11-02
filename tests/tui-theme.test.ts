import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { THEMES, getThemeColors, isTheme, loadTuiConfig, nextTheme, saveTuiConfig } from "../src/tui/theme";

const tempCwd = (): string => mkdtempSync(join(tmpdir(), "astro-tui-theme-"));

describe("configuração da TUI (T2, #197)", () => {
  test("sem arquivo ou JSON inválido cai no tema dark", () => {
    expect(loadTuiConfig(tempCwd())).toEqual({ theme: "dark" });
    const broken = tempCwd();
    mkdirSync(join(broken, ".astro"));
    writeFileSync(join(broken, ".astro", "tui.json"), "{", "utf8");
    expect(loadTuiConfig(broken)).toEqual({ theme: "dark" });
  });

  test("salva tema e último modelo preservando um ao outro", () => {
    const cwd = tempCwd();
    saveTuiConfig(cwd, { theme: "light" });
    saveTuiConfig(cwd, { lastModel: "p/m2" });
    expect(loadTuiConfig(cwd)).toEqual({ theme: "light", lastModel: "p/m2" });
    expect(nextTheme("light")).toBe("contrast"); // ciclo dark -> light -> contrast (#64)
    expect(getThemeColors("dark").accent).toBe("cyan");
  });

  test("favoritos e recentes persistem e ignoram entradas inválidas", () => {
    const cwd = tempCwd();
    saveTuiConfig(cwd, { favoriteModels: ["p/a", "p/a", ""], recentModels: ["p/c", "p/c"] });
    expect(loadTuiConfig(cwd)).toEqual({ theme: "dark", favoriteModels: ["p/a"], recentModels: ["p/c"] });
    const broken = tempCwd();
    mkdirSync(join(broken, ".astro"));
    writeFileSync(join(broken, ".astro", "tui.json"), JSON.stringify({ theme: "light", favoriteModels: ["p/a", 1, ""] }), "utf8");
    expect(loadTuiConfig(broken)).toEqual({ theme: "light", favoriteModels: ["p/a"] });
  });

  test("recusa .astro que escapa do cwd (I-11)", () => {
    const cwd = tempCwd();
    symlinkSync(tempCwd(), join(cwd, ".astro"), process.platform === "win32" ? "junction" : "dir");
    expect(() => saveTuiConfig(cwd, { theme: "light" })).toThrow();
    expect(loadTuiConfig(cwd)).toEqual({ theme: "dark" });
  });
});

describe("/theme e alto contraste (#64)", () => {
  test("THEMES, isTheme e nextTheme cobrem os três temas em ciclo", () => {
    expect(THEMES).toEqual(["dark", "light", "contrast"]);
    expect(isTheme("contrast")).toBe(true);
    expect(isTheme("light")).toBe(true);
    expect(isTheme("neon")).toBe(false);
    expect(nextTheme("dark")).toBe("light");
    expect(nextTheme("light")).toBe("contrast");
    expect(nextTheme("contrast")).toBe("dark");
  });

  test("contrast persiste em .astro/tui.json; tema inválido no arquivo cai em dark", () => {
    const cwd = tempCwd();
    saveTuiConfig(cwd, { theme: "contrast" });
    expect(loadTuiConfig(cwd)).toEqual({ theme: "contrast" });
    const bad = tempCwd();
    mkdirSync(join(bad, ".astro"));
    writeFileSync(join(bad, ".astro", "tui.json"), JSON.stringify({ theme: "neon" }), "utf8");
    expect(loadTuiConfig(bad)).toEqual({ theme: "dark" });
  });

  test("o tema de alto contraste usa cores brilhantes", () => {
    expect(getThemeColors("contrast")).toEqual({ accent: "whiteBright", warning: "yellowBright", error: "redBright" });
    expect(getThemeColors("dark").accent).toBe("cyan");
  });
});
