export type AgentState = "active" | "idle" | "retired";

/** 'human' = a Person acting directly (network mode); 'ai' = every agent today. */
export type AgentKind = "ai" | "human";

/** 'contract' = a network-mode task worked entirely isolated from the real repo (Piece 5); 'internal' = every task today. */
export type TaskKind = "internal" | "contract";

/**
 * Display presence: "working" = online with a fresh MCP call
 * (workingWindowMs), "idle" = reachable (live transport or alive terminal)
 * but quiet, "parked" = the claude session exited cleanly and is
 * refire-able (wake v5 — the sweep revives it on new work), "off" = no
 * transport, no alive terminal, not parked — needs manual reattach.
 */
export type PresenceState = "working" | "idle" | "parked" | "off";

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
 * release pipeline (verification instruments, off-mode orgs). `integrated`
 * (network mode, Piece 5): a verified `kind='contract'` task whose
 * deliverable the project owner has applied to the real repository —
 * the contract-task equivalent of `released`, reached only via
 * `integrateContractTask`, never through the general stage-setting path.
 */
export type TaskStage =
  | "backlog"
  | "definition"
  | "build"
  | "review"
  | "qa"
  | "rc"
  | "released"
  | "done"
  | "integrated";

export const TASK_STAGES: TaskStage[] = [
  "backlog", "definition", "build", "review", "qa", "rc", "released", "done", "integrated",
];

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
  | "greenzone.extended"
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
  | "notice.expired"
  | "agent.terminal_closed"
  | "org.shutdown"
  | "network.idea_submitted";

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
  /** Network mode: the Person this Membership belongs to; null for every local-mode agent. */
  person_id: string | null;
  /** Network mode: 'human' when a Person acts directly (no MCP session — see Piece 1). Defaults 'ai'. */
  kind: AgentKind;
  created_at: string;
  retired_at: string | null;
}

/**
 * Network mode: a durable identity that outlives any single org membership.
 * Global, not org-scoped. See "Design: Person identity & Membership".
 */
export interface Person {
  id: string;
  email: string;
  handle: string;
  bio: string | null;
  github_login: string | null;
  created_at: string;
}

/**
 * Network mode: a magic-link request — orthogonal to the MCP `session`
 * table. Single-use (`consumed_at`), short-lived. See "Design: Person
 * identity & Membership".
 */
export interface PersonLoginRequest {
  id: string;
  email: string;
  token: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

/**
 * Network mode: a signed-in Person's web session — the cookie-based
 * counterpart to the MCP session table, never used by an MCP client.
 */
export interface PersonSession {
  id: string;
  person_id: string;
  token: string;
  created_at: string;
  expires_at: string;
}

/**
 * Network mode: the transparent, non-monetary contribution ledger. Written
 * once per task at QA-pass time, only for network-mode projects. See
 * "Design: Contribution ledger (network mode — Piece 4)".
 */
export interface ContributionEvent {
  id: string;
  /** The contributor who gets credit. */
  person_id: string;
  project_id: string;
  task_id: string;
  /** Fibonacci-ish scale (1/2/3/5/8), assigned by the verifier at QA-pass time. */
  weight: number;
  /** Who checked the work; must not be the same Person as person_id (enforced elsewhere). */
  verified_by: string | null;
  created_at: string;
}

/**
 * Network mode: a contract task's submitted work — the isolated-contributor
 * equivalent of a normal task's `pr_url`. Multiple rows per task are
 * expected (resubmission after a FAIL bounce); the most recent is
 * canonical. See "Design: Contract-based contributor isolation (network
 * mode — Piece 5)".
 */
export interface ContractDeliverable {
  id: string;
  task_id: string;
  content: string;
  submitted_by_agent_id: string | null;
  submitted_at: string;
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
  /** Network mode (Piece 6): null until the project owner explicitly publishes this task to the public directory. */
  published_at: string | null;
  /** Network mode (Piece 5): 'contract' tasks are worked entirely isolated from the real repo. Defaults 'internal'. */
  kind: TaskKind;
  /** Signature/shape, inputs/outputs, behavioral constraints. Meaningful only when kind='contract'. */
  contract_spec: string | null;
  /** An automated test suite the deliverable must satisfy, run in the contributor's sandbox. */
  contract_tests: string | null;
  /** JSON array of other published contract task ids this task may call (interface only). */
  contract_deps: string | null;
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
