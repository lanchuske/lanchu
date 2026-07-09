import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { dbPath } from "../config.js";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

let _db: DatabaseSync | null = null;

/** Opens (or creates) the local database and applies the schema. Idempotent. */
export function openDb(file: string = dbPath()): DatabaseSync {
  if (_db) return _db;

  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);

  _db = db;
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(SCHEMA_SQL);
  const row = db.prepare("SELECT version FROM schema_meta LIMIT 1").get() as
    | { version: number }
    | undefined;
  if (!row) {
    db.prepare("INSERT INTO schema_meta(version) VALUES (?)").run(SCHEMA_VERSION);
  }
  // Future migrations: compare row.version with SCHEMA_VERSION and apply steps.
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}
