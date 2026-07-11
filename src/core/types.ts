export type AgentState = "active" | "idle" | "retired";

export type TaskStatus =
  | "available"
  | "claimed"
  | "in_progress"
  | "blocked"
  | "done";

/** SDLC lane, orthogonal to status. Optional; null is treated as backlog. */
export type TaskStage =
  | "backlog"
  | "definition"
  | "build"
  | "review"
  | "qa"
  | "done";

export const TASK_STAGES: TaskStage[] = ["backlog", "definition", "build", "review", "qa", "done"];

export type EventOutcome = "applied" | "rejected";

export type EventType =
  | "agent.created"
  | "agent.reused"
  | "agent.active"
  | "agent.idle"
  | "agent.retired"
  | "task.created"
  | "task.claimed"
  | "task.released"
  | "task.started"
  | "task.completed"
  | "task.blocked"
  | "task.reassigned"
  | "task.rejected"
  | "task.handoff"
  | "doc.created"
  | "doc.updated"
  | "doc.read"
  | "role.updated"
  | "message.sent"
  | "session.rotated"
  | "greenzone.requested"
  | "greenzone.confirmed"
  | "greenzone.executed"
  | "conflict.detected"
  | "agent.duplicate_session"
  | "scope.violation"
  | "quota.exceeded"
  | "memory.written"
  | "tool.response";

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
