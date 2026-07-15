import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

// Regression for the v0.5.17 boot brick: SCHEMA_SQL used to carry the index
// block, so on a database created before agent.person_id / project.network_mode /
// task.published_at / task.kind existed, CREATE INDEX ran before the ALTERs in
// migrate() and openDb threw "no such column: person_id" — every fresh-DB test
// passed while every real upgraded install broke. Simulate that database shape
// and assert openDb migrates it.

const dir = path.join(os.tmpdir(), "lanchu-migration-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
process.env.LANCHU_STATE_DIR = dir;

const { openDb } = await import("../dist/db/db.js");

test("openDb migrates a database whose tables predate the network-mode columns", () => {
  const file = path.join(dir, "old-install.db");

  // Old-shape tables: what a pre-#120 install has. CREATE TABLE IF NOT EXISTS
  // in SCHEMA_SQL will keep these as-is, so the new columns can only arrive
  // via the addColumn migrations.
  const seed = new DatabaseSync(file);
  seed.exec(`
    CREATE TABLE agent (
      id         TEXT PRIMARY KEY,
      org_id     TEXT NOT NULL,
      role_id    TEXT NOT NULL,
      name       TEXT NOT NULL,
      state      TEXT NOT NULL DEFAULT 'idle',
      created_at TEXT NOT NULL
    );
    CREATE TABLE project (
      id         TEXT PRIMARY KEY,
      org_id     TEXT NOT NULL,
      name       TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE task (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      title           TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'available',
      owner_agent_id  TEXT,
      created_at      TEXT NOT NULL
    );
    INSERT INTO agent  VALUES ('a1', 'o1', 'r1', 'old-agent', 'idle', '2026-07-01T00:00:00Z');
    INSERT INTO project VALUES ('p1', 'o1', 'core', '2026-07-01T00:00:00Z');
    INSERT INTO task VALUES ('t1', 'p1', 'old task', 'available', NULL, '2026-07-01T00:00:00Z');
  `);
  seed.close();

  // Must not throw — this exact call bricked the shared server on 2026-07-15.
  const db = openDb(file);

  const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  assert.ok(cols("agent").includes("person_id"), "agent.person_id added by migration");
  assert.ok(cols("agent").includes("kind"), "agent.kind added by migration");
  assert.ok(cols("project").includes("network_mode"), "project.network_mode added by migration");
  assert.ok(cols("task").includes("published_at"), "task.published_at added by migration");
  assert.ok(cols("task").includes("kind"), "task.kind added by migration");

  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all()
    .map((r) => r.name);
  for (const idx of ["idx_agent_person", "idx_project_network_mode", "idx_task_published", "idx_task_kind"]) {
    assert.ok(indexes.includes(idx), `${idx} created after the column migrations`);
  }

  // The pre-existing rows survived and picked up the defaults.
  const agent = db.prepare("SELECT * FROM agent WHERE id = 'a1'").get();
  assert.equal(agent.kind, "ai");
  assert.equal(agent.person_id, null);
  const task = db.prepare("SELECT * FROM task WHERE id = 't1'").get();
  assert.equal(task.kind, "internal");
});
