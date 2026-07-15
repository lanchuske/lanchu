import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

// Regression for the v0.5.17 production outage: on a database created before
// agent.person_id existed, migrate() ran CREATE INDEX idx_agent_person (inside
// SCHEMA_SQL) BEFORE the addColumn steps, so the whole schema exec aborted with
// "no such column: person_id", the additive migrations never ran, and every
// query on the new columns failed org-wide. Fresh databases never hit this —
// their CREATE TABLE already carries the column — which is exactly why the
// full suite stayed green while production broke. This file rebuilds a
// production-shaped OLD database first, then lets the real openDb migrate it.

const dir = path.join(os.tmpdir(), "lanchu-db-upgrade-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
process.env.LANCHU_STATE_DIR = dir;

// Old-shape tables, verbatim from a real pre-Piece-1 production database
// (agent has no person_id/kind; project has no network_mode/compensation_terms/
// owner_agent_id; task has no published_at/kind/contract_*). Tables the old DB
// also had but whose shape doesn't matter here are left for SCHEMA_SQL to create.
const OLD_DDL = `
CREATE TABLE schema_meta (version INTEGER NOT NULL);
CREATE TABLE org (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE role (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TEXT NOT NULL,
  token_quota INTEGER, preferred_model TEXT,
  UNIQUE (org_id, name)
);
CREATE TABLE project (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL, repo_url TEXT, local_path TEXT,
  UNIQUE (org_id, name)
);
CREATE TABLE agent (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  role_id          TEXT NOT NULL REFERENCES role(id),
  name             TEXT NOT NULL,
  objective        TEXT,
  state            TEXT NOT NULL DEFAULT 'active'
                     CHECK (state IN ('active','idle','retired')),
  last_activity_at TEXT,
  last_activity    TEXT,
  created_at       TEXT NOT NULL,
  retired_at       TEXT, cwd TEXT, branch TEXT, worktree TEXT, terminal_ref TEXT,
  color_slot INTEGER, git_author_name TEXT, git_author_email TEXT, gh_login TEXT,
  model TEXT, claude_session_id TEXT, parked_at TEXT,
  UNIQUE (org_id, name)
);
CREATE TABLE task (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  parent_task_id      TEXT REFERENCES task(id),
  title               TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'available'
                        CHECK (status IN ('available','claimed','in_progress','blocked','done')),
  owner_agent_id      TEXT REFERENCES agent(id),
  workspace           TEXT,
  created_by_agent_id TEXT REFERENCES agent(id),
  created_at          TEXT NOT NULL,
  claimed_at          TEXT,
  updated_at          TEXT NOT NULL,
  done_at             TEXT,
  stage TEXT, pr_url TEXT, rejection_count INTEGER NOT NULL DEFAULT 0,
  last_rejection TEXT, bounce_count INTEGER NOT NULL DEFAULT 0, last_bounce TEXT,
  archived_at TEXT, archived_reason TEXT,
  superseded_by_task_id TEXT REFERENCES task(id), release_version TEXT
);
`;

const file = path.join(dir, "lanchu.db");
{
  const old = new DatabaseSync(file);
  old.exec(OLD_DDL);
  old.prepare("INSERT INTO schema_meta(version) VALUES (17)").run();
  old.prepare("INSERT INTO org(id, name, created_at) VALUES ('o1','upgrade-org','2026-01-01T00:00:00Z')").run();
  old.prepare("INSERT INTO role(id, org_id, name, created_at) VALUES ('r1','o1','builder','2026-01-01T00:00:00Z')").run();
  old
    .prepare("INSERT INTO agent(id, org_id, role_id, name, created_at) VALUES ('a1','o1','r1','old-agent','2026-01-01T00:00:00Z')")
    .run();
  old.close();
}

// Only now import the real thing — openDb migrates on first open.
const { openDb } = await import("../dist/db/db.js");
const store = await import("../dist/core/store.js");

test("migrating a pre-person_id database completes: columns added, indexes created", () => {
  const db = openDb(file);

  const agentCols = db.prepare("PRAGMA table_info(agent)").all().map((c) => c.name);
  assert.ok(agentCols.includes("person_id"), "agent.person_id added by migration");
  assert.ok(agentCols.includes("kind"), "agent.kind added by migration");
  const projectCols = db.prepare("PRAGMA table_info(project)").all().map((c) => c.name);
  assert.ok(projectCols.includes("network_mode"), "project.network_mode added by migration");
  const taskCols = db.prepare("PRAGMA table_info(task)").all().map((c) => c.name);
  assert.ok(taskCols.includes("published_at"), "task.published_at added by migration");

  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
    .all()
    .map((r) => r.name);
  for (const idx of ["idx_agent_person", "idx_project_network_mode", "idx_task_kind", "idx_person_session_person"]) {
    assert.ok(indexes.includes(idx), `${idx} created after column migrations`);
  }
});

test("pre-upgrade rows are readable through the full column list after migration", () => {
  const agents = store.listAgents("o1");
  assert.equal(agents.length, 1);
  assert.equal(agents[0].name, "old-agent");
  assert.equal(agents[0].person_id, null, "old agent gets a null person_id");
  assert.equal(agents[0].kind, "ai", "old agent gets the 'ai' kind default");
});
