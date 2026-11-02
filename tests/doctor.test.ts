import { expect, test } from "bun:test";
import { exitCode, renderReport, runChecks, satisfiesMinimum, type DoctorFacts } from "../scripts/doctor";

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
