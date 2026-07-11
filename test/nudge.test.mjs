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
const { runNudgeSweep, NUDGE_LINE } = await import("../dist/server/server.js");

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

test("a queued notice past the grace window nudges the sleeping agent's terminal, once", async () => {
  const { org, sender } = setup("nudge1");
  store.sendNotice({ orgId: org.id, fromAgentId: sender.id, to: "sleeper", body: "wake up: task-X" });
  await graceElapsed();

  const calls = [];
  const effects = {
    alive: () => true,
    nudge: (ref, line) => { calls.push({ ref, line }); return true; },
  };
  const first = runNudgeSweep(effects);
  assert.deepEqual(first.nudged, ["sleeper"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ref.id, "%99", "targets the agent's own terminal ref");
  assert.equal(calls[0].line, NUDGE_LINE, "only ever the fixed line — no message content");

  // Cooldown: an immediate second sweep must not re-nudge.
  const second = runNudgeSweep(effects);
  assert.deepEqual(second.nudged, [], "rate-limited per agent");
  assert.equal(calls.length, 1);

  // Audited.
  const ev = store.listAuditEvents(org.id).find((e) => e.type === "agent.nudged");
  assert.ok(ev, "nudge is on the record");
  assert.equal(ev.data.queued_notices, 1);
});

test("no nudge when notices were delivered, acked, too fresh, or there is no terminal", async () => {
  const { org, role, sender } = setup("nudge2");

  // Delivered via piggyback → no nudge.
  store.sendNotice({ orgId: org.id, fromAgentId: sender.id, to: "sleeper", body: "a" });
  const sleeperId = store.findAgentByName(org.id, "sleeper").id;
  store.takeUndeliveredNotices(sleeperId);
  await graceElapsed();
  assert.equal(store.agentsNeedingNudge(org.id).length, 0, "delivered notices don't nudge");

  // Fresh (inside the grace window) → no nudge yet.
  store.sendNotice({ orgId: org.id, fromAgentId: sender.id, to: "sleeper", body: "b" });
  assert.equal(store.agentsNeedingNudge(org.id).length, 0, "grace window respected");

  // Acked (e.g. read via inbox) → no nudge even past the window.
  const inbox = store.listNotices(sleeperId);
  store.ackNotices(sleeperId, inbox.map((n) => n.id));
  await graceElapsed();
  assert.equal(store.agentsNeedingNudge(org.id).length, 0, "acked notices don't nudge");

  // No terminal_ref (agent Lanchu didn't spawn) → never nudged.
  const feral = store.createAgent({ orgId: org.id, roleId: role.id, name: "feral" });
  store.sendNotice({ orgId: org.id, fromAgentId: sender.id, to: "feral", body: "c" });
  await graceElapsed();
  assert.equal(store.agentsNeedingNudge(org.id).some((c) => c.agent_name === "feral"), false);
  void feral;
});

test("a dead terminal is skipped and stays un-audited (so a later sweep can retry)", async () => {
  const { org, sender } = setup("nudge3");
  store.sendNotice({ orgId: org.id, fromAgentId: sender.id, to: "sleeper", body: "wake" });
  await graceElapsed();

  const res = runNudgeSweep({ alive: () => false, nudge: () => { throw new Error("must not be called"); } });
  assert.deepEqual(res.nudged, []);
  assert.equal(store.listAuditEvents(org.id).some((e) => e.type === "agent.nudged"), false);

  // Terminal comes back → the same queued notice now nudges.
  const later = runNudgeSweep({ alive: () => true, nudge: () => true });
  assert.deepEqual(later.nudged, ["sleeper"]);
});

// ── v2: state-driven (piggyback starvation), not timer-driven ──

test("v2 bug repro: an actively-working agent is never nudged — a tool call after the notice means piggyback handles it", async () => {
  const { org, sender } = setup("nudge-v2-busy");
  const sleeperId = store.findAgentByName(org.id, "sleeper").id;
  store.sendNotice({ orgId: org.id, fromAgentId: sender.id, to: "sleeper", body: "queued while busy" });
  // The agent keeps working: any MCP tool call records a tool.response event.
  store.recordToolSpend(org.id, sleeperId, "task_update", 1200);
  await graceElapsed();
  assert.equal(
    store.agentsNeedingNudge(org.id).length, 0,
    "tool call after the notice → its burst delivers via piggyback; never type into a busy prompt",
  );
});

test("v2: a tool call BEFORE the notice does not mask starvation — idle agent still gets woken", async () => {
  const { org, sender } = setup("nudge-v2-idle");
  const sleeperId = store.findAgentByName(org.id, "sleeper").id;
  // Old activity, then silence: the agent's turn ended before the notice arrived.
  store.recordToolSpend(org.id, sleeperId, "task_update", 900);
  await new Promise((r) => setTimeout(r, 50));
  store.sendNotice({ orgId: org.id, fromAgentId: sender.id, to: "sleeper", body: "wake up" });
  await graceElapsed();
  const candidates = store.agentsNeedingNudge(org.id);
  assert.equal(candidates.length, 1, "no call since the notice → starved → nudge");
  assert.equal(candidates[0].agent_name, "sleeper");
});

// ── v3: notice hygiene — broadcasts never wake, budgets stop the nagging ──

/** Backdate rows directly (second connection, WAL): tests must not wait wall-clock. */
async function rawDb() {
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(path.join(dir, "lanchu.db"));
}

test("v3: a broadcast never triggers a nudge and self-expires after the TTL", async () => {
  const { org, sender } = setup("nudge-v3-broadcast");
  const sleeperId = store.findAgentByName(org.id, "sleeper").id;
  store.sendNotice({ orgId: org.id, fromAgentId: sender.id, to: "*", body: "FYI: restarting soon" });
  await graceElapsed();

  // Informational fan-out is not a wake trigger — piggyback or expiry handles it.
  assert.equal(store.agentsNeedingNudge(org.id).length, 0, "broadcasts don't wake anyone");
  const sweep = runNudgeSweep({ alive: () => true, nudge: () => { throw new Error("must not type for a broadcast"); } });
  assert.deepEqual(sweep.nudged, []);

  // Past the TTL the broadcast expires: acked by the system, audited.
  const raw = await rawDb();
  const old = new Date(Date.now() - 31 * 60_000).toISOString();
  raw.prepare("UPDATE notice SET created_at = ? WHERE org_id = ? AND is_broadcast = 1").run(old, org.id);
  raw.close();
  const second = runNudgeSweep({ alive: () => true, nudge: () => true });
  assert.ok(second.expired_broadcasts >= 1, "stale broadcast expired");
  assert.equal(store.unackedNoticeCount(sleeperId), 0, "expiry acks the broadcast");
  assert.ok(
    store.listAuditEvents(org.id).some((e) => e.type === "notice.expired"),
    "expiry is on the record",
  );
});

test("v3: the nudge budget caps at 2 per undelivered set, then the agent shows unreachable — and self-clears when it acts", async () => {
  const { org, sender } = setup("nudge-v3-budget");
  const sleeperId = store.findAgentByName(org.id, "sleeper").id;
  store.sendNotice({ orgId: org.id, fromAgentId: sender.id, to: "sleeper", body: "wake" });
  const raw = await rawDb();
  // The set began 10 minutes ago; nudges are backdated past the cooldown so the
  // budget (not the cooldown) is what each next sweep decision exercises.
  raw.prepare("UPDATE notice SET created_at = ? WHERE to_agent_id = ?")
    .run(new Date(Date.now() - 10 * 60_000).toISOString(), sleeperId);

  const first = runNudgeSweep({ alive: () => true, nudge: () => true });
  assert.deepEqual(first.nudged, ["sleeper"], "nudge 1 of the budget");
  raw.prepare("UPDATE event SET created_at = ? WHERE type = 'agent.nudged' AND subject_id = ?")
    .run(new Date(Date.now() - 7 * 60_000).toISOString(), sleeperId);

  const second = runNudgeSweep({ alive: () => true, nudge: () => true });
  assert.deepEqual(second.nudged, ["sleeper"], "nudge 2 of the budget");
  raw.prepare("UPDATE event SET created_at = ? WHERE type = 'agent.nudged' AND subject_id = ? AND created_at > ?")
    .run(new Date(Date.now() - 6 * 60_000).toISOString(), sleeperId, new Date(Date.now() - 60_000).toISOString());
  raw.close();

  // Budget spent: the sweep goes silent and the panel takes over.
  const third = runNudgeSweep({ alive: () => true, nudge: () => { throw new Error("budget spent — must not type"); } });
  assert.deepEqual(third.nudged, [], "no third nudge, ever");
  assert.ok(store.unreachableAgents(org.id).has(sleeperId), "flagged unreachable");
  const card = store.boardSnapshot(org.id).agents.find((a) => a.id === sleeperId);
  assert.equal(card.unreachable, true, "panel card carries the flag");
  assert.ok(card.nudged_at, "nudged_at is wired into the board (was silently missing)");

  // The flag is derived state: the agent acting (any tool call) clears it.
  store.recordToolSpend(org.id, sleeperId, "message_list", 100);
  assert.equal(store.unreachableAgents(org.id).has(sleeperId), false, "self-clears once the agent acts");
});

test("v3: retiring an agent voids its pending notices — nothing is addressed to the dead", async () => {
  const { org, sender } = setup("nudge-v3-retire");
  const sleeperId = store.findAgentByName(org.id, "sleeper").id;
  store.sendNotice({ orgId: org.id, fromAgentId: sender.id, to: "sleeper", body: "you'll never read this" });
  await graceElapsed();
  assert.equal(store.agentsNeedingNudge(org.id).length, 1, "pending set exists pre-retirement");

  const res = store.retireAgent(sleeperId);
  assert.equal(res.retired, true);
  assert.equal(store.unackedNoticeCount(sleeperId), 0, "inbox voided");
  const ev = store.listAuditEvents(org.id).find((e) => e.type === "agent.retired");
  assert.equal(ev.data.voided_notices, 1, "voiding is audited");
  const sweep = runNudgeSweep({ alive: () => true, nudge: () => { throw new Error("must not type at the retired"); } });
  assert.deepEqual(sweep.nudged, [], "retired agents are never woken");
});

test("v2: a nudge is cancelled at the last second when delivery or a tool call races the sweep", async () => {
  const { org, sender } = setup("nudge-v2-race");
  const sleeperId = store.findAgentByName(org.id, "sleeper").id;
  store.sendNotice({ orgId: org.id, fromAgentId: sender.id, to: "sleeper", body: "raced" });
  await graceElapsed();
  assert.equal(store.agentsNeedingNudge(org.id).length, 1, "candidate selected");

  // Between the alive probe and typing, the agent wakes on its own and its
  // tool call delivers the notice — the sweep must cancel, not type.
  const res = runNudgeSweep({
    alive: () => {
      store.takeUndeliveredNotices(sleeperId); // piggyback delivery mid-sweep
      return true;
    },
    nudge: () => { throw new Error("must not type — delivery already happened"); },
  });
  assert.deepEqual(res.nudged, []);
  assert.equal(
    store.listAuditEvents(org.id).some((e) => e.type === "agent.nudged"), false,
    "a cancelled nudge is not audited, so the cooldown never blocks the next real one",
  );
});
