import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state; shrink the nudge grace window so tests don't wait.
const dir = path.join(os.tmpdir(), "lanchu-nudge-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;
process.env.LANCHU_NUDGE_AFTER_SECONDS = "1";

const store = await import("../dist/core/store.js");
const { runNudgeSweep } = await import("../dist/server/server.js");

function setup(orgName) {
  const org = store.getOrCreateOrg(orgName);
  const project = store.getOrCreateProject(org.id, "core");
  const role = store.getOrCreateRole(org.id, "generalist", { wildcard: true });
  const sender = store.createAgent({ orgId: org.id, roleId: role.id, name: "sender" });
  const sleeper = store.createAgent({ orgId: org.id, roleId: role.id, name: "sleeper" });
  store.setAgentTerminal(sleeper.id, { method: "tmux", id: "%99" });
  return { org, project, role, sender, sleeper };
}

const graceElapsed = () => new Promise((r) => setTimeout(r, 1100));

// ── wake v5.1 (task-mrgpl72k9): the sweep NEVER types into a terminal ──
// The owner directive: typing transports are gone by construction. Live idle
// TUIs wake via the asyncRewake Stop hook; the sweep only refires sessions
// that EXITED (parked or verifiably crashed).

test("v5.1: a starved LIVE terminal is never touched by the sweep — the asyncRewake hook owns it", async () => {
  const { org, sender, sleeper } = setup("nudge1");
  store.setAgentClaudeSession(sleeper.id, "sid-live"); // known session, NOT parked
  store.sendNotice({ orgId: org.id, fromAgentId: sender.id, to: "sleeper", body: "wake up: task-X" });
  await graceElapsed();

  // The starvation diagnostic still sees the candidate…
  assert.equal(store.agentsNeedingNudge(org.id).length, 1, "starved candidate visible to diagnostics");
  // …but the sweep does nothing to a live terminal: no refire, no typing rung at all.
  const r = runNudgeSweep({
    alive: () => true, // the TUI is open
    transportLive: () => false,
    liveSessions: () => new Set(),
    refire: () => { throw new Error("a live terminal must never be refired"); },
  });
  assert.deepEqual(r.refired, []);
  assert.equal("nudged" in r, false, "the typing rung does not even exist in the result");
  assert.equal(store.listAuditEvents(org.id).some((e) => e.type === "agent.nudged"), false);
});

test("v5.1: the same starved agent with a DEAD terminal refires — transport runner, never keystrokes", async () => {
  const { org, sender, sleeper } = setup("nudge2");
  store.setAgentClaudeSession(sleeper.id, "sid-dead");
  store.setAgentWorkspace(sleeper.id, { cwd: "/tmp/wt" });
  store.sendNotice({ orgId: org.id, fromAgentId: sender.id, to: "sleeper", body: "wake" });
  await graceElapsed();

  const fired = [];
  const r = runNudgeSweep({
    alive: () => false,
    transportLive: () => false,
    liveSessions: () => new Set(),
    refire: (c) => { fired.push(c.claude_session_id); return true; },
  });
  assert.deepEqual(r.refired, ["sleeper"]);
  assert.deepEqual(fired, ["sid-dead"]);
  const ev = store.listAuditEvents(org.id).find((e) => e.type === "agent.nudged");
  assert.equal(ev.data.transport, "runner", "the only wake transport left is the runner");
});

// ── starvation semantics (v2) survive unchanged in the diagnostics ──

test("delivered, acked, too-fresh or busy agents are never starvation candidates", async () => {
  const { org, sender } = setup("nudge3");
  const sleeperId = store.findAgentByName(org.id, "sleeper").id;

  // Delivered via piggyback → not a candidate.
  store.sendNotice({ orgId: org.id, fromAgentId: sender.id, to: "sleeper", body: "a" });
  store.takeUndeliveredNotices(sleeperId);
  await graceElapsed();
  assert.equal(store.agentsNeedingNudge(org.id).length, 0, "delivered notices don't starve");

  // Fresh (inside the grace window) → not yet.
  store.sendNotice({ orgId: org.id, fromAgentId: sender.id, to: "sleeper", body: "b" });
  assert.equal(store.agentsNeedingNudge(org.id).length, 0, "grace window respected");

  // Acked (read via inbox) → never.
  const inbox = store.listNotices(sleeperId);
  store.ackNotices(sleeperId, inbox.map((n) => n.id));
  await graceElapsed();
  assert.equal(store.agentsNeedingNudge(org.id).length, 0, "acked notices don't starve");

  // A tool call AFTER the notice → piggyback owns delivery, not the sweep.
  store.sendNotice({ orgId: org.id, fromAgentId: sender.id, to: "sleeper", body: "c" });
  store.recordToolSpend(org.id, sleeperId, "task_update", 1200);
  await graceElapsed();
  assert.equal(store.agentsNeedingNudge(org.id).length, 0, "busy agents hear it on their own calls");
});

test("a tool call BEFORE the notice does not mask starvation", async () => {
  const { org, sender } = setup("nudge4");
  const sleeperId = store.findAgentByName(org.id, "sleeper").id;
  store.recordToolSpend(org.id, sleeperId, "task_update", 900);
  await new Promise((r) => setTimeout(r, 50));
  store.sendNotice({ orgId: org.id, fromAgentId: sender.id, to: "sleeper", body: "wake up" });
  await graceElapsed();
  const candidates = store.agentsNeedingNudge(org.id);
  assert.equal(candidates.length, 1, "no call since the notice → starved");
  assert.equal(candidates[0].agent_name, "sleeper");
});

// ── v3 hygiene: broadcasts expire, budgets flag unreachable, the dead hear nothing ──

/** Backdate rows directly (second connection, WAL): tests must not wait wall-clock. */
async function rawDb() {
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(path.join(dir, "lanchu.db"));
}

test("a broadcast never wakes anyone and self-expires after the TTL", async () => {
  const { org, sender } = setup("nudge5");
  const sleeperId = store.findAgentByName(org.id, "sleeper").id;
  store.sendNotice({ orgId: org.id, fromAgentId: sender.id, to: "*", body: "FYI: restarting soon" });
  await graceElapsed();

  assert.equal(store.agentsNeedingNudge(org.id).length, 0, "broadcasts don't starve anyone");

  const raw = await rawDb();
  const old = new Date(Date.now() - 31 * 60_000).toISOString();
  raw.prepare("UPDATE notice SET created_at = ? WHERE org_id = ? AND is_broadcast = 1").run(old, org.id);
  raw.close();
  const sweep = runNudgeSweep({ alive: () => true, liveSessions: () => new Set(), refire: () => false });
  assert.ok(sweep.expired_broadcasts >= 1, "stale broadcast expired");
  assert.equal(store.unackedNoticeCount(sleeperId), 0, "expiry acks the broadcast");
  assert.ok(store.listAuditEvents(org.id).some((e) => e.type === "notice.expired"), "expiry is on the record");
});

test("the wake budget caps per undelivered set, then the agent shows unreachable — and self-clears", async () => {
  const { org, sender } = setup("nudge6");
  const sleeperId = store.findAgentByName(org.id, "sleeper").id;
  store.sendNotice({ orgId: org.id, fromAgentId: sender.id, to: "sleeper", body: "wake" });
  store.setAgentClaudeSession(sleeperId, "sid-budget");
  store.setAgentWorkspace(sleeperId, { cwd: "/tmp/wt" });
  const raw = await rawDb();
  raw.prepare("UPDATE notice SET created_at = ? WHERE to_agent_id = ?")
    .run(new Date(Date.now() - 10 * 60_000).toISOString(), sleeperId);
  raw.close();

  // Two wakes (the budget) already spent — audited as agent.nudged events.
  store.recordNudge(org.id, sleeperId, 1, "runner");
  store.recordNudge(org.id, sleeperId, 1, "runner");
  const raw2 = await rawDb();
  raw2.prepare("UPDATE event SET created_at = ? WHERE type = 'agent.nudged' AND subject_id = ?")
    .run(new Date(Date.now() - 6 * 60_000).toISOString(), sleeperId);
  raw2.close();

  assert.equal(store.agentsNeedingNudge(org.id).length, 0, "budget spent — diagnostics go silent");
  assert.equal(store.agentsNeedingRefire(org.id).length, 0, "refires respect the same budget");
  assert.ok(store.unreachableAgents(org.id).has(sleeperId), "flagged unreachable");
  const card = store.boardSnapshot(org.id).agents.find((a) => a.id === sleeperId);
  assert.equal(card.unreachable, true, "panel card carries the flag");

  // Derived state: the agent acting clears it.
  store.recordToolSpend(org.id, sleeperId, "message_list", 100);
  assert.equal(store.unreachableAgents(org.id).has(sleeperId), false, "self-clears once the agent acts");
});

test("retiring an agent voids its pending notices — nothing is addressed to the dead", async () => {
  const { org, sender } = setup("nudge7");
  const sleeperId = store.findAgentByName(org.id, "sleeper").id;
  store.sendNotice({ orgId: org.id, fromAgentId: sender.id, to: "sleeper", body: "you'll never read this" });
  await graceElapsed();
  assert.equal(store.agentsNeedingNudge(org.id).length, 1, "pending set exists pre-retirement");

  const res = store.retireAgent(sleeperId);
  assert.equal(res.retired, true);
  assert.equal(store.unackedNoticeCount(sleeperId), 0, "inbox voided");
  const ev = store.listAuditEvents(org.id).find((e) => e.type === "agent.retired");
  assert.equal(ev.data.voided_notices, 1, "voiding is audited");
  assert.equal(store.agentsNeedingRefire(org.id).length, 0, "retired agents are never refired");
});
