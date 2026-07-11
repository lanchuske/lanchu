/**
 * Live-session presence registry (in-memory). Complements recency-based
 * presence: a Claude agent holds its MCP transport open continuously but only
 * emits MCP traffic when the model calls a lanchu tool, so recency alone
 * false-idles an agent that is connected yet quietly working. The server marks
 * an agent live for as long as it holds at least one open MCP transport.
 *
 * Ref-counted, because one agent can hold several concurrent sessions. Purely
 * in-memory: it resets when the server restarts (transports reconnect), at
 * which point recency takes over until they do.
 */
const liveSessions = new Map<string, number>();

/** Register an open MCP transport for an agent (call on session init). */
export function addLiveSession(agentId: string): void {
  liveSessions.set(agentId, (liveSessions.get(agentId) ?? 0) + 1);
}

/** Drop one open transport for an agent (call on session close). Idempotent
 * once the count reaches zero, so double-fire from close+onclose is safe. */
export function removeLiveSession(agentId: string): void {
  const n = (liveSessions.get(agentId) ?? 0) - 1;
  if (n > 0) liveSessions.set(agentId, n);
  else liveSessions.delete(agentId);
}

/** True while the agent has at least one open MCP transport. */
export function isAgentLive(agentId: string): boolean {
  return (liveSessions.get(agentId) ?? 0) > 0;
}

/** How many MCP transports the agent holds open right now. */
export function liveSessionCount(agentId: string): number {
  return liveSessions.get(agentId) ?? 0;
}
