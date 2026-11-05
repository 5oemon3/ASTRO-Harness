import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionApi } from "../src/chat/session-api";
import { SessionStore, type SessionRecord } from "../src/chat/store";

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    schemaVersion: 1, id: "session", startedAt: "2026-11-04T12:00:00.000Z",
    model: "provider/model", messages: [{ role: "user", content: "hello" }],
    turns: 1, tokensIn: 10, tokensOut: 5, costUsd: null, ...overrides,
  };
}

describe("session API JSON migration", () => {
  test("re-runs migration and reports corrupt records without deleting source files", () => {
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
    const fixture = makeRecord({
      id: "session-1",
      messages,
      turns: 2,
      tokensIn: 100,
      tokensOut: 25,
      costUsd: 0.001,
      name: "migration fixture",
      resumedFrom: { id: "session-0", startedAt: "2026-11-03T12:00:00.000Z" },
    });
    const validPath = join(legacyDir, "valid.json");
    const invalidPath = join(legacyDir, "invalid.json");
    writeFileSync(validPath, JSON.stringify(fixture), "utf8");
    writeFileSync(invalidPath, "{invalid json", "utf8");
    let api: SessionApi | undefined;
    let reopened: SessionApi | undefined;
    let rerun: SessionApi | undefined;

    try {
      api = new SessionApi(astroDir);
      expect(api.migrationResult).toMatchObject({ migrated: 1, skipped: 1, existing: 0 });
      expect(api.migrationResult.diagnostics).toEqual([
        { file: "invalid.json", reason: "registro inválido ou ilegível" },
      ]);
      expect(api.load("session-1")).toEqual(fixture);
      expect(api.load("session-1").messages).toEqual(messages);

      expect(readdirSync(legacyDir).sort()).toEqual(["invalid.json", "valid.json"]);
      expect(readFileSync(validPath, "utf8")).toBe(JSON.stringify(fixture));

      const lateFixture: SessionRecord = { ...fixture, id: "session-late", name: undefined };
      writeFileSync(join(legacyDir, "late.json"), JSON.stringify(lateFixture), "utf8");
      expect(api.list().map((session) => session.id)).toEqual(["session-1", "session-late"]);
      const currentApi = api;
      currentApi.close();
      api = undefined;

      reopened = new SessionApi(astroDir);
      expect(reopened.migrationResult).toMatchObject({ migrated: 0, skipped: 1, existing: 2 });
      expect(reopened.list()).toHaveLength(2);
      reopened.close();
      reopened = undefined;

      rerun = new SessionApi(astroDir);
      expect(rerun.migrationResult).toMatchObject({ migrated: 0, skipped: 1, existing: 2 });
      expect(rerun.list()).toHaveLength(2);
      rerun.close();
      rerun = undefined;
    } finally {
      api?.close();
      reopened?.close();
      rerun?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reconciles continued JSON sessions before listing and loading", () => {
    const root = mkdtempSync(join(tmpdir(), "astro-session-api-continuation-"));
    const astroDir = join(root, ".astro");
    const legacy = new SessionStore(join(astroDir, "sessions"));
    const initial = makeRecord({ id: "continued", turns: 1 });
    legacy.write(initial);
    let api: SessionApi | undefined;

    try {
      api = new SessionApi(astroDir);
      legacy.write({
        ...initial,
        turns: 2,
        messages: [...initial.messages, { role: "assistant", content: "second turn" }],
      });

      expect(api.list()[0]).toMatchObject({ id: "continued", turns: 2 });
      expect(api.load("continued")).toMatchObject({
        turns: 2,
        messages: [...initial.messages, { role: "assistant", content: "second turn" }],
      });
      api.close();
      api = new SessionApi(astroDir);
      expect(api.load("continued")).toMatchObject({
        turns: 2,
        messages: [...initial.messages, { role: "assistant", content: "second turn" }],
      });
    } finally {
      api?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("duplicate JSON ids resolve consistently to the latest session identity", () => {
    const root = mkdtempSync(join(tmpdir(), "astro-session-api-duplicate-id-"));
    const astroDir = join(root, ".astro");
    const legacy = new SessionStore(join(astroDir, "sessions"));
    const storeRecord = (record: SessionRecord) => {
      legacy.write(record);
    };
    storeRecord(makeRecord({ id: "duplicate", startedAt: "2026-10-01T10:00:00.000Z", turns: 1 }));
    storeRecord(makeRecord({
      id: "duplicate", startedAt: "2026-10-02T10:00:00.000Z", turns: 2,
      messages: [{ role: "user", content: "latest" }],
    }));
    let api: SessionApi | undefined;

    try {
      api = new SessionApi(astroDir);
      expect(api.list()).toHaveLength(1);
      expect(api.load("duplicate")).toMatchObject({ startedAt: "2026-10-02T10:00:00.000Z", turns: 2 });
      expect(api.migrationResult).toMatchObject({ migrated: 1, skipped: 1, existing: 0 });
    } finally {
      api?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("session API", () => {
  test("fails closed on the previous SQLite v1 layout", () => {
    const root = mkdtempSync(join(tmpdir(), "astro-session-api-v1-db-"));
    const astroDir = join(root, ".astro");
    mkdirSync(astroDir, { recursive: true });
    const db = new Database(join(astroDir, "sessions.db"));
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at TEXT, record_json TEXT); CREATE TABLE migrations (name TEXT PRIMARY KEY); PRAGMA user_version = 1");
    db.close();

    try {
      expect(() => new SessionApi(astroDir)).toThrow(/schema do banco de sessões não suportado: 1/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("CRUD roundtrip sanitizes content and persists across close", () => {
    const root = mkdtempSync(join(tmpdir(), "astro-session-api-crud-"));
    const astroDir = join(root, ".astro");
    const secret = ["ghp", "_", "session", "secret", "123456"].join("");
    const record = makeRecord({
      id: "session-crud",
      startedAt: "2026-11-04T13:00:00.000Z",
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
    });
    let api: SessionApi | undefined;
    let reopened: SessionApi | undefined;
    let db: Database | undefined;

    try {
      const apiInstance = new SessionApi(astroDir);
      api = apiInstance;
      expect(apiInstance.create(record)).toMatchObject({ id: record.id });
      expect(apiInstance.load(record.id).messages[0]?.content).not.toContain(secret);
      expect(apiInstance.load(record.id).messages[1]?.toolCalls?.[0]?.arguments).not.toContain(secret);
      expect(() => apiInstance.create(record)).toThrow();

      db = new Database(apiInstance.databasePath, { readonly: true });
      const stored = db.query("SELECT record_json FROM sessions").get() as { record_json: string };
      const schema = db.query("PRAGMA user_version").get() as { user_version: number };
      expect(stored.record_json).not.toContain(secret);
      expect(schema.user_version).toBe(2);
      if (process.platform !== "win32") {
        expect(statSync(apiInstance.databasePath).mode & 0o777).toBe(0o600);
      }
      db.close();
      db = undefined;

      const updated = { ...apiInstance.load(record.id), turns: 2, name: "saved" };
      apiInstance.save(updated);
      expect(apiInstance.list()).toEqual([{
        id: record.id,
        startedAt: record.startedAt,
        model: record.model,
        turns: 2,
        costUsd: null,
        name: "saved",
      }]);
      apiInstance.close();
      api = undefined;

      const reopenedApi = new SessionApi(astroDir);
      reopened = reopenedApi;
      expect(reopenedApi.load(record.id)).toMatchObject({ turns: 2, name: "saved" });
      expect(reopenedApi.delete(record.id)).toBe(true);
      expect(reopenedApi.delete(record.id)).toBe(false);
      expect(() => reopenedApi.load(record.id)).toThrow(/não encontrada/);
      reopenedApi.close();
      reopened = undefined;
    } finally {
      db?.close();
      api?.close();
      reopened?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
