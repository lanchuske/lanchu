export type AgentState = "active" | "idle" | "retired";

/**
 * Display presence, tri-state: "working" = online with a fresh MCP call
 * (workingWindowMs), "idle" = reachable (live transport or alive terminal)
 * but quiet, "off" = no transport and no alive terminal — needs reattach.
 */
export type PresenceState = "working" | "idle" | "off";

export type TaskStatus =
  | "available"
  | "claimed"
  | "in_progress"
  | "blocked"
  | "done";

/**
 * SDLC lane, orthogonal to status. Optional; null is treated as backlog.
 * After qa: `rc` = QA passed, accumulating toward the next release (the
 * visible form of release pressure); `released` = shipped, stamped with
 * release_version. `done` remains the terminal lane for work outside the
 * release pipeline (verification instruments, off-mode orgs).
 */
export type TaskStage =
  | "backlog"
  | "definition"
  | "build"
  | "review"
  | "qa"
  | "rc"
  | "released"
  | "done";

export const TASK_STAGES: TaskStage[] = ["backlog", "definition", "build", "review", "qa", "rc", "released", "done"];

export type EventOutcome = "applied" | "rejected";

export type EventType =
  | "agent.created"
  | "agent.reused"
  | "agent.active"
  | "agent.idle"
  | "agent.retired"
  | "agent.parked"
  | "retire.requested"
  | "retire.approved"
  | "retire.denied"
  | "task.created"
  | "task.claimed"
  | "task.released"
  | "task.started"
  | "task.completed"
  | "task.blocked"
  | "task.reassigned"
  | "task.rejected"
  | "task.stage_changed"
  | "task.stage_reconciled"
  | "task.bounced"
  | "task.archived"
  | "task.superseded"
  | "task.redefined"
  | "pr.merged"
  | "task.handoff"
  | "doc.created"
  | "doc.updated"
  | "doc.read"
  | "doc.archived"
  | "role.updated"
  | "message.sent"
  | "session.rotated"
  | "greenzone.requested"
  | "greenzone.confirmed"
  | "greenzone.executed"
  | "greenzone.expired"
  | "greenzone.cancelled"
  | "coordinator.acquired"
  | "coordinator.released"
  | "coordinator.handoff"
  | "coordinator.expired"
  | "conflict.detected"
  | "agent.duplicate_session"
  | "scope.violation"
  | "quota.exceeded"
  | "memory.written"
  | "memory.deleted"
  | "test.reported"
  | "tool.response"
  | "agent.nudged"
  | "notice.expired";

export interface Org {
  id: string;
  name: string;
  created_at: string;
}

export interface Project {
  id: string;
  org_id: string;
  name: string;
  repo_url: string | null;
  local_path: string | null;
  created_at: string;
}

export interface Role {
  id: string;
  org_id: string;
  name: string;
  is_wildcard: boolean;
  allowed_tags: string[];
  /** Self-reported token budget for ALL agents of this role combined; null = unlimited. */
  token_quota: number | null;
  /** Default claude model tier for agents spawned with this role (opus|sonnet|haiku or any alias); null = harness default. */
  preferred_model: string | null;
  created_at: string;
}

export interface Agent {
  id: string;
  org_id: string;
  role_id: string;
  name: string;
  objective: string | null;
  state: AgentState;
  last_activity_at: string | null;
  last_activity: string | null;
  cwd: string | null;
  branch: string | null;
  worktree: string | null;
  /** Persisted palette slot (per-org de-collision); null until first assignment. */
  color_slot: number | null;
  git_author_name: string | null;
  git_author_email: string | null;
  gh_login: string | null;
  /** The claude model tier this agent's terminal was launched with; null = harness default. */
  model: string | null;
  /** Claude Code session id, reported by the SessionStart hook (wake v5 park & refire). */
  claude_session_id: string | null;
  /** Set by the SessionEnd hook when the Claude session exits: parked, refire-able. */
  parked_at: string | null;
  created_at: string;
  retired_at: string | null;
}

/** Why an agent bounced a task back to definition instead of guessing. */
export type RejectReason =
  | "out_of_scope"
  | "underspecified"
  | "missing_docs"
  | "blocked_dependency"
  | "other";

export interface TaskRejection {
  reason: RejectReason;
  note: string;
  /** Display name of the agent who rejected it. */
  by: string;
  at: string;
}

/** A backward SDLC move (qa→build, review→build…), first-class per the design doc. */
export interface TaskBounce {
  from: TaskStage;
  to: TaskStage;
  reason: string;
  at: string;
}

export interface Task {
  id: string;
  project_id: string;
  parent_task_id: string | null;
  title: string;
  status: TaskStatus;
  stage: TaskStage | null;
  pr_url: string | null;
  owner_agent_id: string | null;
  workspace: string | null;
  tags: string[];
  created_by_agent_id: string | null;
  created_at: string;
  claimed_at: string | null;
  updated_at: string | null;
  done_at: string | null;
  /** How many times agents bounced this task back to definition. 2+ = needs definition. */
  rejection_count: number;
  last_rejection: TaskRejection | null;
  /** Backward SDLC moves so far; 2+ flags the item "needs attention". */
  bounce_count: number;
  last_bounce: TaskBounce | null;
  /** Terminal archive (soft-delete): hidden from the board and every open-work
   *  query, never hard-deleted (audit integrity). Orthogonal to status, which
   *  keeps its last value as the historical record. */
  archived_at: string | null;
  archived_reason: string | null;
  /** When archived because newer work replaces it, the successor task. */
  superseded_by_task_id: string | null;
  /** The release that shipped this task (e.g. "v0.5.13"); stamped by the
   *  release sweep when a tag covering the work appears on origin/main. */
  release_version: string | null;
}

export interface LanchuEvent {
  id: number;
  org_id: string;
  project_id: string | null;
  type: EventType;
  actor_agent_id: string | null;
  subject_kind: string | null;
  subject_id: string | null;
  workspace: string | null;
  tokens: number | null;
  outcome: EventOutcome;
  data: Record<string, unknown> | null;
  created_at: string;
}

export type MemoryScope = "agent" | "project" | "org";
export type MemorySource = "event" | "agent" | "distilled";

/** A persisted learning: org-visible, audited, size-capped. Data, not instructions. */
export interface MemoryEntry {
  id: string;
  org_id: string;
  scope: MemoryScope;
  subject_id: string;
  key: string;
  value: string;
  source: MemorySource;
  source_ref: string | null;
  confidence: number;
  created_at: string;
  updated_at: string;
}

/** Governance error: the action violates the role scope (hard block on mediated actions). */
export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeError";
  }
}

/** Governance error: the role's self-reported token quota is exhausted (blocks new claims). */
export class QuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaError";
  }
}
