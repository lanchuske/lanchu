/**
 * Greenzone: a coordinated maintenance window for disruptive ops (server
 * restart, schema migration…). Instead of yanking the server out from under
 * working agents (evidence 2026-07-11: a unilateral restart mid-work alarmed
 * three agents at once), the supervisor REQUESTS a window: every live agent
 * is noticed to reach a safe point and confirm via the greenzone_ack tool;
 * the op executes when all of them confirm or when the timeout expires (idle
 * agents never block). Everything is audited (greenzone.requested / confirmed
 * / executed). In-memory by design — a greenzone's whole point is to end in
 * the disruptive op, so it never needs to survive one.
 */
import { isAgentLive } from "./presence.js";
import * as store from "./store.js";

export const GREENZONE_DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Belt-and-braces TTL past the deadline: if the arming timer ever dies without
 * executing (the 2026-07-11 orphan blocked the org's greenzones for 20+ min
 * with no way to clear it), any later touch — status read, ack, new request —
 * expires the stale window instead of letting it block forever.
 */
export const GREENZONE_EXPIRY_GRACE_MS = 60_000;

/** Env override (LANCHU_GREENZONE_GRACE_MS) so tests don't wait a minute. */
function expiryGraceMs(): number {
  const s = process.env.LANCHU_GREENZONE_GRACE_MS;
  const n = s ? Number.parseInt(s, 10) : GREENZONE_EXPIRY_GRACE_MS;
  return Number.isFinite(n) && n >= 0 ? n : GREENZONE_EXPIRY_GRACE_MS;
}

export interface GreenzoneStatus {
  state: "idle" | "requested" | "done" | "expired" | "cancelled";
  action?: string;
  requested_at?: string;
  deadline?: string;
  /** Live agents whose confirmation is awaited (plus late voluntary confirms). */
  required: { id: string; name: string; confirmed_at: string | null }[];
  confirmed?: number;
  executed_at?: string;
  ended_at?: string;
  timed_out?: boolean;
}

interface Zone {
  orgId: string;
  action: string;
  requestedAt: number;
  timeoutMs: number;
  timer: NodeJS.Timeout | null;
  required: Map<string, { name: string; confirmedAt: number | null }>;
  execute: () => void;
  /** When the zone ENDED, whatever the reason — null while the window is open. */
  endedAt: number | null;
  endReason: "executed" | "expired" | "cancelled" | null;
  timedOut: boolean;
}

/** One zone per org: the current window, or the last one (state "done"). */
const zones = new Map<string, Zone>();

function statusOf(zone: Zone): GreenzoneStatus {
  const required = [...zone.required.entries()].map(([id, e]) => ({
    id,
    name: e.name,
    confirmed_at: e.confirmedAt ? new Date(e.confirmedAt).toISOString() : null,
  }));
  const state: GreenzoneStatus["state"] =
    zone.endedAt === null ? "requested" : zone.endReason === "executed" ? "done" : (zone.endReason ?? "done");
  return {
    state,
    action: zone.action,
    requested_at: new Date(zone.requestedAt).toISOString(),
    deadline: new Date(zone.requestedAt + zone.timeoutMs).toISOString(),
    required,
    confirmed: required.filter((r) => r.confirmed_at).length,
    ...(zone.endedAt
      ? {
          ended_at: new Date(zone.endedAt).toISOString(),
          ...(zone.endReason === "executed"
            ? { executed_at: new Date(zone.endedAt).toISOString(), timed_out: zone.timedOut }
            : {}),
        }
      : {}),
  };
}

/**
 * Self-healing on every touch: a window whose deadline+grace passed without
 * ending means its timer died (killed requester process in older builds, a
 * cleared timer, a bug) — expire it, audited, so it can never block the org.
 */
function maybeExpire(zone: Zone): void {
  if (zone.endedAt !== null) return;
  if (Date.now() <= zone.requestedAt + zone.timeoutMs + expiryGraceMs()) return;
  endZone(zone, "expired");
}

export function greenzoneStatus(orgId: string): GreenzoneStatus {
  const zone = zones.get(orgId);
  if (!zone) return { state: "idle", required: [] };
  maybeExpire(zone);
  return statusOf(zone);
}

/** True while a window is open — callers pause risky ops (new claims…). */
export function isGreenzoneActive(orgId: string): boolean {
  const zone = zones.get(orgId);
  if (!zone) return false;
  maybeExpire(zone);
  return zone.endedAt === null;
}

/**
 * Open a maintenance window: snapshot the org's LIVE agents as the required
 * confirmations, notice each one, audit, and arm the timeout. With no live
 * agents there is nothing to coordinate — the op executes immediately.
 */
