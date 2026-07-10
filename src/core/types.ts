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
  | "task.handoff"
  | "doc.created"
  | "doc.updated"
  | "scope.violation";

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

/** Governance error: the action violates the role scope (hard block on mediated actions). */
export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeError";
  }
}
