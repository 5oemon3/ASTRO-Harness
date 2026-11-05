import { describe, expect, spyOn, test } from "bun:test";
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
      legacy.write(makeRecord({
        id: "duplicate",
        startedAt: "2026-10-02T10:00:00.000Z",
        turns: 3,
        messages: [{ role: "user", content: "updated latest" }],
      }));
      expect(api.list()).toHaveLength(1);
      expect(api.load("duplicate")).toMatchObject({ startedAt: "2026-10-02T10:00:00.000Z", turns: 3 });
    } finally {
      api?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves SQLite saves when an unrelated JSON session changes", () => {
    const root = mkdtempSync(join(tmpdir(), "astro-session-api-save-reconcile-"));
    const astroDir = join(root, ".astro");
    const legacy = new SessionStore(join(astroDir, "sessions"));
    legacy.write(makeRecord({ id: "saved-session", turns: 1 }));
    let api: SessionApi | undefined;
    let reopened: SessionApi | undefined;

    try {
      const apiInstance = new SessionApi(astroDir);
      api = apiInstance;
      apiInstance.save({ ...makeRecord({ id: "saved-session", turns: 5, name: "saved in SQLite" }) });
      legacy.write(makeRecord({ id: "new-json-session", turns: 2 }));

      expect(apiInstance.list().map(({ id, turns, name }) => ({ id, turns, name }))).toEqual([
        { id: "new-json-session", turns: 2, name: undefined },
        { id: "saved-session", turns: 5, name: "saved in SQLite" },
      ]);
      legacy.write(makeRecord({ id: "saved-session", turns: 7, name: "stale JSON" }));
      expect(apiInstance.list().find(({ id }) => id === "saved-session")).toMatchObject({
        turns: 5,
        name: "saved in SQLite",
      });
      expect(apiInstance.load("saved-session")).toMatchObject({ turns: 5, name: "saved in SQLite" });
      apiInstance.close();
      api = undefined;

      const reopenedApi = new SessionApi(astroDir);
      reopened = reopenedApi;
      expect(reopenedApi.load("saved-session")).toMatchObject({ turns: 5, name: "saved in SQLite" });
      expect(reopenedApi.list().map(({ id }) => id)).toContain("new-json-session");
    } finally {
      api?.close();
      reopened?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reconciles JSON autosaves after renaming a session", () => {
    const root = mkdtempSync(join(tmpdir(), "astro-session-api-rename-autosave-"));
    const astroDir = join(root, ".astro");
    const legacy = new SessionStore(join(astroDir, "sessions"));
    const initial = makeRecord({ id: "renamed-session", turns: 1 });
    legacy.write(initial);
    let api: SessionApi | undefined;
    let reopened: SessionApi | undefined;

    try {
      api = new SessionApi(astroDir);
      legacy.rename(initial.id, "renamed session");
      api.rename(initial.id, "renamed session");

      const afterSecondTurn = {
        ...initial,
        turns: 2,
        messages: [...initial.messages, { role: "assistant" as const, content: "second turn" }],
      };
      legacy.write(afterSecondTurn);
      legacy.write({
        ...afterSecondTurn,
        turns: 3,
        messages: [...afterSecondTurn.messages, { role: "user", content: "third turn" }],
      });

      api.close();
      api = undefined;
      reopened = new SessionApi(astroDir);

      expect(reopened.load(initial.id)).toMatchObject({
        turns: 3,
        name: "renamed session",
      });
    } finally {
      api?.close();
      reopened?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps a direct JSON-backed API rename authoritative", () => {
    const root = mkdtempSync(join(tmpdir(), "astro-session-api-direct-rename-"));
    const astroDir = join(root, ".astro");
    const legacy = new SessionStore(join(astroDir, "sessions"));
    legacy.write(makeRecord({ id: "direct-rename" }));
    let api: SessionApi | undefined;
    let reopened: SessionApi | undefined;

    try {
      api = new SessionApi(astroDir);
      api.rename("direct-rename", "renamed in SQLite");
      api.close();
      api = undefined;

      reopened = new SessionApi(astroDir);
      expect(reopened.load("direct-rename").name).toBe("renamed in SQLite");
    } finally {
      api?.close();
      reopened?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("renames a SQLite-only session and keeps the new name authoritative", () => {
    const root = mkdtempSync(join(tmpdir(), "astro-session-api-rename-"));
    let api: SessionApi | undefined;
    try {
      const apiInstance = new SessionApi(join(root, ".astro"));
      api = apiInstance;
      apiInstance.create(makeRecord({ id: "sqlite-only" }));

      expect(apiInstance.rename("sqlite-only", "renamed in SQLite")).toMatchObject({
        id: "sqlite-only",
        name: "renamed in SQLite",
      });
      expect(apiInstance.list()[0]?.name).toBe("renamed in SQLite");
      expect(apiInstance.load("sqlite-only").name).toBe("renamed in SQLite");
      expect(() => apiInstance.rename("sqlite-only", "   ")).toThrow(/nome da sessão inválido/);
    } finally {
      api?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not resurrect SQLite-deleted sessions after another JSON write", () => {
    const root = mkdtempSync(join(tmpdir(), "astro-session-api-delete-reconcile-"));
    const astroDir = join(root, ".astro");
    const legacy = new SessionStore(join(astroDir, "sessions"));
    legacy.write(makeRecord({ id: "deleted-session", turns: 1 }));
    let api: SessionApi | undefined;
    let reopened: SessionApi | undefined;

    try {
      const apiInstance = new SessionApi(astroDir);
      api = apiInstance;
      expect(apiInstance.delete("deleted-session")).toBe(true);
      expect(legacy.list().map(({ id }) => id)).toEqual([]);
      legacy.write(makeRecord({ id: "new-json-session", turns: 2 }));

      expect(apiInstance.list().map(({ id }) => id)).toEqual(["new-json-session"]);
      expect(() => apiInstance.load("deleted-session")).toThrow(/não encontrada/);
      apiInstance.close();
      api = undefined;

      const reopenedApi = new SessionApi(astroDir);
      reopened = reopenedApi;
      expect(reopenedApi.list().map(({ id }) => id)).toEqual(["new-json-session"]);
      expect(() => reopenedApi.load("deleted-session")).toThrow(/não encontrada/);
    } finally {
      api?.close();
      reopened?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reconciles one changed file without rereading the entire JSON directory", () => {
    const root = mkdtempSync(join(tmpdir(), "astro-session-api-incremental-import-"));
    const astroDir = join(root, ".astro");
    const legacy = new SessionStore(join(astroDir, "sessions"));
    const content = "x".repeat(100_000);
    for (let index = 0; index < 60; index++) {
      legacy.write(makeRecord({
        id: `session-${index}`,
        startedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
        messages: [{ role: "user", content }],
      }));
    }

    let api: SessionApi | undefined;
    try {
      api = new SessionApi(astroDir);
      legacy.write(makeRecord({
        id: "session-30",
        startedAt: new Date(Date.UTC(2026, 0, 31)).toISOString(),
        turns: 2,
        messages: [{ role: "user", content: `${content}updated` }],
      }));

      const readByPath = spyOn(SessionStore.prototype, "readByPath");
      try {
        expect(api.list().find(({ id }) => id === "session-30")?.turns).toBe(2);
        expect(readByPath).toHaveBeenCalledTimes(1);
      } finally {
        readByPath.mockRestore();
      }
    } finally {
      api?.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, { timeout: 30_000 });

  test("reads a JSON session by its validated path without listing siblings", () => {
    const root = mkdtempSync(join(tmpdir(), "astro-session-store-path-read-"));
    const store = new SessionStore(join(root, "sessions"));
    const firstPath = store.write(makeRecord({ id: "first" }));
    store.write(makeRecord({ id: "second" }));

    try {
      store.list = () => { throw new Error("list must not be used by direct reads"); };
      expect(store.readByPath(firstPath)).toMatchObject({ id: "first" });
    } finally {
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

  test("upgrades the SQLite v2 schema with durable import ownership markers", () => {
    const root = mkdtempSync(join(tmpdir(), "astro-session-api-v2-upgrade-"));
    const astroDir = join(root, ".astro");
    mkdirSync(astroDir, { recursive: true });
    const db = new Database(join(astroDir, "sessions.db"));
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY NOT NULL,
        started_at TEXT NOT NULL,
        model TEXT NOT NULL,
        turns INTEGER NOT NULL,
        cost_usd REAL,
        name TEXT,
        record_json TEXT NOT NULL
      );
      CREATE INDEX sessions_started_at ON sessions (started_at DESC, id ASC);
      PRAGMA user_version = 2;
    `);
    db.close();
    const legacy = new SessionStore(join(astroDir, "sessions"));
    legacy.write(makeRecord({ id: "legacy-after-upgrade" }));
    let api: SessionApi | undefined;

    try {
      api = new SessionApi(astroDir);
      const upgraded = new Database(api.databasePath, { readonly: true });
      try {
        expect((upgraded.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(3);
        expect(upgraded.query("SELECT name FROM sqlite_master WHERE name = 'session_overrides'").get()).toBeDefined();
        expect(upgraded.query("SELECT name FROM sqlite_master WHERE name = 'session_tombstones'").get()).toBeDefined();
        expect(api.load("legacy-after-upgrade").id).toBe("legacy-after-upgrade");
      } finally {
        upgraded.close();
      }
    } finally {
      api?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("configures a busy timeout for concurrent SQLite connections", () => {
    const root = mkdtempSync(join(tmpdir(), "astro-session-api-busy-timeout-"));
    let api: SessionApi | undefined;
    let lock: Database | undefined;
    try {
      const apiInstance = new SessionApi(join(root, ".astro"));
      api = apiInstance;
      lock = new Database(apiInstance.databasePath);
      lock.exec("BEGIN EXCLUSIVE");
      const started = performance.now();
      expect(() => apiInstance.list()).toThrow(/locked/);
      expect(performance.now() - started).toBeGreaterThanOrEqual(900);
    } finally {
      if (lock !== undefined) {
        lock.exec("ROLLBACK");
        lock.close();
      }
      api?.close();
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
      expect(schema.user_version).toBe(3);
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
