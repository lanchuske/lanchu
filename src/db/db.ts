import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { dbPath } from "../config.js";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

let _db: DatabaseSync | null = null;

/** Opens (or creates) the local database and applies the schema. Idempotent. */
export function openDb(file: string = dbPath()): DatabaseSync {
  if (_db) return _db;

  try {
    if (file !== ":memory:") {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    }

    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    migrate(db);

    _db = db;
    return db;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM" || code === "EROFS" || code === "ENOSPC") {
      const dir = path.dirname(file);
      const reason =
        code === "EROFS"
          ? "the location is read-only"
          : code === "ENOSPC"
            ? "the disk is full"
            : "Lanchu can't write there (permission denied)";
      throw new Error(
        `Can't open the local Lanchu database at ${file} — ${reason}.\n` +
          `Fix the permissions on ${dir}, or point Lanchu elsewhere with LANCHU_STATE_DIR=/a/writable/path.`,
      );
    }
    throw err;
  }
}

function migrate(db: DatabaseSync): void {
  db.exec(SCHEMA_SQL); // creates any missing tables (fresh installs)

  // Additive column migrations for databases created before a column existed.
  // CREATE TABLE IF NOT EXISTS never alters an existing table, so bring older
  // rows up to date with idempotent ALTER … ADD COLUMN steps.
  addColumn(db, "project", "repo_url", "TEXT");
  addColumn(db, "project", "local_path", "TEXT");
  addColumn(db, "agent", "cwd", "TEXT");
  addColumn(db, "agent", "branch", "TEXT");
  addColumn(db, "agent", "worktree", "TEXT");
  addColumn(db, "agent", "terminal_ref", "TEXT");
  addColumn(db, "task", "stage", "TEXT");
  addColumn(db, "task", "pr_url", "TEXT");
  addColumn(db, "task", "rejection_count", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "task", "last_rejection", "TEXT");
  addColumn(db, "skill", "description", "TEXT NOT NULL DEFAULT ''");
  addColumn(db, "skill", "loaded_at", "TEXT");
  addColumn(db, "doc", "category", "TEXT NOT NULL DEFAULT 'general'");
  addColumn(db, "role", "token_quota", "INTEGER");
  addColumn(db, "agent", "color_slot", "INTEGER");
  addColumn(db, "doc", "read_count", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "doc", "last_read_at", "TEXT");
  addColumn(db, "doc", "last_read_by_agent_id", "TEXT");

  const row = db.prepare("SELECT version FROM schema_meta LIMIT 1").get() as
    | { version: number }
    | undefined;
  if (!row) {
    db.prepare("INSERT INTO schema_meta(version) VALUES (?)").run(SCHEMA_VERSION);
  } else if (row.version < SCHEMA_VERSION) {
    db.prepare("UPDATE schema_meta SET version = ?").run(SCHEMA_VERSION);
  }
}

/** Add a column if the table doesn't already have it. Idempotent. */
function addColumn(db: DatabaseSync, table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}
