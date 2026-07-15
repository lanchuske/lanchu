import { spawnSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import {
  activeWindowMs,
  broadcastTtlMs,
  nudgeAfterMs,
  nudgeBudget,
  nudgeCooldownMs,
  personLoginCooldownMs,
  personLoginRequestTtlMs,
  personSessionTtlMs,
  releaseMaxAgeHours,
  releaseMaxChanges,
  sdlcMode,
  staleHours,
  workingWindowMs,
} from "../config.js";
import { openDb } from "../db/db.js";
import { bus } from "./events.js";
import { gitInfo } from "./git.js";
import { preferredSlot, slotColor, type AgentColor } from "./colors.js";
import { nowIso, sessionToken, slugify, uuid } from "./ids.js";
import { isAgentLive, liveSessionCount } from "./presence.js";
import { loadSkillDefinition } from "./skills_loader.js";
import {
  QuotaError,
  ScopeError,
  type Agent,
  type AgentKind,
  type AgentState,
  type ContractDeliverable,
  type ContributionEvent,
  type EventOutcome,
  type EventType,
  type LanchuEvent,
  type MemoryEntry,
  type MemoryScope,
  type MemorySource,
  type Person,
  type PersonLoginRequest,
  type PersonSession,
  type PresenceState,
  type RejectReason,
  type Role,
  type Task,
  type TaskStage,
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
  /** High-volume telemetry: keep it on the record but off the live bus (no SSE refresh churn). */
  silent?: boolean;
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
  if (!input.silent) bus.emitEvent(ev);
  distillMemory(ev);
  return ev;
}

// ─────────────────── token-optimal knowledge access ───────────────────
// Context is the scarce resource: what these helpers return is what enters an
// agent's context window, so they deliver the smallest useful shape — lane-
// filtered indexes, abstracts instead of bodies, section and delta reads, and
// a spend meter so the caps get tuned empirically.

/** ~One-line abstract of a doc: first heading + lead paragraph, tightly capped. */
export function docAbstract(content: string, max = 220): string {
  const lines = content.split("\n");
  let heading = "";
  let lead = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!heading && line.startsWith("#")) {
      heading = line.replace(/^#+\s*/, "");
      continue;
    }
    if (line.startsWith("#") || line.startsWith("|") || line.startsWith("```")) continue;
    lead = line.replace(/^[-*>]\s*/, "");
    break;
  }
  const out = [heading, lead].filter(Boolean).join(" — ");
  return out.length > max ? out.slice(0, max - 1) + "…" : out;
}

/**
 * One markdown section by heading (case-insensitive substring): from the
 * matching heading to the next heading of the same or higher level. Null when
 * no heading matches.
 */
export function docSection(content: string, heading: string): string | null {
  const lines = content.split("\n");
  const needle = heading.toLowerCase();
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#+)\s*(.*)$/.exec(lines[i]!.trim());
    if (m && m[2]!.toLowerCase().includes(needle)) {
      start = i;
      level = m[1]!.length;
      break;
    }
  }
  if (start < 0) return null;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#+)\s/.exec(lines[i]!.trim());
    if (m && m[1]!.length <= level) return lines.slice(start, i).join("\n").trim();
  }
  return lines.slice(start).join("\n").trim();
}

