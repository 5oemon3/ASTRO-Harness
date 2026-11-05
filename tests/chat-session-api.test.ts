import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionApi } from "../src/chat/session-api";
import type { SessionRecord } from "../src/chat/store";

describe("session API JSON migration", () => {
  test("migrates valid v1 records once and reports corrupt records without deleting source files", () => {
    const root = mkdtempSync(join(tmpdir(), "astro-session-api-migration-"));
    const astroDir = join(root, ".astro");
    const legacyDir = join(astroDir, "sessions");
    mkdirSync(legacyDir, { recursive: true });
    const messages: SessionRecord["messages"] = [
      { role: "user", content: "implement this" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "read_file", arguments: '{"path":"src/main.ts"}' }],
      },
      { role: "tool", toolCallId: "call-1", content: "file contents" },
      { role: "assistant", content: "done" },
    ];
    const fixture: SessionRecord = {
      schemaVersion: 1,
      id: "session-1",
      startedAt: "2026-11-04T12:00:00.000Z",
      model: "provider/model",
      messages,
      turns: 2,
      tokensIn: 100,
      tokensOut: 25,
      costUsd: 0.001,
      name: "migration fixture",
      resumedFrom: { id: "session-0", startedAt: "2026-11-03T12:00:00.000Z" },
    };
    const validPath = join(legacyDir, "valid.json");
    const invalidPath = join(legacyDir, "invalid.json");
    writeFileSync(validPath, JSON.stringify(fixture), "utf8");
    writeFileSync(invalidPath, "{invalid json", "utf8");

    try {
      const api = new SessionApi(astroDir);
      expect(api.migrationResult).toMatchObject({ migrated: 1, skipped: 1 });
      expect(api.migrationResult.diagnostics).toEqual([
        { file: "invalid.json", reason: "registro inválido ou ilegível" },
      ]);
      expect(api.load("session-1")).toEqual(fixture);
      expect(api.load("session-1").messages).toEqual(messages);
      api.close();

      expect(readdirSync(legacyDir).sort()).toEqual(["invalid.json", "valid.json"]);
      expect(readFileSync(validPath, "utf8")).toBe(JSON.stringify(fixture));

      const lateFixture: SessionRecord = { ...fixture, id: "session-late", name: undefined };
      writeFileSync(join(legacyDir, "late.json"), JSON.stringify(lateFixture), "utf8");
      const reopened = new SessionApi(astroDir);
      expect(reopened.migrationResult).toMatchObject({ migrated: 1, skipped: 2 });
      expect(reopened.list().map((session) => session.id)).toEqual(["session-1", "session-late"]);
      reopened.close();

      const rerun = new SessionApi(astroDir);
      expect(rerun.migrationResult).toMatchObject({ migrated: 0, skipped: 3 });
      expect(rerun.list()).toHaveLength(2);
      rerun.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("session API", () => {
  test("CRUD roundtrip sanitizes content and persists across close", () => {
    const root = mkdtempSync(join(tmpdir(), "astro-session-api-crud-"));
    const astroDir = join(root, ".astro");
    const secret = ["ghp", "_", "session", "secret", "123456"].join("");
    const record: SessionRecord = {
      schemaVersion: 1,
      id: "session-crud",
      startedAt: "2026-11-04T13:00:00.000Z",
      model: "provider/model",
      messages: [
        { role: "user" as const, content: `task ${secret}` },
        {
          role: "assistant" as const,
          content: "",
          toolCalls: [{
            id: "call-1",
            name: "run_command",
            arguments: JSON.stringify({ apiKey: secret, command: "echo safe" }),
          }],
        },
        { role: "tool" as const, toolCallId: "call-1", content: "done" },
      ],
      turns: 1,
      tokensIn: 20,
      tokensOut: 5,
      costUsd: null,
    };

    try {
      const api = new SessionApi(astroDir);
      expect(api.create(record)).toMatchObject({ id: record.id });
      expect(api.load(record.id).messages[0]?.content).not.toContain(secret);
      expect(api.load(record.id).messages[1]?.toolCalls?.[0]?.arguments).not.toContain(secret);
      expect(() => api.create(record)).toThrow();

      const db = new Database(api.databasePath, { readonly: true });
      const stored = db.query("SELECT record_json FROM sessions").get() as { record_json: string };
      const schema = db.query("PRAGMA user_version").get() as { user_version: number };
      expect(stored.record_json).not.toContain(secret);
      expect(schema.user_version).toBe(1);
      if (process.platform !== "win32") {
        expect(statSync(api.databasePath).mode & 0o777).toBe(0o600);
      }
      db.close();

      const updated = { ...api.load(record.id), turns: 2, name: "saved" };
      api.save(updated);
      expect(api.list()).toEqual([{
        id: record.id,
        startedAt: record.startedAt,
        model: record.model,
        turns: 2,
        costUsd: null,
        name: "saved",
      }]);
      api.close();

      const reopened = new SessionApi(astroDir);
      expect(reopened.load(record.id)).toMatchObject({ turns: 2, name: "saved" });
      expect(reopened.delete(record.id)).toBe(true);
      expect(reopened.delete(record.id)).toBe(false);
      expect(() => reopened.load(record.id)).toThrow(/não encontrada/);
      reopened.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed when the database schema version is unsupported", () => {
    const root = mkdtempSync(join(tmpdir(), "astro-session-api-schema-"));
    const astroDir = join(root, ".astro");
    mkdirSync(astroDir, { recursive: true });
    const db = new Database(join(astroDir, "sessions.db"));
    db.exec("PRAGMA user_version = 2");
    db.close();

    try {
      expect(() => new SessionApi(astroDir)).toThrow(/schema do banco de sessões não suportado: 2/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
