/**
 * v0 schema, single source (embedded so the build is just `tsc`).
 * Full documentation is in SCHEMA.md.
 */
// 14 = task archive; 15 = doc lifecycle; 16 = wake v5 park & refire (agent session id + parked_at);
// 17 = release pipeline (task.release_version; rc/released stages stamped by the release sweep);
// 18 = network mode Piece 1 (person table; agent.person_id/agent.kind — see
// "Design: Person identity & Membership (network mode — Piece 1)");
// 19 = network mode Piece 4 (contribution_event table — see
// "Design: Contribution ledger (network mode — Piece 4)");
// 20 = network mode Piece 6 (project.network_mode/compensation_terms,
// task.published_at — see "Design: Cross-org task marketplace (Piece 6)");
// 21 = network mode Piece 5 (task.kind='contract' + contract_spec/
// contract_tests/contract_deps — see "Design: Contract-based contributor
// isolation (network mode — Piece 5)");
// 22 = network mode Piece 5 Task 5 (project.owner_agent_id — the exemption
// for the contract-task visibility lockdown);
// 23 = network mode Piece 5 Task 3 (contract_deliverable table — see
// "Design: Contract-based contributor isolation (network mode — Piece 5)").
export const SCHEMA_VERSION = 23;

export const SCHEMA_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS schema_meta (
  version INTEGER NOT NULL
);

