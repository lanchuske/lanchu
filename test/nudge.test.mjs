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