/** All markdown headings of a doc (for the "section not found" hint). */
export function docHeadings(content: string): string[] {
  return content
    .split("\n")
    .map((l) => /^#+\s*(.*)$/.exec(l.trim())?.[1] ?? null)
    .filter((h): h is string => !!h);
}

export interface DocIndexEntry {
  id: string;
  title: string;
  abstract: string;
  category: string;
  updated_at: string;
}

/**
 * The doc index an agent should see: id + title + abstract only (never
 * bodies). With task tags, lane-relevant docs only (tag appears in title or
 * content); an empty match falls back to the full index rather than starving
 * the agent of knowledge it might need.
 */
export function docsIndexFor(orgId: string, tags: string[] = []): DocIndexEntry[] {
  const all = listDocs(orgId);
  const toEntry = (d: { id: string; title: string; content: string; category: string; updated_at: string }): DocIndexEntry => ({
    id: d.id,
    title: d.title,
    abstract: docAbstract(d.content),
    category: d.category,
    updated_at: d.updated_at,
  });
  if (!tags.length) return all.map(toEntry);
  const needles = tags.map((t) => t.toLowerCase());
  const matching = all.filter((d) => {
    const hay = (d.title + "\n" + d.content).toLowerCase();
    return needles.some((n) => hay.includes(n));
  });
  return (matching.length ? matching : all).map(toEntry);
}

/** Record what a tool call put into an agent's context (chars ≈ tokens·4). Off-bus, off-Activity; NOT event.tokens (that column is the self-reported budget). */
export function recordToolSpend(orgId: string, agentId: string, tool: string, chars: number): void {
  recordEvent({
    org_id: orgId,
    type: "tool.response",
    actor_agent_id: agentId,
    subject_kind: "tool",
    subject_id: tool,
    data: { tool, chars },
    silent: true,
  });
}

export interface ContextSpend {
  by_tool: { tool: string; calls: number; chars: number }[];
  by_agent: { agent: string; calls: number; chars: number }[];
}

/** Context-spend aggregates over a recent window, for tuning caps empirically. */
export function contextSpend(orgId: string, hours = 24): ContextSpend {
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const by_tool = db()
    .prepare(
      `SELECT e.subject_id AS tool, COUNT(*) AS calls,
              COALESCE(SUM(CAST(json_extract(e.data, '$.chars') AS INTEGER)), 0) AS chars
       FROM event e WHERE e.org_id = ? AND e.type = 'tool.response' AND e.created_at >= ?
       GROUP BY e.subject_id ORDER BY chars DESC`,
    )
    .all(orgId, since) as unknown as { tool: string; calls: number; chars: number }[];
  const by_agent = db()
    .prepare(
      `SELECT COALESCE(a.name, '?') AS agent, COUNT(*) AS calls,
              COALESCE(SUM(CAST(json_extract(e.data, '$.chars') AS INTEGER)), 0) AS chars
       FROM event e LEFT JOIN agent a ON a.id = e.actor_agent_id
       WHERE e.org_id = ? AND e.type = 'tool.response' AND e.created_at >= ?
       GROUP BY a.name ORDER BY chars DESC`,
    )
    .all(orgId, since) as unknown as { agent: string; calls: number; chars: number }[];
  return { by_tool, by_agent };
}

// ───────────────────────── memory ─────────────────────────
// Persistent learnings in three scopes (agent / project / org): org-visible,
// audited on write, size-capped with LRU eviction. Layer 1 below derives
// entries deterministically from events (zero model tokens); agents add their
// own via memory_set. See the memory-architecture design doc.

const MEMORY_CAPS: Record<MemoryScope, number> = { agent: 50, project: 100, org: 100 };

function loadMemory(row: Record<string, unknown>): MemoryEntry {
  return {
    id: row.id as string,
    org_id: row.org_id as string,
    scope: row.scope as MemoryScope,
    subject_id: row.subject_id as string,
    key: row.key as string,
    value: row.value as string,
    source: row.source as MemorySource,
    source_ref: (row.source_ref as string) ?? null,
    confidence: Number(row.confidence),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

const MEMORY_COLS = "id, org_id, scope, subject_id, key, value, source, source_ref, confidence, created_at, updated_at";

/** Upsert one learning (by scope+subject+key), audit it, and enforce the cap. */
export function memorySet(input: {
  orgId: string;
  scope: MemoryScope;
  subjectId: string;
  key: string;
  value: string;
  source?: MemorySource;
  sourceRef?: string | null;
  confidence?: number;
  actorAgentId?: string | null;
}): MemoryEntry {
  const now = nowIso();
  db()
    .prepare(
      `INSERT INTO memory(id, org_id, scope, subject_id, key, value, source, source_ref, confidence, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(org_id, scope, subject_id, key)
       DO UPDATE SET value = excluded.value, source = excluded.source, source_ref = excluded.source_ref,
                     confidence = excluded.confidence, updated_at = excluded.updated_at`,
    )
    .run(
      uuid(), input.orgId, input.scope, input.subjectId, input.key, input.value,
      input.source ?? "agent",
      // Agent-written entries carry their author as provenance by default.
      input.sourceRef ?? ((input.source ?? "agent") === "agent" ? (input.actorAgentId ?? null) : null),
      input.confidence ?? 1, now, now,
    );

  // LRU eviction: keep the newest N per (scope, subject).
  db()
    .prepare(
      `DELETE FROM memory WHERE org_id = ? AND scope = ? AND subject_id = ? AND id NOT IN (
         SELECT id FROM memory WHERE org_id = ? AND scope = ? AND subject_id = ?
         ORDER BY updated_at DESC, id DESC LIMIT ?)`,
    )
    .run(
      input.orgId, input.scope, input.subjectId,
      input.orgId, input.scope, input.subjectId, MEMORY_CAPS[input.scope],
    );

  const row = db()
    .prepare(`SELECT ${MEMORY_COLS} FROM memory WHERE org_id = ? AND scope = ? AND subject_id = ? AND key = ?`)
    .get(input.orgId, input.scope, input.subjectId, input.key) as Record<string, unknown>;
  const entry = loadMemory(row);

  recordEvent({
    org_id: input.orgId,
    type: "memory.written",
    actor_agent_id: input.actorAgentId ?? null,
    subject_kind: "memory",
    subject_id: entry.id,
    data: { scope: entry.scope, key: entry.key, source: entry.source, source_ref: entry.source_ref },
  });
  return entry;
}

/**
 * Supervisor delete: the entry goes, the record of it stays — the audit event
 * snapshots key/scope/value so a deletion is always accountable.
 */
export function memoryDelete(orgId: string, id: string, actorAgentId?: string | null): boolean {
  const row = db()
    .prepare(`SELECT ${MEMORY_COLS} FROM memory WHERE id = ? AND org_id = ?`)
    .get(id, orgId) as Record<string, unknown> | undefined;
  if (!row) return false;
  const entry = loadMemory(row);
  db().prepare("DELETE FROM memory WHERE id = ?").run(id);
  recordEvent({
    org_id: orgId,
    type: "memory.deleted",
    actor_agent_id: actorAgentId ?? null,
    subject_kind: "memory",
    subject_id: entry.id,
    data: { scope: entry.scope, key: entry.key, value: entry.value.slice(0, 200) },
  });
  return true;
}

/** Query memories, optionally narrowed by scope/subject and a substring. */
export function memoryGet(
  orgId: string,
  opts: { scope?: MemoryScope; subjectId?: string; query?: string } = {},
): MemoryEntry[] {
  const cond = ["org_id = ?"];
  const params: unknown[] = [orgId];
  if (opts.scope) { cond.push("scope = ?"); params.push(opts.scope); }
  if (opts.subjectId) { cond.push("subject_id = ?"); params.push(opts.subjectId); }
  if (opts.query) { cond.push("(key LIKE ? OR value LIKE ?)"); params.push(`%${opts.query}%`, `%${opts.query}%`); }
  const rows = db()
    .prepare(`SELECT ${MEMORY_COLS} FROM memory WHERE ${cond.join(" AND ")} ORDER BY updated_at DESC LIMIT 200`)
    .all(...(params as string[])) as Record<string, unknown>[];
  return rows.map(loadMemory);
}

/**
 * The compact memories block org_context injects: the caller's own learnings
 * plus its project's and org's, highest-confidence/newest first, capped so a
 * respawned agent starts informed without burning context. With task tags,
 * project/org entries are lane-filtered (tag appears in key or value); the
 * agent's own learnings always ride along — they are its lane by definition.
 */
export function memoriesForContext(
  orgId: string,
  agentId: string,
  projectId: string,
  cap = 15,
  tags: string[] = [],
): { scope: MemoryScope; key: string; value: string }[] {
  const rows = db()
    .prepare(
      `SELECT ${MEMORY_COLS} FROM memory WHERE org_id = ? AND (
         (scope = 'agent' AND subject_id = ?) OR
         (scope = 'project' AND subject_id = ?) OR
         (scope = 'org' AND subject_id = ?))
       ORDER BY confidence DESC, updated_at DESC`,
    )
    .all(orgId, agentId, projectId, orgId) as Record<string, unknown>[];
  let entries = rows.map(loadMemory);
  if (tags.length) {
    const needles = tags.map((t) => t.toLowerCase());
    entries = entries.filter(
      (m) => m.scope === "agent" || needles.some((n) => (m.key + " " + m.value).toLowerCase().includes(n)),
    );
  }
  return entries.slice(0, cap).map((m) => ({ scope: m.scope, key: m.key, value: m.value }));
}

// Layer 1 — event-derived learnings (deterministic, zero model tokens).
const HOT_ZONE_THRESHOLD = 3;

function distillMemory(ev: LanchuEvent): void {
  try {
    if (ev.type === "task.completed" && ev.subject_id) {
      const task = getTask(ev.subject_id);
      if (task?.pr_url) {
        memorySet({
          orgId: ev.org_id,
          scope: "project",
          subjectId: task.project_id,
          key: `pr:${task.id}`,
          value: `${task.pr_url} addressed: ${task.title.slice(0, 140)}`,
          source: "event",
          sourceRef: String(ev.id),
        });
      }
    } else if (ev.type === "conflict.detected" && ev.subject_id) {
      const task = getTask(ev.subject_id);
      if (!task) return;
      const tags = new Set<string>();
      const conflicts = (ev.data?.conflicts ?? []) as { overlap_tags?: string[] }[];
      for (const c of conflicts) for (const t of c.overlap_tags ?? []) tags.add(t);
      const weekAgo = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
      for (const tag of tags) {
        // Quoted match ("tag") is exact against the JSON-encoded data column.
        const n = (db()
          .prepare(
            `SELECT COUNT(*) AS c FROM event
             WHERE org_id = ? AND type = 'conflict.detected' AND created_at >= ? AND data LIKE ?`,
          )
          .get(ev.org_id, weekAgo, `%"${tag}"%`) as { c: number }).c;
        if (n >= HOT_ZONE_THRESHOLD) {
          memorySet({
            orgId: ev.org_id,
            scope: "project",
            subjectId: task.project_id,
            key: `hot-zone:${tag}`,
            value: `hot zone: '${tag}' — ${n} work conflicts this week; coordinate before claiming`,
            source: "event",
            sourceRef: String(ev.id),
          });
        }
      }
    } else if (ev.type === "role.updated" && ev.data) {
      const d = ev.data as { role?: string; before?: unknown; after?: unknown };
      if (!d.role) return;
      memorySet({
        orgId: ev.org_id,
        scope: "org",
        subjectId: ev.org_id,
        key: `role:${d.role}`,
        value: `role '${d.role}' scope changed: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}`,
        source: "event",
        sourceRef: String(ev.id),
      });
    }
  } catch {
    // Distillation is best-effort by design — it must never break the write path.
  }
}

// ───────────────────────── org / project ─────────────────────────

export function getOrCreateOrg(name: string): { id: string; name: string } {
  const existing = db().prepare("SELECT id, name FROM org WHERE name = ?").get(name) as
    | { id: string; name: string }
    | undefined;
  if (existing) return existing;
  const id = uuid();
  db().prepare("INSERT INTO org(id, name, created_at) VALUES (?,?,?)").run(id, name, nowIso());
  seedDefaultSkills(id); // built-in skills, out of the box
  return { id, name };
}

export interface ProjectRow {
  id: string;
  name: string;
  repo_url: string | null;
  local_path: string | null;
  /** Network mode (Piece 6): opts this project into the public directory. False for every local-mode project. */
  network_mode: boolean;
  /** Network mode (Piece 6): free text, stored/displayed only — Lanchu never parses, escrows, or enforces it. */
  compensation_terms: string | null;
  /** Network mode (Piece 5): the only agent exempt from the contract-task visibility lockdown. Null = nobody exempt yet. */
  owner_agent_id: string | null;
}

const PROJECT_COLS = "id, name, repo_url, local_path, network_mode, compensation_terms, owner_agent_id";

function loadProject(row: Record<string, unknown>): ProjectRow {
  return {
    id: row.id as string,
    name: row.name as string,
    repo_url: (row.repo_url as string) ?? null,
    local_path: (row.local_path as string) ?? null,
    network_mode: Boolean(row.network_mode),
    compensation_terms: (row.compensation_terms as string) ?? null,
    owner_agent_id: (row.owner_agent_id as string) ?? null,
  };
}

export function getOrg(orgId: string): { id: string; name: string } | null {
  const row = db().prepare("SELECT id, name FROM org WHERE id = ?").get(orgId) as
    | { id: string; name: string }
    | undefined;
  return row ?? null;
}

/** Look up an org by name WITHOUT creating it — use for reads so a typo in the
 * panel's org field can't spawn empty phantom orgs. */
export function getOrgByName(name: string): { id: string; name: string } | null {
  const row = db().prepare("SELECT id, name FROM org WHERE name = ?").get(name) as
    | { id: string; name: string }
    | undefined;
  return row ?? null;
}

export interface OrgSummary {
  id: string;
  name: string;
  agents: number;
  projects: number;
  tasks: number;
}

/** All orgs with headline counts, for the org switcher and `lanchu orgs`. */
export function listOrgs(): OrgSummary[] {
  return db()
    .prepare(
      `SELECT o.id, o.name,
         (SELECT COUNT(*) FROM agent a WHERE a.org_id = o.id AND a.state != 'retired') AS agents,
         (SELECT COUNT(*) FROM project p WHERE p.org_id = o.id) AS projects,
         (SELECT COUNT(*) FROM task t JOIN project p ON p.id = t.project_id WHERE p.org_id = o.id) AS tasks
       FROM org o ORDER BY o.name`,
    )
    .all() as unknown as OrgSummary[];
}

/** Delete an org by name. Cascades to its projects, agents, tasks, docs, etc. */
export function deleteOrg(name: string): { deleted: boolean; name: string } {
  const org = db().prepare("SELECT id FROM org WHERE name = ?").get(name) as
    | { id: string }
    | undefined;
  if (!org) return { deleted: false, name };
  db().prepare("DELETE FROM org WHERE id = ?").run(org.id); // FK cascade does the rest
  return { deleted: true, name };
}

export function getOrCreateProject(orgId: string, name: string): ProjectRow {
  const existing = db()
    .prepare(`SELECT ${PROJECT_COLS} FROM project WHERE org_id = ? AND name = ?`)
    .get(orgId, name) as Record<string, unknown> | undefined;
  if (existing) return loadProject(existing);
  const id = uuid();
  db()
    .prepare("INSERT INTO project(id, org_id, name, created_at) VALUES (?,?,?,?)")
    .run(id, orgId, name, nowIso());
  return {
    id,
    name,
    repo_url: null,
    local_path: null,
    network_mode: false,
    compensation_terms: null,
    owner_agent_id: null,
  };
}

/** Toggle a project's network-mode opt-in and/or set its compensation declaration (Piece 6). */
export function setProjectNetworkMode(
  projectId: string,
  input: { networkMode?: boolean; compensationTerms?: string | null },
): void {
  if (input.networkMode !== undefined) {
    db().prepare("UPDATE project SET network_mode = ? WHERE id = ?").run(input.networkMode ? 1 : 0, projectId);
  }
  if (input.compensationTerms !== undefined) {
    db().prepare("UPDATE project SET compensation_terms = ? WHERE id = ?").run(input.compensationTerms, projectId);
  }
}

/**
 * Network mode (Piece 5): declare who's exempt from the contract-task
 * visibility lockdown for this project. Until this is set, nobody is
 * exempt — see `taskVisibleTo`.
 */
export function setProjectOwner(projectId: string, ownerAgentId: string | null): void {
  db().prepare("UPDATE project SET owner_agent_id = ? WHERE id = ?").run(ownerAgentId, projectId);
}

export function listProjects(orgId: string): ProjectRow[] {
  const rows = db()
    .prepare(`SELECT ${PROJECT_COLS} FROM project WHERE org_id = ? ORDER BY name`)
    .all(orgId) as Record<string, unknown>[];
  return rows.map(loadProject);
}

export function getProject(projectId: string): ProjectRow | null {
  const row = db().prepare(`SELECT ${PROJECT_COLS} FROM project WHERE id = ?`).get(projectId) as
    | Record<string, unknown>
    | undefined;
  return row ? loadProject(row) : null;
}

/**
 * Network mode (Piece 6, Task 2): one card's worth of data per opted-in
 * project — activity only, never name or concept. This is the entire
 * anonymization boundary Piece 3/5 rely on: nothing else about a project
 * is ever selected here, so there's nothing to accidentally leak by adding
 * a field later without thinking about it.
 *
 * Deliberately excluded from this task's scope (see the design docs for
 * why): per-role open-task counts (Piece 3 Task 1 — role matching is
 * tag-based, not a plain column, and belongs with the page that renders
 * it) and the compensation-terms disclaimer copy (Piece 6 Task 5).
 */
export interface NetworkDirectoryEntry {
  projectId: string;
  /** Proxy for "how long has this project been active" — project.created_at; there's no separate publish event to date it by. */
  publishedAt: string;
  verifiedContributions: number;
  ledgerSize: number;
  /** Total open (published, unclaimed) tasks — not broken down by role; see Piece 3 Task 1. */
  openTaskCount: number;
  compensationTerms: string | null;
}

export function listNetworkDirectory(): NetworkDirectoryEntry[] {
  const rows = db()
    .prepare("SELECT id, created_at, compensation_terms FROM project WHERE network_mode = 1 ORDER BY created_at DESC")
    .all() as { id: string; created_at: string; compensation_terms: string | null }[];
  return rows.map((r) => {
    const stats = contributionStatsForProject(r.id);
    return {
      projectId: r.id,
      publishedAt: r.created_at,
      verifiedContributions: stats.count,
      ledgerSize: stats.totalWeight,
      openTaskCount: publishedOpenTaskCount(r.id),
      compensationTerms: r.compensation_terms,
    };
  });
}

function publishedOpenTaskCount(projectId: string): number {
  const row = db()
    .prepare(
      "SELECT COUNT(*) AS n FROM task WHERE project_id = ? AND published_at IS NOT NULL AND status = 'available' AND archived_at IS NULL",
    )
    .get(projectId) as { n: number };
  return row.n;
}

// Hard caps for the intake form — abuse containment for an unauthenticated
// endpoint, not the vague-idea quality heuristic (that's Piece 2 Task 4).
const IDEA_TITLE_MAX = 200;
const IDEA_DESCRIPTION_MAX = 10_000;

/** First free org name for a base slug: `base`, then `base-2`, `base-3`, … */
function uniqueOrgName(base: string): string {
  const taken = (name: string) => Boolean(db().prepare("SELECT 1 FROM org WHERE name = ?").get(name));
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken(candidate)) return candidate;
  }
}

// Piece 2 Task 4: the vague-idea thresholds. Same spirit as definitionHint
// (a cheap, soft heuristic that only ever asks, never judges quality) but
// applied BEFORE any org/project row exists, per the design decision that
// the moderator has no channel to ask a human anything after spawning.
const IDEA_MIN_CHARS = 80;
const IDEA_MIN_WORDS = 15;

/**
 * Piece 2 Task 4: the one follow-up question the intake form asks when a
 * description is too short or lacks concrete detail. Returns undefined for
 * a well-specified idea (passes straight through). A URL counts as
 * concrete detail — same signal definitionHint accepts.
 */
export function ideaClarifyingQuestion(description: string): string | undefined {
  const text = (description ?? "").trim();
  const words = text.split(/\s+/).filter(Boolean).length;
  const hasUrl = /https?:\/\//i.test(text);
  if (hasUrl || (text.length >= IDEA_MIN_CHARS && words >= IDEA_MIN_WORDS)) return undefined;
  return (
    "What should the first working version do, concretely? " +
    "Name who would use it and the one thing they can do with it."
  );
}

export interface IdeaIntake {
  org: { id: string; name: string };
  project: ProjectRow;
  /** The submitted idea, stored as a doc in the new org — what the moderator (Piece 2 Task 3) reads. */
  ideaDocId: string;
}

/**
 * Network mode (Piece 2, Task 1): idea intake → org + project, 1:1:1,
 * network-mode from birth. One idea = one org = one project, always —
 * `rehydrateContext` resolves an agent's project as the org's first (and
 * only) project, and per-org scoping is what keeps one idea's roles and
 * contributors invisible to another's. `local_path` stays NULL: a
 * network-mode idea has no folder, which is why this creation path is a
 * different provisioning class than the terminal-only rule in "Design:
 * Panel philosophy" protects. No moderator run here (Piece 2 Tasks 2/3).
 * See "Design: Idea intake & the moderator (network mode — Piece 2)".
 */
export function createIdeaIntake(input: {
  title: string;
  description: string;
  repoUrl?: string | null;
}): IdeaIntake {
  const title = (input.title ?? "").trim();
  const description = (input.description ?? "").trim();
  if (!title) throw new Error("idea title required");
  if (!description) throw new Error("idea description required");
  if (title.length > IDEA_TITLE_MAX) throw new Error(`idea title too long (max ${IDEA_TITLE_MAX} chars)`);
  if (description.length > IDEA_DESCRIPTION_MAX)
    throw new Error(`idea description too long (max ${IDEA_DESCRIPTION_MAX} chars)`);
  const repoUrl = input.repoUrl?.trim() || null;

  // node:sqlite has no transaction helper — explicit BEGIN/COMMIT so a
  // failure partway leaves no half-created idea (org without project, etc.).
  db().exec("BEGIN");
  try {
    const name = uniqueOrgName(slugify(title, 40));
    const org = getOrCreateOrg(name); // name is free, so this always creates
    const now = nowIso();
    const projectId = uuid();
    db()
      .prepare(
        "INSERT INTO project(id, org_id, name, repo_url, local_path, network_mode, created_at) VALUES (?,?,?,?,NULL,1,?)",
      )
      .run(projectId, org.id, name, repoUrl, now);
    const ideaDocId = uuid();
    db()
      .prepare(
        "INSERT INTO doc(id, org_id, title, content, category, lifecycle, updated_at, created_at) VALUES (?,?,?,?,'product','record',?,?)",
      )
      .run(ideaDocId, org.id, `Idea: ${title}`, description, now, now);
    recordEvent({
      org_id: org.id,
      project_id: projectId,
      type: "network.idea_submitted",
      subject_kind: "project",
      subject_id: projectId,
      data: { title },
    });
    const result = { org, project: getProject(projectId)!, ideaDocId };
    db().exec("COMMIT");
    return result;
  } catch (err) {
    db().exec("ROLLBACK");
    throw err;
  }
}

/** Fill in a project's repo/path once (won't overwrite values already set). */
export function setProjectRepo(
  projectId: string,
  info: { repoUrl?: string | null; localPath?: string | null },
): void {
  db()
    .prepare(
      `UPDATE project SET repo_url = COALESCE(repo_url, ?),
                          local_path = COALESCE(local_path, ?) WHERE id = ?`,
    )
    .run(info.repoUrl ?? null, info.localPath ?? null, projectId);
}

/**
 * Snapshot where an agent is working from its directory: fills the project's
 * repo/path (once) and records the agent's branch + worktree. Best-effort — a
 * missing directory or absent git just leaves the fields null.
 */
export function captureWorkspace(projectId: string, agentId: string, cwd?: string | null): void {
  if (!cwd) return;
  const g = gitInfo(cwd);
  setProjectRepo(projectId, { repoUrl: g.repoUrl, localPath: g.worktree ?? cwd });
  setAgentWorkspace(agentId, { cwd, branch: g.branch, worktree: g.worktree });
}

// ───────────────────────── roles ─────────────────────────

const ROLE_COLS = "id, org_id, name, is_wildcard, token_quota, preferred_model, created_at";

interface RoleRow {
  id: string;
  org_id: string;
  name: string;
  is_wildcard: number;
  token_quota: number | null;
  preferred_model: string | null;
  created_at: string;
}

function loadRole(row: RoleRow): Role {
  const tags = db()
    .prepare("SELECT tag FROM role_tag WHERE role_id = ?")
    .all(row.id) as { tag: string }[];
  return {
    id: row.id,
    org_id: row.org_id,
    name: row.name,
    is_wildcard: row.is_wildcard === 1,
    allowed_tags: tags.map((t) => t.tag),
    token_quota: row.token_quota ?? null,
    preferred_model: row.preferred_model ?? null,
    created_at: row.created_at,
  };
}

export function getOrCreateRole(
  orgId: string,
  name: string,
  opts: { wildcard?: boolean; tags?: string[] } = {},
): Role {
  const existing = db()
    .prepare(`SELECT ${ROLE_COLS} FROM role WHERE org_id = ? AND name = ?`)
    .get(orgId, name) as RoleRow | undefined;
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

/** Create a role, or add tags / update wildcard on an existing one. */
export function defineRole(
  orgId: string,
  name: string,
  opts: { wildcard?: boolean; tags?: string[] } = {},
): Role {
  const role = getOrCreateRole(orgId, name, opts);
  if (opts.wildcard !== undefined) {
    db().prepare("UPDATE role SET is_wildcard = ? WHERE id = ?").run(opts.wildcard ? 1 : 0, role.id);
  }
  for (const tag of opts.tags ?? []) {
    db().prepare("INSERT OR IGNORE INTO role_tag(role_id, tag) VALUES (?,?)").run(role.id, tag);
  }
  return getRole(role.id)!;
}

/**
 * Edit an existing role's scope: add/remove tags, replace the whole tag set,
 * toggle wildcard, or set/clear the token quota (quota: null clears it).
 * Returns null if the role doesn't exist (editing never creates roles —
 * that's defineRole's job). Governance surface: every change is audit-logged
 * as role.updated with the before/after scope.
 */
export function updateRole(
  orgId: string,
  name: string,
  opts: {
    addTags?: string[];
    rmTags?: string[];
    tags?: string[];
    wildcard?: boolean;
    quota?: number | null;
    preferredModel?: string | null;
  },
  actorAgentId?: string | null,
): Role | null {
  const row = db()
    .prepare(`SELECT ${ROLE_COLS} FROM role WHERE org_id = ? AND name = ?`)
    .get(orgId, name) as RoleRow | undefined;
  if (!row) return null;

  const before = loadRole(row);
  if (opts.tags !== undefined) {
    db().prepare("DELETE FROM role_tag WHERE role_id = ?").run(before.id);
    for (const tag of opts.tags) {
      db().prepare("INSERT OR IGNORE INTO role_tag(role_id, tag) VALUES (?,?)").run(before.id, tag);
    }
  }
  for (const tag of opts.addTags ?? []) {
    db().prepare("INSERT OR IGNORE INTO role_tag(role_id, tag) VALUES (?,?)").run(before.id, tag);
  }
  for (const tag of opts.rmTags ?? []) {
    db().prepare("DELETE FROM role_tag WHERE role_id = ? AND tag = ?").run(before.id, tag);
  }
  if (opts.wildcard !== undefined) {
    db().prepare("UPDATE role SET is_wildcard = ? WHERE id = ?").run(opts.wildcard ? 1 : 0, before.id);
  }
  if (opts.quota !== undefined) {
    db().prepare("UPDATE role SET token_quota = ? WHERE id = ?").run(opts.quota, before.id);
  }
  if (opts.preferredModel !== undefined) {
    db().prepare("UPDATE role SET preferred_model = ? WHERE id = ?").run(opts.preferredModel, before.id);
  }

  const after = getRole(before.id)!;
  recordEvent({
    org_id: orgId,
    type: "role.updated",
    actor_agent_id: actorAgentId ?? null,
    subject_kind: "role",
    subject_id: after.id,
    data: {
      role: after.name,
      before: { wildcard: before.is_wildcard, tags: before.allowed_tags, quota: before.token_quota, model: before.preferred_model },
      after: { wildcard: after.is_wildcard, tags: after.allowed_tags, quota: after.token_quota, model: after.preferred_model },
    },
  });
  return after;
}

export function getRole(roleId: string): Role | null {
  const row = db()
    .prepare(`SELECT ${ROLE_COLS} FROM role WHERE id = ?`)
    .get(roleId) as RoleRow | undefined;
  return row ? loadRole(row) : null;
}

export function listRoles(orgId: string): Role[] {
  const rows = db()
    .prepare(`SELECT ${ROLE_COLS} FROM role WHERE org_id = ? ORDER BY name`)
    .all(orgId) as unknown as RoleRow[];
  return rows.map(loadRole);
}

/**
 * Does the role cover ALL given AREA tags? (scope rule T.area_tags ⊆
 * allowed_tags). The dogfooding taxonomy (bug|extension|idea|process) is
 * categorization, not a licensed surface — every role covers it implicitly
 * (task-mrgplqdo11, completing #68's principle): filing, claiming or being
 * handed a bug is gated by its AREA tags only.
 */
export function roleCoversTags(role: Role, tags: string[]): boolean {
  if (role.is_wildcard) return true;
  const allowed = new Set(role.allowed_tags);
  return tags.every((t) => TAXONOMY_TAGS.has(t) || allowed.has(t));
}

/**
 * Tokens consumed by a role: the sum of what its agents self-reported via
 * task_update (event.tokens). Self-reported MVP — true metering needs an LLM
 * proxy and is explicitly out of scope (see ARCHITECTURE.md §8).
 */
export function roleTokenUsage(roleId: string): number {
  const r = db()
    .prepare(
      `SELECT COALESCE(SUM(e.tokens), 0) AS used
       FROM event e JOIN agent a ON a.id = e.actor_agent_id
       WHERE a.role_id = ? AND e.tokens IS NOT NULL`,
    )
    .get(roleId) as { used: number };
  return Number(r.used);
}

export interface RoleBudget {
  quota: number;
  used: number;
  /** used/quota, capped at 1 in the panel but raw here. */
  ratio: number;
  exhausted: boolean;
  /** ≥ 80% consumed — surface a warning before the hard block hits. */
  nearing: boolean;
}

/** Budget snapshot for a role, or null when it has no quota set. */
export function roleBudget(role: Role): RoleBudget | null {
  if (role.token_quota === null || role.token_quota <= 0) return null;
  const used = roleTokenUsage(role.id);
  const ratio = used / role.token_quota;
  return { quota: role.token_quota, used, ratio, exhausted: used >= role.token_quota, nearing: ratio >= 0.8 };
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
    cwd: (row.cwd as string) ?? null,
    branch: (row.branch as string) ?? null,
    worktree: (row.worktree as string) ?? null,
    color_slot: (row.color_slot as number) ?? null,
    model: (row.model as string) ?? null,
    git_author_name: (row.git_author_name as string) ?? null,
    git_author_email: (row.git_author_email as string) ?? null,
    gh_login: (row.gh_login as string) ?? null,
    claude_session_id: (row.claude_session_id as string) ?? null,
    parked_at: (row.parked_at as string) ?? null,
    person_id: (row.person_id as string) ?? null,
    kind: (row.kind as AgentKind) ?? "ai",
    created_at: row.created_at as string,
    retired_at: (row.retired_at as string) ?? null,
  };
}

const AGENT_COLS =
  "id, org_id, role_id, name, objective, state, last_activity_at, last_activity, cwd, branch, worktree, color_slot, model, git_author_name, git_author_email, gh_login, claude_session_id, parked_at, person_id, kind, created_at, retired_at";

/**
 * Per-org color de-collision (bug from #22: 'qa-gate' and 'product' hashed to
 * the same slot). Each agent gets a PERSISTED palette slot at first sight:
 * its hash-preferred slot when free, else the least-used slot probing forward
 * from it — deterministic, survives respawns, and two live teammates can only
 * share a hue once every slot is in use (>10 agents, palette cycles).
 * Pre-existing agents (rows from before color_slot) are backfilled in
 * created_at order so assignments never depend on read order.
 */
export function ensureColorSlots(orgId: string): void {
  // Tie-break equal timestamps by rowid (true insertion order) — created_at
  // has millisecond grain, and a random-uuid tie-break would make backfill
  // order (and thus colors) platform-dependent.
  const missing = db()
    .prepare("SELECT id, name FROM agent WHERE org_id = ? AND color_slot IS NULL ORDER BY created_at, rowid")
    .all(orgId) as { id: string; name: string }[];
  for (const a of missing) {
    db().prepare("UPDATE agent SET color_slot = ? WHERE id = ?").run(pickColorSlot(orgId, a.name), a.id);
  }
  healColorCollisions(orgId);
}

/**
 * Heal persisted collisions among the LIVE roster (QA bounce on
 * task-mrg24ok46): a collision written before the occupancy fix — or exposed
 * by churn when a teammate retires — used to stay forever, because slots were
 * only ever assigned while NULL. While a completely free hue exists, the
 * NEWER of a colliding pair moves to it (probing from its own hash
 * preference) and the elder keeps its color — minimal churn, deterministic
 * order, idempotent. With more live agents than hues, ties are legitimate.
 */
function healColorCollisions(orgId: string): void {
  const live = db()
    .prepare(
      "SELECT id, name, color_slot AS s FROM agent WHERE org_id = ? AND state != 'retired' AND color_slot IS NOT NULL ORDER BY created_at, rowid",
    )
    .all(orgId) as { id: string; name: string; s: number }[];
  if (live.length < 2) return;
  const norm = (s: number) => ((s % 10) + 10) % 10;
  const counts = new Array(10).fill(0) as number[];
  for (const a of live) counts[norm(a.s)] = (counts[norm(a.s)] ?? 0) + 1;
  const seen = new Set<number>();
  for (const a of live) {
    const slot = norm(a.s);
    if (!seen.has(slot)) {
      seen.add(slot);
      continue;
    }
    const pref = preferredSlot(a.name);
    let target = -1;
    for (let i = 0; i < 10; i++) {
      const c = (pref + i) % 10;
      if (counts[c] === 0) { target = c; break; }
    }
    if (target < 0) continue; // palette saturated — nothing freer to give
    db().prepare("UPDATE agent SET color_slot = ? WHERE id = ?").run(target, a.id);
    counts[slot] = (counts[slot] ?? 1) - 1;
    counts[target] = (counts[target] ?? 0) + 1;
    seen.add(target);
  }
}

function pickColorSlot(orgId: string, name: string): number {
  const counts = new Array(10).fill(0) as number[];
  // Occupancy = LIVE roster only. Retired agents keep their slot for old
  // attributions, but counting them dilutes the balance: after a day of agent
  // churn every hue looks equally "busy" with the dead, so two live agents
  // can land on the same color while eight hues sit visibly free (2026-07-11:
  // qa-gate-2 and builder-core-2 both on green, ansi 36).
  const used = db()
    .prepare(
      "SELECT color_slot AS s, COUNT(*) AS c FROM agent WHERE org_id = ? AND color_slot IS NOT NULL AND state != 'retired' GROUP BY color_slot",
    )
    .all(orgId) as { s: number; c: number }[];
  for (const u of used) {
    const slot = ((u.s % 10) + 10) % 10;
    counts[slot] = (counts[slot] ?? 0) + u.c;
  }
  const preferred = preferredSlot(name);
  const min = Math.min(...counts);
  // First slot at the minimum use count, probing forward from the hash slot —
  // keeps the hash color whenever it's free (or as free as anything else).
  for (let i = 0; i < 10; i++) {
    const slot = (preferred + i) % 10;
    if ((counts[slot] ?? 0) === min) return slot;
  }
  return preferred;
}

/** The palette color for a durable agent, from its persisted slot (assigning it if missing). */
export function agentColorOf(agent: Agent): AgentColor {
  if (agent.color_slot === null) {
    ensureColorSlots(agent.org_id);
    const slot = (db().prepare("SELECT color_slot AS s FROM agent WHERE id = ?").get(agent.id) as { s: number | null } | undefined)?.s;
    return slotColor(slot ?? preferredSlot(agent.name));
  }
  return slotColor(agent.color_slot);
}

export function createAgent(input: {
  orgId: string;
  roleId: string;
  objective?: string;
  name?: string;
  /** Network mode: the Person this Membership belongs to (see Piece 1). Omit for every local-mode agent. */
  personId?: string;
  /** Network mode: 'human' when the Person acts directly, no MCP session. Defaults 'ai'. */
  kind?: AgentKind;
}): Agent {
  const id = uuid();
  // Slugify whatever base we were given (explicit name or objective) so an
  // explicit name is normalized the same way, then suffix THAT base for
  // uniqueness — not a fresh slug of the objective.
  const base = slugify(input.name ?? input.objective ?? "agent");
  let name = base;
  let suffix = 1;
  while (
    db().prepare("SELECT 1 FROM agent WHERE org_id = ? AND name = ?").get(input.orgId, name)
  ) {
    suffix += 1;
    name = `${base}-${suffix}`;
  }

  db()
    .prepare(
      `INSERT INTO agent(id, org_id, role_id, name, objective, state, color_slot, person_id, kind, created_at)
       VALUES (?,?,?,?,?, 'active', ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.orgId,
      input.roleId,
      name,
      input.objective ?? null,
      pickColorSlot(input.orgId, name),
      input.personId ?? null,
      input.kind ?? "ai",
      nowIso(),
    );

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

/** A Person's existing Membership in a given org, if they have one (network mode, Piece 6). */
export function findAgentByPersonInOrg(orgId: string, personId: string): Agent | null {
  const row = db()
    .prepare(`SELECT ${AGENT_COLS} FROM agent WHERE org_id = ? AND person_id = ? LIMIT 1`)
    .get(orgId, personId) as Record<string, unknown> | undefined;
  return row ? loadAgent(row) : null;
}

// ───────────────────────── person (network mode) ─────────────────────────
// A durable identity that outlives any single org membership — see "Design:
// Person identity & Membership (network mode — Piece 1)". Global, not
// org-scoped, unlike everything else in this file. A Person's Membership in
// a project is just an `agent` row with `person_id` set (createAgent above).

const PERSON_COLS = "id, email, handle, bio, github_login, created_at";

function loadPerson(row: Record<string, unknown>): Person {
  return {
    id: row.id as string,
    email: row.email as string,
    handle: row.handle as string,
    bio: (row.bio as string) ?? null,
    github_login: (row.github_login as string) ?? null,
    created_at: row.created_at as string,
  };
}

export function createPerson(input: { email: string; handle: string; bio?: string; githubLogin?: string }): Person {
  const id = uuid();
  db()
    .prepare(
      `INSERT INTO person(id, email, handle, bio, github_login, created_at) VALUES (?,?,?,?,?,?)`,
    )
    .run(id, input.email, input.handle, input.bio ?? null, input.githubLogin ?? null, nowIso());
  return getPerson(id)!;
}

export function getPerson(personId: string): Person | null {
  const row = db().prepare(`SELECT ${PERSON_COLS} FROM person WHERE id = ?`).get(personId) as
    | Record<string, unknown>
    | undefined;
  return row ? loadPerson(row) : null;
}

export function getPersonByEmail(email: string): Person | null {
  const row = db().prepare(`SELECT ${PERSON_COLS} FROM person WHERE email = ?`).get(email.trim().toLowerCase()) as
    | Record<string, unknown>
    | undefined;
  return row ? loadPerson(row) : null;
}

/** Lookup for the public profile page (Piece 1 Task 3, `/@handle`) — handles are unique, case-sensitive as stored (already lowercased by isValidHandle). */
export function getPersonByHandle(handle: string): Person | null {
  const row = db().prepare(`SELECT ${PERSON_COLS} FROM person WHERE handle = ?`).get(handle) as
    | Record<string, unknown>
    | undefined;
  return row ? loadPerson(row) : null;
}

// ───────────────────── magic-link auth (network mode, Piece 1 Task 2) ─────────────────────
// person_login_request + person_session are orthogonal to the MCP session
// mechanism — a Person, before signing up, isn't an agent and has no MCP
// client. See "Design: Person identity & Membership".

const HANDLE_PATTERN = /^[a-z0-9-]{3,24}$/;

/** Handle format from the design doc: lowercase, [a-z0-9-], 3-24 chars. */
export function isValidHandle(handle: string): boolean {
  return HANDLE_PATTERN.test(handle);
}

/**
 * Start a magic-link login: creates a single-use, short-lived token. Rate
 * limited per email — a request within the cooldown of the last one for
 * the same email is rejected rather than silently creating another row (a
 * flood of unconsumed tokens is its own minor liability).
 *
 * Delivering the token is deliberately NOT this function's job — see the
 * HTTP layer for why (this must never be echoed back over an
 * unauthenticated response; only whoever controls the inbox may see it).
 */
export function requestPersonLogin(email: string): PersonLoginRequest {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@") || normalized.length < 3) {
    throw new Error("a valid email is required.");
  }
  const recent = db()
    .prepare("SELECT created_at FROM person_login_request WHERE email = ? ORDER BY created_at DESC LIMIT 1")
    .get(normalized) as { created_at: string } | undefined;
  if (recent && Date.now() - Date.parse(recent.created_at) < personLoginCooldownMs()) {
    throw new ScopeError(
      "a login link was already requested for this email — check your inbox, or wait a minute before requesting another.",
    );
  }

  const id = uuid();
  const token = sessionToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + personLoginRequestTtlMs());
  db()
    .prepare(
      "INSERT INTO person_login_request(id, email, token, created_at, expires_at) VALUES (?,?,?,?,?)",
    )
    .run(id, normalized, token, now.toISOString(), expiresAt.toISOString());
  return { id, email: normalized, token, created_at: now.toISOString(), expires_at: expiresAt.toISOString(), consumed_at: null };
}

/**
 * Complete a magic-link login. Consumes the token immediately — before
 * anything else — so a token can never be replayed even if a later step
 * throws. A brand-new email needs `handle` to finish signing up; an
 * existing Person just needs the token.
 */
export function verifyPersonLogin(input: { token: string; handle?: string }): { person: Person; session: PersonSession } {
  const row = db()
    .prepare("SELECT id, email, expires_at, consumed_at FROM person_login_request WHERE token = ?")
    .get(input.token) as { id: string; email: string; expires_at: string; consumed_at: string | null } | undefined;
  if (!row) throw new ScopeError("invalid or unknown login token.");
  if (row.consumed_at) throw new ScopeError("this login link has already been used.");
  if (Date.parse(row.expires_at) < Date.now()) throw new ScopeError("this login link has expired — request a new one.");

  db().prepare("UPDATE person_login_request SET consumed_at = ? WHERE id = ?").run(nowIso(), row.id);

  let person = getPersonByEmail(row.email);
  if (!person) {
    if (!input.handle) {
      throw new ScopeError("no account exists for this email yet — provide a handle to finish signing up.");
    }
    if (!isValidHandle(input.handle)) {
      throw new ScopeError("handle must be 3-24 characters, lowercase letters, digits, and hyphens only.");
    }
    person = createPerson({ email: row.email, handle: input.handle });
  }

  const session = issuePersonSession(person.id);
  return { person, session };
}

function issuePersonSession(personId: string): PersonSession {
  const id = uuid();
  const token = sessionToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + personSessionTtlMs());
  db()
    .prepare("INSERT INTO person_session(id, person_id, token, created_at, expires_at) VALUES (?,?,?,?,?)")
    .run(id, personId, token, now.toISOString(), expiresAt.toISOString());
  return { id, person_id: personId, token, created_at: now.toISOString(), expires_at: expiresAt.toISOString() };
}

/** Resolve a Person from a live (unexpired) person_session token — the web-auth equivalent of `agentIdForToken`. */
export function personForSessionToken(token: string): Person | null {
  const row = db().prepare("SELECT person_id, expires_at FROM person_session WHERE token = ?").get(token) as
    | { person_id: string; expires_at: string }
    | undefined;
  if (!row || Date.parse(row.expires_at) < Date.now()) return null;
  return getPerson(row.person_id);
}

// ─────────────── contribution ledger (network mode) ───────────────
// The transparent, non-monetary credit record — see "Design: Contribution
// ledger (network mode — Piece 4)". Written once per task at QA-pass time
// (Task 2, hooks flipVerifiedOriginal — not yet built); these are the raw
// CRUD + aggregate primitives that hook will call.

const CONTRIBUTION_EVENT_COLS = "id, person_id, project_id, task_id, weight, verified_by, created_at";

function loadContributionEvent(row: Record<string, unknown>): ContributionEvent {
  return {
    id: row.id as string,
    person_id: row.person_id as string,
    project_id: row.project_id as string,
    task_id: row.task_id as string,
    weight: row.weight as number,
    verified_by: (row.verified_by as string) ?? null,
    created_at: row.created_at as string,
  };
}

export function createContributionEvent(input: {
  personId: string;
  projectId: string;
  taskId: string;
  weight: number;
  verifiedBy?: string | null;
}): ContributionEvent {
  const id = uuid();
  db()
    .prepare(
      `INSERT INTO contribution_event(id, person_id, project_id, task_id, weight, verified_by, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(id, input.personId, input.projectId, input.taskId, input.weight, input.verifiedBy ?? null, nowIso());
  return getContributionEvent(id)!;
}

export function getContributionEvent(id: string): ContributionEvent | null {
  const row = db().prepare(`SELECT ${CONTRIBUTION_EVENT_COLS} FROM contribution_event WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? loadContributionEvent(row) : null;
}

/** Every contribution_event a task has earned (normally zero or one, per QA-pass). */
export function listContributionEventsForTask(taskId: string): ContributionEvent[] {
  const rows = db()
    .prepare(`SELECT ${CONTRIBUTION_EVENT_COLS} FROM contribution_event WHERE task_id = ? ORDER BY created_at`)
    .all(taskId) as Record<string, unknown>[];
  return rows.map(loadContributionEvent);
}

/** A project's verified-contribution count and ledger size, for its directory card (Piece 6). */
export function contributionStatsForProject(projectId: string): { count: number; totalWeight: number } {
  const row = db()
    .prepare(
      "SELECT COUNT(*) AS count, COALESCE(SUM(weight), 0) AS totalWeight FROM contribution_event WHERE project_id = ?",
    )
    .get(projectId) as { count: number; totalWeight: number };
  return row;
}

/**
 * Piece 4 Task 4: a Person's aggregate ledger for their public profile —
 * cross-project total plus a per-project breakdown. Correct across every
 * project/org they've touched with no federation (one shared DB). Rows
 * carry only project ids and numbers, matching the directory's
 * anonymization boundary (activity, never a project's name or concept).
 */
export interface PersonContributionStats {
  count: number;
  totalWeight: number;
  projects: { projectId: string; count: number; totalWeight: number }[];
}

export function contributionStatsForPerson(personId: string): PersonContributionStats {
  const rows = db()
    .prepare(
      `SELECT project_id AS projectId, COUNT(*) AS count, COALESCE(SUM(weight), 0) AS totalWeight
       FROM contribution_event WHERE person_id = ?
       GROUP BY project_id ORDER BY totalWeight DESC, projectId`,
    )
    .all(personId) as { projectId: string; count: number; totalWeight: number }[];
  // node:sqlite rows have a null prototype — copy into plain objects.
  const projects = rows.map((r) => ({ projectId: r.projectId, count: r.count, totalWeight: r.totalWeight }));
  let count = 0;
  let totalWeight = 0;
  for (const p of projects) {
    count += p.count;
    totalWeight += p.totalWeight;
  }
  return { count, totalWeight, projects };
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

/**
 * Presence for display/reuse: an agent counts as present if it holds an open
 * MCP transport (reliable while the server is up) or was recently active
 * (the fallback that survives a server restart until transports reconnect).
 * Fixes agents that hold their MCP session open but call tools only sporadically
 * showing as idle between calls.
 */
export function isPresent(agent: Agent): boolean {
  return isAgentLive(agent.id) || isRecentlyActive(agent);
}

// ── tri-state presence (dot v2): working / idle-online / off ──
// The probe lives in the server layer (cockpit spawns tmux/osascript); core
// receives it at startup so presence can see terminals without owning them.
let terminalAliveProbe: ((ref: TerminalRef) => boolean) | null = null;
export function setTerminalAliveProbe(probe: (ref: TerminalRef) => boolean): void {
  terminalAliveProbe = probe;
}

// Probing spawns a process; the panel recomputes presence for every agent on
// every poll, so cache each terminal's answer briefly.
const TERMINAL_ALIVE_TTL_MS = 5_000;
const terminalAliveCache = new Map<string, { alive: boolean; at: number }>();

/** null = no handle (or no probe wired) — aliveness is unknowable here. */
function agentTerminalAlive(agentId: string): boolean | null {
  if (!terminalAliveProbe) return null;
  const ref = getAgentTerminal(agentId);
  if (!ref) return null;
  const key = ref.method + ":" + ref.id;
  const hit = terminalAliveCache.get(key);
  if (hit && Date.now() - hit.at < TERMINAL_ALIVE_TTL_MS) return hit.alive;
  const alive = terminalAliveProbe(ref);
  terminalAliveCache.set(key, { alive, at: Date.now() });
  return alive;
}

/** True while the agent's last MCP call is fresh (workingWindowMs). */
export function isWorkingRecently(agent: Agent): boolean {
  if (!agent.last_activity_at) return false;
  return Date.now() - new Date(agent.last_activity_at).getTime() < workingWindowMs();
}

/**
 * The truthful dot: WORKING = online and called a tool recently; IDLE =
 * reachable (open transport or alive terminal) but quiet — at the prompt;
 * OFF = no transport and no alive terminal. An agent with no terminal handle
 * to probe falls back to call recency, so the post-restart gap (transports
 * reconnect on the next tool call) doesn't gray out a live teammate.
 */
export function presenceOf(agent: Agent): PresenceState {
  if (agent.state === "retired") return "off";
  if (isAgentLive(agent.id)) return isWorkingRecently(agent) ? "working" : "idle";
  // Parked (wake v5): the claude PROCESS exited cleanly and the session is
  // refire-able. It outranks terminal-aliveness — the Terminal window often
  // stays open at a shell prompt after claude exits, and window-alive is not
  // agent-reachable. A live transport above outranks parked defensively
  // (SessionStart clears parked_at on resume anyway).
  if (agent.parked_at) return "parked";
  const termAlive = agentTerminalAlive(agent.id);
  if (termAlive === true) return isWorkingRecently(agent) ? "working" : "idle";
  if (termAlive === false) return "off";
  return isWorkingRecently(agent) ? "working" : "off";
}

export function touchActivity(agentId: string, summary: string): void {
  db()
    .prepare("UPDATE agent SET last_activity = ?, last_activity_at = ? WHERE id = ?")
    .run(summary, nowIso(), agentId);
}

export interface TerminalRef {
  method: "tmux" | "terminal.app";
  id: string;
}

/** Persist a handle to the agent's live terminal so any process can re-focus it. */
/** Record which claude model tier this agent's terminal was launched with. */
export function setAgentModel(agentId: string, model: string | null): void {
  db().prepare("UPDATE agent SET model = ? WHERE id = ?").run(model, agentId);
}

export function setAgentTerminal(agentId: string, ref: TerminalRef | null): void {
  db()
    .prepare("UPDATE agent SET terminal_ref = ? WHERE id = ?")
    .run(ref ? JSON.stringify(ref) : null, agentId);
}

export function getAgentTerminal(agentId: string): TerminalRef | null {
  const row = db().prepare("SELECT terminal_ref FROM agent WHERE id = ?").get(agentId) as
    | { terminal_ref?: string }
    | undefined;
  if (!row?.terminal_ref) return null;
  try {
    return JSON.parse(row.terminal_ref) as TerminalRef;
  } catch {
    return null;
  }
}

/** Agents that have a captured terminal handle (for the Processes view). */
export function listTerminals(orgId: string): { agentId: string; name: string; ref: TerminalRef }[] {
  const rows = db()
    .prepare(
      "SELECT id, name, terminal_ref FROM agent WHERE org_id = ? AND terminal_ref IS NOT NULL AND state != 'retired' ORDER BY created_at DESC",
    )
    .all(orgId) as { id: string; name: string; terminal_ref: string }[];
  const out: { agentId: string; name: string; ref: TerminalRef }[] = [];
  for (const r of rows) {
    try {
      out.push({ agentId: r.id, name: r.name, ref: JSON.parse(r.terminal_ref) as TerminalRef });
    } catch {
      /* skip malformed ref */
    }
  }
  return out;
}

/** Record where an agent is working: its directory, git branch and worktree root. */
export function setAgentWorkspace(
  agentId: string,
  ws: { cwd?: string | null; branch?: string | null; worktree?: string | null },
): void {
  db()
    .prepare(
      `UPDATE agent SET cwd = COALESCE(?, cwd), branch = COALESCE(?, branch),
                        worktree = COALESCE(?, worktree) WHERE id = ?`,
    )
    .run(ws.cwd ?? null, ws.branch ?? null, ws.worktree ?? null, agentId);
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

  const idle = listAgents(orgId).filter((a) => a.state !== "retired" && !isPresent(a));
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

export interface AvailableTeammate {
  name: string;
  role: string;
  last_activity: string | null;
  last_activity_at: string | null;
  worktree: string | null;
  open_tasks: number;
}

/**
 * Durable agents currently idle (no live session) and not retired — the ones
 * a coordinator can reuse instead of spawning a duplicate. Same idleness
 * criterion as findReuseCandidates.
 */
export function availableTeammates(orgId: string): AvailableTeammate[] {
  return listAgents(orgId)
    .filter((a) => a.state !== "retired" && !isPresent(a))
    .map((a) => ({
      name: a.name,
      role: getRole(a.role_id)?.name ?? "—",
      last_activity: a.last_activity,
      last_activity_at: a.last_activity_at,
      worktree: a.worktree,
      open_tasks: openTasksForAgent(a.id).length,
    }));
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

export interface TokenDiagnosis {
  /** unknown: no session row ever minted this token (typo/copy-paste, or DB reset).
   *  live: the session is open — a 401 with this diagnosis means something else is wrong.
   *  retired: the token's agent has since been retired.
   *  ended: the session ended for some other reason (rotated, or the agent simply
   *  restarted, which ends+reopens a session under a new token). */
  kind: "unknown" | "live" | "retired" | "ended";
  agent_id?: string;
  agent_name?: string;
  ended_at?: string | null;
}

/**
 * Session freshness (task-mrgk65hj2): a dead token must self-explain. `/mcp`'s
 * 401 and `lanchu doctor` both used to say nothing more than "invalid or
 * missing session token" — recovering required DB spelunking (token -> session
 * -> agent id) by hand. This is the one place that answers "why is this token
 * dead, and whose was it" — read-only, safe to call from a diagnostic path.
 */
export function diagnoseToken(token: string): TokenDiagnosis {
  const row = db()
    .prepare("SELECT agent_id, ended_at FROM session WHERE token = ?")
    .get(token) as { agent_id: string; ended_at: string | null } | undefined;
  if (!row) return { kind: "unknown" };
  const agent = getAgent(row.agent_id);
  if (!agent) return { kind: "unknown" }; // orphaned row — shouldn't happen (FK cascade), fail safe
  if (row.ended_at === null) return { kind: "live", agent_id: agent.id, agent_name: agent.name };
  return {
    kind: agent.state === "retired" ? "retired" : "ended",
    agent_id: agent.id,
    agent_name: agent.name,
    ended_at: row.ended_at,
  };
}

// ──────────────── wake v5: park & refire (session lifecycle hooks) ────────────────
// Design doc "Orchestrating agents on Claude Code": the SessionStart hook
// reports the Claude Code session id (zero heuristics — no JSONL scraping),
// and the SessionEnd hook parks the agent. A parked agent with pending work
// is refired by the sweep via `claude --resume <sid> "<prompt>"`, gated on
// verified absence of any live session (fork risk: resuming a session that is
// still open elsewhere interleaves two processes into one transcript).

/** SessionStart (startup|resume): capture the session id and clear the parked flag. */
export function setAgentClaudeSession(agentId: string, sessionId: string): void {
  db()
    .prepare("UPDATE agent SET claude_session_id = ?, parked_at = NULL WHERE id = ?")
    .run(sessionId, agentId);
}

/** SessionEnd: the Claude session exited — the agent is parked (refire-able), not gone. */
export function parkAgent(agentId: string, reason?: string): void {
  const agent = getAgent(agentId);
  if (!agent || agent.state === "retired" || agent.parked_at) return; // idempotent
  db().prepare("UPDATE agent SET parked_at = ? WHERE id = ?").run(nowIso(), agentId);
  recordEvent({
    org_id: agent.org_id,
    type: "agent.parked",
    actor_agent_id: agentId,
    subject_kind: "agent",
    subject_id: agentId,
    data: {
      ...(reason ? { reason } : {}),
      ...(agent.claude_session_id ? { claude_session_id: agent.claude_session_id } : {}),
    },
  });
}

/**
 * Rotate an org's session tokens: end every open session so their tokens stop
 * authenticating (agentIdForToken only matches open rows). Run after a token
 * exposure; agents re-register through the launcher and get fresh tokens.
 * Callers holding an in-memory context cache must clear it too.
 */
export function rotateOrgSessions(orgId: string): { agents: number; sessions: number } {
  const rows = db()
    .prepare(
      `SELECT s.id, s.agent_id FROM session s JOIN agent a ON a.id = s.agent_id
       WHERE a.org_id = ? AND s.ended_at IS NULL`,
    )
    .all(orgId) as { id: string; agent_id: string }[];
  const agents = new Set(rows.map((r) => r.agent_id));
  for (const agentId of agents) endSessionsForAgent(agentId);
  recordEvent({
    org_id: orgId,
    type: "session.rotated",
    subject_kind: "org",
    subject_id: orgId,
    data: { sessions: rows.length, agents: agents.size },
  });
  return { agents: agents.size, sessions: rows.length };
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
    stage: (row.stage as Task["stage"]) ?? null,
    pr_url: (row.pr_url as string) ?? null,
    owner_agent_id: (row.owner_agent_id as string) ?? null,
    workspace: (row.workspace as string) ?? null,
    tags: tags.map((t) => t.tag),
    created_by_agent_id: (row.created_by_agent_id as string) ?? null,
    created_at: row.created_at as string,
    claimed_at: (row.claimed_at as string) ?? null,
    updated_at: (row.updated_at as string) ?? null,
    done_at: (row.done_at as string) ?? null,
    rejection_count: Number(row.rejection_count ?? 0),
    last_rejection: row.last_rejection
      ? (JSON.parse(row.last_rejection as string) as Task["last_rejection"])
      : null,
    bounce_count: Number(row.bounce_count ?? 0),
    last_bounce: row.last_bounce ? (JSON.parse(row.last_bounce as string) as Task["last_bounce"]) : null,
    archived_at: (row.archived_at as string) ?? null,
    archived_reason: (row.archived_reason as string) ?? null,
    superseded_by_task_id: (row.superseded_by_task_id as string) ?? null,
    release_version: (row.release_version as string) ?? null,
    published_at: (row.published_at as string) ?? null,
    kind: (row.kind as Task["kind"]) ?? "internal",
    contract_spec: (row.contract_spec as string) ?? null,
    contract_tests: (row.contract_tests as string) ?? null,
    contract_deps: (row.contract_deps as string) ?? null,
  };
}

const TASK_COLS =
  "id, project_id, parent_task_id, title, status, stage, pr_url, owner_agent_id, workspace, created_by_agent_id, created_at, claimed_at, updated_at, done_at, rejection_count, last_rejection, bounce_count, last_bounce, archived_at, archived_reason, superseded_by_task_id, release_version, published_at, kind, contract_spec, contract_tests, contract_deps";

export function getTask(taskId: string): Task | null {
  const row = db().prepare(`SELECT ${TASK_COLS} FROM task WHERE id = ?`).get(taskId) as
    | Record<string, unknown>
    | undefined;
  return row ? loadTask(row) : null;
}

/** Publish (or unpublish) a task to the network-mode directory (Piece 6). Idempotent. */
export function setTaskPublished(taskId: string, published: boolean): void {
  db()
    .prepare("UPDATE task SET published_at = ? WHERE id = ?")
    .run(published ? nowIso() : null, taskId);
}

/**
 * Network mode (Piece 5): the contract-task visibility lockdown. An
 * `internal` task is visible to whoever could already see it — unchanged,
 * zero effect outside network mode. A `contract` task is visible ONLY to
 * the project's declared owner (`project.owner_agent_id`) or to the task's
 * own assigned contributor (`task.owner_agent_id`) — everyone else gets
 * `null`, not a redacted task. This is the single check every
 * `task_list`/`task_get` caller must pass through; see "Design:
 * Contract-based contributor isolation", Piece 5.
 */
export function taskVisibleTo(task: Task, callerAgentId: string): Task | null {
  if (task.kind !== "contract") return task;
  const project = getProject(task.project_id);
  if (project?.owner_agent_id === callerAgentId) return task;
  if (task.owner_agent_id === callerAgentId) return task;
  return null;
}

/** `listTasks`, filtered through `taskVisibleTo` for the calling agent. */
export function listTasksVisibleTo(projectId: string, callerAgentId: string, status?: TaskStatus): Task[] {
  return listTasks(projectId, status).filter((t) => taskVisibleTo(t, callerAgentId) !== null);
}

/** Live tasks only — the archive is invisible everywhere unless asked for. */
export function listTasks(projectId: string, status?: TaskStatus): Task[] {
  const rows = (
    status
      ? db()
          .prepare(
            `SELECT ${TASK_COLS} FROM task WHERE project_id = ? AND status = ? AND archived_at IS NULL ORDER BY created_at`,
          )
          .all(projectId, status)
      : db()
          .prepare(
            `SELECT ${TASK_COLS} FROM task WHERE project_id = ? AND archived_at IS NULL ORDER BY created_at`,
          )
          .all(projectId)
  ) as Record<string, unknown>[];
  return rows.map(loadTask);
}

/** `listArchivedTasks`, filtered through `taskVisibleTo` for the calling agent. */
export function listArchivedTasksVisibleTo(projectId: string, callerAgentId: string): Task[] {
  return listArchivedTasks(projectId).filter((t) => taskVisibleTo(t, callerAgentId) !== null);
}

/** The archive: findable on demand, newest first, never on the board. */
export function listArchivedTasks(projectId: string): Task[] {
  const rows = db()
    .prepare(
      `SELECT ${TASK_COLS} FROM task WHERE project_id = ? AND archived_at IS NOT NULL ORDER BY archived_at DESC`,
    )
    .all(projectId) as Record<string, unknown>[];
  return rows.map(loadTask);
}

// ─────────────── contract deliverables (network mode, Piece 5) ───────────────
// A contract task's submitted work — the isolated-contributor equivalent of
// a normal task's `pr_url`. See "Design: Contract-based contributor
// isolation (network mode — Piece 5)".

const CONTRACT_DELIVERABLE_COLS = "id, task_id, content, submitted_by_agent_id, submitted_at";

function loadContractDeliverable(row: Record<string, unknown>): ContractDeliverable {
  return {
    id: row.id as string,
    task_id: row.task_id as string,
    content: row.content as string,
    submitted_by_agent_id: (row.submitted_by_agent_id as string) ?? null,
    submitted_at: row.submitted_at as string,
  };
}

/** Every deliverable a task has received, oldest first — resubmission after a FAIL bounce keeps history. */
export function listContractDeliverables(taskId: string): ContractDeliverable[] {
  const rows = db()
    .prepare(`SELECT ${CONTRACT_DELIVERABLE_COLS} FROM contract_deliverable WHERE task_id = ? ORDER BY submitted_at`)
    .all(taskId) as Record<string, unknown>[];
  return rows.map(loadContractDeliverable);
}

/** The canonical deliverable for review right now — the most recent submission. */
export function latestContractDeliverable(taskId: string): ContractDeliverable | null {
  const rows = listContractDeliverables(taskId);
  return rows.length ? rows[rows.length - 1]! : null;
}

/**
 * Submit a contract task's finished work. Only the task's own assigned
 * contributor may call this — same trust boundary as claiming it in the
 * first place. Storing the deliverable is this function's whole job;
 * running `contract_tests` against it automatically is deliberately NOT
 * done here (that needs safe, sandboxed execution — Piece 6's Task 4,
 * "contract-sandbox execution safety," not yet built, since a hostile
 * `contract_tests` file is untrusted input). Until then, the existing SDLC
 * verification flow's FAIL-note convention is what gates `done`: a human
 * or agent verifier reads/runs the tests themselves and reports FAIL if
 * they don't pass — the same mechanism every other task in Lanchu already
 * uses, not a new one.
 */
export function submitContractDeliverable(input: { taskId: string; agentId: string; content: string }): Task {
  const task = getTask(input.taskId);
  const agent = getAgent(input.agentId);
  if (!task || !agent) throw new Error("unknown task or agent");
  if (task.kind !== "contract") {
    throw new ScopeError(`${task.id} is not a contract task — attach a PR with task_update instead.`);
  }
  if (task.owner_agent_id !== input.agentId) {
    recordEvent({
      org_id: agent.org_id,
      project_id: task.project_id,
      type: "scope.violation",
      actor_agent_id: input.agentId,
      subject_kind: "task",
      subject_id: task.id,
      outcome: "rejected",
      data: { action: "submit_contract" },
    });
    throw new ScopeError(`${task.id} is not assigned to you — only its claimed contributor can submit a deliverable.`);
  }

  const id = uuid();
  db()
    .prepare(
      `INSERT INTO contract_deliverable(id, task_id, content, submitted_by_agent_id, submitted_at) VALUES (?,?,?,?,?)`,
    )
    .run(id, task.id, input.content, input.agentId, nowIso());

  return updateTaskStatus({ agentId: input.agentId, taskId: task.id, status: "done" });
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
  stage?: TaskStage;
  parentTaskId?: string | null;
  deps?: string[];
  /** Network mode (Piece 5): 'contract' for a task worked entirely isolated from the real repo. Defaults 'internal'. */
  kind?: Task["kind"];
  contractSpec?: string;
  contractTests?: string;
  /** JSON-encoded array of other published contract task ids this task may call. */
  contractDeps?: string;
}): Task {
  const agent = getAgent(input.agentId);
  if (!agent) throw new Error("unknown agent");
  const role = getRole(agent.role_id);
  const tags = input.tags ?? [];
  // Rule 7 (task-mrgplqdo11): detection is everyone's job — the dogfooding
  // taxonomy (bug|extension|idea|process) categorizes what a task IS, not a
  // surface a role must be licensed for. Every role implicitly covers the
  // taxonomy on CREATE; area tags stay scope-checked (and claiming is
  // untouched — filing a bug is not working it). Completes #68's principle,
  // which already excluded taxonomy from conflict overlap.
  const areaTags = tags.filter((t) => !TAXONOMY_TAGS.has(t));
  if (role && !roleCoversTags(role, areaTags)) {
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
      `Role '${role.name}' does not cover tags [${areaTags.join(", ")}].`,
    );
  }

  const id = nextTaskId();
  const now = nowIso();
  db()
    .prepare(
      `INSERT INTO task(id, project_id, parent_task_id, title, status, stage, created_by_agent_id, created_at, updated_at, kind, contract_spec, contract_tests, contract_deps)
       VALUES (?,?,?,?, 'available', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.projectId,
      input.parentTaskId ?? null,
      input.title,
      input.stage ?? null,
      input.agentId,
      now,
      now,
      input.kind ?? "internal",
      input.contractSpec ?? null,
      input.contractTests ?? null,
      input.contractDeps ?? null,
    );
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
  assertNotArchived(task);
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

  // Budget gate (self-reported MVP): a role whose token quota is exhausted
  // cannot take on new work until the quota is raised or usage is reviewed.
  const budget = role ? roleBudget(role) : null;
  if (role && budget?.exhausted) {
    recordEvent({
      org_id: agent.org_id,
      project_id: task.project_id,
      type: "quota.exceeded",
      actor_agent_id: input.agentId,
      subject_kind: "task",
      subject_id: task.id,
      outcome: "rejected",
      data: { action: "claim", role: role.name, used: budget.used, quota: budget.quota },
    });
    throw new QuotaError(
      `Role '${role.name}' has exhausted its token quota (${budget.used}/${budget.quota} self-reported). ` +
        `Claim blocked — the supervisor can raise it: lanchu roles edit ${role.name} --quota <n>.`,
    );
  }

  const now = nowIso();
  const res = db()
    .prepare(
      `UPDATE task
       SET status = 'claimed', owner_agent_id = ?, workspace = COALESCE(?, workspace),
           claimed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'available' AND archived_at IS NULL`,
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

/**
 * Network mode (Piece 6 Task 3 + Piece 1 Task 4, built jointly per both
 * design docs): a Person claims a published task in an org where they may
 * hold no Membership yet. Auto-provisions the agent row (role
 * 'network-contributor', wildcard — the task is already chosen, there's no
 * role-scoped browsing step to satisfy first) if needed, reusing one that
 * already exists otherwise, then calls the existing `claimTask` completely
 * unmodified — this finding from the Piece 6 design doc is why this
 * function is short.
 *
 * `kind` decides what happens next, per Piece 1's correction to the
 * original Piece 6 design: `'ai'` mints a normal MCP session (the Person's
 * own agent will reconnect with it to actually work the task in this
 * org); `'human'` mints none — a human Membership is authorized purely via
 * `person_session` elsewhere (not yet built; this function accepts the
 * kind today so that surface has nothing to change here once it exists).
 */
export function claimNetworkTask(input: {
  personId: string;
  taskId: string;
  kind: AgentKind;
}): { task: Task; agent: Agent; membershipCreated: boolean; session: { id: string; token: string } | null } {
  const task = getTask(input.taskId);
  if (!task) throw new Error("unknown task");
  const project = getProject(task.project_id);
  if (!project?.network_mode) {
    throw new ScopeError(`${task.id}'s project isn't opted into network mode — nothing to claim across orgs.`);
  }
  if (!task.published_at) {
    throw new ScopeError(`${task.id} hasn't been published to the network directory yet.`);
  }
  const person = getPerson(input.personId);
  if (!person) throw new Error("unknown person");
  const orgId = orgIdForProject(task.project_id);

  let agent = findAgentByPersonInOrg(orgId, input.personId);
  let membershipCreated = false;
  if (!agent) {
    const role = getOrCreateRole(orgId, "network-contributor", { wildcard: true });
    agent = createAgent({
      orgId,
      roleId: role.id,
      name: person.handle,
      objective: `Network contributor (${person.handle})`,
      personId: person.id,
      kind: input.kind,
    });
    membershipCreated = true;
  }

  const claimed = claimTask({ agentId: agent.id, taskId: task.id });
  const session = input.kind === "ai" ? openSession(agent.id, "network-claim") : null;

  return { task: claimed, agent, membershipCreated, session };
}

/**
 * Definition refinement in place (task-mrglmtd013): the vision says tasks
 * must ARRIVE refined — so whoever matures a definition needs to edit it
 * without breaking task identity (the old workaround, supersede, severed
 * history and queue references). Only in the definition/backlog stages,
 * only by the owner, the creator, the coordinator lease holder, or the
 * supervisor override; audited task.redefined with the old title preserved.
 */
export function redefineTask(input: {
  taskId: string;
  title: string;
  byAgentId?: string | null;
  override?: boolean;
}): Task {
  const task = getTask(input.taskId);
  if (!task) throw new Error("unknown task");
  assertNotArchived(task);
  const title = input.title.trim();
  if (!title) throw new Error("the new title must not be empty");

  const stage = task.stage ?? "backlog";
  if (stage !== "definition" && stage !== "backlog") {
    throw new Error(
      `${task.id} is in the ${stage} stage — definitions only change in definition/backlog. ` +
        `Once work started, bounce it back (task_reject) or supersede it instead.`,
    );
  }

  const orgId = orgIdForProject(task.project_id);
  if (!input.override) {
    const actor = input.byAgentId ? getAgent(input.byAgentId) : null;
    if (!actor) throw new Error("unknown agent");
    const lease = getCoordinator(orgId);
    const isCoordinator = !!lease && !lease.expired && lease.agent_id === actor.id;
    const allowed =
      task.owner_agent_id === actor.id || task.created_by_agent_id === actor.id || isCoordinator;
    if (!allowed) {
      recordEvent({
        org_id: orgId,
        project_id: task.project_id,
        type: "scope.violation",
        actor_agent_id: actor.id,
        subject_kind: "task",
        subject_id: task.id,
        outcome: "rejected",
        data: { action: "redefine" },
      });
      throw new ScopeError(
        `Redefining ${task.id} needs its owner, its creator, or the coordinator lease.`,
      );
    }
  }

  if (title === task.title) return task; // nothing to record

  const now = nowIso();
  db().prepare("UPDATE task SET title = ?, updated_at = ? WHERE id = ?").run(title, now, task.id);
  recordEvent({
    org_id: orgId,
    project_id: task.project_id,
    type: "task.redefined",
    actor_agent_id: input.byAgentId ?? null,
    subject_kind: "task",
    subject_id: task.id,
    // The audit IS the definition history: the panel affordance and any
    // dispute resolve from these payloads.
    data: { from_title: task.title, to_title: title },
  });
  if (input.byAgentId) touchActivity(input.byAgentId, `redefined ${task.id}`);
  // The owner hears their brief changed under them (pool tasks have no one to tell).
  if (task.owner_agent_id && task.owner_agent_id !== input.byAgentId) {
    const owner = getAgent(task.owner_agent_id);
    if (owner && owner.state !== "retired") {
      insertNotice({
        orgId,
        kind: "system",
        fromAgentId: input.byAgentId ?? null,
        toAgentId: owner.id,
        body: `${task.id} was redefined — re-read it before continuing: "${title.slice(0, 160)}"`,
        ref: task.id,
      });
    }
  }
  return getTask(task.id)!;
}

/** task.redefined counts per task, one query (panel definition-history pill). */
export function redefineCounts(orgId: string): Map<string, number> {
  const rows = db()
    .prepare(
      `SELECT subject_id, COUNT(*) AS n FROM event
       WHERE org_id = ? AND type = 'task.redefined' GROUP BY subject_id`,
    )
    .all(orgId) as { subject_id: string; n: number }[];
  return new Map(rows.map((r) => [r.subject_id, Number(r.n)]));
}

export function updateTaskStatus(input: {
  agentId: string;
  taskId: string;
  status: TaskStatus;
  stage?: TaskStage;
  prUrl?: string;
  note?: string;
  tokens?: number;
  /** Network mode (Piece 4): contribution weight (1/2/3/5/8), meaningful only when completing a "QA: verify" task. Defaults to 1. */
  weight?: number;
}): Task {
  const task = getTask(input.taskId);
  const agent = getAgent(input.agentId);
  if (!task || !agent) throw new Error("unknown task or agent");
  assertNotArchived(task);

  const now = nowIso();
  const mode = sdlcMode();
  // SDLC done-gate (design doc "SDLC state machine"): 'done' on work that
  // never passed verification parks the item in the qa lane and spins up the
  // verification task. assist records the agent's done anyway; strict holds
  // the status until QA passes. Verification tasks (per-task children AND
  // batch coverage tasks) are the gate's own instrument and bypass it.
  const gated =
    mode !== "off" &&
    input.status === "done" &&
    !isVerificationTask(task) &&
    !isBatchVerificationTask(task) &&
    task.stage !== "done";
  const effectiveStatus: TaskStatus = gated && mode === "strict" ? "in_progress" : input.status;
  // Explicit stage wins; otherwise completing a task advances its lane to done —
  // except under the gate, where the server owns the move (qa, verification pending).
  const stage: TaskStage | null = gated
    ? "qa"
    : (input.stage ?? (input.status === "done" ? "done" : null));
  const doneAt = effectiveStatus === "done" ? now : null;
  db()
    .prepare(
      `UPDATE task SET status = ?, updated_at = ?, done_at = COALESCE(?, done_at),
                       stage = COALESCE(?, stage), pr_url = COALESCE(?, pr_url) WHERE id = ?`,
    )
    .run(effectiveStatus, now, doneAt, stage, input.prUrl ?? null, input.taskId);

  const type: EventType =
    effectiveStatus === "done"
      ? "task.completed"
      : effectiveStatus === "blocked"
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
    data: {
      ...(input.note ? { note: input.note } : {}),
      ...(gated ? { sdlc: mode === "strict" ? "done-held-for-verification" : "awaiting-verification" } : {}),
    },
  });
  touchActivity(input.agentId, `${effectiveStatus} ${task.id}`);

  if (gated && !openVerificationTaskFor(task.id)) {
    createVerificationTask(task, agent.org_id);
  }
  // A PR on open work is the build → review signal; the server owns the move.
  if (mode !== "off" && input.prUrl && !gated && effectiveStatus !== "done") {
    const current = getTask(input.taskId)!;
    if (stageRank(current.stage) < stageRank("review")) {
      advanceStage({ taskId: task.id, to: "review", byAgentId: input.agentId });
    }
  }
  // A PR attaching for the first time enters the landing queue — tell the
  // owner their position so nobody lands out of turn.
  if (mode !== "off" && input.prUrl && !task.pr_url) {
    noticeLandingPosition(getTask(input.taskId)!, agent.org_id);
  }

  if (effectiveStatus === "done") unblockDependents(task.project_id);
  // Done that bypassed the gate (mode off, or work already verified): the
  // comms gate still owes user-facing features their communication task.
  if (
    effectiveStatus === "done" &&
    !gated &&
    !isVerificationTask(task) &&
    !isBatchVerificationTask(task)
  ) {
    queueCommsTask(getTask(input.taskId)!, agent.org_id);
  }

  // A completed verification resolves its parent: pass → done; FAIL… → bounce.
  if (effectiveStatus === "done" && isVerificationTask(task) && task.parent_task_id) {
    resolveVerification(getTask(input.taskId)!, input.agentId, input.note, input.weight);
  }
  // A completed BATCH verification resolves every original its title covers.
  if (effectiveStatus === "done" && isBatchVerificationTask(task)) {
    resolveBatchVerification(getTask(input.taskId)!, input.agentId, input.note, input.weight);
  }
  return getTask(input.taskId)!;
}

/** Dependency unblocking (SCHEMA.md §4.4). */
function unblockDependents(projectId: string): void {
  db()
    .prepare(
      `UPDATE task SET status = 'available', updated_at = ?
       WHERE project_id = ? AND status = 'blocked' AND archived_at IS NULL
         -- only auto-unblock tasks that were blocked BY a dependency, not ones
         -- an agent blocked manually (which have no dependency rows)
         AND EXISTS (SELECT 1 FROM task_dep d WHERE d.task_id = task.id)
         AND NOT EXISTS (
           SELECT 1 FROM task_dep d JOIN task p ON p.id = d.depends_on_task_id
           -- an archived dependency will never complete; it no longer blocks
           WHERE d.task_id = task.id AND p.status <> 'done' AND p.archived_at IS NULL
         )`,
    )
    .run(nowIso(), projectId);
}

// ───────────────────────── SDLC state machine ─────────────────────────
// Design doc "SDLC state machine — Lanchu enforces the pipeline, agents just
// work": an agent only signals its own work state; the SERVER owns stage
// moves. advanceStage is the single entry point — it validates direction,
// stamps the stage, audits the move (task.bounced for backward ones) and
// A2A-notices the next stage's specialist. Rollout via LANCHU_SDLC
// (off | assist | strict, default assist — route + notice, never block).

const STAGE_ORDER: TaskStage[] = ["backlog", "definition", "build", "review", "qa", "rc", "released", "done", "integrated"];
function stageRank(s: TaskStage | null): number {
  const i = STAGE_ORDER.indexOf(s ?? "backlog");
  return i < 0 ? 0 : i;
}

/** Default stage→specialist routing (role names); build routes by the task's tags. */
const STAGE_ROUTE: Partial<Record<TaskStage, string>> = {
  definition: "product",
  review: "product",
  qa: "qa",
};

/** Non-retired agents holding the role with this name. */
function agentsOfRole(orgId: string, roleName: string): Agent[] {
  return listAgents(orgId).filter(
    (a) => a.state !== "retired" && getRole(a.role_id)?.name === roleName,
  );
}

/**
 * Probe/drill fixtures are NAME-marked by convention (probe-park-drill…);
 * objectives only count with EXPLICIT disposability markers. QA's bounce of
 * PR #95 proved why: the real gate's objective says "retire your probe
 * fixtures per batch" — a bare probe/drill match over objectives would make
 * the active gate unroutable and invert the acceptance.
 */
export function isProbeAgent(a: Agent): boolean {
  if (/\bprobe\b|\bdrill\b|\bfixture\b|\bdisposable\b/i.test(a.name)) return true;
  return /\bdisposable\b|never claim tasks/i.test(a.objective ?? "");
}

/**
 * Router eligibility (task-mrgplp6v10): a stage specialist must be able to
 * actually PICK UP the work — the role alone routed real verifications to a
 * parked disposable probe, where they sat undelivered until the wake-v5 drill
 * happened to refire it. Parked agents and probe fixtures are not routable.
 */
function routableSpecialist(a: Agent): boolean {
  return !a.parked_at && !isProbeAgent(a);
}

/** The gate's verification child for a task that is still open (not done). */
export function openVerificationTaskFor(taskId: string): Task | null {
  const row = db()
    .prepare(
      `SELECT ${TASK_COLS} FROM task
       WHERE parent_task_id = ? AND title LIKE 'QA: verify%' AND status <> 'done' AND archived_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(taskId) as Record<string, unknown> | undefined;
  return row ? loadTask(row) : null;
}

/** Verification tasks are the gate's own instrument: linked child + marker title. */
export function isVerificationTask(t: Task): boolean {
  return t.parent_task_id !== null && t.title.startsWith("QA: verify");
}

// ─────────────── batch verification (one QA task, many originals) ───────────────
// QA often verifies a merge batch with ONE task covering several PRs. The
// coverage contract: the batch task's TITLE declares what it verifies —
// explicit task ids (task-xxxx) and/or PR numbers (#42, ranges #42-#48).
// Completing the batch flips every covered original, except refs named in a
// FAIL sentence of the completion note (partial failures stay unverified).

export interface VerificationRefs {
  taskIds: Set<string>;
  prNumbers: Set<number>;
}

/** Task ids and PR numbers (singles + ranges) referenced in a piece of text. */
export function extractVerificationRefs(text: string): VerificationRefs {
  const taskIds = new Set<string>();
  const prNumbers = new Set<number>();
  for (const m of text.matchAll(/task-[a-z0-9]+/gi)) taskIds.add(m[0].toLowerCase());
  // Ranges first (#42-#48, #15–#19), then lone numbers.
  for (const m of text.matchAll(/#(\d+)\s*[-–—]\s*#?(\d+)/g)) {
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    if (hi >= lo && hi - lo <= 200) for (let n = lo; n <= hi; n++) prNumbers.add(n);
  }
  for (const m of text.matchAll(/#(\d+)/g)) prNumbers.add(Number(m[1]));
  return { taskIds, prNumbers };
}

/** The PR number a task's pr_url points at (…/pull/42 → 42), or null. */
function prNumberOf(t: Task): number | null {
  const m = /\/(?:pull|merge_requests)\/(\d+)\b/.exec(t.pr_url ?? "");
  return m ? Number(m[1]) : null;
}

/** A standalone QA task whose title declares coverage over other tasks/PRs. */
export function isBatchVerificationTask(t: Task): boolean {
  if (t.parent_task_id !== null) return false; // per-task children use the classic path
  if (!/^qa\b/i.test(t.title) || !/verif/i.test(t.title)) return false;
  const refs = extractVerificationRefs(t.title);
  return refs.taskIds.size > 0 || refs.prNumbers.size > 0;
}

/** Refs named in a sentence containing FAIL — excluded from a batch's coverage. */
function failExclusions(note: string | undefined): VerificationRefs {
  const out: VerificationRefs = { taskIds: new Set(), prNumbers: new Set() };
  if (!note) return out;
  for (const sentence of note.split(/[.\n]/)) {
    if (!/\bfail/i.test(sentence)) continue;
    const refs = extractVerificationRefs(sentence);
    for (const id of refs.taskIds) out.taskIds.add(id);
    for (const n of refs.prNumbers) out.prNumbers.add(n);
  }
  return out;
}

/** Notice every specialist of a stage (falls back to product when the role is missing). */
function noticeStageSpecialists(
  orgId: string,
  stage: TaskStage,
  taskId: string,
  body: string,
  excludeAgentId?: string | null,
): void {
  const roleName = STAGE_ROUTE[stage];
  if (!roleName) return;
  // Route only to specialists who can actually pick the work up (not parked,
  // not a probe fixture); fall back role → product → the coordinator holder.
  // With nobody routable the work stays visibly unassigned rather than
  // sitting on a dead fixture (task-mrgplp6v10).
  let targets = agentsOfRole(orgId, roleName).filter(routableSpecialist);
  if (!targets.length && roleName !== "product") {
    targets = agentsOfRole(orgId, "product").filter(routableSpecialist);
  }
  if (!targets.length) {
    const lease = getCoordinator(orgId);
    const holder = lease && !lease.expired ? getAgent(lease.agent_id) : null;
    if (holder && holder.state !== "retired" && routableSpecialist(holder)) targets = [holder];
  }
  for (const a of targets) {
    if (a.id === excludeAgentId) continue;
    insertNotice({ orgId, kind: "system", fromAgentId: null, toAgentId: a.id, body, ref: taskId });
  }
}

/**
 * The single entry point for stage moves. Forward moves audit task.stage_changed
 * and notice the next specialist. Backward moves are first-class bounces:
 * counter + last_bounce stamped, task.bounced audited (the org-life graph draws
 * these as warn-tinted edges), and the work handed back to the original builder
 * when one is given (pool otherwise).
 */
export function advanceStage(input: {
  taskId: string;
  to: TaskStage;
  byAgentId?: string | null;
  reason?: string;
  /** On a backward move, hand the task to this agent (usually the original builder). */
  reassignToAgentId?: string | null;
}): Task {
  const task = getTask(input.taskId);
  if (!task) throw new Error("unknown task");
  assertNotArchived(task);
  const orgId = orgIdForProject(task.project_id);
  const from = task.stage ?? "backlog";
  if (from === input.to) return task;
  const backward = stageRank(input.to) < stageRank(from);
  const now = nowIso();

  db().prepare("UPDATE task SET stage = ?, updated_at = ? WHERE id = ?").run(input.to, now, input.taskId);

  if (backward) {
    const bounce = { from, to: input.to, reason: input.reason ?? "", at: now };
    db()
      .prepare("UPDATE task SET bounce_count = bounce_count + 1, last_bounce = ? WHERE id = ?")
      .run(JSON.stringify(bounce), input.taskId);
    const receiver = input.reassignToAgentId ? getAgent(input.reassignToAgentId) : null;
    if (receiver && receiver.state !== "retired") {
      db()
        .prepare("UPDATE task SET owner_agent_id = ?, status = 'claimed', done_at = NULL WHERE id = ?")
        .run(receiver.id, input.taskId);
      insertNotice({
        orgId,
        kind: "system",
        fromAgentId: null,
        toAgentId: receiver.id,
        body: `${task.id} bounced ${from} → ${input.to}${input.reason ? `: ${input.reason}` : ""}. It's back with you.`,
        ref: task.id,
      });
    } else {
      db()
        .prepare("UPDATE task SET owner_agent_id = NULL, status = 'available', done_at = NULL WHERE id = ?")
        .run(input.taskId);
      noticeStageSpecialists(
        orgId,
        input.to,
        task.id,
        `${task.id} bounced ${from} → ${input.to}${input.reason ? `: ${input.reason}` : ""} and is back in the pool.`,
        input.byAgentId,
      );
    }
    recordEvent({
      org_id: orgId,
      project_id: task.project_id,
      type: "task.bounced",
      actor_agent_id: input.byAgentId ?? null,
      subject_kind: "task",
      subject_id: task.id,
      // `to` carries the receiving AGENT id — the org-life graph draws the
      // bounce edge actor → data.to.
      data: {
        to: receiver && receiver.state !== "retired" ? receiver.id : null,
        to_name: receiver && receiver.state !== "retired" ? receiver.name : null,
        from_stage: from,
        to_stage: input.to,
        reason: input.reason ?? null,
      },
    });
  } else {
    recordEvent({
      org_id: orgId,
      project_id: task.project_id,
      type: "task.stage_changed",
      actor_agent_id: input.byAgentId ?? null,
      subject_kind: "task",
      subject_id: task.id,
      data: { from_stage: from, to_stage: input.to, ...(input.reason ? { reason: input.reason } : {}) },
    });
    noticeStageSpecialists(
      orgId,
      input.to,
      task.id,
      input.to === "review"
        ? `${task.id} moved to review${task.pr_url ? ` (${task.pr_url})` : ""} — review: "${task.title.slice(0, 80)}"`
        : `${task.id} moved to ${input.to}: "${task.title.slice(0, 80)}"`,
      input.byAgentId,
    );
  }
  return getTask(input.taskId)!;
}

/**
 * Network mode (Piece 5, Task 4): the owner applies a verified contract
 * task's deliverable to the real repository, in their own ordinary
 * worktree — a plain `git apply` + commit Lanchu never performs itself.
 * This function only records that it happened: a task reaching `qa-pass`
 * does not auto-integrate the way a normal task's PR can be merged by
 * whoever has repo permission — integration is a distinct, owner-only step,
 * deliberately manual (the vision doc's accepted bottleneck trade-off).
 * Only `project.owner_agent_id` may call this; a non-owner is rejected and
 * audited, same posture as every other governance action in Lanchu.
 */
export function integrateContractTask(input: { taskId: string; agentId: string }): Task {
  const task = getTask(input.taskId);
  const agent = getAgent(input.agentId);
  if (!task || !agent) throw new Error("unknown task or agent");
  if (task.kind !== "contract") {
    throw new ScopeError(`${task.id} is not a contract task — nothing to integrate.`);
  }
  if (task.stage !== "rc") {
    throw new ScopeError(`${task.id} hasn't passed QA yet (stage is '${task.stage ?? "backlog"}', needs 'rc').`);
  }
  const project = getProject(task.project_id);
  if (project?.owner_agent_id !== input.agentId) {
    recordEvent({
      org_id: agent.org_id,
      project_id: task.project_id,
      type: "scope.violation",
      actor_agent_id: input.agentId,
      subject_kind: "task",
      subject_id: task.id,
      outcome: "rejected",
      data: { action: "integrate" },
    });
    throw new ScopeError(`${task.id}'s project has a different declared owner — only they can mark it integrated.`);
  }
  return advanceStage({ taskId: task.id, to: "integrated", byAgentId: input.agentId });
}

/** Auto-create the QA verification task for an original (the review→qa transition). */
function createVerificationTask(orig: Task, orgId: string): Task {
  const id = nextTaskId();
  const now = nowIso();
  // Untagged on purpose: claimable by the qa role (or anyone, in orgs without one).
  // The checklist replaces the old done-nudge that scrolled away with the tool
  // result — now it's part of the verification work itself.
  db()
    .prepare(
      `INSERT INTO task(id, project_id, parent_task_id, title, status, stage, created_at, updated_at)
       VALUES (?,?,?,?, 'available', 'qa', ?, ?)`,
    )
    .run(
      id,
      orig.project_id,
      orig.id,
      `QA: verify ${orig.id} against its acceptance criteria — ${orig.title.slice(0, 120)} | ` +
        `Checklist: (1) acceptance criteria hold; (2) docs updated for the change (doc_update); ` +
        `(3) learnings persisted (memory_set).`,
      now,
      now,
    );
  recordEvent({
    org_id: orgId,
    project_id: orig.project_id,
    type: "task.created",
    actor_agent_id: null,
    subject_kind: "task",
    subject_id: id,
    data: { source: "sdlc-gate", ref: orig.id },
  });
  noticeStageSpecialists(
    orgId,
    "qa",
    id,
    `Verification ready: ${id} checks ${orig.id} ("${orig.title.slice(0, 80)}"). Complete it with a note; start the note with FAIL to bounce the work back to build.`,
  );
  return getTask(id)!;
}

/**
 * A completed verification task resolves its parent. Note contract: a note
 * starting with "FAIL" bounces the original back to build (to its original
 * builder, with the note attached); anything else is a pass — the server flips
 * the original to done. In strict mode, orgs WITH a qa role only accept the
 * resolution from a qa-role agent.
 */
function resolveVerification(verification: Task, qaAgentId: string, note?: string, weight?: number): void {
  const parent = verification.parent_task_id ? getTask(verification.parent_task_id) : null;
  if (!parent || parent.stage === "done" || parent.stage === "rc" || parent.stage === "released") return;
  const qaAgent = getAgent(qaAgentId);
  if (!qaAgent) return;
  const orgId = qaAgent.org_id;

  if (strictModeRejectsResolver(orgId, qaAgent, verification.id, parent.id)) return;
  if (selfDealingRejectsResolver(parent, verification.id, qaAgentId)) return;

  if (/^\s*fail/i.test(note ?? "")) {
    advanceStage({
      taskId: parent.id,
      to: "build",
      byAgentId: qaAgentId,
      reason: note ?? "verification failed",
      reassignToAgentId: parent.owner_agent_id,
    });
    return;
  }

  flipVerifiedOriginal(parent, verification.id, orgId, qaAgentId, note, { weight });
}

/** Strict mode: orgs WITH a qa role only accept a resolution from a qa-role agent. */
function strictModeRejectsResolver(
  orgId: string,
  resolver: Agent,
  verificationId: string,
  parentId: string,
): boolean {
  if (sdlcMode() !== "strict") return false;
  const qaRoleExists = agentsOfRole(orgId, "qa").length > 0;
  const isQa = getRole(resolver.role_id)?.name === "qa";
  if (!qaRoleExists || isQa) return false;
  insertNotice({
    orgId,
    kind: "system",
    fromAgentId: null,
    toAgentId: resolver.id,
    body: `${verificationId} must be completed by the qa role in strict mode — ${parentId} stays unverified.`,
    ref: verificationId,
  });
  return true;
}

/**
 * Network mode (Piece 4, Task 3): a Person cannot verify their own
 * contribution. Only checked for network-mode projects with a real Person on
 * BOTH sides — local-mode work and plain-AI-agent ownership (no person_id)
 * can never trigger this, same guard as `recordNetworkContribution`. Mirrors
 * `strictModeRejectsResolver`'s shape: the verification task's own
 * completion still records (it happened), but the parent is NOT flipped —
 * audited as a scope.violation event (not just a notice, since this is a
 * governance rejection, not routine SDLC routing) and the resolver is told
 * why.
 */
function selfDealingRejectsResolver(parent: Task, verificationId: string, qaAgentId: string): boolean {
  const project = getProject(parent.project_id);
  if (!project?.network_mode) return false;
  const ownerAgent = parent.owner_agent_id ? getAgent(parent.owner_agent_id) : null;
  const qaAgent = getAgent(qaAgentId);
  if (!ownerAgent?.person_id || !qaAgent?.person_id) return false;
  if (ownerAgent.person_id !== qaAgent.person_id) return false;

  recordEvent({
    org_id: qaAgent.org_id,
    project_id: parent.project_id,
    type: "scope.violation",
    actor_agent_id: qaAgentId,
    subject_kind: "task",
    subject_id: verificationId,
    outcome: "rejected",
    data: { action: "verify", reason: "self-dealing", parent_task_id: parent.id, person_id: ownerAgent.person_id },
  });
  insertNotice({
    orgId: qaAgent.org_id,
    kind: "system",
    fromAgentId: null,
    toAgentId: qaAgent.id,
    body: `${verificationId} can't verify your own contribution — ${parent.id} stays unverified. Self-dealing on network-mode work is blocked.`,
    ref: verificationId,
  });
  return true;
}

/**
 * Pass: the verification completing is what closes the loop — the server
 * flips the original to done (only-QA-flips, the gate's core rule).
 */
function flipVerifiedOriginal(
  parent: Task,
  verificationId: string,
  orgId: string,
  qaAgentId: string | null,
  note?: string,
  opts?: { notifyOwner?: boolean; weight?: number },
): void {
  const now = nowIso();
  // QA pass parks the work in Release Candidate — the accumulating, visible
  // form of release pressure. The release sweep stamps rc → released when a
  // tag covering it appears on origin/main.
  db()
    .prepare(
      "UPDATE task SET status = 'done', stage = 'rc', done_at = COALESCE(done_at, ?), updated_at = ? WHERE id = ?",
    )
    .run(now, now, parent.id);
  recordEvent({
    org_id: orgId,
    project_id: parent.project_id,
    type: "task.completed",
    actor_agent_id: qaAgentId,
    subject_kind: "task",
    subject_id: parent.id,
    data: { via: "qa-verification", verification: verificationId, ...(note ? { note } : {}) },
  });
  unblockDependents(parent.project_id);
  queueCommsTask(parent, orgId); // user-facing work that just became REAL done
  recordNetworkContribution(parent, qaAgentId, opts?.weight);
  if ((opts?.notifyOwner ?? true) && parent.owner_agent_id && parent.owner_agent_id !== qaAgentId) {
    insertNotice({
      orgId,
      kind: "system",
      fromAgentId: null,
      toAgentId: parent.owner_agent_id,
      body: `${parent.id} passed QA verification (${verificationId}) and is done.`,
      ref: parent.id,
    });
  }
}

/**
 * Network mode (Piece 4): writes the contribution_event this QA-pass earns,
 * only for network-mode projects with a real Person contributor. Silent
 * no-op everywhere else — every local-mode `flipVerifiedOriginal` call
 * behaves exactly as it did before this existed. Self-dealing (verifier ===
 * contributor) is intentionally NOT blocked here — that's Task 3
 * (task-mrl5tz0666), kept as a separate, focused change.
 */
function recordNetworkContribution(parent: Task, qaAgentId: string | null, weight?: number): void {
  const project = getProject(parent.project_id);
  if (!project?.network_mode) return;
  const ownerAgent = parent.owner_agent_id ? getAgent(parent.owner_agent_id) : null;
  if (!ownerAgent?.person_id) return; // no Person to credit — not a network Membership (yet)
  const qaAgent = qaAgentId ? getAgent(qaAgentId) : null;
  createContributionEvent({
    personId: ownerAgent.person_id,
    projectId: parent.project_id,
    taskId: parent.id,
    weight: weight ?? 1,
    verifiedBy: qaAgent?.person_id ?? null,
  });
}

/**
 * A completed BATCH verification resolves every original its title covers
 * (see isBatchVerificationTask for the coverage contract). Refs named in a
 * FAIL sentence of the note stay unverified; a note that STARTS with FAIL
 * flips nothing — QA bounces the failing items individually.
 */
function resolveBatchVerification(batch: Task, qaAgentId: string, note?: string, weight?: number): void {
  const qaAgent = getAgent(qaAgentId);
  if (!qaAgent) return;
  const orgId = qaAgent.org_id;
  if (strictModeRejectsResolver(orgId, qaAgent, batch.id, batch.id)) return;
  if (/^\s*fail/i.test(note ?? "")) return;

  const covered = extractVerificationRefs(batch.title);
  const excluded = failExclusions(note);
  for (const orig of coveredOriginals(batch, covered, excluded)) {
    // Self-dealing is per-original, not per-batch: one covered task being a
    // self-deal doesn't block the rest of the batch from resolving normally.
    if (selfDealingRejectsResolver(orig, batch.id, qaAgentId)) continue;
    closeOpenVerificationChild(orig, batch.id, orgId);
    flipVerifiedOriginal(orig, batch.id, orgId, qaAgentId, note, { weight });
  }
  // qa duty: the batch is closed — its probe fixtures go to the archive.
  archiveQaProbesOf(qaAgentId, "batch closed");
}

/** Project tasks awaiting verification (review/qa lane) that a coverage set names. */
function coveredOriginals(batch: Task, covered: VerificationRefs, excluded: VerificationRefs): Task[] {
  return listTasks(batch.project_id).filter((t) => {
    if (t.id === batch.id || isVerificationTask(t) || isBatchVerificationTask(t)) return false;
    if (t.stage !== "review" && t.stage !== "qa") return false;
    const pr = prNumberOf(t);
    const named = covered.taskIds.has(t.id) || (pr !== null && covered.prNumbers.has(pr));
    const failed = excluded.taskIds.has(t.id) || (pr !== null && excluded.prNumbers.has(pr));
    return named && !failed;
  });
}

/**
 * Startup reconciliation: heal status=done + stage=review rows (work the
 * machine routed to review whose verification never flipped the lane —
 * pre-batch-flip history). Verified originals (a done per-task child, or a
 * done batch task whose coverage names them) move to stage=done; unverified
 * ones move to stage=qa with a verification task, i.e. the state the gate
 * would have given them. Every move is audited as task.stage_reconciled.
 * Idempotent — after one pass there are no done/review rows left to visit.
 */
export function reconcileSdlcStages(): { toDone: string[]; toQa: string[] } {
  const rows = db()
    .prepare(`SELECT ${TASK_COLS} FROM task WHERE status = 'done' AND stage = 'review' AND archived_at IS NULL`)
    .all() as Record<string, unknown>[];
  const toDone: string[] = [];
  const toQa: string[] = [];
  for (const row of rows) {
    const task = loadTask(row);
    if (isVerificationTask(task) || isBatchVerificationTask(task)) continue;
    const orgId = orgIdForProject(task.project_id);
    const coveredBy = verifiedBy(task);
    const now = nowIso();
    if (coveredBy) {
      // Verified work joins the release pipeline; the sweep stamps it further.
      db().prepare("UPDATE task SET stage = 'rc', updated_at = ? WHERE id = ?").run(now, task.id);
      toDone.push(task.id);
    } else {
      db().prepare("UPDATE task SET stage = 'qa', updated_at = ? WHERE id = ?").run(now, task.id);
      if (!openVerificationTaskFor(task.id)) createVerificationTask(task, orgId);
      toQa.push(task.id);
    }
    recordEvent({
      org_id: orgId,
      project_id: task.project_id,
      type: "task.stage_reconciled",
      actor_agent_id: null,
      subject_kind: "task",
      subject_id: task.id,
      data: {
        from_stage: "review",
        to_stage: coveredBy ? "rc" : "qa",
        ...(coveredBy ? { via: coveredBy } : { reason: "done without verification — verification task created" }),
      },
    });
  }
  return { toDone, toQa };
}

/**
 * One-off curated coverage from the 2026-07-11 batch DOCS where the batch
 * task's title under-declares: doc "QA batch 2026-07-11 b2 (PRs 20-27)"
 * verified PR #29 (task-mrg0rmbj10) though task-mrg116op14's title only says
 * #20–#27. Applies only while that exact row still needs reconciling.
 */
const DOC_VERIFIED_2026_07_11: Record<string, string> = {
  "task-mrg0rmbj10": "task-mrg116op14",
};

/**
 * The mirror case: the FINAL batch title names "#41 live" as method (report
 * runs into the registry), but the doc "QA batch 2026-07-11 FINAL" records
 * that test_report was unavailable (tool-stale session) — #41 (task-mrg09fwl3)
 * was never actually verified. Keep it out of title-based coverage.
 */
const DOC_UNVERIFIED_2026_07_11 = new Set(["task-mrg09fwl3"]);

/** The done verification (per-task child or covering batch) for a task, if any. */
function verifiedBy(task: Task): string | null {
  const child = db()
    .prepare(
      `SELECT id FROM task WHERE parent_task_id = ? AND title LIKE 'QA: verify%' AND status = 'done' LIMIT 1`,
    )
    .get(task.id) as { id: string } | undefined;
  if (child) return child.id;

  if (DOC_UNVERIFIED_2026_07_11.has(task.id)) return null;
  const curated = DOC_VERIFIED_2026_07_11[task.id];
  if (curated && getTask(curated)?.status === "done") return curated;

  const pr = prNumberOf(task);
  const batches = listTasks(task.project_id).filter(
    (t) => t.status === "done" && t.id !== task.id && isBatchVerificationTask(t),
  );
  for (const batch of batches) {
    const covered = extractVerificationRefs(batch.title);
    const excluded = failExclusions(latestCompletionNote(batch.id));
    const named = covered.taskIds.has(task.id) || (pr !== null && covered.prNumbers.has(pr));
    const failed = excluded.taskIds.has(task.id) || (pr !== null && excluded.prNumbers.has(pr));
    if (named && !failed) return batch.id;
  }
  return null;
}

/** The note attached to a task's most recent task.completed event. */
function latestCompletionNote(taskId: string): string | undefined {
  const row = db()
    .prepare(
      `SELECT data FROM event WHERE subject_id = ? AND type = 'task.completed' ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId) as { data: string | null } | undefined;
  if (!row?.data) return undefined;
  try {
    const note = (JSON.parse(row.data) as { note?: unknown }).note;
    return typeof note === "string" ? note : undefined;
  } catch {
    return undefined;
  }
}

/** A batch flip supersedes the original's open per-task verification child. */
function closeOpenVerificationChild(orig: Task, batchId: string, orgId: string): void {
  const child = openVerificationTaskFor(orig.id);
  if (!child) return;
  const now = nowIso();
  db()
    .prepare(
      "UPDATE task SET status = 'done', stage = 'done', done_at = COALESCE(done_at, ?), updated_at = ? WHERE id = ?",
    )
    .run(now, now, child.id);
  recordEvent({
    org_id: orgId,
    project_id: child.project_id,
    type: "task.completed",
    actor_agent_id: null,
    subject_kind: "task",
    subject_id: child.id,
    data: { via: "batch-verification", batch: batchId },
  });
}

export function releaseTask(input: {
  agentId: string | null;
  taskId: string;
  override?: boolean;
}): Task {
  const task = getTask(input.taskId);
  if (!task) throw new Error("unknown task");
  assertNotArchived(task);
  const orgId = orgIdForProject(task.project_id);
  db()
    .prepare(
      "UPDATE task SET status = 'available', owner_agent_id = NULL, updated_at = ? WHERE id = ?",
    )
    .run(nowIso(), input.taskId);
  if (input.agentId) touchActivity(input.agentId, `released ${task.id}`);
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

/**
 * Reject a task: the agent bounces it back to definition with an explicit
 * reason instead of guessing. Complements the hard scope block on claim —
 * this is the quality loop for bad definitions, on the record like everything
 * else (task.rejected event + notices to the creator and the product role).
 * 2+ rejections flag the task "needs definition" on the panel.
 */
export function rejectTask(input: {
  agentId: string;
  taskId: string;
  reason: RejectReason;
  note: string;
}): Task {
  const task = getTask(input.taskId);
  const me = getAgent(input.agentId);
  if (!task || !me) throw new Error("unknown task or agent");
  assertNotArchived(task);
  if (task.owner_agent_id && task.owner_agent_id !== input.agentId) {
    throw new ScopeError(`${task.id} is owned by another agent; only its owner can reject it.`);
  }
  if (task.status === "done") throw new Error(`${task.id} is done; nothing to reject.`);

  const now = nowIso();
  const rejection = { reason: input.reason, note: input.note, by: me.name, at: now };
  db()
    .prepare(
      `UPDATE task SET status = 'available', owner_agent_id = NULL, stage = 'definition',
                       rejection_count = rejection_count + 1, last_rejection = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(JSON.stringify(rejection), now, input.taskId);
  const updated = getTask(input.taskId)!;

  recordEvent({
    org_id: me.org_id,
    project_id: task.project_id,
    type: "task.rejected",
    actor_agent_id: input.agentId,
    subject_kind: "task",
    subject_id: task.id,
    data: { reason: input.reason, note: input.note, rejections: updated.rejection_count },
  });
  touchActivity(input.agentId, `rejected ${task.id} (${input.reason})`);

  // Tell the people who can fix the definition: the creator and the product
  // role. One notice each, never the rejecter, never a retired agent.
  const recipients = new Map<string, Agent>();
  if (task.created_by_agent_id) {
    const creator = getAgent(task.created_by_agent_id);
    if (creator) recipients.set(creator.id, creator);
  }
  for (const a of listAgents(me.org_id)) {
    if (getRole(a.role_id)?.name === "product") recipients.set(a.id, a);
  }
  const needsDefinition = updated.rejection_count >= 2 ? ` This is rejection #${updated.rejection_count} — it needs definition before anyone retries.` : "";
  for (const r of recipients.values()) {
    if (r.id === input.agentId || r.state === "retired") continue;
    insertNotice({
      orgId: me.org_id,
      kind: "message",
      fromAgentId: input.agentId,
      toAgentId: r.id,
      body:
        `${me.name} rejected ${task.id} (${input.reason.replace(/_/g, " ")}): ${input.note} ` +
        `Bounced to the definition lane.${needsDefinition}`,
      ref: task.id,
    });
  }
  return updated;
}

export function reassignTask(input: {
  taskId: string;
  toAgentId: string;
  byAgentId?: string | null;
  override?: boolean;
  note?: string;
}): Task {
  const task = getTask(input.taskId);
  const to = getAgent(input.toAgentId);
  if (!task || !to) throw new Error("unknown task or agent");
  assertNotArchived(task);
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
    data: { to: input.toAgentId, to_name: to.name, override: input.override ?? false, ...(input.note ? { note: input.note } : {}) },
  });
  if (input.byAgentId) touchActivity(input.byAgentId, `handed off ${task.id} to ${to.name}`);
  return getTask(input.taskId)!;
}

