import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { MAX_SESSION_BYTES, SessionStore, sanitizeSessionRecord, type SessionRecord } from "./store";

const DATABASE_SCHEMA_VERSION = 3;

interface SessionRow {
  record_json: string;
}

interface SessionSummaryRow {
  id: string;
  started_at: string;
  model: string;
  turns: number;
  cost_usd: number | null;
  name: string | null;
}

interface JsonSessionCacheEntry {
  signature: string;
  record?: SessionRecord;
}

export interface SessionSummary {
  id: string;
  startedAt: string;
  model: string;
  turns: number;
  costUsd: number | null;
  name?: string;
}

export interface SessionMigrationDiagnostic {
  file: string;
  reason: string;
}

export interface SessionMigrationResult {
  migrated: number;
  skipped: number;
  existing: number;
  diagnostics: SessionMigrationDiagnostic[];
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** CRUD e migração do store de sessões sanitizado para `.astro/sessions.db`. */
export class SessionApi {
  readonly databasePath: string;
  readonly migrationResult: SessionMigrationResult;
  readonly #db: Database;
  #jsonFiles = new Map<string, JsonSessionCacheEntry>();

  constructor(readonly astroDir: string = join(process.cwd(), ".astro")) {
    mkdirSync(astroDir, { recursive: true });
    this.databasePath = join(astroDir, "sessions.db");
    this.#db = new Database(this.databasePath, { create: true });
    try {
      this.#db.exec("PRAGMA busy_timeout = 1000");
      if (process.platform !== "win32") chmodSync(this.databasePath, 0o600);
      this.#initialize();
      this.migrationResult = this.#migrateJsonSessions();
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  /** Cria uma sessão; falha se já houver uma sessão com o mesmo id. */
  create(value: SessionRecord): SessionRecord {
    const record = this.#prepare(value);
    const transaction = this.#db.transaction(() => {
      this.#db.run(
        `INSERT INTO sessions (id, started_at, model, turns, cost_usd, name, record_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [record.id, record.startedAt, record.model, record.turns, record.costUsd, record.name ?? null, JSON.stringify(record)],
      );
      this.#markSqliteAuthoritative(record.id);
    });
    transaction();
    return record;
  }

  /** Lista metadados de sessão por início decrescente, sem carregar mensagens. */
  list(): SessionSummary[] {
    this.#migrateJsonSessions();
    const rows = this.#db.query(
      `SELECT id, started_at, model, turns, cost_usd, name
       FROM sessions ORDER BY started_at DESC, id ASC`,
    ).all() as SessionSummaryRow[];
    return rows.map((row) => ({
      id: row.id,
      startedAt: row.started_at,
      model: row.model,
      turns: row.turns,
      costUsd: row.cost_usd,
      ...(row.name === null ? {} : { name: row.name }),
    }));
  }

  /** Carrega uma sessão pelo id. */
  load(id: string): SessionRecord {
    this.#migrateJsonSessions();
    const row = this.#db.query(
      "SELECT record_json FROM sessions WHERE id = ?",
    ).get(id) as SessionRow | null;
    if (row === null) throw new Error(`sessão "${id}" não encontrada`);
    return this.#decode(row.record_json);
  }

  /** Cria ou substitui uma sessão com a mesma sanitização de escrita do JSON v1. */
  save(value: SessionRecord): SessionRecord {
    const record = this.#prepare(value);
    const transaction = this.#db.transaction(() => {
      this.#db.run(
        `INSERT INTO sessions (id, started_at, model, turns, cost_usd, name, record_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           started_at = excluded.started_at,
           model = excluded.model,
           turns = excluded.turns,
           cost_usd = excluded.cost_usd,
           name = excluded.name,
           record_json = excluded.record_json`,
        [record.id, record.startedAt, record.model, record.turns, record.costUsd, record.name ?? null, JSON.stringify(record)],
      );
      this.#markSqliteAuthoritative(record.id);
    });
    transaction();
    return record;
  }

  /** Remove uma sessão; retorna false quando o id não existe. */
  delete(id: string): boolean {
    this.#migrateJsonSessions();
    const transaction = this.#db.transaction(() => {
      const deleted = this.#db.run("DELETE FROM sessions WHERE id = ?", [id]).changes > 0;
      if (!deleted) return false;
      this.#db.run("DELETE FROM session_overrides WHERE id = ?", [id]);
      this.#db.run("INSERT OR IGNORE INTO session_tombstones (id) VALUES (?)", [id]);
      return true;
    });
    return transaction();
  }

  close(): void {
    this.#db.close();
  }

  #initialize(): void {
    const row = this.#db.query("PRAGMA user_version").get() as { user_version: number };
    if (row.user_version === 0) {
      const transaction = this.#db.transaction(() => {
        this.#db.exec(`
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
          CREATE TABLE session_overrides (id TEXT PRIMARY KEY NOT NULL);
          CREATE TABLE session_tombstones (id TEXT PRIMARY KEY NOT NULL);
          PRAGMA user_version = ${DATABASE_SCHEMA_VERSION};
        `);
      });
      transaction();
      return;
    }
    if (row.user_version === 2) {
      const transaction = this.#db.transaction(() => {
        this.#db.exec(`
          CREATE TABLE session_overrides (id TEXT PRIMARY KEY NOT NULL);
          CREATE TABLE session_tombstones (id TEXT PRIMARY KEY NOT NULL);
          PRAGMA user_version = ${DATABASE_SCHEMA_VERSION};
        `);
      });
      transaction();
      return;
    }
    if (row.user_version !== DATABASE_SCHEMA_VERSION) {
      throw new Error(
        `schema do banco de sessões não suportado: ${row.user_version} (esperado ${DATABASE_SCHEMA_VERSION})`,
      );
    }
  }

  #migrateJsonSessions(): SessionMigrationResult {
    const legacyDir = join(this.astroDir, "sessions");
    let files: Dirent[];
    try {
      files = readdirSync(legacyDir, { withFileTypes: true });
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      files = [];
    }

    const store = new SessionStore(legacyDir);
    const nextJsonFiles = new Map(this.#jsonFiles);
    const changedIds = new Set<string>();
    const diagnostics: SessionMigrationDiagnostic[] = [];
    let skipped = 0;
    let existing = 0;
    const candidates = files
      .filter((entry) => entry.name.endsWith(".json"))
      .sort((a, b) => a.name.localeCompare(b.name));
    const signatures = new Map<string, string>();
    for (const entry of candidates) {
      if (!entry.isFile()) {
        signatures.set(entry.name, "non-file");
        continue;
      }
      try {
        const stat = statSync(join(legacyDir, entry.name));
        signatures.set(entry.name, `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`);
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        signatures.set(entry.name, "missing");
      }
    }
    if (
      signatures.size === this.#jsonFiles.size &&
      [...signatures].every(([file, signature]) => this.#jsonFiles.get(file)?.signature === signature)
    ) {
      return { migrated: 0, skipped: 0, existing: 0, diagnostics: [] };
    }

    for (const entry of candidates) {
      const signature = signatures.get(entry.name);
      if (signature === undefined) throw new Error("assinatura do arquivo de sessão ausente");
      const previous = nextJsonFiles.get(entry.name);
      if (previous?.signature === signature) continue;
      if (previous?.record !== undefined) changedIds.add(previous.record.id);
      if (!entry.isFile()) {
        skipped++;
        diagnostics.push({ file: entry.name, reason: "não é um arquivo regular" });
        nextJsonFiles.set(entry.name, { signature });
        continue;
      }
      try {
        const record = store.readByPath(entry.name);
        nextJsonFiles.set(entry.name, { signature, record });
        changedIds.add(record.id);
      } catch {
        skipped++;
        diagnostics.push({ file: entry.name, reason: "registro inválido ou ilegível" });
        nextJsonFiles.set(entry.name, { signature });
      }
    }

    for (const [file, cached] of nextJsonFiles) {
      if (!signatures.has(file)) {
        if (cached.record !== undefined) changedIds.add(cached.record.id);
        nextJsonFiles.delete(file);
      }
    }

    const canonicalRecords = new Map<string, { file: string; record: SessionRecord }>();
    for (const [file, cached] of nextJsonFiles) {
      if (cached.record === undefined || !changedIds.has(cached.record.id)) continue;
      const current = canonicalRecords.get(cached.record.id);
      if (
        current === undefined ||
        cached.record.startedAt.localeCompare(current.record.startedAt) > 0 ||
        (cached.record.startedAt === current.record.startedAt && file.localeCompare(current.file) < 0)
      ) {
        canonicalRecords.set(cached.record.id, { file, record: cached.record });
      }
    }
    for (const [file, cached] of nextJsonFiles) {
      if (cached.record === undefined || !changedIds.has(cached.record.id)) continue;
      if (canonicalRecords.get(cached.record.id)?.file !== file) {
        skipped++;
        diagnostics.push({ file, reason: "id de sessão duplicado" });
      }
    }

    let migrated = 0;
    const transaction = this.#db.transaction(() => {
      for (const { record } of canonicalRecords.values()) {
        const found = this.#db.query("SELECT id FROM sessions WHERE id = ?").get(record.id);
        if (found !== null) existing++;
        if (this.#db.query("SELECT id FROM session_tombstones WHERE id = ?").get(record.id) !== null) continue;
        if (this.#db.query("SELECT id FROM session_overrides WHERE id = ?").get(record.id) !== null) continue;
        this.#db.run(
          `INSERT INTO sessions
           (id, started_at, model, turns, cost_usd, name, record_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             started_at = excluded.started_at,
             model = excluded.model,
             turns = excluded.turns,
             cost_usd = excluded.cost_usd,
             name = excluded.name,
             record_json = excluded.record_json`,
          [
            record.id, record.startedAt, record.model, record.turns, record.costUsd,
            record.name ?? null, JSON.stringify(record),
          ],
        );
        if (found === null) migrated++;
      }
    });
    transaction();
    this.#jsonFiles = nextJsonFiles;
    return { migrated, skipped, existing, diagnostics };
  }

  #markSqliteAuthoritative(id: string): void {
    this.#db.run("DELETE FROM session_tombstones WHERE id = ?", [id]);
    this.#db.run("INSERT OR IGNORE INTO session_overrides (id) VALUES (?)", [id]);
  }

  #prepare(value: SessionRecord): SessionRecord {
    const record = sanitizeSessionRecord(value);
    if (Buffer.byteLength(JSON.stringify(record), "utf8") > MAX_SESSION_BYTES) {
      throw new Error("sessão grande demais para gravar (máx 5 MB)");
    }
    return record;
  }

  #decode(json: string): SessionRecord {
    return sanitizeSessionRecord(JSON.parse(json) as unknown);
  }
}
