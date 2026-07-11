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

export interface GreenzoneStatus {
  state: "idle" | "requested" | "done";
  action?: string;
  requested_at?: string;
  deadline?: string;
  /** Live agents whose confirmation is awaited (plus late voluntary confirms). */
  required: { id: string; name: string; confirmed_at: string | null }[];
  confirmed?: number;
  executed_at?: string;
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
  executedAt: number | null;
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
  return {
    state: zone.executedAt ? "done" : "requested",
    action: zone.action,
    requested_at: new Date(zone.requestedAt).toISOString(),
    deadline: new Date(zone.requestedAt + zone.timeoutMs).toISOString(),
    required,
    confirmed: required.filter((r) => r.confirmed_at).length,
    ...(zone.executedAt ? { executed_at: new Date(zone.executedAt).toISOString(), timed_out: zone.timedOut } : {}),
  };
}

export function greenzoneStatus(orgId: string): GreenzoneStatus {
  const zone = zones.get(orgId);
  return zone ? statusOf(zone) : { state: "idle", required: [] };
}

/** True while a window is open — callers pause risky ops (new claims…). */
export function isGreenzoneActive(orgId: string): boolean {
  const zone = zones.get(orgId);
  return !!zone && zone.executedAt === null;
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
  if (existing && existing.executedAt === null) {
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
    executedAt: null,
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
    store.systemNotice(
      input.orgId,
      a.id,
      `Greenzone requested (${action}): reach a safe point — commit WIP, finish writes — then confirm with greenzone_ack. ` +
        `Executes when every live agent confirms, or in ${Math.round(timeoutMs / 1000)}s.`,
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
  if (!zone || zone.executedAt !== null) throw new Error("no greenzone in progress");
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
  if (zone.executedAt !== null) return;
  zone.executedAt = Date.now();
  zone.timedOut = timedOut;
  if (zone.timer) clearTimeout(zone.timer);
  const entries = [...zone.required.values()];
  store.recordEvent({
    org_id: zone.orgId,
    type: "greenzone.executed",
    subject_kind: "org",
    subject_id: zone.orgId,
    data: {
      action: zone.action,
      confirmed: entries.filter((e) => e.confirmedAt).length,
      required: entries.length,
      timed_out: timedOut,
    },
  });
  try {
    zone.execute();
  } catch {
    /* the op itself failing must not corrupt greenzone state */
  }
}

/** Test hook: drop all in-memory windows. */
export function resetGreenzones(): void {
  for (const z of zones.values()) if (z.timer) clearTimeout(z.timer);
  zones.clear();
}
