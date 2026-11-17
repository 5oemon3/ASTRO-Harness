import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (file: string) => readFileSync(new URL(file, root), "utf8");
const packageName = (JSON.parse(read("package.json")) as { name: string }).name;
const installHint = `npm install -g ${packageName}@alpha`;

describe("release metadata", () => {
  test("package name matches the published npm package", () => {
    expect(packageName).toBe("@umtioai/astro-harness");
  });

  test("launcher install hint uses the package name", () => {
    expect(read("src/launcher.ts")).toContain(installHint);
  });

  test("README install command uses the package name", () => {
    expect(read("README.md")).toContain(installHint);
  });
});
