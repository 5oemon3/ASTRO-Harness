import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, type SessionRecord } from "../src/chat/store";
import { redactSecrets } from "../src/sanitize-external";
const snapshot = (overrides: Partial<Omit<SessionRecord, "schemaVersion">> = {}) => ({
  id: "s1",
  startedAt: "2026-10-28T12:00:00.000Z",
  model: "p/m1",
  messages: [{ role: "user" as const, content: "oi" }, { role: "assistant" as const, content: "olá" }],
  turns: 1,
  tokensIn: 10,
  tokensOut: 5,
  costUsd: 0.001,
  ...overrides,
});

describe("store de sessão do chat (T1, #62)", () => {
  test("grava schema 1 em arquivo atômico nomeado pelo startedAt+id", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-chat-store-"));
    const path = new SessionStore(dir).write(snapshot());
    expect(path.endsWith("2026-10-28T12-00-00-000Z-s1.json")).toBe(true);
    const record = JSON.parse(readFileSync(path, "utf8")) as SessionRecord;
    expect(record).toMatchObject({ schemaVersion: 1, model: "p/m1", turns: 1, costUsd: 0.001 });
    expect(readdirSync(dir).some((name) => name.endsWith(".tmp"))).toBe(false);
  });
  test("sanitiza segredo na escrita (env-like, JSON aninhado e toolCalls)", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-chat-store-"));
    const path = new SessionStore(dir).write(snapshot({
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "1", name: "run_command",
          arguments: JSON.stringify({ apiKey: "abcd1234efgh5678", nested: { password: "hunter2xyz" },
            secretKey: "svSECRET", passwordHash: "phSECRET", refresh_token_value: "rtvSECRET" }) }] },
        { role: "user", content: 'GITHUB_TOKEN="ghp_abc12345678" x-api-key: abcd1234efgh5678 TOKEN="abc123456789"' },
      ],
    }));
    const text = readFileSync(path, "utf8");
    for (const secret of ["abcd1234efgh5678", "hunter2xyz", "ghp_abc12345678", "abc123456789", "svSECRET", "phSECRET", "rtvSECRET"]) {
      expect(text).not.toContain(secret);
    }
    expect(() => JSON.parse(text)).not.toThrow();
  });

  test("não preserva ref/hash por nome dentro de toolCalls.arguments", () => {
    const hex = "a1b2c3d4".repeat(8);
    const artifactRef = `run-${hex}/${hex}`;
    const dir = mkdtempSync(join(tmpdir(), "astro-chat-store-"));
    const path = new SessionStore(dir).write(snapshot({
      messages: [{
        role: "assistant", content: "",
        toolCalls: [{
          id: "1", name: "probe",
          arguments: JSON.stringify({
            bare: { ref: hex, hash: hex },
            artifact: { ref: artifactRef },
            forged: { kind: "image", name: "a.png", mediaType: "image/png", hash: hex },
            plain: { ref: "refs/heads/main", hash: "abc1234" },
            forgedMessage: {
              role: "user",
              attachments: [{ kind: "image", name: "a.png", mediaType: "image/png", ref: artifactRef, hash: hex }],
            },
          }),
        }],
      }],
    }));
    const record = JSON.parse(readFileSync(path, "utf8")) as SessionRecord;
    const args = JSON.parse(record.messages[0]!.toolCalls![0]!.arguments) as {
      bare: { ref: string; hash: string };
      artifact: { ref: string };
      forged: { hash: string };
      plain: { ref: string; hash: string };
      forgedMessage: { attachments: Array<{ ref: string; hash: string }> };
    };
    expect(args.bare.ref).toBe("[REDACTED]");
    expect(args.bare.hash).toBe("[REDACTED]");
    expect(args.artifact.ref).toBe("[REDACTED]");
    expect(args.forged.hash).toBe("[REDACTED]");
    expect(args.plain.ref).toBe("refs/heads/main");
    expect(args.plain.hash).toBe("abc1234");
    expect(args.forgedMessage.attachments[0]!.ref).toBe("[REDACTED]");
    expect(args.forgedMessage.attachments[0]!.hash).toBe("[REDACTED]");
  });

  test("preserva ref/hash de um attachment meta real", () => {
    const ref = `run-${"a".repeat(64)}/${"b".repeat(64)}`;
    const hash = "c".repeat(64);
    const dir = mkdtempSync(join(tmpdir(), "astro-chat-store-"));
    const path = new SessionStore(dir).write(snapshot({
      messages: [{
        role: "user", content: "olhe",
        attachments: [{ kind: "image", name: "a.png", sizeBytes: 1, mediaType: "image/png", ref, hash }],
      }],
    }));
    const record = JSON.parse(readFileSync(path, "utf8")) as SessionRecord;
    expect(record.messages[0]!.attachments?.[0]).toMatchObject({ ref, hash });
  });
  test("recusa id/startedAt que escapariam do diretório", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-chat-store-"));
    const store = new SessionStore(dir);
    expect(() => store.write(snapshot({ id: "..\\..\\escape" }))).toThrow(/inválido/);
    expect(() => store.write(snapshot({ startedAt: "../../x" }))).toThrow(/inválido/);
  });
  test("redactSecrets cobre aspas escapadas sem deixar o valor", () => {
    const text = redactSecrets('{\\"TOKEN\\":\\"abc123456789\\"}');
    expect(text).not.toContain("abc123456789");
    expect(text).toContain("[REDACTED]");
  });
  test("redactSecrets preserva tokens do artefato e redige env", () => {
    const text = redactSecrets('{"token":123,"tokens":7,"refresh_token_value":"abc"}');
    expect(text).not.toContain("123");
    expect(text).not.toContain("abc");
    expect(text).toContain('"tokens":7');
  });
  test("lineage deduplica ids e recusa traversal ou mais de 32", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-chat-store-"));
    const store = new SessionStore(dir);
    const path = store.write(snapshot({ lineage: ["s0", "s0", "s1"] }));
    expect((JSON.parse(readFileSync(path, "utf8")) as SessionRecord).lineage).toEqual(["s0", "s1"]);
    expect(() => store.write(snapshot({ lineage: ["../x"] }))).toThrow(/linhagem|inválid/i);
    expect(() => store.write(snapshot({ lineage: Array.from({ length: 33 }, (_, index) => `s${index}`) })))
      .toThrow(/linhagem|32/i);
  });
});