-- Network mode: a durable identity that outlives any single org membership.
-- Global, not org-scoped — unlike everything else in this schema. An agent
-- row references one via agent.person_id when it's a network-mode
-- Membership (see "Design: Person identity & Membership", Piece 1).
CREATE TABLE IF NOT EXISTS person (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  handle       TEXT NOT NULL UNIQUE,
  bio          TEXT,
  github_login TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS org (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  repo_url            TEXT,
  local_path          TEXT,
  -- Network mode (Piece 6): opts this project into the public directory.
  -- Off by default — zero behavior change for every local-mode project.
  network_mode        INTEGER NOT NULL DEFAULT 0,
  -- Network mode (Piece 6): free text, stored and displayed only — Lanchu
  -- never parses, escrows, or enforces it. See "Design: Cross-org task
  -- marketplace", Piece 6, "Where the line is drawn, explicitly".
  compensation_terms  TEXT,
  -- Network mode (Piece 5): the only agent exempt from the contract-task
  -- visibility lockdown. NULL means nobody is exempt yet — a project with
  -- no declared owner locks contract tasks down to each contributor's own
  -- assignment for everyone, including whoever created it. See "Design:
  -- Contract-based contributor isolation", Piece 5.
  owner_agent_id       TEXT REFERENCES agent(id),
  created_at          TEXT NOT NULL,
  UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS role (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  is_wildcard INTEGER NOT NULL DEFAULT 0,
  token_quota INTEGER,
  preferred_model TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS role_tag (
  role_id TEXT NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  PRIMARY KEY (role_id, tag)
);

CREATE TABLE IF NOT EXISTS agent (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  role_id          TEXT NOT NULL REFERENCES role(id),
  name             TEXT NOT NULL,
  objective        TEXT,
  state            TEXT NOT NULL DEFAULT 'active'
                     CHECK (state IN ('active','idle','retired')),
  last_activity_at TEXT,
  last_activity    TEXT,
  cwd              TEXT,
  branch           TEXT,
  worktree         TEXT,
  terminal_ref     TEXT,
  color_slot       INTEGER,
  model            TEXT,
  git_author_name  TEXT,
  git_author_email TEXT,
  gh_login         TEXT,
  claude_session_id TEXT,
  parked_at        TEXT,
  person_id        TEXT REFERENCES person(id),
  kind             TEXT NOT NULL DEFAULT 'ai',
  created_at       TEXT NOT NULL,
  retired_at       TEXT,
  UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS session (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  client     TEXT,
  started_at TEXT NOT NULL,
  ended_at   TEXT
);

CREATE TABLE IF NOT EXISTS task (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  parent_task_id      TEXT REFERENCES task(id),
  title               TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'available'
                        CHECK (status IN ('available','claimed','in_progress','blocked','done')),
  stage               TEXT,
  pr_url              TEXT,
  owner_agent_id      TEXT REFERENCES agent(id),
  workspace           TEXT,
  created_by_agent_id TEXT REFERENCES agent(id),
  created_at          TEXT NOT NULL,
  claimed_at          TEXT,
  updated_at          TEXT NOT NULL,
  done_at             TEXT,
  rejection_count     INTEGER NOT NULL DEFAULT 0,
  last_rejection      TEXT,
  bounce_count        INTEGER NOT NULL DEFAULT 0,
  last_bounce         TEXT,
  archived_at         TEXT,
  archived_reason     TEXT,
  superseded_by_task_id TEXT REFERENCES task(id),
  release_version     TEXT,
  -- Network mode (Piece 6): NULL until the project owner explicitly
  -- publishes this task to the public directory. Existing solely because a
  -- task can exist without being discoverable network-wide.
  published_at        TEXT,
  -- Network mode (Piece 5): 'internal' (default, every task today) vs
  -- 'contract' — a task a network contributor works entirely isolated from
  -- the real repo, seeded only from the fields below. See "Design:
  -- Contract-based contributor isolation", Piece 5.
  kind                TEXT NOT NULL DEFAULT 'internal',
  -- Signature/shape, inputs/outputs, behavioral constraints. Markdown +
  -- code fences is enough for v1 — no bespoke DSL. Meaningful only when
  -- kind='contract'.
  contract_spec       TEXT,
  -- An automated test suite the deliverable must satisfy, run inside the
  -- contributor's sandbox before any human check (feeds Piece 4's weight).
  contract_tests      TEXT,
  -- JSON array of other *published* contract task ids this task may call —
  -- their interface only, never their implementation.
  contract_deps       TEXT
);

CREATE TABLE IF NOT EXISTS task_tag (
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  PRIMARY KEY (task_id, tag)
);

CREATE TABLE IF NOT EXISTS task_dep (
  task_id            TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_task_id)
);

CREATE TABLE IF NOT EXISTS doc (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  content             TEXT NOT NULL DEFAULT '',
  category            TEXT NOT NULL DEFAULT 'general',
  lifecycle           TEXT NOT NULL DEFAULT 'living'
                        CHECK (lifecycle IN ('living','record')),
  archived_at         TEXT,
  read_count          INTEGER NOT NULL DEFAULT 0,
  last_read_at        TEXT,
  last_read_by_agent_id TEXT REFERENCES agent(id),
  updated_at          TEXT NOT NULL,
  updated_by_agent_id TEXT REFERENCES agent(id),
  created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id         TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  project_id     TEXT REFERENCES project(id) ON DELETE SET NULL,
  type           TEXT NOT NULL,
  actor_agent_id TEXT REFERENCES agent(id),
  subject_kind   TEXT,
  subject_id     TEXT,
  workspace      TEXT,
  tokens         INTEGER,
  outcome        TEXT NOT NULL DEFAULT 'applied'
                   CHECK (outcome IN ('applied','rejected')),
  data           TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  events     TEXT NOT NULL,
  secret     TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  tags         TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  skill_url    TEXT,
  loaded_at    TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS org_rules (
  org_id     TEXT PRIMARY KEY REFERENCES org(id) ON DELETE CASCADE,
  rules      TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recurring (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  project_id       TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  tags             TEXT,
  interval_seconds INTEGER NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1,
  next_run_at      TEXT NOT NULL,
  last_run_at      TEXT,
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notice (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'message'
                  CHECK (kind IN ('message','conflict','system')),
  from_agent_id TEXT REFERENCES agent(id),
  to_agent_id   TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  body          TEXT NOT NULL,
  ref           TEXT,
  is_broadcast  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  delivered_at  TEXT,
  acked_at      TEXT
);

CREATE TABLE IF NOT EXISTS memory (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  scope      TEXT NOT NULL CHECK (scope IN ('agent','project','org')),
  subject_id TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'agent'
               CHECK (source IN ('event','agent','distilled')),
  source_ref TEXT,
  confidence REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (org_id, scope, subject_id, key)
);

CREATE TABLE IF NOT EXISTS coordinator (
  org_id      TEXT PRIMARY KEY REFERENCES org(id) ON DELETE CASCADE,
  agent_id    TEXT NOT NULL REFERENCES agent(id),
  acquired_at TEXT NOT NULL,
  renewed_at  TEXT NOT NULL,
  ttl_seconds INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS test_suite (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS test_case (
  id         TEXT PRIMARY KEY,
  suite_id   TEXT NOT NULL REFERENCES test_suite(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  planned    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (suite_id, name)
);

CREATE TABLE IF NOT EXISTS test_run (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id         TEXT NOT NULL REFERENCES test_case(id) ON DELETE CASCADE,
  status          TEXT NOT NULL CHECK (status IN ('pass','fail','skip')),
  duration_ms     INTEGER,
  commit_sha      TEXT,
  ran_by_agent_id TEXT REFERENCES agent(id),
  created_at      TEXT NOT NULL
);

-- Network mode: the transparent, non-monetary contribution ledger (see
-- "Design: Contribution ledger", Piece 4). Written once, at QA-pass time,
-- only for network-mode projects — flipVerifiedOriginal in store.ts is the
-- hook point (Task 2, not yet built). person_id is the contributor who gets
-- credit; verified_by is who checked the work (must not be the same
-- Person — enforced by Task 3, not yet built).
CREATE TABLE IF NOT EXISTS contribution_event (
  id          TEXT PRIMARY KEY,
  person_id   TEXT NOT NULL REFERENCES person(id),
  project_id  TEXT NOT NULL REFERENCES project(id),
  task_id     TEXT NOT NULL REFERENCES task(id),
  weight      INTEGER NOT NULL,
  verified_by TEXT REFERENCES person(id),
  created_at  TEXT NOT NULL
);

-- Network mode (Piece 5, Task 3): a contract task's submitted work — the
-- isolated-contributor equivalent of a normal task's pr_url. A unified
-- diff or small file set (base64 if needed), never executed automatically
-- here — see "Design: Contract-based contributor isolation", Piece 5, and
-- Piece 6's Task 4 (contract-sandbox execution safety, not yet built) for
-- why. Multiple rows per task are expected (resubmission after a FAIL
-- bounce); the most recent by submitted_at is canonical.
CREATE TABLE IF NOT EXISTS contract_deliverable (
  id                    TEXT PRIMARY KEY,
  task_id               TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  content               TEXT NOT NULL,
  submitted_by_agent_id TEXT REFERENCES agent(id),
  submitted_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_project_status ON task(project_id, status);
CREATE INDEX IF NOT EXISTS idx_task_owner          ON task(owner_agent_id);
CREATE INDEX IF NOT EXISTS idx_task_tag_tag        ON task_tag(tag);
CREATE INDEX IF NOT EXISTS idx_role_tag_tag        ON role_tag(tag);
CREATE INDEX IF NOT EXISTS idx_agent_org_state     ON agent(org_id, state);
CREATE INDEX IF NOT EXISTS idx_agent_person        ON agent(person_id);
CREATE INDEX IF NOT EXISTS idx_session_agent_live  ON session(agent_id, ended_at);
CREATE INDEX IF NOT EXISTS idx_event_org_id        ON event(org_id, id);
CREATE INDEX IF NOT EXISTS idx_event_actor         ON event(actor_agent_id, id);
CREATE INDEX IF NOT EXISTS idx_notice_pending      ON notice(to_agent_id, acked_at);
CREATE INDEX IF NOT EXISTS idx_memory_subject      ON memory(org_id, scope, subject_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_test_run_case       ON test_run(case_id, id);
CREATE INDEX IF NOT EXISTS idx_contribution_person  ON contribution_event(person_id);
CREATE INDEX IF NOT EXISTS idx_contribution_project ON contribution_event(project_id);
CREATE INDEX IF NOT EXISTS idx_project_network_mode ON project(network_mode);
CREATE INDEX IF NOT EXISTS idx_task_published        ON task(published_at);
CREATE INDEX IF NOT EXISTS idx_task_kind              ON task(kind);
CREATE INDEX IF NOT EXISTS idx_contract_deliverable_task ON contract_deliverable(task_id, submitted_at);
`;
