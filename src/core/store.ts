import type { DatabaseSync } from "node:sqlite";
import { activeWindowMs, staleHours } from "../config.js";
import { openDb } from "../db/db.js";
import { bus } from "./events.js";
import { nowIso, sessionToken, slugify, uuid } from "./ids.js";
import {
  ScopeError,
  type Agent,
  type AgentState,
  type EventOutcome,
  type EventType,
  type LanchuEvent,
  type Role,
  type Task,
  type TaskStatus,
} from "./types.js";

function db(): DatabaseSync {
  return openDb();
}

// ───────────────────────── events / audit ─────────────────────────

interface RecordEventInput {
  org_id: string;
  project_id?: string | null;
  type: EventType;
  actor_agent_id?: string | null;
  subject_kind?: string | null;
  subject_id?: string | null;
  workspace?: string | null;
  tokens?: number | null;
  outcome?: EventOutcome;
  data?: Record<string, unknown> | null;
}

export function recordEvent(input: RecordEventInput): LanchuEvent {
  const created_at = nowIso();
  const info = db()
    .prepare(
      `INSERT INTO event
       (org_id, project_id, type, actor_agent_id, subject_kind, subject_id, workspace, tokens, outcome, data, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      input.org_id,
      input.project_id ?? null,
      input.type,
      input.actor_agent_id ?? null,
      input.subject_kind ?? null,
      input.subject_id ?? null,
      input.workspace ?? null,
      input.tokens ?? null,
      input.outcome ?? "applied",
      input.data ? JSON.stringify(input.data) : null,
      created_at,
    );
  const ev: LanchuEvent = {
    id: Number(info.lastInsertRowid),
    org_id: input.org_id,
    project_id: input.project_id ?? null,
    type: input.type,
    actor_agent_id: input.actor_agent_id ?? null,
    subject_kind: input.subject_kind ?? null,
    subject_id: input.subject_id ?? null,
    workspace: input.workspace ?? null,
    tokens: input.tokens ?? null,
    outcome: input.outcome ?? "applied",
    data: input.data ?? null,
    created_at,
  };
  bus.emitEvent(ev);
  return ev;
}

// ───────────────────────── org / project ─────────────────────────

export function getOrCreateOrg(name: string): { id: string; name: string } {
  const existing = db().prepare("SELECT id, name FROM org WHERE name = ?").get(name) as
    | { id: string; name: string }
    | undefined;
  if (existing) return existing;
  const id = uuid();
  db().prepare("INSERT INTO org(id, name, created_at) VALUES (?,?,?)").run(id, name, nowIso());
  return { id, name };
}

export function getOrCreateProject(orgId: string, name: string): { id: string; name: string } {
  const existing = db()
    .prepare("SELECT id, name FROM project WHERE org_id = ? AND name = ?")
    .get(orgId, name) as { id: string; name: string } | undefined;
  if (existing) return existing;
  const id = uuid();
  db()
    .prepare("INSERT INTO project(id, org_id, name, created_at) VALUES (?,?,?,?)")
    .run(id, orgId, name, nowIso());
  return { id, name };
}

// ───────────────────────── roles ─────────────────────────

function loadRole(row: {
  id: string;
  org_id: string;
  name: string;
  is_wildcard: number;
  created_at: string;
}): Role {
  const tags = db()
    .prepare("SELECT tag FROM role_tag WHERE role_id = ?")
    .all(row.id) as { tag: string }[];
  return {
    id: row.id,
    org_id: row.org_id,
    name: row.name,
    is_wildcard: row.is_wildcard === 1,
    allowed_tags: tags.map((t) => t.tag),
    created_at: row.created_at,
  };
}

export function getOrCreateRole(
  orgId: string,
  name: string,
  opts: { wildcard?: boolean; tags?: string[] } = {},
): Role {
  const existing = db()
    .prepare("SELECT id, org_id, name, is_wildcard, created_at FROM role WHERE org_id = ? AND name = ?")
    .get(orgId, name) as
    | { id: string; org_id: string; name: string; is_wildcard: number; created_at: string }
    | undefined;
  if (existing) return loadRole(existing);

  const id = uuid();
  db()
    .prepare("INSERT INTO role(id, org_id, name, is_wildcard, created_at) VALUES (?,?,?,?,?)")
    .run(id, orgId, name, opts.wildcard ? 1 : 0, nowIso());
  for (const tag of opts.tags ?? []) {
    db().prepare("INSERT OR IGNORE INTO role_tag(role_id, tag) VALUES (?,?)").run(id, tag);
  }
  return getOrCreateRole(orgId, name);
}

export function getRole(roleId: string): Role | null {
  const row = db()
    .prepare("SELECT id, org_id, name, is_wildcard, created_at FROM role WHERE id = ?")
    .get(roleId) as
    | { id: string; org_id: string; name: string; is_wildcard: number; created_at: string }
    | undefined;
  return row ? loadRole(row) : null;
}

export function listRoles(orgId: string): Role[] {
  const rows = db()
    .prepare("SELECT id, org_id, name, is_wildcard, created_at FROM role WHERE org_id = ? ORDER BY name")
    .all(orgId) as {
    id: string;
    org_id: string;
    name: string;
    is_wildcard: number;
    created_at: string;
  }[];
  return rows.map(loadRole);
}

/** Does the role cover ALL given tags? (scope rule T.tags ⊆ allowed_tags) */
export function roleCoversTags(role: Role, tags: string[]): boolean {
  if (role.is_wildcard) return true;
  const allowed = new Set(role.allowed_tags);
  return tags.every((t) => allowed.has(t));
}

// ───────────────────────── agents ─────────────────────────

function loadAgent(row: Record<string, unknown>): Agent {
  return {
    id: row.id as string,
    org_id: row.org_id as string,
    role_id: row.role_id as string,
    name: row.name as string,
    objective: (row.objective as string) ?? null,
    state: row.state as AgentState,
    last_activity_at: (row.last_activity_at as string) ?? null,
    last_activity: (row.last_activity as string) ?? null,
    created_at: row.created_at as string,
    retired_at: (row.retired_at as string) ?? null,
  };
}

const AGENT_COLS =
  "id, org_id, role_id, name, objective, state, last_activity_at, last_activity, created_at, retired_at";

export function createAgent(input: {
  orgId: string;
  roleId: string;
  objective?: string;
  name?: string;
}): Agent {
  const id = uuid();
  let name = input.name ?? slugify(input.objective ?? "agent");
  // Ensures name uniqueness per org.
  let suffix = 1;
  while (
    db().prepare("SELECT 1 FROM agent WHERE org_id = ? AND name = ?").get(input.orgId, name)
  ) {
    suffix += 1;
    name = `${slugify(input.objective ?? "agent")}-${suffix}`;
  }

  db()
    .prepare(
      `INSERT INTO agent(id, org_id, role_id, name, objective, state, created_at)
       VALUES (?,?,?,?,?, 'active', ?)`,
    )
    .run(id, input.orgId, input.roleId, name, input.objective ?? null, nowIso());

  recordEvent({
    org_id: input.orgId,
    type: "agent.created",
    actor_agent_id: id,
    subject_kind: "agent",
    subject_id: id,
    data: { name, objective: input.objective ?? null },
  });
  return getAgent(id)!;
}

export function getAgent(agentId: string): Agent | null {
  const row = db().prepare(`SELECT ${AGENT_COLS} FROM agent WHERE id = ?`).get(agentId) as
    | Record<string, unknown>
    | undefined;
  return row ? loadAgent(row) : null;
}

export function listAgents(orgId: string): Agent[] {
  const rows = db()
    .prepare(`SELECT ${AGENT_COLS} FROM agent WHERE org_id = ? ORDER BY created_at DESC`)
    .all(orgId) as Record<string, unknown>[];
  return rows.map(loadAgent);
}

export function setAgentState(agentId: string, state: AgentState): void {
  const retiredAt = state === "retired" ? nowIso() : null;
  db()
    .prepare("UPDATE agent SET state = ?, retired_at = COALESCE(?, retired_at) WHERE id = ?")
    .run(state, retiredAt, agentId);
}

/** Update only the last-seen timestamp (presence heartbeat), keeping the summary. */
export function touchSeen(agentId: string): void {
  db().prepare("UPDATE agent SET last_activity_at = ? WHERE id = ?").run(nowIso(), agentId);
}

/** Presence: an agent is active if it was seen within the active window. */
export function isRecentlyActive(agent: Agent): boolean {
  if (!agent.last_activity_at) return false;
  return Date.now() - new Date(agent.last_activity_at).getTime() < activeWindowMs();
}

export function touchActivity(agentId: string, summary: string): void {
  db()
    .prepare("UPDATE agent SET last_activity = ?, last_activity_at = ? WHERE id = ?")
    .run(summary, nowIso(), agentId);
}

const STOPWORDS = new Set([
  "the", "and", "for", "que", "con", "los", "las", "una", "por", "del", "arregla",
  "fix", "the", "add", "crea", "haz",
]);

function keywords(text: string): string[] {
  return slugify(text, 200)
    .split("-")
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/** Reuse-by-objective candidates: idle agents whose footprint overlaps. */
export function findReuseCandidates(
  orgId: string,
  objective: string,
): { agent: Agent; score: number }[] {
  const wanted = new Set(keywords(objective));
  if (wanted.size === 0) return [];

  const idle = listAgents(orgId).filter((a) => a.state !== "retired" && !isRecentlyActive(a));
  const scored = idle.map((agent) => {
    const footprint = new Set<string>(keywords(agent.objective ?? ""));
    const tasks = db()
      .prepare(
        `SELECT t.title FROM task t
         WHERE t.owner_agent_id = ? OR t.created_by_agent_id = ?`,
      )
      .all(agent.id, agent.id) as { title: string }[];
    for (const t of tasks) for (const k of keywords(t.title)) footprint.add(k);
    const tags = db()
      .prepare(
        `SELECT DISTINCT tt.tag FROM task_tag tt
         JOIN task t ON t.id = tt.task_id
         WHERE t.owner_agent_id = ?`,
      )
      .all(agent.id) as { tag: string }[];
    for (const t of tags) footprint.add(t.tag);

    let score = 0;
    for (const w of wanted) if (footprint.has(w)) score += 1;
    return { agent, score };
  });

  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
}

// ───────────────────────── sessions ─────────────────────────

export function openSession(agentId: string, client?: string): { id: string; token: string } {
  const id = uuid();
  const token = sessionToken();
  db()
    .prepare("INSERT INTO session(id, agent_id, token, client, started_at) VALUES (?,?,?,?,?)")
    .run(id, agentId, token, client ?? null, nowIso());
  setAgentState(agentId, "active");
  touchSeen(agentId); // fresh presence on registration
  const agent = getAgent(agentId);
  if (agent) {
    recordEvent({
      org_id: agent.org_id,
      type: "agent.active",
      actor_agent_id: agentId,
      subject_kind: "agent",
      subject_id: agentId,
    });
  }
  return { id, token };
}

export function agentIdForToken(token: string): string | null {
  const row = db()
    .prepare("SELECT agent_id FROM session WHERE token = ? AND ended_at IS NULL")
    .get(token) as { agent_id: string } | undefined;
  return row?.agent_id ?? null;
}

export function endSessionsForAgent(agentId: string): void {
  db()
    .prepare("UPDATE session SET ended_at = ? WHERE agent_id = ? AND ended_at IS NULL")
    .run(nowIso(), agentId);
  const agent = getAgent(agentId);
  if (agent && agent.state !== "retired") {
    setAgentState(agentId, "idle");
    recordEvent({
      org_id: agent.org_id,
      type: "agent.idle",
      actor_agent_id: agentId,
      subject_kind: "agent",
      subject_id: agentId,
    });
  }
}

export function isAgentActive(agentId: string): boolean {
  const row = db()
    .prepare("SELECT 1 FROM session WHERE agent_id = ? AND ended_at IS NULL LIMIT 1")
    .get(agentId);
  return !!row;
}

// ───────────────────────── tasks ─────────────────────────

function loadTask(row: Record<string, unknown>): Task {
  const id = row.id as string;
  const tags = db().prepare("SELECT tag FROM task_tag WHERE task_id = ?").all(id) as {
    tag: string;
  }[];
  return {
    id,
    project_id: row.project_id as string,
    parent_task_id: (row.parent_task_id as string) ?? null,
    title: row.title as string,
    status: row.status as TaskStatus,
    owner_agent_id: (row.owner_agent_id as string) ?? null,
    workspace: (row.workspace as string) ?? null,
    tags: tags.map((t) => t.tag),
    created_by_agent_id: (row.created_by_agent_id as string) ?? null,
    created_at: row.created_at as string,
    claimed_at: (row.claimed_at as string) ?? null,
    updated_at: (row.updated_at as string) ?? null,
    done_at: (row.done_at as string) ?? null,
  };
}

const TASK_COLS =
  "id, project_id, parent_task_id, title, status, owner_agent_id, workspace, created_by_agent_id, created_at, claimed_at, updated_at, done_at";

export function getTask(taskId: string): Task | null {
  const row = db().prepare(`SELECT ${TASK_COLS} FROM task WHERE id = ?`).get(taskId) as
    | Record<string, unknown>
    | undefined;
  return row ? loadTask(row) : null;
}

export function listTasks(projectId: string, status?: TaskStatus): Task[] {
  const rows = (
    status
      ? db()
          .prepare(`SELECT ${TASK_COLS} FROM task WHERE project_id = ? AND status = ? ORDER BY created_at`)
          .all(projectId, status)
      : db()
          .prepare(`SELECT ${TASK_COLS} FROM task WHERE project_id = ? ORDER BY created_at`)
          .all(projectId)
  ) as Record<string, unknown>[];
  return rows.map(loadTask);
}

let _taskSeq = 0;
function nextTaskId(): string {
  // readable id + unique suffix
  _taskSeq += 1;
  return `task-${Date.now().toString(36)}${_taskSeq}`;
}

/** Creates a task. Applies the scope check over the tags (A2). */
export function createTask(input: {
  projectId: string;
  orgId: string;
  agentId: string;
  title: string;
  tags?: string[];
  parentTaskId?: string | null;
  deps?: string[];
}): Task {
  const agent = getAgent(input.agentId);
  if (!agent) throw new Error("unknown agent");
  const role = getRole(agent.role_id);
  const tags = input.tags ?? [];
  if (role && !roleCoversTags(role, tags)) {
    recordEvent({
      org_id: input.orgId,
      project_id: input.projectId,
      type: "scope.violation",
      actor_agent_id: input.agentId,
      subject_kind: "task",
      outcome: "rejected",
      data: { action: "create", title: input.title, tags },
    });
    throw new ScopeError(
      `Role '${role.name}' does not cover tags [${tags.join(", ")}].`,
    );
  }

  const id = nextTaskId();
  const now = nowIso();
  db()
    .prepare(
      `INSERT INTO task(id, project_id, parent_task_id, title, status, created_by_agent_id, created_at, updated_at)
       VALUES (?,?,?,?, 'available', ?, ?, ?)`,
    )
    .run(id, input.projectId, input.parentTaskId ?? null, input.title, input.agentId, now, now);
  for (const tag of tags) {
    db().prepare("INSERT OR IGNORE INTO task_tag(task_id, tag) VALUES (?,?)").run(id, tag);
  }
  for (const dep of input.deps ?? []) {
    db()
      .prepare("INSERT OR IGNORE INTO task_dep(task_id, depends_on_task_id) VALUES (?,?)")
      .run(id, dep);
  }

  recordEvent({
    org_id: input.orgId,
    project_id: input.projectId,
    type: "task.created",
    actor_agent_id: input.agentId,
    subject_kind: "task",
    subject_id: id,
    data: { title: input.title, tags },
  });
  touchActivity(input.agentId, `created ${id}: ${input.title}`);
  return getTask(id)!;
}

export type ScopeCheck = "yours" | "someone_else" | "out_of_role" | "available";

export function checkScope(agentId: string, taskId: string): ScopeCheck {
  const task = getTask(taskId);
  const agent = getAgent(agentId);
  if (!task || !agent) throw new Error("unknown task or agent");
  if (task.owner_agent_id === agentId) return "yours";
  const role = getRole(agent.role_id);
  if (role && !roleCoversTags(role, task.tags)) return "out_of_role";
  if (task.owner_agent_id) return "someone_else";
  return "available";
}

/** Atomic claim + scope check (A2, SCHEMA.md §4.1). */
export function claimTask(input: {
  agentId: string;
  taskId: string;
  workspace?: string;
}): Task {
  const task = getTask(input.taskId);
  const agent = getAgent(input.agentId);
  if (!task || !agent) throw new Error("unknown task or agent");
  const role = getRole(agent.role_id);

  if (role && !roleCoversTags(role, task.tags)) {
    recordEvent({
      org_id: agent.org_id,
      project_id: task.project_id,
      type: "scope.violation",
      actor_agent_id: input.agentId,
      subject_kind: "task",
      subject_id: task.id,
      outcome: "rejected",
      data: { action: "claim", tags: task.tags, role: role.name },
    });
    throw new ScopeError(
      `Role '${role.name}' cannot claim task ${task.id} [${task.tags.join(", ")}].`,
    );
  }

  const now = nowIso();
  const res = db()
    .prepare(
      `UPDATE task
       SET status = 'claimed', owner_agent_id = ?, workspace = COALESCE(?, workspace),
           claimed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'available'`,
    )
    .run(input.agentId, input.workspace ?? null, now, now, input.taskId);

  if (res.changes !== 1) {
    throw new Error(`Task ${task.id} is no longer available (another agent took it).`);
  }

  recordEvent({
    org_id: agent.org_id,
    project_id: task.project_id,
    type: "task.claimed",
    actor_agent_id: input.agentId,
    subject_kind: "task",
    subject_id: task.id,
    workspace: input.workspace ?? null,
  });
  touchActivity(input.agentId, `claimed ${task.id}`);
  return getTask(input.taskId)!;
}

export function updateTaskStatus(input: {
  agentId: string;
  taskId: string;
  status: TaskStatus;
  note?: string;
  tokens?: number;
}): Task {
  const task = getTask(input.taskId);
  const agent = getAgent(input.agentId);
  if (!task || !agent) throw new Error("unknown task or agent");

  const now = nowIso();
  const doneAt = input.status === "done" ? now : null;
  db()
    .prepare("UPDATE task SET status = ?, updated_at = ?, done_at = COALESCE(?, done_at) WHERE id = ?")
    .run(input.status, now, doneAt, input.taskId);

  const type: EventType =
    input.status === "done"
      ? "task.completed"
      : input.status === "blocked"
        ? "task.blocked"
        : "task.started";
  recordEvent({
    org_id: agent.org_id,
    project_id: task.project_id,
    type,
    actor_agent_id: input.agentId,
    subject_kind: "task",
    subject_id: task.id,
    tokens: input.tokens ?? null,
    data: input.note ? { note: input.note } : null,
  });
  touchActivity(input.agentId, `${input.status} ${task.id}`);

  if (input.status === "done") unblockDependents(task.project_id);
  return getTask(input.taskId)!;
}

/** Dependency unblocking (SCHEMA.md §4.4). */
function unblockDependents(projectId: string): void {
  db()
    .prepare(
      `UPDATE task SET status = 'available', updated_at = ?
       WHERE project_id = ? AND status = 'blocked'
         AND NOT EXISTS (
           SELECT 1 FROM task_dep d JOIN task p ON p.id = d.depends_on_task_id
           WHERE d.task_id = task.id AND p.status <> 'done'
         )`,
    )
    .run(nowIso(), projectId);
}

export function releaseTask(input: {
  agentId: string | null;
  taskId: string;
  override?: boolean;
}): Task {
  const task = getTask(input.taskId);
  if (!task) throw new Error("unknown task");
  const orgId = orgIdForProject(task.project_id);
  db()
    .prepare(
      "UPDATE task SET status = 'available', owner_agent_id = NULL, updated_at = ? WHERE id = ?",
    )
    .run(nowIso(), input.taskId);
  recordEvent({
    org_id: orgId,
    project_id: task.project_id,
    type: "task.released",
    actor_agent_id: input.agentId,
    subject_kind: "task",
    subject_id: task.id,
    data: input.override ? { override: true } : null,
  });
  return getTask(input.taskId)!;
}

export function reassignTask(input: {
  taskId: string;
  toAgentId: string;
  byAgentId?: string | null;
  override?: boolean;
}): Task {
  const task = getTask(input.taskId);
  const to = getAgent(input.toAgentId);
  if (!task || !to) throw new Error("unknown task or agent");
  const role = getRole(to.role_id);
  if (role && !roleCoversTags(role, task.tags)) {
    throw new ScopeError(
      `Role '${role.name}' does not cover the tags of ${task.id}; cannot reassign.`,
    );
  }
  db()
    .prepare("UPDATE task SET owner_agent_id = ?, status = 'claimed', updated_at = ? WHERE id = ?")
    .run(input.toAgentId, nowIso(), input.taskId);
  recordEvent({
    org_id: to.org_id,
    project_id: task.project_id,
    type: "task.reassigned",
    actor_agent_id: input.byAgentId ?? null,
    subject_kind: "task",
    subject_id: task.id,
    data: { to: input.toAgentId, override: input.override ?? false },
  });
  return getTask(input.taskId)!;
}

export function openTasksForAgent(agentId: string): Task[] {
  const rows = db()
    .prepare(
      `SELECT ${TASK_COLS} FROM task
       WHERE owner_agent_id = ? AND status IN ('claimed','in_progress','blocked')`,
    )
    .all(agentId) as Record<string, unknown>[];
  return rows.map(loadTask);
}

// ───────────────────────── safe retirement ─────────────────────────

export function retireAgent(agentId: string): { retired: boolean; blockedBy: Task[] } {
  const open = openTasksForAgent(agentId);
  if (open.length > 0) return { retired: false, blockedBy: open };
  const agent = getAgent(agentId);
  endSessionsForAgent(agentId);
  setAgentState(agentId, "retired");
  if (agent) {
    recordEvent({
      org_id: agent.org_id,
      type: "agent.retired",
      actor_agent_id: agentId,
      subject_kind: "agent",
      subject_id: agentId,
    });
  }
  return { retired: true, blockedBy: [] };
}

// ───────────────────────── docs (minimal, C5) ─────────────────────────

export interface Doc {
  id: string;
  org_id: string;
  title: string;
  content: string;
  updated_at: string;
  updated_by_agent_id: string | null;
  created_at: string;
}

export function listDocs(orgId: string): Doc[] {
  return db()
    .prepare("SELECT * FROM doc WHERE org_id = ? ORDER BY updated_at DESC")
    .all(orgId) as unknown as Doc[];
}

export function searchDocs(orgId: string, query: string): Doc[] {
  const like = `%${query}%`;
  return db()
    .prepare(
      "SELECT * FROM doc WHERE org_id = ? AND (title LIKE ? OR content LIKE ?) ORDER BY updated_at DESC",
    )
    .all(orgId, like, like) as unknown as Doc[];
}

export function getDoc(docId: string): Doc | null {
  return (db().prepare("SELECT * FROM doc WHERE id = ?").get(docId) as unknown as Doc | undefined) ?? null;
}

/** Create or update a doc (upsert by id or title within the org). Emits doc.created/updated. */
export function upsertDoc(input: {
  orgId: string;
  agentId: string;
  id?: string;
  title: string;
  content: string;
}): Doc {
  const now = nowIso();
  const existing =
    (input.id ? getDoc(input.id) : null) ??
    ((db()
      .prepare("SELECT * FROM doc WHERE org_id = ? AND title = ?")
      .get(input.orgId, input.title) as unknown as Doc | undefined) ??
      null);

  if (existing) {
    db()
      .prepare("UPDATE doc SET content = ?, title = ?, updated_at = ?, updated_by_agent_id = ? WHERE id = ?")
      .run(input.content, input.title, now, input.agentId, existing.id);
    recordEvent({
      org_id: input.orgId,
      type: "doc.updated",
      actor_agent_id: input.agentId,
      subject_kind: "doc",
      subject_id: existing.id,
      data: { title: input.title },
    });
    touchActivity(input.agentId, `updated doc: ${input.title}`);
    return getDoc(existing.id)!;
  }

  const id = input.id ?? uuid();
  db()
    .prepare(
      "INSERT INTO doc(id, org_id, title, content, updated_at, updated_by_agent_id, created_at) VALUES (?,?,?,?,?,?,?)",
    )
    .run(id, input.orgId, input.title, input.content, now, input.agentId, now);
  recordEvent({
    org_id: input.orgId,
    type: "doc.created",
    actor_agent_id: input.agentId,
    subject_kind: "doc",
    subject_id: id,
    data: { title: input.title },
  });
  touchActivity(input.agentId, `created doc: ${input.title}`);
  return getDoc(id)!;
}

// ───────────────────────── helpers ─────────────────────────

export function orgIdForProject(projectId: string): string {
  const row = db().prepare("SELECT org_id FROM project WHERE id = ?").get(projectId) as
    | { org_id: string }
    | undefined;
  if (!row) throw new Error("unknown project");
  return row.org_id;
}

/** Task plus derived governance signals for the panel (C4). */
export type BoardTask = Task & {
  reserved: boolean;
  stale: boolean;
  owner_state: AgentState | null;
  owner_name: string | null;
};

/** Agent plus derived details for the panel. */
export type BoardAgent = Agent & {
  role_name: string | null;
  open_tasks: number;
  workspace: string | null;
};

export interface BoardSnapshot {
  agents: BoardAgent[];
  tasks: BoardTask[];
}

export interface AuditEvent {
  id: number;
  type: string;
  actor_name: string | null;
  subject_kind: string | null;
  subject_id: string | null;
  workspace: string | null;
  tokens: number | null;
  outcome: string;
  data: Record<string, unknown> | null;
  created_at: string;
}

/** Recent audit/event log for an org, newest first (with actor names resolved). */
export function listAuditEvents(orgId: string, limit = 60): AuditEvent[] {
  const rows = db()
    .prepare(
      `SELECT e.id, e.type, a.name AS actor_name, e.subject_kind, e.subject_id,
              e.workspace, e.tokens, e.outcome, e.data, e.created_at
       FROM event e LEFT JOIN agent a ON a.id = e.actor_agent_id
       WHERE e.org_id = ? ORDER BY e.id DESC LIMIT ?`,
    )
    .all(orgId, limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: Number(r.id),
    type: r.type as string,
    actor_name: (r.actor_name as string) ?? null,
    subject_kind: (r.subject_kind as string) ?? null,
    subject_id: (r.subject_id as string) ?? null,
    workspace: (r.workspace as string) ?? null,
    tokens: (r.tokens as number) ?? null,
    outcome: r.outcome as string,
    data: r.data ? (JSON.parse(r.data as string) as Record<string, unknown>) : null,
    created_at: r.created_at as string,
  }));
}

function ageHours(iso: string | null): number {
  if (!iso) return 0;
  return (Date.now() - new Date(iso).getTime()) / 3_600_000;
}

export function boardSnapshot(orgId: string): BoardSnapshot {
  // Presence is derived from recency of activity (robust; no reliance on
  // detecting transport disconnects). Retired agents stay retired.
  const rawAgents = listAgents(orgId)
    .filter((a) => a.state !== "retired")
    .map((a) => ({ ...a, state: (isRecentlyActive(a) ? "active" : "idle") as AgentState }));
  const stateById = new Map(rawAgents.map((a) => [a.id, a.state] as const));
  const nameById = new Map(rawAgents.map((a) => [a.id, a.name] as const));
  const roleName = new Map<string, string | null>();
  const projects = db()
    .prepare("SELECT id FROM project WHERE org_id = ?")
    .all(orgId) as { id: string }[];
  const threshold = staleHours();
  const isOpen = (s: TaskStatus) => s === "claimed" || s === "in_progress" || s === "blocked";

  const tasks: BoardTask[] = projects
    .flatMap((p) => listTasks(p.id))
    .map((t) => {
      const ownerState = t.owner_agent_id ? (stateById.get(t.owner_agent_id) ?? "retired") : null;
      const reserved = isOpen(t.status) && ownerState === "idle";
      const stale = reserved && ageHours(t.updated_at) >= threshold;
      const owner_name = t.owner_agent_id ? (nameById.get(t.owner_agent_id) ?? null) : null;
      return { ...t, owner_state: ownerState, reserved, stale, owner_name };
    });

  const agents: BoardAgent[] = rawAgents.map((a) => {
    if (!roleName.has(a.role_id)) roleName.set(a.role_id, getRole(a.role_id)?.name ?? null);
    const owned = tasks.filter((t) => t.owner_agent_id === a.id);
    const openOwned = owned.filter((t) => isOpen(t.status));
    const wsTask = openOwned.find((t) => t.workspace) ?? owned.find((t) => t.workspace);
    return {
      ...a,
      role_name: roleName.get(a.role_id) ?? null,
      open_tasks: openOwned.length,
      workspace: wsTask?.workspace ?? null,
    };
  });

  return { agents, tasks };
}