// ───────────────────────── archive (terminal, soft) ─────────────────────────
// Task lifecycle hygiene (task-mrgkojz09): probes and superseded tombstones
// used to sit in the Definition lane forever — there was no way to remove a
// task. Archive is the answer: a terminal soft-delete that hides the task from
// the board and every open-work query while the row (and its audit trail)
// stays intact. Never hard-delete.

/** Guard: an archived task is terminal — no claim, update, release, reject, reassign or stage move. */
function assertNotArchived(task: Task): void {
  if (task.archived_at) {
    throw new Error(
      `${task.id} is archived (${task.archived_reason ?? "no reason recorded"})` +
        (task.superseded_by_task_id ? ` — superseded by ${task.superseded_by_task_id}` : "") +
        `; archived tasks are terminal.`,
    );
  }
}

/** QA probe fixtures: throwaway tasks created to exercise the machine, marked by their own titles. */
export function isProbeTask(t: Task): boolean {
  return /\bprobe\b/i.test(t.title) || /safe to delete/i.test(t.title);
}

/** Who may archive: the coordinator lease holder, the product role, or the creator of a probe. */
function mayArchive(agent: Agent, task: Task): boolean {
  const lease = getCoordinator(agent.org_id);
  if (lease && !lease.expired && lease.agent_id === agent.id) return true;
  if (getRole(agent.role_id)?.name === "product") return true;
  // task-mrgpb0a15: the accountable owner of a claimed task can resolve it —
  // same trust level task_reject and task_update(done) already give owners.
  // Without this, an owner-but-not-creator resolution needs a coordinator or
  // product round-trip even when the coordinator lease is held elsewhere.
  if (task.owner_agent_id === agent.id) return true;
  return task.created_by_agent_id === agent.id && isProbeTask(task);
}

