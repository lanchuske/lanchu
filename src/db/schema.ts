/**
 * v0 schema, single source (embedded so the build is just `tsc`).
 * Full documentation is in SCHEMA.md.
 */
export const SCHEMA_VERSION = 9;

export const SCHEMA_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS schema_meta (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS org (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  repo_url   TEXT,
  local_path TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS role (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  is_wildcard INTEGER NOT NULL DEFAULT 0,
  token_quota INTEGER,
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
  last_rejection      TEXT
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

CREATE INDEX IF NOT EXISTS idx_task_project_status ON task(project_id, status);
CREATE INDEX IF NOT EXISTS idx_task_owner          ON task(owner_agent_id);
CREATE INDEX IF NOT EXISTS idx_task_tag_tag        ON task_tag(tag);
CREATE INDEX IF NOT EXISTS idx_role_tag_tag        ON role_tag(tag);
CREATE INDEX IF NOT EXISTS idx_agent_org_state     ON agent(org_id, state);
CREATE INDEX IF NOT EXISTS idx_session_agent_live  ON session(agent_id, ended_at);
CREATE INDEX IF NOT EXISTS idx_event_org_id        ON event(org_id, id);
CREATE INDEX IF NOT EXISTS idx_event_actor         ON event(actor_agent_id, id);
CREATE INDEX IF NOT EXISTS idx_notice_pending      ON notice(to_agent_id, acked_at);
CREATE INDEX IF NOT EXISTS idx_memory_subject      ON memory(org_id, scope, subject_id, updated_at);
`;