export function requestGreenzone(input: {
  orgId: string;
  action?: string;
  timeoutMs?: number;
  byAgentId?: string | null;
  execute: () => void;
}): GreenzoneStatus {
  const existing = zones.get(input.orgId);
  if (existing) maybeExpire(existing);
  if (existing && existing.endedAt === null) {
    throw new Error("a greenzone is already in progress for this org");
  }
  const action = input.action ?? "restart";
  const timeoutMs = input.timeoutMs ?? GREENZONE_DEFAULT_TIMEOUT_MS;
  const live = store
    .listAgents(input.orgId)
    .filter((a) => a.state !== "retired" && isAgentLive(a.id) && a.id !== input.byAgentId);

  const zone: Zone = {
    orgId: input.orgId,
    action,
    requestedAt: Date.now(),
    timeoutMs,
    timer: null,
    required: new Map(live.map((a) => [a.id, { name: a.name, confirmedAt: null }])),
    execute: input.execute,
    endedAt: null,
    endReason: null,
    timedOut: false,
  };
  zones.set(input.orgId, zone);

  store.recordEvent({
    org_id: input.orgId,
    type: "greenzone.requested",
    actor_agent_id: input.byAgentId ?? null,
    subject_kind: "org",
    subject_id: input.orgId,
    data: { action, timeout_ms: timeoutMs, required: live.map((a) => a.name) },
  });
  for (const a of live) {
    // ref 'greenzone' lets message_ack double as the confirmation: sessions
    // opened before greenzone_ack existed can't see that tool (tool lists are
    // fixed at session init), but every session can ack a notice.
    store.systemNotice(
      input.orgId,
      a.id,
      `Greenzone requested (${action}): reach a safe point — commit WIP, finish writes — then confirm with greenzone_ack ` +
        `(if that tool isn't available in your session, message_ack this notice: it counts as your confirmation). ` +
        `Executes when every live agent confirms, or in ${Math.round(timeoutMs / 1000)}s.`,
      "greenzone",
    );
  }

  if (!zone.required.size) {
    executeZone(zone, false);
  } else {
    zone.timer = setTimeout(() => executeZone(zone, true), timeoutMs);
    zone.timer.unref?.();
  }
  return statusOf(zone);
}

/** An agent confirms it reached a safe point. All confirmed → execute early. */
export function ackGreenzone(orgId: string, agentId: string): GreenzoneStatus {
  const zone = zones.get(orgId);
  if (zone) maybeExpire(zone);
  if (!zone || zone.endedAt !== null) throw new Error("no greenzone in progress");
  const entry = zone.required.get(agentId);
  if (entry) {
    if (!entry.confirmedAt) entry.confirmedAt = Date.now();
  } else {
    // Not in the required snapshot (connected after the request): a voluntary
    // confirm still counts as "this agent is safe" and shows on the banner.
    zone.required.set(agentId, {
      name: store.getAgent(agentId)?.name ?? agentId,
      confirmedAt: Date.now(),
    });
  }
  const confirmed = [...zone.required.values()].filter((e) => e.confirmedAt).length;
  store.recordEvent({
    org_id: orgId,
    type: "greenzone.confirmed",
    actor_agent_id: agentId,
    subject_kind: "org",
    subject_id: orgId,
    data: { action: zone.action, progress: `${confirmed}/${zone.required.size}` },
  });
  if (confirmed === zone.required.size) executeZone(zone, false);
  return statusOf(zone);
}

function executeZone(zone: Zone, timedOut: boolean): void {
  if (zone.endedAt !== null) return;
  zone.timedOut = timedOut;
  endZone(zone, "executed");
  try {
    zone.execute();
  } catch {
    /* the op itself failing must not corrupt greenzone state */
  }
}

/** Close the window for any reason (executed | expired | cancelled), audited. */
function endZone(zone: Zone, reason: "executed" | "expired" | "cancelled", byAgentId?: string | null): void {
  if (zone.endedAt !== null) return;
  zone.endedAt = Date.now();
  zone.endReason = reason;
  if (zone.timer) clearTimeout(zone.timer);
  const entries = [...zone.required.values()];
  store.recordEvent({
    org_id: zone.orgId,
    type: `greenzone.${reason}` as "greenzone.executed" | "greenzone.expired" | "greenzone.cancelled",
    actor_agent_id: byAgentId ?? null,
    subject_kind: "org",
    subject_id: zone.orgId,
    data: {
      action: zone.action,
      confirmed: entries.filter((e) => e.confirmedAt).length,
      required: entries.length,
      ...(reason === "executed" ? { timed_out: zone.timedOut } : {}),
      ...(reason === "expired" ? { deadline_overrun_ms: zone.endedAt - zone.requestedAt - zone.timeoutMs } : {}),
    },
  });
}

/**
 * Supervisor override: abort a requested window before it executes. The armed
 * op never runs; the agents that were told to reach a safe point are noticed
 * that the window is off. Audited as greenzone.cancelled.
 */
export function cancelGreenzone(orgId: string, byAgentId?: string | null): GreenzoneStatus {
  const zone = zones.get(orgId);
  if (zone) maybeExpire(zone);
  if (!zone || zone.endedAt !== null) throw new Error("no greenzone in progress");
  endZone(zone, "cancelled", byAgentId);
  for (const [agentId] of zone.required) {
    store.systemNotice(
      orgId,
      agentId,
      `Greenzone cancelled (${zone.action}): the maintenance window was called off — resume normal work.`,
    );
  }
  return statusOf(zone);
}

/** Test hook: drop all in-memory windows. */
export function resetGreenzones(): void {
  for (const z of zones.values()) if (z.timer) clearTimeout(z.timer);
  zones.clear();
}

/** Test hook: kill a window's armed timer — simulates the orphan (a lost execution). */
export function dropTimerForTest(orgId: string): void {
  const z = zones.get(orgId);
  if (z?.timer) {
    clearTimeout(z.timer);
    z.timer = null;
  }
}