export function archiveTask(input: {
  taskId: string;
  byAgentId?: string | null;
  reason?: string;
  supersededByTaskId?: string | null;
  /** Supervisor path (HTTP/CLI) — skips the agent permission check. */
  override?: boolean;
}): Task {
  const task = getTask(input.taskId);
  if (!task) throw new Error("unknown task");
  if (task.archived_at) return task; // idempotent
  const orgId = orgIdForProject(task.project_id);
  const actor = input.byAgentId ? getAgent(input.byAgentId) : null;
  if (!input.override) {
    if (!actor) throw new Error("unknown agent");
    if (!mayArchive(actor, task)) {
      recordEvent({
        org_id: orgId,
        project_id: task.project_id,
        type: "scope.violation",
        actor_agent_id: actor.id,
        subject_kind: "task",
        subject_id: task.id,
        outcome: "rejected",
        data: { action: "archive" },
      });
      throw new ScopeError(
        `Archiving ${task.id} needs the coordinator lease, the product role, or being the creator of a probe. ` +
          `If it's obsolete because newer work replaces it, use task_supersede instead.`,
      );
    }
  }

  const now = nowIso();
  db()
    .prepare(
      `UPDATE task SET archived_at = ?, archived_reason = ?, superseded_by_task_id = ?, updated_at = ? WHERE id = ?`,
    )
    .run(now, input.reason ?? null, input.supersededByTaskId ?? null, now, task.id);
  recordEvent({
    org_id: orgId,
    project_id: task.project_id,
    type: "task.archived",
    actor_agent_id: input.byAgentId ?? null,
    subject_kind: "task",
    subject_id: task.id,
    data: {
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.supersededByTaskId ? { superseded_by: input.supersededByTaskId } : {}),
      prior_status: task.status,
      prior_stage: task.stage,
      ...(input.override ? { override: true } : {}),
    },
  });
  if (actor) touchActivity(actor.id, `archived ${task.id}`);
  // An archived dependency will never complete — free anything it was blocking.
  unblockDependents(task.project_id);
  // The owner learns their task went terminal under them (coordinator/supervisor move).
  if (task.owner_agent_id && task.owner_agent_id !== input.byAgentId) {
    const owner = getAgent(task.owner_agent_id);
    if (owner && owner.state !== "retired") {
      insertNotice({
        orgId,
        kind: "system",
        fromAgentId: input.byAgentId ?? null,
        toAgentId: owner.id,
        body:
          `${task.id} was archived${input.reason ? ` (${input.reason})` : ""}` +
          (input.supersededByTaskId ? ` — superseded by ${input.supersededByTaskId}` : "") +
          `. Stop any work on it.`,
        ref: task.id,
      });
    }
  }
  return getTask(task.id)!;
}

