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

const byToken = new Map<string, SessionContext>();

export function putContext(ctx: SessionContext): void {
  byToken.set(ctx.token, ctx);
}

export function getContext(token: string): SessionContext | undefined {
  return byToken.get(token);
}

export function dropContext(token: string): void {
  byToken.delete(token);
}
