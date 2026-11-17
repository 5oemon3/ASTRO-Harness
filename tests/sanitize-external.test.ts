import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactSecrets } from "../src/sanitize-external";
import { readFileTool } from "../src/tools/read-file";

// Montados em runtime para não expor literais no diff (gate G6)
const JWT = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "c2lnbmF0dXJlLWRlLXRlc3Rl"].join(".");
const PEM_HEADER = ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ");
const PEM_FOOTER = ["-----END", "RSA PRIVATE KEY-----"].join(" ");
const PEM_BODY = "MIIEowIBAAKCAQEA7teste";
const PEM = [PEM_HEADER, PEM_BODY, PEM_FOOTER].join("\n");
const HEX64 = "a1b2c3d4".repeat(8); // 64 hex chars

test("redactSecrets cobre JWT e bloco PEM de chave privada", () => {
  const redacted = redactSecrets(`token=${JWT}\n${PEM}\n`);
  expect(redacted).not.toContain(JWT);
  expect(redacted).not.toContain(PEM_BODY);
  expect(redacted).toContain("[REDACTED]");
});

test("redactSecrets redige hex longo só com contexto de credencial", () => {
  const hex = "0123456789abcdef0123456789abcdef01234567";
  expect(redactSecrets(`api_key: ${hex}`)).not.toContain(hex);
  // sha de commit em texto corrido não é segredo e continua legível
  expect(redactSecrets(`commit ${hex}`)).toContain(hex);
});

test("redactSecrets redige hex de 64+ sem contexto e preserva SHA-1/MD5 comuns", () => {
  const hex64 = HEX64;
  const hex40 = "0123456789abcdef0123456789abcdef01234567"; // git SHA-1
  const hex32 = "0123456789abcdef0123456789abcdef"; // MD5/checksum: residual
  expect(redactSecrets(`chave ${hex64}`)).not.toContain(hex64);
  expect(redactSecrets(`chave ${hex64}`)).toContain("[REDACTED]");
  // rótulo de digest em texto externo não vira passe livre: 64+ hex redige sempre
  expect(redactSecrets(`sha256: ${hex64}`)).not.toContain(hex64);
  // 40 hex só com rótulo de credencial; saída normal de git continua legível
  expect(redactSecrets(`KEY=${hex40}`)).not.toContain(hex40);
  expect(redactSecrets(`token: ${hex40}`)).not.toContain(hex40);
  expect(redactSecrets(`MY_API_KEY=${hex40}`)).not.toContain(hex40);
  expect(redactSecrets(`x-api-key: ${hex40}`)).not.toContain(hex40);
  expect(redactSecrets(`commit ${hex40}`)).toContain(hex40);
  expect(redactSecrets(`checksum ${hex32}`)).toContain(hex32);
});

test("redactSecrets redige 40 hex em Authorization/AUTHORIZATION/oauth", () => {
  const hex40 = "0123456789abcdef0123456789abcdef01234567";
  expect(redactSecrets(`Authorization: ${hex40}`)).not.toContain(hex40);
  expect(redactSecrets(`AUTHORIZATION=${hex40}`)).not.toContain(hex40);
  expect(redactSecrets(`oauth: ${hex40}`)).not.toContain(hex40);
  // author/monkey não são credencial (boundary, não substring)
  expect(redactSecrets(`author: ${hex40}`)).toContain(hex40);
  expect(redactSecrets(`monkey: ${hex40}`)).toContain(hex40);
});

test("redactSecrets redige hex 64+ colado a prefixo word-char (0x, api_key_)", () => {
  // `0x` e `_` são word chars: \b não separa do hex e deixava o valor passar
  expect(redactSecrets(`PRIVATE_KEY=0x${HEX64}`)).not.toContain(HEX64);
  expect(redactSecrets(`api_key_${HEX64}`)).not.toContain(HEX64);
  expect(redactSecrets(`api_key_${HEX64}`)).toContain("[REDACTED]");
});

test("redactSecrets não trata author/monkey como rótulo de credencial", () => {
  const hex40 = "0123456789abcdef0123456789abcdef01234567";
  expect(redactSecrets(`author: ${hex40}`)).toContain(hex40);
  expect(redactSecrets(`monkey: ${hex40}`)).toContain(hex40);
});

test("read_file sanitiza conteúdo externo antes de devolver à sessão", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-sanitize-"));
  writeFileSync(join(dir, "env.txt"), `TOKEN ${JWT}\n${PEM}\n`, "utf8");
  const result = await readFileTool.execute({ path: "env.txt" }, { cwd: dir, run: "r1", agent: "a" });

  expect(result.isError).toBeUndefined();
  expect(result.output).not.toContain(JWT);
  expect(result.output).not.toContain(PEM_BODY);
});

test("read_file redige hex 64+ colado a prefixo (0x, api_key_)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-sanitize-hex-"));
  writeFileSync(join(dir, "hex.txt"), `PRIVATE_KEY=0x${HEX64}\napi_key_${HEX64}\n`, "utf8");
  const result = await readFileTool.execute({ path: "hex.txt" }, { cwd: dir, run: "r1", agent: "a" });

  expect(result.isError).toBeUndefined();
  expect(result.output).not.toContain(HEX64);
  expect(result.output).toContain("[REDACTED]");
});

test("read_file redige 40 hex em Authorization/AUTHORIZATION", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-sanitize-auth-"));
  const hex40 = "0123456789abcdef0123456789abcdef01234567";
  writeFileSync(join(dir, "auth.txt"), `Authorization: ${hex40}\nAUTHORIZATION=${hex40}\n`, "utf8");
  const result = await readFileTool.execute({ path: "auth.txt" }, { cwd: dir, run: "r1", agent: "a" });

  expect(result.isError).toBeUndefined();
  expect(result.output).not.toContain(hex40);
  expect(result.output).toContain("[REDACTED]");
});