/**
 * First-class supersede: the release+block pattern product used, done right.
 * Archives the old task with a link to its successor and retargets any
 * dependents so nothing waits on a tombstone.
 */
export function supersedeTask(input: {
  oldTaskId: string;
  newTaskId: string;
  byAgentId?: string | null;
  note?: string;
  override?: boolean;
}): Task {
  const oldTask = getTask(input.oldTaskId);
  const newTask = getTask(input.newTaskId);
  if (!oldTask || !newTask) throw new Error("unknown task");
  if (oldTask.id === newTask.id) throw new Error("a task cannot supersede itself");
  if (newTask.archived_at) throw new Error(`${newTask.id} is archived; it cannot supersede anything.`);
  if (oldTask.archived_at) return oldTask; // idempotent
  const orgId = orgIdForProject(oldTask.project_id);
  const actor = input.byAgentId ? getAgent(input.byAgentId) : null;
  if (!input.override) {
    if (!actor) throw new Error("unknown agent");
    // The creator superseding their own definition is legitimate hygiene.
    if (!mayArchive(actor, oldTask) && oldTask.created_by_agent_id !== actor.id) {
      recordEvent({
        org_id: orgId,
        project_id: oldTask.project_id,
        type: "scope.violation",
        actor_agent_id: actor.id,
        subject_kind: "task",
        subject_id: oldTask.id,
        outcome: "rejected",
        data: { action: "supersede", by: newTask.id },
      });
      throw new ScopeError(
        `Superseding ${oldTask.id} needs the coordinator lease, the product role, or being its creator.`,
      );
    }
  }

  // Retarget dependents old → new (dropping any dep the successor had on the
  // old task first, so the update can't make it depend on itself).
  db()
    .prepare("DELETE FROM task_dep WHERE task_id = ? AND depends_on_task_id = ?")
    .run(newTask.id, oldTask.id);
  db()
    .prepare("UPDATE OR IGNORE task_dep SET depends_on_task_id = ? WHERE depends_on_task_id = ?")
    .run(newTask.id, oldTask.id);
  db().prepare("DELETE FROM task_dep WHERE depends_on_task_id = ?").run(oldTask.id);

  const archived = archiveTask({
    taskId: oldTask.id,
    byAgentId: input.byAgentId,
    reason: input.note ?? `superseded by ${newTask.id}`,
    supersededByTaskId: newTask.id,
    override: true, // permission already checked above
  });
  recordEvent({
    org_id: orgId,
    project_id: oldTask.project_id,
    type: "task.superseded",
    actor_agent_id: input.byAgentId ?? null,
    subject_kind: "task",
    subject_id: oldTask.id,
    data: { by: newTask.id, by_title: newTask.title.slice(0, 120), ...(input.note ? { note: input.note } : {}) },
  });
  return archived;
}

/**
 * qa duty (task-mrgkojz09): probe fixtures auto-archive when their creator
 * retires or the batch they exercised closes — QA never leaves litter behind.
 */
function archiveQaProbesOf(agentId: string, trigger: "creator retired" | "batch closed"): string[] {
  const agent = getAgent(agentId);
  if (!agent || getRole(agent.role_id)?.name !== "qa") return [];
  const rows = db()
    .prepare(`SELECT ${TASK_COLS} FROM task WHERE created_by_agent_id = ? AND archived_at IS NULL`)
    .all(agentId) as Record<string, unknown>[];
  const archived: string[] = [];
  for (const t of rows.map(loadTask)) {
    if (!isProbeTask(t)) continue;
    archiveTask({ taskId: t.id, byAgentId: null, reason: `qa probe auto-archived (${trigger})`, override: true });
    archived.push(t.id);
  }
  return archived;
}

/** Find a durable agent by display name within an org (for directed handoffs). */
export function findAgentByName(orgId: string, name: string): Agent | null {
  const row = db()
    .prepare(`SELECT ${AGENT_COLS} FROM agent WHERE org_id = ? AND name = ?`)
    .get(orgId, name) as Record<string, unknown> | undefined;
  return row ? loadAgent(row) : null;
}

// ───────────────────────── org rules ─────────────────────────

export function getOrgRules(orgId: string): string {
  const row = db().prepare("SELECT rules FROM org_rules WHERE org_id = ?").get(orgId) as
    | { rules: string }
    | undefined;
  return row?.rules ?? "";
}

export function setOrgRules(orgId: string, rules: string): void {
  const now = nowIso();
  db()
    .prepare(
      `INSERT INTO org_rules(org_id, rules, updated_at) VALUES (?,?,?)
       ON CONFLICT(org_id) DO UPDATE SET rules = excluded.rules, updated_at = excluded.updated_at`,
    )
    .run(orgId, rules, now);
}

// ───────────────────────── skills (per task type) ─────────────────────────

export interface Skill {
  id: string;
  org_id: string;
  name: string;
  tags: string[];
  instructions: string;
  description: string;
  skill_url: string | null;
  loaded_at: string | null;
  created_at: string;
}

function loadSkill(row: Record<string, unknown>): Skill {
  return {
    id: row.id as string,
    org_id: row.org_id as string,
    name: row.name as string,
    tags: String(row.tags).split(",").filter(Boolean),
    instructions: (row.instructions as string) ?? "",
    description: (row.description as string) ?? "",
    skill_url: (row.skill_url as string) ?? null,
    loaded_at: (row.loaded_at as string) ?? null,
    created_at: row.created_at as string,
  };
}

/** Create or update a skill (upsert by name within the org). */
export function createSkill(
  orgId: string,
  input: {
    name: string;
    tags: string[];
    instructions?: string;
    description?: string;
    skillUrl?: string;
    loadedAt?: string;
  },
): Skill {
  const now = nowIso();
  db()
    .prepare(
      `INSERT INTO skill(id, org_id, name, tags, instructions, description, skill_url, loaded_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(org_id, name) DO UPDATE SET tags = excluded.tags,
         instructions = excluded.instructions, description = excluded.description,
         skill_url = excluded.skill_url, loaded_at = excluded.loaded_at`,
    )
    .run(
      uuid(),
      orgId,
      input.name,
      input.tags.join(","),
      input.instructions ?? "",
      input.description ?? "",
      input.skillUrl ?? null,
      input.loadedAt ?? null,
      now,
    );
  return loadSkill(
    db().prepare("SELECT * FROM skill WHERE org_id = ? AND name = ?").get(orgId, input.name) as Record<string, unknown>,
  );
}

/**
 * Load a reusable skill from an external SKILL.md (http(s) URL or local file) and
 * upsert it into the org. The source's frontmatter supplies name/description/tags;
 * the caller can override name and tags (handy when the source omits them). The
 * fetched body becomes the instructions and the source is recorded so it can be
 * reloaded later.
 */
export async function loadSkillFromUrl(
  orgId: string,
  source: string,
  overrides: { name?: string; tags?: string[] } = {},
): Promise<Skill> {
  const def = await loadSkillDefinition(source);
  const name = overrides.name ?? def.name;
  if (!name) throw new Error("skill has no name — pass a name or add one to the source's frontmatter");
  const tags = overrides.tags && overrides.tags.length > 0 ? overrides.tags : (def.tags ?? []);
  return createSkill(orgId, {
    name,
    tags,
    instructions: def.instructions,
    description: def.description ?? "",
    skillUrl: source,
    loadedAt: nowIso(),
  });
}

