import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sentinelas construídos em runtime para não disparar o gate de segredos.
const SENTINEL = ["sentinel", "-", "xyz"].join("");

test("providers vault-import é dry-run por default e não vaza o segredo (#311)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-vault-import-cli-"));
  const configPath = join(dir, "astro.config.json");
  writeFileSync(configPath, JSON.stringify({
    providers: { p: { kind: "openai-compat", baseUrl: "https://p.example/v1", credentialRef: "KEY" } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "p/m1", maxSteps: 2, tools: [] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  const entry = join(import.meta.dir, "..", "src", "cli.ts");
  const proc = Bun.spawn([process.execPath, entry, "providers", "vault-import", "p", "--config", configPath], {
    env: { ...process.env, ASTRO_HOME: dir, KEY: SENTINEL },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(0);
  expect(out).toContain("plano:");
  expect(out).toContain("--apply");
  expect(out).not.toContain(SENTINEL);
  expect(err).not.toContain(SENTINEL);
  // dry-run não altera a config
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as { providers: { p: { credentialRef: string } } };
  expect(raw.providers.p.credentialRef).toBe("KEY");
});

test("--apply fora de vault-import é recusado (#311)", async () => {
  const entry = join(import.meta.dir, "..", "src", "cli.ts");
  const proc = Bun.spawn([process.execPath, entry, "providers", "list", "--apply"], { stdout: "pipe", stderr: "pipe" });
  const err = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(1);
  expect(err).toContain("só valem para providers vault-import");
});
