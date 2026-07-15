import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const { openDb, closeDb } = await import("../dist/db/db.js");

// Regression for a live org-wide MCP outage (2026-07-15): schema.ts declared
// `CREATE INDEX IF NOT EXISTS idx_agent_person ON agent(person_id)` inside the
// same SQL block as `CREATE TABLE IF NOT EXISTS agent (...)`. On a database
// that predates the person_id/kind/network_mode/published_at/kind columns
// (any real install upgrading across the network-mode release), CREATE TABLE
// IF NOT EXISTS is a no-op — the table already exists without those columns —
// so the index statement throws "no such column", aborting the whole
// SCHEMA_SQL exec before the ADD COLUMN migrations that would have added
// them ever run. Every subsequent boot hit the same wall: schema_meta stuck
// below version 18, every DB-touching request throwing. This test builds a
// pre-network-mode database by hand (the exact shape pulled from a live
// pre-upgrade install) and asserts openDb() migrates it cleanly instead of
// wedging forever.
test("openDb migrates a pre-network-mode database (agent/task/project without the new columns) without throwing", () => {
  const dir = path.join(os.tmpdir(), "lanchu-test-migration-upgrade-" + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "old.db");

  const seed = new DatabaseSync(file);
  seed.exec(`
    CREATE TABLE schema_meta (version INTEGER NOT NULL);
    INSERT INTO schema_meta(version) VALUES (17);

    CREATE TABLE org (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE role (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL);

    -- Pre-Piece-1/4/5/6 shape: no person_id/kind (agent), no network_mode/
    -- compensation_terms/owner_agent_id (project), no published_at/kind/
    -- contract_* (task) — exactly what any real database looked like before
    -- the network-mode release.
    CREATE TABLE agent (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
      role_id TEXT NOT NULL REFERENCES role(id),
      name TEXT NOT NULL,
      objective TEXT,
      state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','idle','retired')),
      last_activity_at TEXT,
      last_activity TEXT,
      created_at TEXT NOT NULL,
      retired_at TEXT, cwd TEXT, branch TEXT, worktree TEXT, terminal_ref TEXT,
      color_slot INTEGER, git_author_name TEXT, git_author_email TEXT, gh_login TEXT,
      model TEXT, claude_session_id TEXT, parked_at TEXT,
      UNIQUE (org_id, name)
    );

    CREATE TABLE project (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      repo_url TEXT,
      local_path TEXT
    );

    CREATE TABLE task (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      parent_task_id TEXT REFERENCES task(id),
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','claimed','in_progress','blocked','done')),
      owner_agent_id TEXT REFERENCES agent(id),
      workspace TEXT,
      created_by_agent_id TEXT REFERENCES agent(id),
      created_at TEXT NOT NULL,
      claimed_at TEXT,
      updated_at TEXT NOT NULL,
      done_at TEXT,
      stage TEXT, pr_url TEXT, rejection_count INTEGER NOT NULL DEFAULT 0,
      last_rejection TEXT, bounce_count INTEGER NOT NULL DEFAULT 0, last_bounce TEXT,
      archived_at TEXT, archived_reason TEXT,
      superseded_by_task_id TEXT REFERENCES task(id), release_version TEXT
    );
  `);
  seed.close();

  closeDb(); // drop any cached handle from an earlier test in this run
  assert.doesNotThrow(() => openDb(file), "migrate() must not throw on a pre-network-mode database");

  const db = openDb(file);
  const agentCols = db.prepare("PRAGMA table_info(agent)").all().map((c) => c.name);
  const projectCols = db.prepare("PRAGMA table_info(project)").all().map((c) => c.name);
  const taskCols = db.prepare("PRAGMA table_info(task)").all().map((c) => c.name);
  for (const col of ["person_id", "kind"]) assert.ok(agentCols.includes(col), `agent.${col} missing`);
  for (const col of ["network_mode", "compensation_terms", "owner_agent_id"]) {
    assert.ok(projectCols.includes(col), `project.${col} missing`);
  }
  for (const col of ["published_at", "kind", "contract_spec", "contract_tests", "contract_deps"]) {
    assert.ok(taskCols.includes(col), `task.${col} missing`);
  }

  const indexNames = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all()
    .map((r) => r.name);
  for (const idx of ["idx_agent_person", "idx_project_network_mode", "idx_task_published", "idx_task_kind"]) {
    assert.ok(indexNames.includes(idx), `${idx} was not created`);
  }

  const version = db.prepare("SELECT version FROM schema_meta").get().version;
  assert.ok(version >= 24, `schema_meta.version should reach the current version, got ${version}`);

  closeDb();
});