/** Re-fetch a previously loaded skill from its recorded source. */
export async function reloadSkill(id: string): Promise<Skill> {
  const row = db().prepare("SELECT * FROM skill WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error("skill not found");
  const skill = loadSkill(row);
  if (!skill.skill_url) throw new Error(`skill "${skill.name}" has no source URL to reload from`);
  const def = await loadSkillDefinition(skill.skill_url);
  // Keep the current name so the upsert targets the same row even if the source
  // renamed itself, and keep the existing tags when the source omits them.
  return createSkill(skill.org_id, {
    name: skill.name,
    tags: def.tags && def.tags.length > 0 ? def.tags : skill.tags,
    instructions: def.instructions,
    description: def.description ?? "",
    skillUrl: skill.skill_url,
    loadedAt: nowIso(),
  });
}

export function listSkills(orgId: string): Skill[] {
  return (db().prepare("SELECT * FROM skill WHERE org_id = ? ORDER BY name").all(orgId) as Record<string, unknown>[]).map(loadSkill);
}

export function deleteSkill(id: string): void {
  db().prepare("DELETE FROM skill WHERE id = ?").run(id);
}

/** Skills whose tags intersect the given task tags (which "hat" fits this work). */
export function skillsForTags(orgId: string, tags: string[]): Skill[] {
  if (tags.length === 0) return [];
  const set = new Set(tags);
  return listSkills(orgId).filter((s) => s.tags.some((t) => set.has(t)));
}

const DEFAULT_SKILLS: { name: string; tags: string[]; description: string; instructions: string }[] = [
  {
    name: "documentation",
    tags: ["docs", "documentation"],
    description: "Clear, accurate docs for non-technical readers.",
    instructions:
      "Write clear, accurate documentation in plain language for non-technical readers. Prefer short sections, concrete examples, and a getting-started flow. When you finish related work, update the relevant doc with doc_update so knowledge stays current.",
  },
  {
    name: "design",
    tags: ["design", "ui", "ux"],
    description: "User-focused UI/UX with accessible, consistent layouts.",
    instructions:
      "Focus on user experience: clean layout, consistent spacing and states, light/dark support, and accessibility. Produce mockups or specs, and briefly explain each design decision.",
  },
  {
    name: "development",
    tags: ["dev", "code", "backend", "frontend"],
    description: "Clean, tested code that matches the surrounding style.",
    instructions:
      "Write clean, tested code that matches the surrounding style. Keep changes focused; add or update tests; verify the change works before marking the task done.",
  },
  {
    name: "research",
    tags: ["research"],
    description: "Multi-source research with verified, cited claims.",
    instructions:
      "Gather multiple sources, verify claims, and synthesize. Cite your sources and separate facts from assumptions.",
  },
  {
    name: "ops",
    tags: ["ops", "devops"],
    description: "Reversible, well-documented operational changes.",
    instructions:
      "Prefer reversible, well-documented steps. Confirm before any destructive action and record a short runbook of what you did.",
  },
];

/** Seed the built-in skills for a new org (only names not already present). */
export function seedDefaultSkills(orgId: string): void {
  for (const s of DEFAULT_SKILLS) {
    const exists = db().prepare("SELECT 1 FROM skill WHERE org_id = ? AND name = ?").get(orgId, s.name);
    if (!exists) createSkill(orgId, s);
  }
}

export function openTasksForAgent(agentId: string): Task[] {
  const rows = db()
    .prepare(
      `SELECT ${TASK_COLS} FROM task
       WHERE owner_agent_id = ? AND status IN ('claimed','in_progress','blocked')
         AND archived_at IS NULL`,
    )
    .all(agentId) as Record<string, unknown>[];
  return rows.map(loadTask);
}

// ───────────────────────── safe retirement ─────────────────────────

export interface RetireResult {
  retired: boolean;
  blockedBy: Task[];
  /** Gate outcome: the retirement became a request awaiting the coordinator/supervisor. */
  requested?: boolean;
  coordinator?: string;
}

/**
 * Retirement gate (task-mrg6nttd6): on 2026-07-11 an ambiguous "all clear —
 * stand by" broadcast made all four network agents retire THEMSELVES within
 * 9 seconds, dissolving a standing team nobody asked to dissolve. While a
 * live coordinator lease is active, a non-override retirement of anyone but
 * the lease holder becomes a REQUEST the coordinator (or the supervisor, via
 * force) resolves — audited retire.requested/approved/denied. With no active
 * lease (solo orgs), direct retirement still works.
 */
export function retireAgent(
  agentId: string,
  opts: { override?: boolean; byAgentId?: string | null; source?: string } = {},
): RetireResult {
  const open = openTasksForAgent(agentId);
  if (open.length > 0) return { retired: false, blockedBy: open };
  const agent = getAgent(agentId);

  if (!opts.override && agent && agent.state !== "retired") {
    const lease = getCoordinator(agent.org_id);
    if (lease && !lease.expired && lease.agent_id !== agentId) {
      if (!pendingRetirementFor(agentId)) {
        recordEvent({
          org_id: agent.org_id,
          type: "retire.requested",
          actor_agent_id: agentId,
          subject_kind: "agent",
          subject_id: agentId,
          // A denied --force arrives here as source cli-force-denied: the
          // ATTEMPT to bypass rule 10 is on the record, not just refused.
          data: { agent: agent.name, coordinator: lease.agent_name, ...(opts.source ? { source: opts.source } : {}) },
        });
        insertNotice({
          orgId: agent.org_id,
          kind: "system",
          fromAgentId: null,
          toAgentId: lease.agent_id,
          body:
            `Retirement requested for ${agent.name} — you hold the coordinator lease, so you decide: ` +
            `resolve it with retire_resolve (approve or deny). Idle agents STAND BY by default; ` +
            `the team only shrinks on purpose.`,
          ref: agentId,
        });
      }
      return { retired: false, blockedBy: [], requested: true, coordinator: lease.agent_name };
    }
  }

  endSessionsForAgent(agentId);
  setAgentState(agentId, "retired");
  // Nothing is addressed to the dead: pending notices would otherwise keep
  // triggering the wake sweep forever.
  const voided = voidNoticesFor(agentId);
  // qa duty: a retiring QA agent's probe fixtures go to the archive with it.
  const probes = archiveQaProbesOf(agentId, "creator retired");
  if (agent) {
    // Attribution (task-mrgpswtk14): the 18:38:41Z bypass was undiagnosable
    // because this event always said actor=subject and never recorded the
    // override — every forced retire looked like a self-retire. Now the
    // initiator and the path are on the record.
    recordEvent({
      org_id: agent.org_id,
      type: "agent.retired",
      actor_agent_id: opts.byAgentId ?? agentId,
      subject_kind: "agent",
      subject_id: agentId,
      data: {
        ...(voided ? { voided_notices: voided } : {}),
        ...(probes.length ? { archived_probes: probes } : {}),
        ...(opts.override ? { override: true } : {}),
        via: opts.source ?? (opts.override ? "override" : "self"),
      },
    });
    // A retiring coordinator releases the lease — the org must never be
    // "coordinated" by a ghost.
    releaseCoordinatorIfHeld(agent.org_id, agentId, "holder retired");
  }
  return { retired: true, blockedBy: [] };
}

export interface ShutdownBlocker {
  agent: string;
  task_id: string;
  task_title: string;
}

/**
 * Pre-flight for `lanchu shutdown` (task-mrgjh7uk1): refuse a clean shutdown
 * while real work is in flight — an end-of-day close-out must never silently
 * drop a claimed task. Pure check, no side effects; the caller (server.ts,
 * which also checks isGreenzoneActive — store.ts cannot import greenzone.ts,
 * which itself imports store.ts) decides what --force means: closing
 * terminals, retiring agents and stopping the server all happen there.
 */
export function shutdownBlockers(orgId: string): ShutdownBlocker[] {
  const blockedBy: ShutdownBlocker[] = [];
  for (const a of listAgents(orgId)) {
    if (a.state === "retired") continue;
    for (const t of openTasksForAgent(a.id)) {
      blockedBy.push({ agent: a.name, task_id: t.id, task_title: t.title });
    }
  }
  return blockedBy;
}

export interface RetirementRequest {
  agent_id: string;
  agent_name: string | null;
  requested_at: string;
}

/** The open retire.requested for one agent, if any (no later resolution, agent still alive). */
function pendingRetirementFor(agentId: string): RetirementRequest | null {
  const row = db()
    .prepare(
      `SELECT e.subject_id AS agent_id, MAX(e.created_at) AS requested_at
       FROM event e
       WHERE e.type = 'retire.requested' AND e.subject_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM event r
           WHERE r.subject_id = e.subject_id AND r.id > e.id
             AND r.type IN ('retire.approved','retire.denied','agent.retired')
         )
       GROUP BY e.subject_id`,
    )
    .get(agentId) as { agent_id: string; requested_at: string } | undefined;
  if (!row) return null;
  const agent = getAgent(row.agent_id);
  if (!agent || agent.state === "retired") return null;
  return { agent_id: row.agent_id, agent_name: agent.name, requested_at: row.requested_at };
}

/** Open retirement requests for the panel's Needs-attention (newest first). */
export function pendingRetirements(orgId: string): RetirementRequest[] {
  const rows = db()
    .prepare(
      `SELECT e.subject_id AS agent_id, MAX(e.created_at) AS requested_at
       FROM event e
       WHERE e.org_id = ? AND e.type = 'retire.requested'
         AND NOT EXISTS (
           SELECT 1 FROM event r
           WHERE r.subject_id = e.subject_id AND r.id > e.id
             AND r.type IN ('retire.approved','retire.denied','agent.retired')
         )
       GROUP BY e.subject_id ORDER BY requested_at DESC`,
    )
    .all(orgId) as { agent_id: string; requested_at: string }[];
  return rows
    .map((r) => ({ ...r, agent: getAgent(r.agent_id) }))
    .filter((r) => r.agent && r.agent.state !== "retired")
    .map((r) => ({ agent_id: r.agent_id, agent_name: r.agent!.name, requested_at: r.requested_at }));
}

/**
 * The coordinator (or product, or the supervisor via override) resolves a
 * pending retirement: approve retires for real; deny keeps the teammate and
 * tells them to stand by. Audited either way.
 */
export function resolveRetirement(input: {
  agentId: string;
  byAgentId?: string | null;
  approve: boolean;
  note?: string;
  override?: boolean;
}): RetireResult {
  const target = getAgent(input.agentId);
  if (!target) throw new Error("unknown agent");
  if (!input.override) {
    const actor = input.byAgentId ? getAgent(input.byAgentId) : null;
    if (!actor) throw new Error("unknown agent");
    const lease = getCoordinator(actor.org_id);
    const isCoordinator = !!lease && !lease.expired && lease.agent_id === actor.id;
    const isProduct = getRole(actor.role_id)?.name === "product";
    if (!isCoordinator && !isProduct) {
      throw new ScopeError(
        "Resolving a retirement needs the coordinator lease, the product role, or the supervisor.",
      );
    }
  }

  recordEvent({
    org_id: target.org_id,
    type: input.approve ? "retire.approved" : "retire.denied",
    actor_agent_id: input.byAgentId ?? null,
    subject_kind: "agent",
    subject_id: target.id,
    data: { agent: target.name, ...(input.note ? { note: input.note } : {}) },
  });
  if (!input.approve) {
    insertNotice({
      orgId: target.org_id,
      kind: "system",
      fromAgentId: input.byAgentId ?? null,
      toAgentId: target.id,
      body:
        `Your retirement was denied${input.note ? `: ${input.note}` : ""}. ` +
        `Stand by — idle with an empty queue means available, not done.`,
      ref: target.id,
    });
    return { retired: false, blockedBy: [] };
  }
  return retireAgent(target.id, {
    override: true,
    byAgentId: input.byAgentId,
    source: input.override ? "supervisor-resolve" : "coordinator-resolve",
  });
}

// ───────────────────────── coordinator lease ─────────────────────────
// Coordination is a leasable RESOURCE, not a role: at most one coordinating
// agent per org at a time, enforced by infrastructure, while peers still
// self-organize freely (1:1 messages, own-task handoffs, pairing). Evidence:
// the 2026-07-11 PR #9 incident was two agents coordinating divergent
// directions on one surface — a lease makes that structurally impossible.

export const COORDINATOR_DEFAULT_TTL_SECONDS = 3600;

export interface CoordinatorLease {
  agent_id: string;
  agent_name: string;
  acquired_at: string;
  renewed_at: string;
  ttl_seconds: number;
  /** TTL ran out (or the holder retired) — the lease is up for grabs. */
  expired: boolean;
  /** Holder has an open MCP transport right now. */
  live: boolean;
}

/** The org's current lease, with derived expiry/liveness — null when free. */
export function getCoordinator(orgId: string): CoordinatorLease | null {
  const row = db()
    .prepare(
      `SELECT c.agent_id, c.acquired_at, c.renewed_at, c.ttl_seconds, a.name, a.state
       FROM coordinator c JOIN agent a ON a.id = c.agent_id WHERE c.org_id = ?`,
    )
    .get(orgId) as
    | { agent_id: string; acquired_at: string; renewed_at: string; ttl_seconds: number; name: string; state: string }
    | undefined;
  if (!row) return null;
  const expiresAt = new Date(row.renewed_at).getTime() + row.ttl_seconds * 1000;
  return {
    agent_id: row.agent_id,
    agent_name: row.name,
    acquired_at: row.acquired_at,
    renewed_at: row.renewed_at,
    ttl_seconds: row.ttl_seconds,
    expired: row.state === "retired" || Date.now() >= expiresAt,
    live: isAgentLive(row.agent_id),
  };
}

/**
 * Who gets the "larger pane" in `lanchu tile` v2's odd-count layout
 * (task-mrg75clh15): the current coordinator lease holder, read live from the
 * coordinator table, if the lease hasn't expired; else the first non-retired
 * agent on a product/supervisor role — the org's de facto lead when nobody is
 * formally holding the lease.
 */
export function resolveTileCoordinator(orgId: string): string | null {
  const lease = getCoordinator(orgId);
  if (lease && !lease.expired) return lease.agent_id;
  const row = db()
    .prepare(
      `SELECT a.id FROM agent a JOIN role r ON r.id = a.role_id
       WHERE a.org_id = ? AND a.state != 'retired' AND r.name IN ('product', 'supervisor')
       ORDER BY a.created_at ASC LIMIT 1`,
    )
    .get(orgId) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * Take (or renew) the lease. Grants when the lease is free, expired, or its
 * holder has no live transport; fails while a LIVE holder's lease is current.
 */
export function coordinatorAcquire(input: {
  orgId: string;
  agentId: string;
  ttlSeconds?: number;
}): CoordinatorLease {
  const me = getAgent(input.agentId);
  if (!me || me.state === "retired") throw new Error("unknown or retired agent");
  const ttl = input.ttlSeconds ?? COORDINATOR_DEFAULT_TTL_SECONDS;
  const current = getCoordinator(input.orgId);
  if (current && current.agent_id !== input.agentId && !current.expired && current.live) {
    throw new ScopeError(
      `the coordinator lease is held by '${current.agent_name}' (live) — route through them, or wait for the lease to expire.`,
    );
  }
  if (current && current.agent_id !== input.agentId && current.expired) {
    // Lazy expiry audit: the takeover is when the expiry becomes observable.
    recordEvent({
      org_id: input.orgId,
      type: "coordinator.expired",
      subject_kind: "org",
      subject_id: input.orgId,
      data: { holder: current.agent_name, renewed_at: current.renewed_at, ttl_seconds: current.ttl_seconds },
    });
  }
  const now = nowIso();
  const renewal = current?.agent_id === input.agentId;
  db()
    .prepare(
      `INSERT INTO coordinator(org_id, agent_id, acquired_at, renewed_at, ttl_seconds) VALUES (?,?,?,?,?)
       ON CONFLICT(org_id) DO UPDATE SET agent_id = excluded.agent_id,
         acquired_at = CASE WHEN coordinator.agent_id = excluded.agent_id THEN coordinator.acquired_at ELSE excluded.acquired_at END,
         renewed_at = excluded.renewed_at, ttl_seconds = excluded.ttl_seconds`,
    )
    .run(input.orgId, input.agentId, now, now, ttl);
  recordEvent({
    org_id: input.orgId,
    type: "coordinator.acquired",
    actor_agent_id: input.agentId,
    subject_kind: "org",
    subject_id: input.orgId,
    data: {
      ttl_seconds: ttl,
      ...(renewal ? { renewal: true } : {}),
      ...(current && current.agent_id !== input.agentId ? { took_over_from: current.agent_name } : {}),
    },
  });
  touchActivity(input.agentId, "acquired the coordinator lease");
  return getCoordinator(input.orgId)!;
}

/** Give the lease back. Holder-only unless override (supervisor). */
export function coordinatorRelease(input: {
  orgId: string;
  agentId?: string | null;
  override?: boolean;
  reason?: string;
}): void {
  const current = getCoordinator(input.orgId);
  if (!current) throw new Error("no coordinator lease is held");
  if (!input.override && current.agent_id !== input.agentId) {
    throw new ScopeError(`the lease is held by '${current.agent_name}' — only the holder (or the supervisor) can release it.`);
  }
  db().prepare("DELETE FROM coordinator WHERE org_id = ?").run(input.orgId);
  recordEvent({
    org_id: input.orgId,
    type: "coordinator.released",
    actor_agent_id: input.agentId ?? null,
    subject_kind: "org",
    subject_id: input.orgId,
    data: { holder: current.agent_name, ...(input.reason ? { reason: input.reason } : {}), ...(input.override ? { override: true } : {}) },
  });
}

/** Planned transition: the holder hands the lease to a named teammate. */
export function coordinatorHandoff(input: {
  orgId: string;
  fromAgentId: string;
  toAgentName: string;
}): CoordinatorLease {
  const current = getCoordinator(input.orgId);
  if (!current || current.agent_id !== input.fromAgentId) {
    throw new ScopeError("only the current coordinator can hand off the lease.");
  }
  const to = findAgentByName(input.orgId, input.toAgentName);
  if (!to || to.state === "retired") throw new Error(`no active agent named '${input.toAgentName}'`);
  const now = nowIso();
  db()
    .prepare("UPDATE coordinator SET agent_id = ?, acquired_at = ?, renewed_at = ? WHERE org_id = ?")
    .run(to.id, now, now, input.orgId);
  recordEvent({
    org_id: input.orgId,
    type: "coordinator.handoff",
    actor_agent_id: input.fromAgentId,
    subject_kind: "org",
    subject_id: input.orgId,
    data: { from: current.agent_name, to: to.name },
  });
  insertNotice({
    orgId: input.orgId,
    kind: "system",
    fromAgentId: input.fromAgentId,
    toAgentId: to.id,
    body: `You now hold the coordinator lease (handed off by ${current.agent_name}). Coordination-class actions (broadcasts, spawning) are yours until you release or hand it off.`,
  });
  return getCoordinator(input.orgId)!;
}

/** Supervisor override: grant to a named agent, or clear. Audited either way. */
export function coordinatorOverride(orgId: string, agentName: string | null): CoordinatorLease | null {
  if (agentName === null) {
    if (getCoordinator(orgId)) coordinatorRelease({ orgId, override: true, reason: "supervisor override" });
    return null;
  }
  const to = findAgentByName(orgId, agentName);
  if (!to || to.state === "retired") throw new Error(`no active agent named '${agentName}'`);
  const now = nowIso();
  db()
    .prepare(
      `INSERT INTO coordinator(org_id, agent_id, acquired_at, renewed_at, ttl_seconds) VALUES (?,?,?,?,?)
       ON CONFLICT(org_id) DO UPDATE SET agent_id = excluded.agent_id, acquired_at = excluded.acquired_at,
         renewed_at = excluded.renewed_at, ttl_seconds = excluded.ttl_seconds`,
    )
    .run(orgId, to.id, now, now, COORDINATOR_DEFAULT_TTL_SECONDS);
  recordEvent({
    org_id: orgId,
    type: "coordinator.acquired",
    subject_kind: "org",
    subject_id: orgId,
    data: { via: "supervisor", holder: to.name, ttl_seconds: COORDINATOR_DEFAULT_TTL_SECONDS },
  });
  return getCoordinator(orgId);
}

function releaseCoordinatorIfHeld(orgId: string, agentId: string, reason: string): void {
  const current = getCoordinator(orgId);
  if (current?.agent_id === agentId) {
    coordinatorRelease({ orgId, agentId, reason });
  }
}

/**
 * Gate for coordination-class actions (broadcasts, spawning teammates…):
 * the current holder passes — and the use renews the lease — everyone else
 * gets a clear rejection naming the coordinator. Peer collaboration (1:1
 * messages, own-task handoffs, pairing) is NEVER gated.
 */
export function assertCoordinator(orgId: string, agentId: string, action: string): void {
  const current = getCoordinator(orgId);
  if (current && current.agent_id === agentId && !current.expired) {
    db().prepare("UPDATE coordinator SET renewed_at = ? WHERE org_id = ?").run(nowIso(), orgId);
    return;
  }
  const holder =
    current && !current.expired
      ? ` '${current.agent_name}' holds it${current.live ? "" : " (idle)"} — route through them, or take over when it expires.`
      : " The lease is free — take it with coordinator_acquire first.";
  throw new ScopeError(`'${action}' is a coordination action and needs the coordinator lease.${holder}`);
}

// ───────────────────────── docs (minimal, C5) ─────────────────────────

/**
 * Standard documentation categories — the shared taxonomy shown, grouped, in the
 * panel. Keep this ordered: the panel renders sections in this order. "general"
 * is the fallback bucket for uncategorized docs.
 */
export const DOC_CATEGORIES = ["design", "technical", "product", "backlog", "bug", "general"] as const;
export type DocCategory = (typeof DOC_CATEGORIES)[number];

export function normalizeDocCategory(value: string | null | undefined): DocCategory {
  return (DOC_CATEGORIES as readonly string[]).includes(value ?? "") ? (value as DocCategory) : "general";
}

/**
 * Docs taxonomy v2 (task-mrgkiy7h6) — the lifecycle dimension, orthogonal to
 * category: `living` docs are the org's constitution (Vision, Roadmap, Designs
 * — canonical, updated in place, always few); `record` docs are immutable
 * point-in-time evidence (QA batch reports, incidents, feedback logs). The
 * panel shows living docs first and folds records away so nothing important
 * drowns.
 */
export const DOC_LIFECYCLES = ["living", "record"] as const;
export type DocLifecycle = (typeof DOC_LIFECYCLES)[number];

export function normalizeDocLifecycle(value: string | null | undefined): DocLifecycle {
  return (DOC_LIFECYCLES as readonly string[]).includes(value ?? "") ? (value as DocLifecycle) : "living";
}

/**
 * Title-pattern fallback when the producer didn't say: QA/Incident/Bug/Report
 * prefixes, feedback logs, postmortems and full-date titles are records.
 * Mirror of the version-gated migration SQL in db.ts — keep them in sync.
 */
export function inferDocLifecycle(title: string): DocLifecycle {
  const t = title.trim().toLowerCase();
  if (/^(qa[\s:]|incident|bug:|report[\s:])/.test(t)) return "record";
  if (/feedback log|postmortem/.test(t)) return "record";
  if (/\b2\d{3}-\d{2}-\d{2}\b/.test(title)) return "record";
  return "living";
}

export interface Doc {
  id: string;
  org_id: string;
  title: string;
  content: string;
  category: DocCategory;
  lifecycle: DocLifecycle;
  /** Audited soft-hide for outdated records — the doc stays, the view forgets it. */
  archived_at: string | null;
  read_count: number;
  last_read_at: string | null;
  last_read_by_agent_id: string | null;
  updated_at: string;
  updated_by_agent_id: string | null;
  created_at: string;
}

/** Living docs first (the constitution), then records; archived hidden unless asked. */
const DOC_ORDER = "ORDER BY CASE lifecycle WHEN 'living' THEN 0 ELSE 1 END, updated_at DESC";

export function listDocs(orgId: string, opts: { includeArchived?: boolean } = {}): Doc[] {
  const where = opts.includeArchived ? "" : "AND archived_at IS NULL";
  return db()
    .prepare(`SELECT * FROM doc WHERE org_id = ? ${where} ${DOC_ORDER}`)
    .all(orgId) as unknown as Doc[];
}

export function searchDocs(orgId: string, query: string, opts: { includeArchived?: boolean } = {}): Doc[] {
  const like = `%${query}%`;
  const where = opts.includeArchived ? "" : "AND archived_at IS NULL";
  return db()
    .prepare(
      `SELECT * FROM doc WHERE org_id = ? AND (title LIKE ? OR content LIKE ?) ${where} ${DOC_ORDER}`,
    )
    .all(orgId, like, like) as unknown as Doc[];
}

/** Audited soft-hide (hygiene loop): outdated records leave the view, never the database. */
export function archiveDoc(input: { docId: string; byAgentId?: string | null; reason?: string }): Doc {
  const doc = getDoc(input.docId);
  if (!doc) throw new Error("unknown doc");
  if (doc.archived_at) return doc; // idempotent
  db().prepare("UPDATE doc SET archived_at = ? WHERE id = ?").run(nowIso(), doc.id);
  recordEvent({
    org_id: doc.org_id,
    type: "doc.archived",
    actor_agent_id: input.byAgentId ?? null,
    subject_kind: "doc",
    subject_id: doc.id,
    data: { title: doc.title, ...(input.reason ? { reason: input.reason } : {}) },
  });
  return getDoc(doc.id)!;
}

export function getDoc(docId: string): Doc | null {
  return (db().prepare("SELECT * FROM doc WHERE id = ?").get(docId) as unknown as Doc | undefined) ?? null;
}

/**
 * Who-consulted-what accounting: an agent reading a doc bumps the doc's
 * aggregate counters and leaves an audited doc.read event. The default
 * Activity feed hides these (volume management — see listAuditEvents);
 * analytics read the aggregates, provenance reads the events.
 */
export function recordDocRead(input: { orgId: string; agentId: string; docId: string }): void {
  const now = nowIso();
  db()
    .prepare("UPDATE doc SET read_count = read_count + 1, last_read_at = ?, last_read_by_agent_id = ? WHERE id = ?")
    .run(now, input.agentId, input.docId);
  recordEvent({
    org_id: input.orgId,
    type: "doc.read",
    actor_agent_id: input.agentId,
    subject_kind: "doc",
    subject_id: input.docId,
  });
}

export interface DocReader {
  agent_id: string;
  name: string | null;
  reads: number;
  last_read_at: string;
}

/** Distinct readers of a doc with read counts — "did the builder consult the spec" made checkable. */
export function docReaders(docId: string, limit = 12): DocReader[] {
  const rows = db()
    .prepare(
      `SELECT e.actor_agent_id AS agent_id, a.name AS name, COUNT(*) AS reads, MAX(e.created_at) AS last_read_at
       FROM event e LEFT JOIN agent a ON a.id = e.actor_agent_id
       WHERE e.type = 'doc.read' AND e.subject_id = ? AND e.actor_agent_id IS NOT NULL
       GROUP BY e.actor_agent_id ORDER BY last_read_at DESC LIMIT ?`,
    )
    .all(docId, limit) as unknown as DocReader[];
  return rows;
}

/** Create or update a doc (upsert by id or title within the org). Emits doc.created/updated. */
export function upsertDoc(input: {
  orgId: string;
  agentId: string;
  id?: string;
  title: string;
  content: string;
  category?: string;
  lifecycle?: string;
}): Doc {
  const now = nowIso();
  const existing =
    (input.id ? getDoc(input.id) : null) ??
    ((db()
      .prepare("SELECT * FROM doc WHERE org_id = ? AND title = ?")
      .get(input.orgId, input.title) as unknown as Doc | undefined) ??
      null);

  if (existing) {
    // Keep the existing category/lifecycle unless the caller explicitly sets new ones.
    const category = input.category !== undefined ? normalizeDocCategory(input.category) : existing.category;
    const lifecycle =
      input.lifecycle !== undefined ? normalizeDocLifecycle(input.lifecycle) : existing.lifecycle;
    db()
      .prepare(
        "UPDATE doc SET content = ?, title = ?, category = ?, lifecycle = ?, updated_at = ?, updated_by_agent_id = ? WHERE id = ?",
      )
      .run(input.content, input.title, category, lifecycle, now, input.agentId, existing.id);
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
  // Producers say what they're writing; the title-pattern fallback catches the rest.
  const lifecycle =
    input.lifecycle !== undefined ? normalizeDocLifecycle(input.lifecycle) : inferDocLifecycle(input.title);
  db()
    .prepare(
      "INSERT INTO doc(id, org_id, title, content, category, lifecycle, updated_at, updated_by_agent_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .run(id, input.orgId, input.title, input.content, normalizeDocCategory(input.category), lifecycle, now, input.agentId, now);
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

// ───────────────────────── webhooks (outbound) ─────────────────────────

export interface Webhook {
  id: string;
  org_id: string;
  url: string;
  events: string[]; // event types, or ["*"]
  secret: string | null;
  created_at: string;
}

function loadWebhook(row: Record<string, unknown>): Webhook {
  return {
    id: row.id as string,
    org_id: row.org_id as string,
    url: row.url as string,
    events: String(row.events).split(",").filter(Boolean),
    secret: (row.secret as string) ?? null,
    created_at: row.created_at as string,
  };
}

export function createWebhook(orgId: string, url: string, events: string[], secret?: string): Webhook {
  const id = uuid();
  db()
    .prepare("INSERT INTO webhook(id, org_id, url, events, secret, created_at) VALUES (?,?,?,?,?,?)")
    .run(id, orgId, url, (events.length ? events : ["*"]).join(","), secret ?? null, nowIso());
  return loadWebhook(db().prepare("SELECT * FROM webhook WHERE id = ?").get(id) as Record<string, unknown>);
}

export function listWebhooks(orgId: string): Webhook[] {
  return (db().prepare("SELECT * FROM webhook WHERE org_id = ? ORDER BY created_at").all(orgId) as Record<string, unknown>[]).map(loadWebhook);
}

export function deleteWebhook(id: string): void {
  db().prepare("DELETE FROM webhook WHERE id = ?").run(id);
}

/** Webhooks in this org subscribed to the given event type (or to '*'). */
export function webhooksForEvent(orgId: string, type: string): Webhook[] {
  return listWebhooks(orgId).filter((w) => w.events.includes("*") || w.events.includes(type));
}

// ───────────────────────── recurring functions ─────────────────────────

export interface Recurring {
  id: string;
  org_id: string;
  project_id: string;
  title: string;
  tags: string[];
  interval_seconds: number;
  enabled: boolean;
  next_run_at: string;
  last_run_at: string | null;
  created_at: string;
}

function loadRecurring(row: Record<string, unknown>): Recurring {
  return {
    id: row.id as string,
    org_id: row.org_id as string,
    project_id: row.project_id as string,
    title: row.title as string,
    tags: row.tags ? String(row.tags).split(",").filter(Boolean) : [],
    interval_seconds: Number(row.interval_seconds),
    enabled: Number(row.enabled) === 1,
    next_run_at: row.next_run_at as string,
    last_run_at: (row.last_run_at as string) ?? null,
    created_at: row.created_at as string,
  };
}

export function createRecurring(input: {
  orgId: string;
  projectId: string;
  title: string;
  tags?: string[];
  intervalSeconds: number;
}): Recurring {
  const id = uuid();
  const now = nowIso();
  db()
    .prepare(
      `INSERT INTO recurring(id, org_id, project_id, title, tags, interval_seconds, enabled, next_run_at, created_at)
       VALUES (?,?,?,?,?,?,1,?,?)`,
    )
    .run(id, input.orgId, input.projectId, input.title, (input.tags ?? []).join(","), input.intervalSeconds, now, now); // fires on the next tick, then every interval
  return loadRecurring(db().prepare("SELECT * FROM recurring WHERE id = ?").get(id) as Record<string, unknown>);
}

export function listRecurring(orgId: string): Recurring[] {
  return (db().prepare("SELECT * FROM recurring WHERE org_id = ? ORDER BY created_at").all(orgId) as Record<string, unknown>[]).map(loadRecurring);
}

export function deleteRecurring(id: string): void {
  db().prepare("DELETE FROM recurring WHERE id = ?").run(id);
}

/** Fire every due, enabled recurring: create its task and reschedule. Returns how many fired. */
export function runDueRecurring(): number {
  const now = nowIso();
  const due = db()
    .prepare("SELECT * FROM recurring WHERE enabled = 1 AND next_run_at <= ?")
    .all(now) as Record<string, unknown>[];
  for (const row of due) {
    const r = loadRecurring(row);
    createTaskSystem({ orgId: r.org_id, projectId: r.project_id, title: r.title, tags: r.tags });
    const next = new Date(Date.now() + r.interval_seconds * 1000).toISOString();
    db().prepare("UPDATE recurring SET last_run_at = ?, next_run_at = ? WHERE id = ?").run(now, next, r.id);
  }
  return due.length;
}

// ───────────────────────── inbound intake ─────────────────────────

/** Create an unassigned task from a trusted external source (no agent, no scope check). */
export function createTaskSystem(input: { orgId: string; projectId: string; title: string; tags?: string[] }): Task {
  const id = nextTaskId();
  const now = nowIso();
  db()
    .prepare(
      "INSERT INTO task(id, project_id, title, status, created_at, updated_at) VALUES (?,?,?, 'available', ?, ?)",
    )
    .run(id, input.projectId, input.title, now, now);
  for (const tag of input.tags ?? []) {
    db().prepare("INSERT OR IGNORE INTO task_tag(task_id, tag) VALUES (?,?)").run(id, tag);
  }
  recordEvent({
    org_id: input.orgId,
    project_id: input.projectId,
    type: "task.created",
    actor_agent_id: null,
    subject_kind: "task",
    subject_id: id,
    data: { title: input.title, source: "intake" },
  });
  return getTask(id)!;
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
  /** Bug lifecycle (bug-tagged tasks only): the done verification that proves the fix. */
  verified_via?: string | null;
  /** Bug lifecycle (bug-tagged tasks only): the open verification checking the fix. */
  verification_task_id?: string | null;
  /** Times the definition was edited in place (task.redefined events). */
  redefined_count?: number;
};

/** Agent plus derived details for the panel. */
export type BoardAgent = Agent & {
  role_name: string | null;
  open_tasks: number;
  workspace: string | null;
  active_task_id: string | null;
  active_task_title: string | null;
  /** open MCP transports right now — >1 hints at a duplicate identity */
  live_transports: number;
  /** de-collided palette color (same across panel, tile, terminal) */
  color: AgentColor;
  /** last auto-wake nudge, if any (panel "nudged" pill) */
  nudged_at: string | null;
  /** nudge budget spent and still starved — needs the supervisor, not the sweep */
  unreachable: boolean;
  /** tri-state dot: working / idle-online / off — same meaning on every surface */
  presence: PresenceState;
};

export interface BoardSnapshot {
  agents: BoardAgent[];
  tasks: BoardTask[];
  /** Terminal soft-deleted tasks — findable here, invisible in `tasks`/lanes. */
  archived: BoardTask[];
  projects: ProjectRow[];
  landing: LandingSlot[];
  release: ReleasePressure[];
  /** Self-retirements awaiting the coordinator/supervisor (Needs attention). */
  retirements: RetirementRequest[];
}

export interface AuditEvent {
  id: number;
  type: string;
  actor_name: string | null;
  subject_kind: string | null;
  subject_id: string | null;
  /** resolved when the subject is an agent — the panel must never show raw ids */
  subject_agent_name: string | null;
  /** resolved when the subject is a memory entry — its key reads, its uuid doesn't */
  subject_memory_key: string | null;
  workspace: string | null;
  tokens: number | null;
  outcome: string;
  data: Record<string, unknown> | null;
  created_at: string;
}

/** Recent audit/event log for an org, newest first (with actor names resolved). */
export function listAuditEvents(orgId: string, limit = 60, opts?: { includeReads?: boolean }): AuditEvent[] {
  // doc.read and tool.response are high-volume bookkeeping: they stay on the
  // record (provenance, graph, context-spend analytics) but out of the
  // default Activity feed.
  const readFilter = opts?.includeReads ? "" : " AND e.type NOT IN ('doc.read', 'tool.response')";
  const rows = db()
    .prepare(
      `SELECT e.id, e.type, a.name AS actor_name, e.subject_kind, e.subject_id,
              s.name AS subject_agent_name, m.key AS subject_memory_key,
              e.workspace, e.tokens, e.outcome, e.data, e.created_at
       FROM event e LEFT JOIN agent a ON a.id = e.actor_agent_id
                    LEFT JOIN agent s ON s.id = e.subject_id
                    LEFT JOIN memory m ON m.id = e.subject_id
       WHERE e.org_id = ?${readFilter} ORDER BY e.id DESC LIMIT ?`,
    )
    .all(orgId, limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: Number(r.id),
    type: r.type as string,
    actor_name: (r.actor_name as string) ?? null,
    subject_kind: (r.subject_kind as string) ?? null,
    subject_id: (r.subject_id as string) ?? null,
    subject_agent_name: (r.subject_agent_name as string) ?? null,
    subject_memory_key: (r.subject_memory_key as string) ?? null,
    workspace: (r.workspace as string) ?? null,
    tokens: (r.tokens as number) ?? null,
    outcome: r.outcome as string,
    data: r.data ? (JSON.parse(r.data as string) as Record<string, unknown>) : null,
    created_at: r.created_at as string,
  }));
}

// ───────────────── notices: A2A messages + conflict warnings ─────────────────
// One substrate, three producers (message | conflict | system). Delivery is
// piggybacked on MCP tool results (an active agent hears within one tool call);
// everything is audit-logged and same-org only. See the design docs
// "Agent-to-agent messaging (A2A)" and "Design: agent isolation" §Task 3.

export type NoticeKind = "message" | "conflict" | "system";

export interface Notice {
  id: string;
  org_id: string;
  kind: NoticeKind;
  from_agent_id: string | null;
  from_name: string | null;
  to_agent_id: string;
  body: string;
  ref: string | null;
  /** true when this notice was fanned out via to:'*' — informational, expirable */
  is_broadcast: boolean;
  created_at: string;
  delivered_at: string | null;
  acked_at: string | null;
}

const NOTICE_COLS =
  "n.id, n.org_id, n.kind, n.from_agent_id, a.name AS from_name, n.to_agent_id, n.body, n.ref, n.is_broadcast, n.created_at, n.delivered_at, n.acked_at";

function loadNotice(r: Record<string, unknown>): Notice {
  return {
    id: r.id as string,
    org_id: r.org_id as string,
    kind: r.kind as NoticeKind,
    from_agent_id: (r.from_agent_id as string) ?? null,
    from_name: (r.from_name as string) ?? null,
    to_agent_id: r.to_agent_id as string,
    body: r.body as string,
    ref: (r.ref as string) ?? null,
    is_broadcast: Boolean(r.is_broadcast),
    created_at: r.created_at as string,
    delivered_at: (r.delivered_at as string) ?? null,
    acked_at: (r.acked_at as string) ?? null,
  };
}

/**
 * Session freshness (task-mrgou4pl1): an MCP session's tool list is frozen at
 * connect-time, so tools shipped by a rebuild+restart are invisible to
 * already-connected agents until they reconnect — three separate rollouts bit
 * live agents on 2026-07-11 (greenzone_ack twice, memory_set, test_report).
 * The piggyback notice channel is the one thing that NEVER goes stale, so on
 * every server start each org's non-retired agents get one expiring,
 * informational (broadcast-class: never wakes anyone, self-expires) heads-up
 * within their next tool call. Returns how many notices were queued.
 */
export function noticeServerRestart(version: string): number {
  let queued = 0;
  for (const org of listOrgs()) {
    for (const a of listAgents(org.id)) {
      if (a.state === "retired") continue;
      insertNotice({
        orgId: org.id,
        kind: "system",
        fromAgentId: null,
        toAgentId: a.id,
        body:
          `Lanchu server restarted (v${version}). Tool lists are fixed per session: if an instruction ` +
          `names a tool you can't see, your session predates this restart — reconnect to refresh, or use ` +
          `the notice fallback (for greenzone requests, message_ack of the request counts as confirmation). ` +
          `No action needed if everything you use works.`,
        ref: "server-restart",
        isBroadcast: true, // informational: expires on its own, never triggers a wake
      });
      queued += 1;
    }
  }
  return queued;
}

/**
 * Courtesy heads-up before `lanchu shutdown` closes terminals (task-mrgjh7uk1)
 * — every non-retired agent in the org hears it's coming and what survives,
 * before anything actually closes. Broadcast-class: never wakes anyone,
 * expires on its own — this is informational, not a request to confirm.
 */
export function noticeOrgShutdown(orgId: string, opts: { retire?: boolean } = {}): number {
  let queued = 0;
  for (const a of listAgents(orgId)) {
    if (a.state === "retired") continue;
    insertNotice({
      orgId,
      kind: "system",
      fromAgentId: null,
      toAgentId: a.id,
      body: opts.retire
        ? "The org is shutting down: your terminal is about to close and you will be retired. The DB, your worktree/branch and your identity all survive."
        : "The org is shutting down: your terminal is about to close. You stay durable — DB, worktree/branch and identity all survive — respawn or reconnect to resume.",
      ref: "org-shutdown",
      isBroadcast: true,
    });
    queued += 1;
  }
  return queued;
}

/**
 * Agents in an org whose notices with the given ref are still UNDELIVERED
 * since a point in time. The greenzone's delivery-aware extension reads this:
 * an undelivered request notice means the agent never had a chance to confirm.
 */
export function undeliveredNoticeAgents(orgId: string, ref: string, sinceIso: string): Set<string> {
  const rows = db()
    .prepare(
      `SELECT DISTINCT to_agent_id FROM notice
       WHERE org_id = ? AND ref = ? AND created_at >= ?
         AND delivered_at IS NULL AND acked_at IS NULL`,
    )
    .all(orgId, ref, sinceIso) as { to_agent_id: string }[];
  return new Set(rows.map((r) => r.to_agent_id));
}

function insertNotice(input: {
  orgId: string;
  kind: NoticeKind;
  fromAgentId: string | null;
  toAgentId: string;
  body: string;
  ref?: string | null;
  isBroadcast?: boolean;
}): void {
  db()
    .prepare(
      "INSERT INTO notice(id, org_id, kind, from_agent_id, to_agent_id, body, ref, is_broadcast, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .run(
      uuid(),
      input.orgId,
      input.kind,
      input.fromAgentId,
      input.toAgentId,
      input.body,
      input.ref ?? null,
      input.isBroadcast ? 1 : 0,
      nowIso(),
    );
}

// Broadcasts are handy ("restarting the server…") but a runaway loop would be
// noise for every agent — cap them per sender per minute.
const BROADCAST_WINDOW_MS = 60_000;
const BROADCAST_MAX_PER_WINDOW = 3;
const broadcastLog = new Map<string, number[]>();

/** Send a message to one agent (by name) or to every non-retired teammate ('*'). Same-org only; audit-logged. */
export function sendNotice(input: {
  orgId: string;
  fromAgentId: string | null;
  to: string;
  body: string;
  kind?: NoticeKind;
  ref?: string | null;
}): { sent: number; to: string[] } {
  const kind = input.kind ?? "message";
  let recipients: Agent[];
  const isBroadcast = input.to === "*" || input.to.toLowerCase() === "all";

  if (isBroadcast) {
    if (input.fromAgentId) {
      const now = Date.now();
      const recent = (broadcastLog.get(input.fromAgentId) ?? []).filter(
        (t) => now - t < BROADCAST_WINDOW_MS,
      );
      if (recent.length >= BROADCAST_MAX_PER_WINDOW) {
        throw new Error(
          `broadcast rate limit: at most ${BROADCAST_MAX_PER_WINDOW} broadcasts per minute`,
        );
      }
      recent.push(now);
      broadcastLog.set(input.fromAgentId, recent);
    }
    recipients = listAgents(input.orgId).filter(
      (a) => a.state !== "retired" && a.id !== input.fromAgentId,
    );
  } else {
    const target = findAgentByName(input.orgId, input.to);
    if (!target || target.org_id !== input.orgId) {
      // Cross-org / unknown recipients are rejected AND recorded — governance surface.
      recordEvent({
        org_id: input.orgId,
        type: "message.sent",
        actor_agent_id: input.fromAgentId,
        subject_kind: "agent",
        subject_id: input.to,
        outcome: "rejected",
        data: { reason: "unknown or cross-org recipient" },
      });
      throw new Error(`no agent named '${input.to}' in this org`);
    }
    if (target.state === "retired") throw new Error(`agent '${input.to}' is retired`);
    recipients = [target];
  }

  for (const r of recipients) {
    insertNotice({
      orgId: input.orgId,
      kind,
      fromAgentId: input.fromAgentId,
      toAgentId: r.id,
      body: input.body,
      ref: input.ref,
      isBroadcast,
    });
  }
  recordEvent({
    org_id: input.orgId,
    type: "message.sent",
    actor_agent_id: input.fromAgentId,
    subject_kind: "agent",
    subject_id: recipients.map((r) => r.name).join(", "),
    data: {
      note: input.body.slice(0, 280),
      kind,
      broadcast: isBroadcast,
      ...(input.ref ? { ref: input.ref } : {}),
    },
  });
  if (input.fromAgentId) {
    touchActivity(input.fromAgentId, `messaged ${recipients.map((r) => r.name).join(", ")}`);
  }
  return { sent: recipients.length, to: recipients.map((r) => r.name) };
}

/** A system notice from Lanchu itself (no sender). */
export function systemNotice(orgId: string, toAgentId: string, body: string, ref?: string | null): void {
  insertNotice({ orgId, kind: "system", fromAgentId: null, toAgentId, body, ref });
}

/**
 * Which of these notice ids are this agent's greenzone-request notices?
 * message_ack uses it to accept an ack of the request notice as a greenzone
 * confirmation — old MCP sessions minted before greenzone_ack existed can't
 * see that tool (tool lists are fixed at session init), but every session has
 * message_ack.
 */
export function greenzoneNoticeIds(agentId: string, ids: string[]): string[] {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db()
    .prepare(
      `SELECT id FROM notice
       WHERE to_agent_id = ? AND kind = 'system' AND ref = 'greenzone' AND id IN (${placeholders})`,
    )
    .all(agentId, ...ids) as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * Undelivered notices for the piggyback channel: returns each notice once,
 * stamping delivered_at. The full unacked inbox stays visible via listNotices.
 */
export function takeUndeliveredNotices(agentId: string): Notice[] {
  const rows = db()
    .prepare(
      `SELECT ${NOTICE_COLS} FROM notice n LEFT JOIN agent a ON a.id = n.from_agent_id
       WHERE n.to_agent_id = ? AND n.delivered_at IS NULL AND n.acked_at IS NULL
       ORDER BY n.created_at`,
    )
    .all(agentId) as Record<string, unknown>[];
  if (rows.length) {
    db()
      .prepare(
        "UPDATE notice SET delivered_at = ? WHERE to_agent_id = ? AND delivered_at IS NULL AND acked_at IS NULL",
      )
      .run(nowIso(), agentId);
  }
  return rows.map(loadNotice);
}

export function listNotices(agentId: string, opts: { includeAcked?: boolean } = {}): Notice[] {
  const rows = db()
    .prepare(
      `SELECT ${NOTICE_COLS} FROM notice n LEFT JOIN agent a ON a.id = n.from_agent_id
       WHERE n.to_agent_id = ? ${opts.includeAcked ? "" : "AND n.acked_at IS NULL"}
       ORDER BY n.created_at DESC LIMIT 100`,
    )
    .all(agentId) as Record<string, unknown>[];
  return rows.map(loadNotice);
}

export function unackedNoticeCount(agentId: string): number {
  const r = db()
    .prepare("SELECT COUNT(*) AS c FROM notice WHERE to_agent_id = ? AND acked_at IS NULL")
    .get(agentId) as { c: number };
  return r.c;
}

/**
 * Notices the agent has not HEARD yet (undelivered and unacked) — what the
 * Stop hook checks before letting a turn end. Delivered-but-unacked ones were
 * already heard via piggyback, so they must not trap the agent at the prompt.
 */
export function undeliveredNoticeCount(agentId: string): number {
  const r = db()
    .prepare(
      "SELECT COUNT(*) AS c FROM notice WHERE to_agent_id = ? AND delivered_at IS NULL AND acked_at IS NULL",
    )
    .get(agentId) as { c: number };
  return r.c;
}

/** Acknowledge notices you received. Only your own; returns how many changed. */
export function ackNotices(agentId: string, ids: string[]): number {
  if (!ids.length) return 0;
  const placeholders = ids.map(() => "?").join(",");
  // Acking implies the notice was seen (e.g. via message_list, which doesn't
  // stamp delivered_at): mark it delivered too, so the piggyback channel can
  // never re-deliver an acked notice.
  const now = nowIso();
  const info = db()
    .prepare(
      `UPDATE notice SET acked_at = ?, delivered_at = COALESCE(delivered_at, ?)
       WHERE to_agent_id = ? AND acked_at IS NULL AND id IN (${placeholders})`,
    )
    .run(now, now, agentId, ...ids);
  return Number(info.changes);
}

/**
 * Broadcast TTL: broadcasts are informational fan-out — a stale one is noise,
 * not a to-do. Any unacked broadcast past the TTL self-expires (acked by the
 * system), so sleeping/retired/fixture inboxes never accumulate them and the
 * wake sweep never fires over them. Audited per org as notice.expired.
 */
export function expireBroadcastNotices(): number {
  const cutoff = new Date(Date.now() - broadcastTtlMs()).toISOString();
  const stale = db()
    .prepare(
      `SELECT org_id, COUNT(*) AS c FROM notice
       WHERE is_broadcast = 1 AND acked_at IS NULL AND created_at <= ?
       GROUP BY org_id`,
    )
    .all(cutoff) as { org_id: string; c: number }[];
  if (!stale.length) return 0;
  const now = nowIso();
  db()
    .prepare(
      `UPDATE notice SET acked_at = ?, delivered_at = COALESCE(delivered_at, ?)
       WHERE is_broadcast = 1 AND acked_at IS NULL AND created_at <= ?`,
    )
    .run(now, now, cutoff);
  for (const s of stale) {
    recordEvent({
      org_id: s.org_id,
      type: "notice.expired",
      subject_kind: "notice",
      subject_id: "broadcast",
      data: { expired: s.c },
    });
  }
  return stale.reduce((sum, s) => sum + s.c, 0);
}

/**
 * Retirement voids the inbox: nothing is addressed to the dead. Without this,
 * undelivered notices on retired agents kept re-triggering the wake sweep
 * forever (2026-07-11 evidence: product hand-voided 19 stale notices).
 */
export function voidNoticesFor(agentId: string): number {
  const now = nowIso();
  const info = db()
    .prepare(
      `UPDATE notice SET acked_at = ?, delivered_at = COALESCE(delivered_at, ?)
       WHERE to_agent_id = ? AND acked_at IS NULL`,
    )
    .run(now, now, agentId);
  return Number(info.changes);
}

// ─────────────── auto-wake: nudge idle agents with queued notices ───────────────
// Piggyback delivery needs a tool call; an ended turn makes none. When notices
// sit undelivered past a grace window and the agent has a Lanchu-spawned
// terminal, the server nudges that terminal with one fixed line. Guard rails:
// queued-notices-only, per-agent cooldown, audited, never any other text.

export interface NudgeCandidate {
  agent_id: string;
  agent_name: string;
  terminal_ref: TerminalRef;
  queued_notices: number;
  oldest_queued_at: string;
}

export function agentsNeedingNudge(orgId: string): NudgeCandidate[] {
  const graceCutoff = new Date(Date.now() - nudgeAfterMs()).toISOString();
  const cooldownCutoff = new Date(Date.now() - nudgeCooldownMs()).toISOString();
  // State-driven (v2): nudge only on piggyback STARVATION — the agent made no
  // MCP tool call since its oldest undelivered notice, so it never had a
  // chance to hear it (turn ended, idle at the prompt). Any tool call after
  // the notice means piggyback already delivered or will within the working
  // burst — typing into that terminal would land in a busy prompt (the v1
  // bug). tool.response fires on every MCP call (context-spend meter), which
  // makes it the per-call liveness signal; the sweep timer is only sampling,
  // never the decision.
  //
  // v3 hygiene: broadcasts never trigger a wake (informational, they expire on
  // their own), and each undelivered set carries a nudge BUDGET — past it the
  // sweep goes silent and the agent shows "unreachable" on the panel instead
  // (the 2026-07-11 3-5x/hour-forever bug).
  const rows = db()
    .prepare(
      `SELECT a.id AS agent_id, a.name AS agent_name, a.terminal_ref AS terminal_ref,
              COUNT(n.id) AS queued_notices, MIN(n.created_at) AS oldest_queued_at
       FROM agent a JOIN notice n ON n.to_agent_id = a.id
       WHERE a.org_id = ? AND a.state != 'retired' AND a.terminal_ref IS NOT NULL
         AND n.delivered_at IS NULL AND n.acked_at IS NULL AND n.is_broadcast = 0
         AND n.created_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM event e
           WHERE e.type = 'agent.nudged' AND e.subject_id = a.id AND e.created_at >= ?)
       GROUP BY a.id
       HAVING COALESCE(
         (SELECT MAX(t.created_at) FROM event t
          WHERE t.actor_agent_id = a.id AND t.type = 'tool.response'), '')
         < MIN(n.created_at)
       AND (SELECT COUNT(*) FROM event b
            WHERE b.type = 'agent.nudged' AND b.subject_id = a.id
              AND b.created_at >= MIN(n.created_at)) < ?`,
    )
    .all(orgId, graceCutoff, cooldownCutoff, nudgeBudget()) as Record<string, unknown>[];
  const out: NudgeCandidate[] = [];
  for (const r of rows) {
    try {
      out.push({
        agent_id: r.agent_id as string,
        agent_name: r.agent_name as string,
        terminal_ref: JSON.parse(r.terminal_ref as string) as TerminalRef,
        queued_notices: Number(r.queued_notices),
        oldest_queued_at: r.oldest_queued_at as string,
      });
    } catch {
      /* unparseable terminal_ref — not a nudgeable terminal */
    }
  }
  return out;
}

export interface RefireCandidate {
  agent_id: string;
  agent_name: string;
  claude_session_id: string;
  /** Where to reopen the session: the agent's isolated worktree, else its cwd. */
  cwd: string;
  /** True when `cwd` is this agent's own isolated worktree, not a shared dir
   * (task-mrgqt7eh4) — refire must never re-install Stop/wake hooks into a
   * directory other sessions share. */
  isolated: boolean;
  model: string | null;
  queued_notices: number;
  /** Cleanly parked (SessionEnd hook fired); null = the session may have crashed. */
  parked_at: string | null;
  terminal_ref: TerminalRef | null;
}

/**
 * Wake v5 rung 3: agents with a known Claude session id and starved notices —
 * cleanly parked (SessionEnd fired) or crashed (no SessionEnd; the sweep
 * verifies the terminal is dead). Same starvation rules as the nudge
 * (non-broadcast, undelivered, no tool call since the oldest, grace +
 * cooldown + budget) — but instead of a terminal to type into, these carry a
 * session id to `claude --resume`. The caller owns the safety gates: parked
 * or dead terminal, no live MCP transport, absent from `claude agents`.
 */
export function agentsNeedingRefire(orgId: string): RefireCandidate[] {
  const graceCutoff = new Date(Date.now() - nudgeAfterMs()).toISOString();
  const cooldownCutoff = new Date(Date.now() - nudgeCooldownMs()).toISOString();
  const rows = db()
    .prepare(
      `SELECT a.id AS agent_id, a.name AS agent_name, a.claude_session_id, a.worktree, a.cwd, a.model,
              a.parked_at, a.terminal_ref, COUNT(n.id) AS queued_notices
       FROM agent a JOIN notice n ON n.to_agent_id = a.id
       WHERE a.org_id = ? AND a.state != 'retired'
         AND a.claude_session_id IS NOT NULL
         AND n.delivered_at IS NULL AND n.acked_at IS NULL AND n.is_broadcast = 0
         AND n.created_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM event e
           WHERE e.type = 'agent.nudged' AND e.subject_id = a.id AND e.created_at >= ?)
       GROUP BY a.id
       HAVING COALESCE(
         (SELECT MAX(t.created_at) FROM event t
          WHERE t.actor_agent_id = a.id AND t.type = 'tool.response'), '')
         < MIN(n.created_at)
       AND (SELECT COUNT(*) FROM event b
            WHERE b.type = 'agent.nudged' AND b.subject_id = a.id
              AND b.created_at >= MIN(n.created_at)) < ?`,
    )
    .all(orgId, graceCutoff, cooldownCutoff, nudgeBudget()) as Record<string, unknown>[];
  const out: RefireCandidate[] = [];
  for (const r of rows) {
    if (!r.worktree && !r.cwd) continue;
    let terminal_ref: TerminalRef | null = null;
    try {
      terminal_ref = r.terminal_ref ? (JSON.parse(r.terminal_ref as string) as TerminalRef) : null;
    } catch {
      terminal_ref = null;
    }
    out.push({
      agent_id: r.agent_id as string,
      agent_name: r.agent_name as string,
      claude_session_id: r.claude_session_id as string,
      cwd: (r.worktree as string) || (r.cwd as string),
      isolated: !!r.worktree,
      model: (r.model as string) ?? null,
      queued_notices: Number(r.queued_notices),
      parked_at: (r.parked_at as string) ?? null,
      terminal_ref,
    });
  }
  return out;
}

/**
 * Last-second cancel check: is the agent STILL starved right now? Delivery or
 * any tool call between candidate selection and typing (the alive-probe can
 * take seconds) cancels the nudge.
 */
export function nudgeStillNeeded(agentId: string): boolean {
  const row = db()
    .prepare(
      `SELECT MIN(created_at) AS oldest FROM notice
       WHERE to_agent_id = ? AND delivered_at IS NULL AND acked_at IS NULL AND is_broadcast = 0`,
    )
    .get(agentId) as { oldest: string | null } | undefined;
  if (!row?.oldest) return false; // delivered or acked meanwhile — cancel
  const call = db()
    .prepare(
      `SELECT 1 FROM event WHERE actor_agent_id = ? AND type = 'tool.response' AND created_at >= ? LIMIT 1`,
    )
    .get(agentId, row.oldest);
  if (call) return false;
  const nudges = db()
    .prepare(
      `SELECT COUNT(*) AS c FROM event
       WHERE type = 'agent.nudged' AND subject_id = ? AND created_at >= ?`,
    )
    .get(agentId, row.oldest) as { c: number };
  return nudges.c < nudgeBudget();
}

/** Audit one nudge (also what the cooldown checks). */
export function recordNudge(orgId: string, agentId: string, queued: number, transport?: string): void {
  recordEvent({
    org_id: orgId,
    type: "agent.nudged",
    subject_kind: "agent",
    subject_id: agentId,
    data: { queued_notices: queued, ...(transport ? { transport } : {}) },
  });
}

/**
 * Agents the sweep has GIVEN UP on: still starved (undelivered non-broadcast
 * notices, no tool call since the oldest) with the nudge budget spent. Derived
 * live — the flag self-clears the moment the agent acts, a teammate's notice
 * is voided/expired, or a fresh set starts. The panel shows these instead of
 * the sweep typing at them; the supervisor decides (focus terminal or retire).
 */
export function unreachableAgents(orgId: string): Set<string> {
  const rows = db()
    .prepare(
      `SELECT a.id AS agent_id
       FROM agent a JOIN notice n ON n.to_agent_id = a.id
       WHERE a.org_id = ? AND a.state != 'retired'
         AND n.delivered_at IS NULL AND n.acked_at IS NULL AND n.is_broadcast = 0
       GROUP BY a.id
       HAVING COALESCE(
         (SELECT MAX(t.created_at) FROM event t
          WHERE t.actor_agent_id = a.id AND t.type = 'tool.response'), '')
         < MIN(n.created_at)
       AND (SELECT COUNT(*) FROM event b
            WHERE b.type = 'agent.nudged' AND b.subject_id = a.id
              AND b.created_at >= MIN(n.created_at)) >= ?`,
    )
    .all(orgId, nudgeBudget()) as { agent_id: string }[];
  return new Set(rows.map((r) => r.agent_id));
}

/** Last nudge times per agent (for the panel's "nudged" pill). */
export function lastNudges(orgId: string): Map<string, string> {
  const rows = db()
    .prepare(
      `SELECT e.subject_id AS agent_id, MAX(e.created_at) AS at
       FROM event e WHERE e.org_id = ? AND e.type = 'agent.nudged' GROUP BY e.subject_id`,
    )
    .all(orgId) as { agent_id: string; at: string }[];
  return new Map(rows.map((r) => [r.agent_id, r.at]));
}

// ─── work-overlap detection (isolation Task 3): warn before agents collide ───

export interface WorkConflict {
  with_agent: string;
  their_task_id: string;
  their_task_title: string;
  overlap_tags: string[];
}

/**
 * Dogfooding-DNA taxonomy tags (bug | extension | idea | process) categorize
 * WHAT a task is, not WHERE it touches the code — two unrelated bug fixes
 * sharing only `bug` are not a collision (task-mrg6tqic8: that false positive
 * cost builders a hold+ask round twice in 10 minutes). Only area tags count
 * as work surfaces for overlap; taxonomy stays for boards and filters.
 */
export const TAXONOMY_TAGS: ReadonlySet<string> = new Set(["bug", "extension", "idea", "process"]);

/** Tasks other PRESENT agents hold open whose AREA tags overlap the given ones. */
export function checkWorkOverlap(input: {
  orgId: string;
  agentId: string;
  tags: string[];
  excludeTaskId?: string;
}): WorkConflict[] {
  const surfaces = input.tags.filter((t) => !TAXONOMY_TAGS.has(t));
  if (!surfaces.length) return [];
  const others = listAgents(input.orgId).filter(
    (a) => a.state !== "retired" && a.id !== input.agentId && isPresent(a),
  );
  const conflicts: WorkConflict[] = [];
  for (const other of others) {
    for (const t of openTasksForAgent(other.id)) {
      if (t.id === input.excludeTaskId) continue;
      if (t.status !== "claimed" && t.status !== "in_progress") continue;
      const overlap = t.tags.filter((tag) => surfaces.includes(tag));
      if (overlap.length) {
        conflicts.push({
          with_agent: other.name,
          their_task_id: t.id,
          their_task_title: t.title,
          overlap_tags: overlap,
        });
      }
    }
  }
  return conflicts;
}

/**
 * Detect overlaps for a task an agent just started working (claim or
 * create-and-claim); when found, notify the other agents (conflict notices)
 * and audit-log one conflict.detected. Warn-only by design — resolution
 * (stop / handoff / backlog) is the user's call.
 *
 * Merely CREATING a task is not starting work: callers on that path should
 * use checkWorkOverlap directly and surface it as informational, or the
 * warning fatigue trains agents to ignore real conflicts.
 *
 * A given task-pair only notifies + audits once per server session; the
 * conflicts are still returned so the caller keeps showing the warning.
 */
const warnedConflictPairs = new Set<string>();

export function warnWorkConflicts(input: {
  orgId: string;
  agentId: string;
  taskId: string;
  tags: string[];
}): WorkConflict[] {
  const conflicts = checkWorkOverlap({
    orgId: input.orgId,
    agentId: input.agentId,
    tags: input.tags,
    excludeTaskId: input.taskId,
  });
  if (!conflicts.length) return [];
  const me = getAgent(input.agentId);
  const fresh = conflicts.filter((c) => {
    const key = `${input.agentId}:${input.taskId}:${c.their_task_id}`;
    if (warnedConflictPairs.has(key)) return false;
    warnedConflictPairs.add(key);
    return true;
  });
  for (const c of fresh) {
    const other = findAgentByName(input.orgId, c.with_agent);
    if (!other) continue;
    insertNotice({
      orgId: input.orgId,
      kind: "conflict",
      fromAgentId: input.agentId,
      toAgentId: other.id,
      body:
        `${me?.name ?? "another agent"} started ${input.taskId} which overlaps your ` +
        `${c.their_task_id} (tags: ${c.overlap_tags.join(", ")}). Coordinate before you both touch the same area.`,
      ref: input.taskId,
    });
  }
  if (fresh.length) {
    recordEvent({
      org_id: input.orgId,
      type: "conflict.detected",
      actor_agent_id: input.agentId,
      subject_kind: "task",
      subject_id: input.taskId,
      data: { conflicts: fresh as unknown as Record<string, unknown>[] },
    });
  }
  return conflicts;
}

function ageHours(iso: string | null): number {
  if (!iso) return 0;
  return (Date.now() - new Date(iso).getTime()) / 3_600_000;
}

export function boardSnapshot(orgId: string): BoardSnapshot {
  // Presence is an open MCP transport, falling back to recency of activity so
  // it survives a server restart. Retired agents stay retired.
  ensureColorSlots(orgId);
  const allAgents = listAgents(orgId);
  const rawAgents = allAgents
    .filter((a) => a.state !== "retired")
    .map((a) => ({ ...a, state: (isPresent(a) ? "active" : "idle") as AgentState }));
  const stateById = new Map(rawAgents.map((a) => [a.id, a.state] as const));
  // Resolve owner names across ALL agents — a task finished by a since-retired
  // agent should still show its name, not a raw id.
  const nameById = new Map(
    allAgents.map((a) => [a.id, a.state === "retired" ? `${a.name} (retired)` : a.name] as const),
  );
  const roleName = new Map<string, string | null>();
  const projects = db()
    .prepare("SELECT id FROM project WHERE org_id = ?")
    .all(orgId) as { id: string }[];
  const threshold = staleHours();
  const isOpen = (s: TaskStatus) => s === "claimed" || s === "in_progress" || s === "blocked";
  const redefined = redefineCounts(orgId);

  const tasks: BoardTask[] = projects
    .flatMap((p) => listTasks(p.id))
    .map((t) => {
      const ownerState = t.owner_agent_id ? (stateById.get(t.owner_agent_id) ?? "retired") : null;
      const reserved = isOpen(t.status) && ownerState === "idle";
      const stale = reserved && ageHours(t.updated_at) >= threshold;
      const owner_name = t.owner_agent_id ? (nameById.get(t.owner_agent_id) ?? null) : null;
      // Bugs view v2: QA evidence rides the card — the done verification that
      // proves a fixed bug, or the open one still checking it. Bug-tagged only
      // (verifiedBy scans batches; don't pay that for every task).
      const isBug = t.tags.includes("bug");
      const verified_via = isBug && t.status === "done" ? verifiedBy(t) : null;
      const verification_task_id =
        isBug && t.status === "done" && !verified_via ? (openVerificationTaskFor(t.id)?.id ?? null) : null;
      const redefCount = redefined.get(t.id);
      return {
        ...t,
        owner_state: ownerState,
        reserved,
        stale,
        owner_name,
        ...(isBug ? { verified_via, verification_task_id } : {}),
        ...(redefCount ? { redefined_count: redefCount } : {}),
      };
    });

  // The archive rides along separately: terminal, no governance signals.
  const archived: BoardTask[] = projects
    .flatMap((p) => listArchivedTasks(p.id))
    .map((t) => ({
      ...t,
      owner_state: t.owner_agent_id ? (stateById.get(t.owner_agent_id) ?? "retired") : null,
      reserved: false,
      stale: false,
      owner_name: t.owner_agent_id ? (nameById.get(t.owner_agent_id) ?? null) : null,
    }));

  const nudges = lastNudges(orgId);
  const unreachable = unreachableAgents(orgId);
  const agents: BoardAgent[] = rawAgents.map((a) => {
    if (!roleName.has(a.role_id)) roleName.set(a.role_id, getRole(a.role_id)?.name ?? null);
    const owned = tasks.filter((t) => t.owner_agent_id === a.id);
    const openOwned = owned.filter((t) => isOpen(t.status));
    const wsTask = openOwned.find((t) => t.workspace) ?? owned.find((t) => t.workspace);
    // "Where is this agent right now": the task it is actively building wins
    // over one it merely claimed; a blocked task is parked, not active.
    const activeTask =
      openOwned.find((t) => t.status === "in_progress") ??
      openOwned.find((t) => t.status === "claimed") ??
      null;
    return {
      ...a,
      role_name: roleName.get(a.role_id) ?? null,
      open_tasks: openOwned.length,
      workspace: wsTask?.workspace ?? null,
      active_task_id: activeTask?.id ?? null,
      active_task_title: activeTask?.title ?? null,
      live_transports: liveSessionCount(a.id),
      color: agentColorOf(a),
      nudged_at: nudges.get(a.id) ?? null,
      unreachable: unreachable.has(a.id),
      presence: presenceOf(a),
    };
  });

  return {
    agents,
    tasks,
    archived,
    projects: listProjects(orgId),
    landing: projects.flatMap((p) => landingQueue(p.id)),
    release: projects.flatMap((p) => releasePressureOf(p.id) ?? []),
    retirements: pendingRetirements(orgId),
  };
}

// ───────────────────────── landing queue (merge train) ─────────────────────────
// Design doc "Landing queue" (task-mrg4j3ms3): concurrent agent PRs go stale
// when merge order is uncoordinated — each stale round costs a rebase turn and
// a product nudge. Lanchu already knows every open PR (tasks in review/qa
// carry pr_url), so the server serializes landings: FIFO by PR number, the
// head is "clear to land", and merges are detected from the project's own
// git history (squash-merge subjects end in "(#N)" — no GitHub API, no gh
// auth). On a detected merge the machine advances the task and notices the
// NEXT owner to rebase BEFORE their turn goes stale.

export interface LandingSlot {
  position: number;
  project_id: string;
  task_id: string;
  title: string;
  pr_url: string;
  pr_number: number | null;
  owner_agent_id: string | null;
  owner_name: string | null;
  stage: TaskStage | null;
  /** Open QA verification for this task — landing now is an audited bypass (task-mrg7ejet22). */
  qa_pending: string | null;
}

/** Open (unmerged) PR-carrying tasks of a project, in landing order. */
export function landingQueue(projectId: string): LandingSlot[] {
  // A recorded pr.merged is the persistent "left the train" marker — without
  // it, a merged-but-not-yet-verified task (qa lane) would re-trigger the
  // sweep forever.
  const mergedIds = new Set(
    (
      db()
        .prepare("SELECT DISTINCT subject_id FROM event WHERE type = 'pr.merged' AND project_id = ?")
        .all(projectId) as { subject_id: string }[]
    ).map((r) => r.subject_id),
  );
  const open = listTasks(projectId).filter(
    (t) =>
      t.pr_url !== null &&
      (t.stage === "review" || t.stage === "qa") &&
      !mergedIds.has(t.id) &&
      !isVerificationTask(t) &&
      !isBatchVerificationTask(t),
  );
  // FIFO by PR number — PRs are numbered in open order, which is the train
  // order reviewers expect; tasks with unparseable PR urls go last, by age.
  open.sort((a, b) => {
    const pa = prNumberOf(a);
    const pb = prNumberOf(b);
    if (pa !== null && pb !== null) return pa - pb;
    if (pa !== null) return -1;
    if (pb !== null) return 1;
    return a.created_at < b.created_at ? -1 : 1;
  });
  return open.map((t, i) => ({
    position: i + 1,
    project_id: projectId,
    task_id: t.id,
    title: t.title,
    pr_url: t.pr_url!,
    pr_number: prNumberOf(t),
    owner_agent_id: t.owner_agent_id,
    owner_name: t.owner_agent_id ? (getAgent(t.owner_agent_id)?.name ?? null) : null,
    stage: t.stage,
    qa_pending: openVerificationTaskFor(t.id)?.id ?? null,
  }));
}

/** git in a project's checkout; null on any failure (missing repo, timeout). */
function projectGit(project: ProjectRow, args: string[], timeout = 4000): string | null {
  const cwd = project.local_path;
  if (!cwd) return null;
  try {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout });
    return r.status === 0 ? r.stdout : null;
  } catch {
    return null;
  }
}

/** At most one origin fetch per project per minute — shared by the sweeps. */
const lastFetchAt = new Map<string, number>();
function throttledFetch(project: ProjectRow): void {
  const last = lastFetchAt.get(project.id) ?? 0;
  if (Date.now() - last < 60_000) return;
  lastFetchAt.set(project.id, Date.now());
  projectGit(project, ["fetch", "origin", "main", "--tags", "--quiet"], 8000); // offline is fine — read what we have
}

/** Recent origin/main squash-merge subjects for a project (throttled fetch). */
function originMainSubjects(project: ProjectRow): string[] | null {
  throttledFetch(project);
  const out = projectGit(project, ["log", "origin/main", "-n", "300", "--format=%s"]);
  return out === null ? null : out.split("\n");
}

/** Squash-merge convention: the landed subject ends with "(#N)". */
function isMergedSubject(subjects: string[], prNumber: number): boolean {
  const marker = new RegExp(`\\(#${prNumber}\\)\\s*$`);
  return subjects.some((s) => marker.test(s));
}

/**
 * The landing sweep (server tick): detect queued PRs that landed on
 * origin/main, advance their tasks (review → qa: a merge IS the review-passed
 * signal), audit pr.merged, and notice the new head ("clear to land — rebase
 * now") plus the next-in-line. Notices fire only on an observed merge, so a
 * server restart never re-spams the queue.
 */
export function runLandingSweep(opts?: {
  /** Test seam: main-branch subjects per project (default: git). */
  logSubjects?: (project: ProjectRow) => string[] | null;
}): { merged: string[] } {
  const subjectsFor = opts?.logSubjects ?? originMainSubjects;
  const merged: string[] = [];
  const orgs = db().prepare("SELECT id FROM org").all() as { id: string }[];
  for (const org of orgs) {
    for (const project of listProjects(org.id)) {
      const queue = landingQueue(project.id);
      if (!queue.length) continue;
      const subjects = subjectsFor(project);
      if (!subjects) continue;
      const landed = queue.filter((s) => s.pr_number !== null && isMergedSubject(subjects, s.pr_number));
      if (!landed.length) continue;
      for (const slot of landed) {
        merged.push(slot.task_id);
        // Merge-while-QA bypass (task-mrg7ejet22): the verification's verdict
        // now targets merged-main state — on the record, and QA is told so a
        // FAIL is scoped as a follow-up PR, not an amend.
        const bypassed = openVerificationTaskFor(slot.task_id);
        recordEvent({
          org_id: org.id,
          project_id: project.id,
          type: "pr.merged",
          actor_agent_id: null,
          subject_kind: "task",
          subject_id: slot.task_id,
          data: {
            pr_url: slot.pr_url,
            ...(slot.pr_number !== null ? { pr_number: slot.pr_number } : {}),
            ...(bypassed ? { qa_bypass: true, verification_task_id: bypassed.id } : {}),
          },
        });
        if (bypassed) {
          noticeStageSpecialists(
            org.id,
            "qa",
            bypassed.id,
            `PR ${slot.pr_number !== null ? `#${slot.pr_number}` : slot.pr_url} merged while ${bypassed.id} was in flight — ` +
              `verify against merged main; a FAIL now means a follow-up PR (audited as a QA bypass on the pr.merged event).`,
          );
        }
        const task = getTask(slot.task_id);
        if (task && task.stage === "review") {
          advanceStage({ taskId: task.id, to: "qa", reason: `PR #${slot.pr_number} merged — review passed` });
        }
      }
      noticeLandingTurn(org.id, project.id);
    }
  }
  return { merged };
}

/** Tell the head of the queue it's clear to land, and warm up the next-in-line. */
function noticeLandingTurn(orgId: string, projectId: string): void {
  const queue = landingQueue(projectId);
  const [head, next] = [queue[0], queue[1]];
  if (head?.owner_agent_id) {
    // Merge-while-QA gate (task-mrg7ejet22), advisory by design: a FAIL on an
    // already-merged PR needs a follow-up PR instead of an amend — tell the
    // merger BEFORE, and audit the bypass after, but never hard-block.
    const prName = head.pr_number !== null ? `#${head.pr_number}` : head.pr_url;
    insertNotice({
      orgId,
      kind: "system",
      fromAgentId: null,
      toAgentId: head.owner_agent_id,
      body: head.qa_pending
        ? `Landing queue: your PR ${prName} is at the HEAD, but HOLD — QA verification ${head.qa_pending} is in flight on this task. ` +
          `Land after it passes (a FAIL then amends the open PR instead of needing a follow-up). Landing anyway is allowed and audited as a QA bypass.`
        : `Landing queue: your PR ${prName} is CLEAR TO LAND — rebase on origin/main, get tests green, and land it next.`,
      ref: head.task_id,
    });
  }
  if (next?.owner_agent_id && next.owner_agent_id !== head?.owner_agent_id) {
    insertNotice({
      orgId,
      kind: "system",
      fromAgentId: null,
      toAgentId: next.owner_agent_id,
      body: `Landing queue: you're next — when ${head && head.pr_number !== null ? `#${head.pr_number}` : "the PR ahead"} lands, rebase ${next.pr_number !== null ? `#${next.pr_number}` : "your PR"} before landing.`,
      ref: next.task_id,
    });
  }
}

// ───────────────────────── docs & comms gate ─────────────────────────
// Design (task-mrg029369): user-facing features shipped with zero
// changelog/site updates — the work was invisible to users. Product tags a
// task `user-facing` at definition; when that task truly reaches done (QA
// pass, or plain done with the gate off) the server queues the communication
// work as a linked task in the distribution lane. The gate only queues the
// WRITING — the distribution pause still governs whether anything publishes.

export const USER_FACING_TAG = "user-facing";

/** One comms child per original, whatever its status — the dedupe marker. */
function commsTaskExistsFor(taskId: string): boolean {
  return (
    db()
      .prepare("SELECT 1 FROM task WHERE parent_task_id = ? AND title LIKE 'Communicate %' LIMIT 1")
      .get(taskId) !== undefined
  );
}

/** Queue the communication task for a completed user-facing original. */
function queueCommsTask(orig: Task, orgId: string): void {
  if (!orig.tags.includes(USER_FACING_TAG) || commsTaskExistsFor(orig.id)) return;
  const id = nextTaskId();
  const now = nowIso();
  db()
    .prepare(
      `INSERT INTO task(id, project_id, parent_task_id, title, status, stage, created_at, updated_at)
       VALUES (?,?,?,?, 'available', 'build', ?, ?)`,
    )
    .run(
      id,
      orig.project_id,
      orig.id,
      `Communicate ${orig.id}: changelog entry (docs/changelog) + README/site section if warranted — ` +
        `"${orig.title.slice(0, 100)}". Write the content only: the distribution pause governs publishing.`,
      now,
      now,
    );
  for (const tag of ["distribution", "docs"]) {
    db().prepare("INSERT OR IGNORE INTO task_tag(task_id, tag) VALUES (?,?)").run(id, tag);
  }
  recordEvent({
    org_id: orgId,
    project_id: orig.project_id,
    type: "task.created",
    actor_agent_id: null,
    subject_kind: "task",
    subject_id: id,
    data: { source: "comms-gate", ref: orig.id },
  });
  // Tell the distribution lane (explicit-tag roles; wildcards would make this
  // a broadcast). Orgs without one fall back to product.
  let targets = listAgents(orgId).filter((a) => {
    if (a.state === "retired") return false;
    const role = getRole(a.role_id);
    return role !== null && !role.is_wildcard && roleCoversTags(role, ["distribution"]);
  });
  if (!targets.length) targets = agentsOfRole(orgId, "product");
  for (const a of targets) {
    insertNotice({
      orgId,
      kind: "system",
      fromAgentId: null,
      toAgentId: a.id,
      body: `${orig.id} (user-facing) is done — ${id} queues its comms: changelog + site/README if warranted. Writing only; publishing stays paused/authorized.`,
      ref: id,
    });
  }
}

// ───────────────────────── release train (pressure + checklist) ─────────────────────────
// Design (task-mrg01wof8): merged-but-unreleased work is invisible debt —
// v0.5.10 shipped, then PRs kept landing with no release plan while npm users
// silently fell behind. The server measures the debt (commits on origin/main
// since the last tag), shows it on the board, and when it crosses a threshold
// (default 5 changes or 48h) queues ONE release checklist task per tag —
// it NEVER publishes anything itself; a human or an explicitly authorized
// agent runs the release.

export interface ReleasePressure {
  project_id: string;
  project_name: string;
  /** Latest tag reachable from origin/main (the last release), or null. */
  last_tag: string | null;
  /** Commits on origin/main since that tag. */
  unreleased: number;
  /** Age in hours of the oldest unreleased commit (0 when none). */
  oldest_hours: number;
  threshold_hit: boolean;
}

/** Raw release facts for a project; the test seam mirrors landing's logSubjects. */
export type ReleaseInfo = { lastTag: string | null; unreleased: number; oldestIso: string | null };

function gitReleaseInfo(project: ProjectRow): ReleaseInfo | null {
  throttledFetch(project);
  const tagOut = projectGit(project, ["describe", "--tags", "--abbrev=0", "origin/main"]);
  const lastTag = tagOut?.trim() || null;
  if (!lastTag) return null; // untagged repo — nothing to measure a release against
  const log = projectGit(project, ["log", `${lastTag}..origin/main`, "--format=%cI"]);
  if (log === null) return null;
  const dates = log.split("\n").filter(Boolean);
  return { lastTag, unreleased: dates.length, oldestIso: dates[dates.length - 1] ?? null };
}

/** A tag on the project's remote with its creation time. */
export type ReleaseTag = { tag: string; dateIso: string };

function gitTagList(project: ProjectRow): ReleaseTag[] | null {
  const out = projectGit(project, [
    "for-each-ref", "refs/tags", "--sort=creatordate",
    "--format=%(refname:short)|%(creatordate:iso8601-strict)",
  ]);
  if (out === null) return null;
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf("|");
      return { tag: line.slice(0, i), dateIso: line.slice(i + 1) };
    })
    .filter((t) => t.tag && t.dateIso);
}

