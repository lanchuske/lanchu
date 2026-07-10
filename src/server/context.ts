/**
 * In-memory session context: maps the token (Authorization) to the agent and its
 * org/project. Created when the session is registered (/session endpoint) and consumed by
 * the MCP server on `initialize`. Ephemeral: if the server restarts, the launcher
 * re-registers (durable agents persist in the DB; sessions do not).
 */
export interface SessionContext {
  token: string;
  agentId: string;
  agentName: string;
  orgId: string;
  orgName: string;
  projectId: string;
  projectName: string;
  cwd?: string;
}

import * as store from "../core/store.js";

const byToken = new Map<string, SessionContext>();

export function putContext(ctx: SessionContext): void {
  byToken.set(ctx.token, ctx);
}

export function getContext(token: string): SessionContext | undefined {
  const cached = byToken.get(token);
  if (cached) return cached;
  // Rehydrate from the DB. Sessions persist across a server restart (the row
  // stays open in the `session` table) but this in-memory map does not — so
  // without this fallback any agent whose token was minted before the last
  // restart is locked out with a 401 until it is relaunched. Rebuild the
  // context the same way the launcher would and cache it.
  return rehydrateContext(token);
}

function rehydrateContext(token: string): SessionContext | undefined {
  const agentId = store.agentIdForToken(token);
  if (!agentId) return undefined;
  const agent = store.getAgent(agentId);
  if (!agent) return undefined;
  const org = store.getOrg(agent.org_id);
  if (!org) return undefined;
  const project = store.listProjects(org.id)[0];
  const ctx: SessionContext = {
    token,
    agentId: agent.id,
    agentName: agent.name,
    orgId: org.id,
    orgName: org.name,
    projectId: project?.id ?? "",
    projectName: project?.name ?? "",
    cwd: agent.cwd ?? undefined,
  };
  byToken.set(token, ctx);
  return ctx;
}

export function dropContext(token: string): void {
  byToken.delete(token);
}