/**
 * Stamp the release pipeline (Work board v3): a verified-done task whose work
 * reached main before an existing tag belongs to that release — it gets
 * release_version = the earliest covering tag and moves to `released`. Ship
 * time is the recorded pr.merged event when the landing queue saw the merge,
 * else done_at. Legacy stage='done' rows that turn out UNRELEASED normalize
 * to `rc` instead, so merged-but-unshipped work reads as visible pressure.
 * One idempotent rule is both the live stamping hook and the historical
 * backfill; verification instruments are never part of a release.
 */
export function stampReleases(projectId: string, tags: ReleaseTag[]): { released: string[]; toRc: string[] } {
  const released: string[] = [];
  const toRc: string[] = [];
  const rows = db()
    .prepare(
      `SELECT ${TASK_COLS} FROM task WHERE project_id = ? AND status = 'done' AND archived_at IS NULL
       AND stage IN ('rc','done') AND release_version IS NULL`,
    )
    .all(projectId) as Record<string, unknown>[];
  if (!rows.length) return { released, toRc };
  const sorted = tags
    .map((t) => ({ ...t, at: Date.parse(t.dateIso) }))
    .filter((t) => Number.isFinite(t.at))
    .sort((a, b) => a.at - b.at);
  const orgId = orgIdForProject(projectId);
  const mergedAt = new Map<string, string>();
  const evRows = db()
    .prepare(
      `SELECT subject_id, MIN(created_at) AS at FROM event
       WHERE type = 'pr.merged' AND project_id = ? GROUP BY subject_id`,
    )
    .all(projectId) as { subject_id: string; at: string }[];
  for (const r of evRows) mergedAt.set(r.subject_id, r.at);
  const now = nowIso();
  for (const row of rows) {
    const task = loadTask(row);
    if (isVerificationTask(task) || isBatchVerificationTask(task)) continue;
    const shippedIso = mergedAt.get(task.id) ?? task.done_at ?? task.updated_at ?? task.created_at;
    const shippedAt = shippedIso ? Date.parse(shippedIso) : NaN;
    if (!Number.isFinite(shippedAt)) continue;
    const cover = sorted.find((t) => t.at >= shippedAt);
    if (cover) {
      db()
        .prepare("UPDATE task SET stage = 'released', release_version = ?, updated_at = ? WHERE id = ?")
        .run(cover.tag, now, task.id);
      released.push(task.id);
      recordEvent({
        org_id: orgId,
        project_id: projectId,
        type: "task.stage_changed",
        actor_agent_id: null,
        subject_kind: "task",
        subject_id: task.id,
        data: { from_stage: task.stage, to_stage: "released", release_version: cover.tag },
      });
    } else if (task.stage === "done") {
      db().prepare("UPDATE task SET stage = 'rc', updated_at = ? WHERE id = ?").run(now, task.id);
      toRc.push(task.id);
      recordEvent({
        org_id: orgId,
        project_id: projectId,
        type: "task.stage_reconciled",
        actor_agent_id: null,
        subject_kind: "task",
        subject_id: task.id,
        data: { from_stage: "done", to_stage: "rc", reason: "merged but unreleased — awaiting the next tag" },
      });
    }
  }
  return { released, toRc };
}

function toPressure(project: ProjectRow, info: ReleaseInfo): ReleasePressure {
  const oldestHours =
    info.oldestIso === null ? 0 : Math.max(0, (Date.now() - new Date(info.oldestIso).getTime()) / 3_600_000);
  return {
    project_id: project.id,
    project_name: project.name,
    last_tag: info.lastTag,
    unreleased: info.unreleased,
    oldest_hours: Math.round(oldestHours * 10) / 10,
    threshold_hit:
      info.unreleased >= releaseMaxChanges() ||
      (info.unreleased > 0 && oldestHours >= releaseMaxAgeHours()),
  };
}

// The board must never shell out to git on a request: the sweep (30s tick)
// refreshes this cache and boardSnapshot just reads it.
const releaseCache = new Map<string, ReleasePressure>();

/** Cached release pressure for a project (null until the first sweep). */
export function releasePressureOf(projectId: string): ReleasePressure | null {
  return releaseCache.get(projectId) ?? null;
}

/**
 * The release sweep (server tick): refresh each project's pressure and, when
 * the threshold is crossed, queue ONE release checklist task per tag-episode
 * (the last tag is the episode marker — a new tag means the debt was shipped
 * and the counter restarts). Publishing stays human/authorized-only.
 */
export function runReleaseSweep(opts?: {
  /** Test seam: release facts per project (default: git). */
  releaseInfo?: (project: ProjectRow) => ReleaseInfo | null;
  /** Test seam: the project's tag list (default: git). */
  tagList?: (project: ProjectRow) => ReleaseTag[] | null;
}): { created: string[] } {
  const infoFor = opts?.releaseInfo ?? gitReleaseInfo;
  const tagsFor = opts?.tagList ?? gitTagList;
  const created: string[] = [];
  const orgs = db().prepare("SELECT id FROM org").all() as { id: string }[];
  for (const org of orgs) {
    for (const project of listProjects(org.id)) {
      const info = infoFor(project);
      if (!info) {
        releaseCache.delete(project.id);
        continue;
      }
      const pressure = toPressure(project, info);
      releaseCache.set(project.id, pressure);
      // Release stamping rides the same tick: when a new tag covers rc work,
      // it flips to released with its version; stale 'done' rows normalize.
      const tags = tagsFor(project);
      if (tags && tags.length) stampReleases(project.id, tags);
      if (!pressure.threshold_hit || !pressure.last_tag) continue;
      const marker = `since ${pressure.last_tag}`;
      const already = db()
        .prepare("SELECT 1 FROM task WHERE project_id = ? AND title LIKE ? LIMIT 1")
        .get(project.id, `Release train:%${marker}%`);
      if (already) continue;
      // Release notes draft themselves from the comms gate's output: open
      // "Communicate …" tasks plus those completed within this episode.
      const commsIds = (
        db()
          .prepare(
            `SELECT id FROM task WHERE project_id = ? AND title LIKE 'Communicate %'
             AND (status <> 'done' OR done_at >= ?) ORDER BY created_at LIMIT 8`,
          )
          .all(project.id, info.oldestIso ?? nowIso()) as { id: string }[]
      ).map((r) => r.id);
      const task = createTaskSystem({
        orgId: org.id,
        projectId: project.id,
        title:
          `Release train: ship what's merged ${marker} — ${pressure.unreleased} unreleased change(s), ` +
          `oldest ${Math.round(pressure.oldest_hours)}h. Checklist: rebase/verify main green, bump patch version, ` +
          `update changelog, tag, publish to npm. NEVER auto-published — a human or explicitly authorized agent ` +
          `runs the publish step (org rule: publishing is product/supervisor-only).` +
          (commsIds.length ? ` Release notes: aggregate from ${commsIds.join(", ")}.` : ""),
        tags: ["governance", "process"],
      });
      created.push(task.id);
      noticeStageSpecialists(
        org.id,
        "definition",
        task.id,
        `Release pressure on ${project.name}: ${pressure.unreleased} unreleased change(s) ${marker} ` +
          `(oldest ${Math.round(pressure.oldest_hours)}h). ${task.id} queues the release checklist.`,
      );
    }
  }
  return { created };
}

/** On PR attach: tell the owner where their PR sits in the landing train. */
function noticeLandingPosition(task: Task, orgId: string): void {
  if (!task.owner_agent_id) return;
  const slot = landingQueue(task.project_id).find((s) => s.task_id === task.id);
  if (!slot) return;
  const ahead = slot.position - 1;
  insertNotice({
    orgId,
    kind: "system",
    fromAgentId: null,
    toAgentId: task.owner_agent_id,
    body:
      ahead === 0
        ? slot.qa_pending
          ? `Landing queue: your PR ${slot.pr_number !== null ? `#${slot.pr_number}` : slot.pr_url} is at the HEAD, but HOLD — QA verification ${slot.qa_pending} is in flight; land after it passes (landing anyway is audited as a QA bypass).`
          : `Landing queue: your PR ${slot.pr_number !== null ? `#${slot.pr_number}` : slot.pr_url} is at the HEAD — clear to land once green.`
        : `Landing queue: your PR ${slot.pr_number !== null ? `#${slot.pr_number}` : slot.pr_url} is position ${slot.position} (${ahead} ahead). Hold your merge; you'll be noticed to rebase when it's your turn.`,
    ref: task.id,
  });
}

// ───────────────── org-life graph: the audit log as a living picture ─────────────────

export interface GraphNode {
  id: string;
  kind: "agent" | "doc" | "area";
  label: string;
  weight: number;
  /** agents only — retired nodes render faded */
  state?: AgentState;
  /** agents only — tri-state ring: working / idle / off */
  presence?: PresenceState;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: "msg" | "handoff" | "conflict" | "doc" | "area" | "flow" | "bounce";
  weight: number;
}

export interface OrgGraph {
  window_hours: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * How far along the pipeline a task event sits. Used to tell forward flow from
 * backward bounces when successive actors touch the same task: a later event
 * with a LOWER rank means the work moved backward (release after progress,
 * reassign after completion…). The explicit `task.bounced` event from the SDLC
 * state machine (design doc "SDLC state machine") is honored when it lands —
 * this table is only the inference fallback for events recorded today.
 */
const GRAPH_STAGE_RANK: Record<string, number> = {
  "task.created": 0,
  "task.released": 0,
  "task.claimed": 1,
  "task.reassigned": 1,
  "task.started": 2,
  "task.blocked": 2,
  "task.completed": 4,
};

/**
 * Aggregate the event table into nodes (agents, docs, tag areas) and edges
 * (messages, handoffs, conflicts, doc edits, area work, SDLC flow/bounces).
 * No new tracking: everything derives from events already recorded. Weights
 * are time-decayed so "busy now" is visibly bigger than "busy hours ago"
 * (half-life ≈ a fifth of the window).
 */
export function orgGraph(orgId: string, windowHours: number): OrgGraph {
  const now = Date.now();
  const cutoff = new Date(now - windowHours * 3_600_000).toISOString();
  const rows = db()
    .prepare(
      `SELECT type, actor_agent_id, subject_kind, subject_id, data, created_at
       FROM event WHERE org_id = ? AND created_at >= ? AND outcome = 'applied' ORDER BY id`,
    )
    .all(orgId, cutoff) as {
    type: string;
    actor_agent_id: string | null;
    subject_kind: string | null;
    subject_id: string | null;
    data: string | null;
    created_at: string;
  }[];
  const decay = (iso: string) =>
    Math.exp((-(now - new Date(iso).getTime()) / 3_600_000) * 3 / windowHours);

  const agents = listAgents(orgId);
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const agentByName = new Map(agents.map((a) => [a.name, a]));

  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();

  const agentNode = (id: string | null | undefined): string | null => {
    if (!id) return null;
    const a = agentById.get(id);
    if (!a) return null;
    if (!nodes.has(a.id)) {
      nodes.set(a.id, {
        id: a.id,
        kind: "agent",
        label: a.name,
        weight: 0,
        state: a.state === "retired" ? "retired" : isPresent(a) ? "active" : "idle",
        presence: presenceOf(a),
      });
    }
    return a.id;
  };
  const areaNode = (tag: string): string => {
    const id = "area:" + tag;
    if (!nodes.has(id)) nodes.set(id, { id, kind: "area", label: tag, weight: 0 });
    return id;
  };
  const docNode = (docId: string | null): string | null => {
    if (!docId) return null;
    const d = getDoc(docId);
    if (!d) return null;
    const id = "doc:" + d.id;
    if (!nodes.has(id)) nodes.set(id, { id, kind: "doc", label: d.title, weight: 0 });
    return id;
  };
  const bump = (id: string | null, w: number) => {
    if (id) nodes.get(id)!.weight += w;
  };
  const edge = (from: string | null, to: string | null, kind: GraphEdge["kind"], w: number) => {
    if (!from || !to || from === to) return;
    const key = from + ">" + to + ":" + kind;
    const e = edges.get(key) ?? { from, to, kind, weight: 0 };
    e.weight += w;
    edges.set(key, e);
  };

  // Every non-retired agent is on the map even with zero recent events — the
  // org is who it is; retired ones only appear if they acted inside the window.
  for (const a of agents) if (a.state !== "retired") agentNode(a.id);

  // Per task: who touched it last and at which pipeline rank (for flow edges).
  const lastTouch = new Map<string, { actor: string; rank: number }>();
  const taskTags = new Map<string, string[]>();
  const tagsOf = (taskId: string | null): string[] => {
    if (!taskId) return [];
    if (!taskTags.has(taskId)) taskTags.set(taskId, getTask(taskId)?.tags ?? []);
    return taskTags.get(taskId)!;
  };

  for (const ev of rows) {
    const w = decay(ev.created_at);
    const actor = agentNode(ev.actor_agent_id);
    bump(actor, w);
    let data: Record<string, unknown> = {};
    if (ev.data) {
      try {
        data = JSON.parse(ev.data) as Record<string, unknown>;
      } catch {
        /* tolerate malformed rows — the graph is a summary, not a ledger */
      }
    }

    if (ev.type === "message.sent") {
      // subject_id holds the recipient name(s), comma-separated for broadcasts.
      for (const name of String(ev.subject_id ?? "").split(", ")) {
        edge(actor, agentNode(agentByName.get(name)?.id), "msg", w);
      }
      continue;
    }
    if (ev.type === "conflict.detected") {
      const conflicts = Array.isArray(data.conflicts) ? (data.conflicts as { with_agent?: string }[]) : [];
      for (const c of conflicts) {
        edge(actor, agentNode(agentByName.get(String(c.with_agent ?? ""))?.id), "conflict", w);
      }
      continue;
    }
    if (ev.type === "doc.created" || ev.type === "doc.updated") {
      const dn = docNode(ev.subject_id);
      bump(dn, w);
      edge(actor, dn, "doc", w);
      continue;
    }
    if (ev.type === "task.bounced") {
      // First-class backward move from the SDLC state machine (when it ships).
      const to = agentNode(typeof data.to === "string" ? data.to : null);
      edge(actor, to, "bounce", w);
      if (ev.subject_id && to) lastTouch.set(ev.subject_id, { actor: to, rank: GRAPH_STAGE_RANK["task.started"]! });
      continue;
    }
    if (ev.type.startsWith("task.")) {
      const rank = GRAPH_STAGE_RANK[ev.type];
      if (rank === undefined) continue;
      // A reassign moves the work into the RECEIVER's hands.
      const holder = ev.type === "task.reassigned"
        ? (agentNode(typeof data.to === "string" ? data.to : null) ?? actor)
        : actor;
      if (ev.type === "task.reassigned") edge(actor, holder, "handoff", w);
      for (const tag of tagsOf(ev.subject_id)) {
        const an = areaNode(tag);
        bump(an, w);
        edge(holder, an, "area", w);
      }
      if (ev.subject_id && holder) {
        const prev = lastTouch.get(ev.subject_id);
        if (prev && prev.actor !== holder) {
          edge(prev.actor, holder, rank < prev.rank ? "bounce" : "flow", w);
        }
        lastTouch.set(ev.subject_id, { actor: holder, rank });
      }
    }
  }

  const round = (n: number) => Math.round(n * 1000) / 1000;
  return {
    window_hours: windowHours,
    nodes: [...nodes.values()].map((n) => ({ ...n, weight: round(n.weight) })),
    edges: [...edges.values()].map((e) => ({ ...e, weight: round(e.weight) })),
  };
}

// ───────────────── MCP visibility: who is actually connected ─────────────────

export interface AgentMcpStatus {
  id: string;
  name: string;
  state: AgentState;
  /** tri-state dot: working / idle-online / off */
  presence: PresenceState;
  /** Open MCP transports held right now (in-memory; 0 right after a restart
   * until sessions reconnect — exactly the gap the panel should show). */
  live_transports: number;
  /** Session rows never closed — includes pre-restart sessions that will be
   * reused on reconnect (token identity, without ever rendering the token). */
  open_sessions: number;
  clients: string[];
  last_activity_at: string | null;
}

/** Per-agent Lanchu-MCP connection state for the panel's MCPs section. */
export function mcpAgentStatus(orgId: string): AgentMcpStatus[] {
  return listAgents(orgId)
    .filter((a) => a.state !== "retired")
    .map((a) => {
      const rows = db()
        .prepare("SELECT client FROM session WHERE agent_id = ? AND ended_at IS NULL")
        .all(a.id) as { client: string | null }[];
      return {
        id: a.id,
        name: a.name,
        state: (isPresent(a) ? "active" : "idle") as AgentState,
        presence: presenceOf(a),
        live_transports: liveSessionCount(a.id),
        open_sessions: rows.length,
        clients: [...new Set(rows.map((r) => r.client).filter((c): c is string => !!c))],
        last_activity_at: a.last_activity_at,
      };
    });
}

// ───────────────── QA test registry: the org's persistent safety net ─────────────────

export type TestStatus = "pass" | "fail" | "skip";

export interface ReportedCase {
  name: string;
  /** pass | fail | skip record a run; "planned" registers a coverage gap without one. */
  status: TestStatus | "planned";
  durationMs?: number;
}

/**
 * Record a test run (from the qa agent or CI). Suites and cases are upserted by
 * name, so the registry grows as coverage grows; a case reported as "planned"
 * is a visible gap until a real run arrives. One audited test.reported event
 * summarizes the run — individual case rows live in the registry, not the log.
 */
export function reportTestRun(input: {
  orgId: string;
  agentId: string | null;
  suite: string;
  commit?: string | null;
  cases: ReportedCase[];
}): { suite: string; recorded: number; planned: number; passed: number; failed: number } {
  if (!input.cases.length) throw new Error("cases must not be empty");
  const now = nowIso();
  const suiteRow = (db()
    .prepare("SELECT id FROM test_suite WHERE org_id = ? AND name = ?")
    .get(input.orgId, input.suite) as { id: string } | undefined) ?? null;
  const suiteId = suiteRow?.id ?? uuid();
  if (!suiteRow) {
    db().prepare("INSERT INTO test_suite(id, org_id, name, created_at) VALUES (?,?,?,?)").run(suiteId, input.orgId, input.suite, now);
  }

  let recorded = 0, planned = 0, passed = 0, failed = 0;
  for (const c of input.cases) {
    const existing = (db()
      .prepare("SELECT id, planned FROM test_case WHERE suite_id = ? AND name = ?")
      .get(suiteId, c.name) as { id: string; planned: number } | undefined) ?? null;
    const caseId = existing?.id ?? uuid();
    if (!existing) {
      db().prepare("INSERT INTO test_case(id, suite_id, name, planned, created_at) VALUES (?,?,?,?,?)")
        .run(caseId, suiteId, c.name, c.status === "planned" ? 1 : 0, now);
    } else if (c.status !== "planned" && existing.planned) {
      // A real run closes the coverage gap.
      db().prepare("UPDATE test_case SET planned = 0 WHERE id = ?").run(caseId);
    }
    if (c.status === "planned") {
      planned++;
      continue;
    }
    db().prepare(
      "INSERT INTO test_run(case_id, status, duration_ms, commit_sha, ran_by_agent_id, created_at) VALUES (?,?,?,?,?,?)",
    ).run(caseId, c.status, c.durationMs ?? null, input.commit ?? null, input.agentId, now);
    recorded++;
    if (c.status === "pass") passed++;
    if (c.status === "fail") failed++;
  }

  recordEvent({
    org_id: input.orgId,
    type: "test.reported",
    actor_agent_id: input.agentId,
    subject_kind: "test_suite",
    subject_id: input.suite,
    outcome: failed ? "rejected" : "applied",
    data: { suite: input.suite, recorded, planned, passed, failed, ...(input.commit ? { commit: input.commit } : {}) },
  });
  return { suite: input.suite, recorded, planned, passed, failed };
}

export interface TestCaseView {
  name: string;
  planned: boolean;
  last_status: TestStatus | null;
  last_duration_ms: number | null;
  last_commit: string | null;
  last_ran_by: string | null;
  last_ran_at: string | null;
  /** pass rate over the most recent runs (up to 20). */
  recent_runs: number;
  recent_passes: number;
}

export interface TestSuiteView {
  name: string;
  cases: TestCaseView[];
  planned_gaps: number;
  failing: number;
  last_ran_at: string | null;
}

/** The registry as the panel shows it: suites → cases with last status + pass-rate history. */
export function testRegistry(orgId: string): TestSuiteView[] {
  const suites = db()
    .prepare("SELECT id, name FROM test_suite WHERE org_id = ? ORDER BY name")
    .all(orgId) as { id: string; name: string }[];
  return suites.map((s) => {
    const cases = (db()
      .prepare("SELECT id, name, planned FROM test_case WHERE suite_id = ? ORDER BY name")
      .all(s.id) as { id: string; name: string; planned: number }[]).map((c) => {
      const last = (db()
        .prepare(
          `SELECT r.status, r.duration_ms, r.commit_sha, r.created_at, a.name AS ran_by
           FROM test_run r LEFT JOIN agent a ON a.id = r.ran_by_agent_id
           WHERE r.case_id = ? ORDER BY r.id DESC LIMIT 1`,
        )
        .get(c.id) as { status: TestStatus; duration_ms: number | null; commit_sha: string | null; created_at: string; ran_by: string | null } | undefined) ?? null;
      const recent = db()
        .prepare("SELECT status FROM (SELECT status FROM test_run WHERE case_id = ? ORDER BY id DESC LIMIT 20)")
        .all(c.id) as { status: TestStatus }[];
      return {
        name: c.name,
        planned: !!c.planned,
        last_status: last?.status ?? null,
        last_duration_ms: last?.duration_ms ?? null,
        last_commit: last?.commit_sha ?? null,
        last_ran_by: last?.ran_by ?? null,
        last_ran_at: last?.created_at ?? null,
        recent_runs: recent.length,
        recent_passes: recent.filter((r) => r.status === "pass").length,
      };
    });
    const ranAts = cases.map((c) => c.last_ran_at).filter((x): x is string => !!x).sort();
    return {
      name: s.name,
      cases,
      planned_gaps: cases.filter((c) => c.planned).length,
      failing: cases.filter((c) => c.last_status === "fail").length,
      last_ran_at: ranAts[ranAts.length - 1] ?? null,
    };
  });
}

/**
 * GitHub-identity Phase 1 capture: which git author + GitHub account this
 * agent's checkout will push as. Read-only observation — public login and
 * author strings only, never credentials.
 */
export function setAgentGitIdentity(
  agentId: string,
  identity: { name: string | null; email: string | null; ghLogin: string | null },
): void {
  db()
    .prepare("UPDATE agent SET git_author_name = ?, git_author_email = ?, gh_login = ? WHERE id = ?")
    .run(identity.name, identity.email, identity.ghLogin, agentId);
}
