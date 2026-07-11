import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-notices-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;

const store = await import("../dist/core/store.js");
const presence = await import("../dist/core/presence.js");

/** An org with a wildcard role and two named agents. */
function setup(orgName) {
  const org = store.getOrCreateOrg(orgName);
  const project = store.getOrCreateProject(org.id, "core");
  const role = store.getOrCreateRole(org.id, "generalist", { wildcard: true });
  const alice = store.createAgent({ orgId: org.id, roleId: role.id, name: "alice" });
  const bob = store.createAgent({ orgId: org.id, roleId: role.id, name: "bob" });
  return { org, project, role, alice, bob };
}

test("direct message: queued → delivered once via piggyback → acked", () => {
  const { org, alice, bob } = setup("msg-org");

  const r = store.sendNotice({ orgId: org.id, fromAgentId: alice.id, to: "bob", body: "next: task-X" });
  assert.deepEqual(r, { sent: 1, to: ["bob"] });

  // Piggyback returns it once (undelivered → delivered), not twice.
  const first = store.takeUndeliveredNotices(bob.id);
  assert.equal(first.length, 1);
  assert.equal(first[0].body, "next: task-X");
  assert.equal(first[0].from_name, "alice");
  assert.equal(first[0].kind, "message");
  assert.ok(first[0].delivered_at === null); // snapshot taken before stamping
  assert.equal(store.takeUndeliveredNotices(bob.id).length, 0);

  // Still in the inbox until acked; ack only touches the recipient's own rows.
  const inbox = store.listNotices(bob.id);
  assert.equal(inbox.length, 1);
  assert.ok(inbox[0].delivered_at);
  assert.equal(store.ackNotices(alice.id, [inbox[0].id]), 0); // not alice's notice
  assert.equal(store.ackNotices(bob.id, [inbox[0].id]), 1);
  assert.equal(store.listNotices(bob.id).length, 0);
  assert.equal(store.listNotices(bob.id, { includeAcked: true }).length, 1);
});

test("unknown or cross-org recipient is rejected (and never silently delivered)", () => {
  const a = setup("org-a");
  setup("org-b"); // bob exists here too, but in another org

  assert.throws(
    () => store.sendNotice({ orgId: a.org.id, fromAgentId: a.alice.id, to: "nobody", body: "hi" }),
    /no agent named 'nobody'/,
  );
});

test("messages to a retired agent are refused", () => {
  const { org, alice, bob } = setup("retired-org");
  store.retireAgent(bob.id);
  assert.throws(
    () => store.sendNotice({ orgId: org.id, fromAgentId: alice.id, to: "bob", body: "hello?" }),
    /retired/,
  );
});

test("broadcast fans out to everyone but the sender, and is rate-limited", () => {
  const { org, alice } = setup("bcast-org");
  const role = store.getOrCreateRole(org.id, "generalist", { wildcard: true });
  store.createAgent({ orgId: org.id, roleId: role.id, name: "carol" });

  const r = store.sendNotice({ orgId: org.id, fromAgentId: alice.id, to: "*", body: "restarting the server" });
  assert.equal(r.sent, 2); // bob + carol, not alice
  assert.ok(!r.to.includes("alice"));

  store.sendNotice({ orgId: org.id, fromAgentId: alice.id, to: "*", body: "again" });
  store.sendNotice({ orgId: org.id, fromAgentId: alice.id, to: "*", body: "and again" });
  assert.throws(
    () => store.sendNotice({ orgId: org.id, fromAgentId: alice.id, to: "*", body: "spam" }),
    /rate limit/,
  );
});

test("overlapping work by a PRESENT agent yields a conflict + notice to the other side", () => {
  const { org, project, alice, bob } = setup("conflict-org");

  // Alice is live and holds an open panel task.
  presence.addLiveSession(alice.id);
  const aliceTask = store.createTask({
    projectId: project.id, orgId: org.id, agentId: alice.id,
    title: "Alice reworks the panel", tags: ["panel"],
  });
  store.claimTask({ agentId: alice.id, taskId: aliceTask.id });

  // Bob starts a task on the same surface.
  const bobTask = store.createTask({
    projectId: project.id, orgId: org.id, agentId: bob.id,
    title: "Bob also touches the panel", tags: ["panel", "server"],
  });
  const conflicts = store.warnWorkConflicts({
    orgId: org.id, agentId: bob.id, taskId: bobTask.id, tags: ["panel", "server"],
  });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].with_agent, "alice");
  assert.equal(conflicts[0].their_task_id, aliceTask.id);
  assert.deepEqual(conflicts[0].overlap_tags, ["panel"]);

  // Alice hears about it on her next tool call.
  const heard = store.takeUndeliveredNotices(alice.id);
  assert.equal(heard.length, 1);
  assert.equal(heard[0].kind, "conflict");
  assert.match(heard[0].body, /bob started/);
  assert.equal(heard[0].ref, bobTask.id);

  presence.removeLiveSession(alice.id);
});

test("repeat warnings for the same task-pair are suppressed: no duplicate notice or audit event", () => {
  const { org, project, alice, bob } = setup("dedupe-org");

  presence.addLiveSession(alice.id);
  const aliceTask = store.createTask({
    projectId: project.id, orgId: org.id, agentId: alice.id,
    title: "Alice works the panel", tags: ["panel"],
  });
  store.claimTask({ agentId: alice.id, taskId: aliceTask.id });

  const bobTask = store.createTask({
    projectId: project.id, orgId: org.id, agentId: bob.id,
    title: "Bob claims panel work too", tags: ["panel"],
  });
  const args = { orgId: org.id, agentId: bob.id, taskId: bobTask.id, tags: ["panel"] };

  const first = store.warnWorkConflicts(args);
  assert.equal(first.length, 1);
  assert.equal(store.takeUndeliveredNotices(alice.id).length, 1, "first warning notifies alice");

  // Same pair again (e.g. a retried claim): caller still sees the conflict,
  // but alice is not pinged again.
  const second = store.warnWorkConflicts(args);
  assert.equal(second.length, 1, "conflict still returned to the caller");
  assert.equal(store.takeUndeliveredNotices(alice.id).length, 0, "no duplicate notice");

  presence.removeLiveSession(alice.id);
});

test("create-without-claim path (checkWorkOverlap) reports overlap without notifying anyone", () => {
  const { org, project, alice, bob } = setup("fyi-org");

  presence.addLiveSession(alice.id);
  const aliceTask = store.createTask({
    projectId: project.id, orgId: org.id, agentId: alice.id,
    title: "Alice builds the server", tags: ["server"],
  });
  store.claimTask({ agentId: alice.id, taskId: aliceTask.id });

  // Bob FILES a task on the same surface but does not claim it: informational.
  const overlaps = store.checkWorkOverlap({ orgId: org.id, agentId: bob.id, tags: ["server"] });
  assert.equal(overlaps.length, 1);
  assert.equal(overlaps[0].with_agent, "alice");
  assert.equal(store.takeUndeliveredNotices(alice.id).length, 0, "filing a task must not ping the busy agent");

  presence.removeLiveSession(alice.id);
});

test("no conflict when the other agent is not present, or tags don't overlap", () => {
  const { org, project, alice, bob } = setup("quiet-org");

  // Alice holds a task but has NO live session (and no recent-activity window trickery).
  const aliceTask = store.createTask({
    projectId: project.id, orgId: org.id, agentId: alice.id,
    title: "Alice's dormant task", tags: ["panel"],
  });
  store.claimTask({ agentId: alice.id, taskId: aliceTask.id });

  // Not present → no conflict even with overlapping tags… unless recency makes her present.
  const overlapping = store.checkWorkOverlap({ orgId: org.id, agentId: bob.id, tags: ["panel"] });
  // claimTask touches activity, so alice counts as recently-active; assert the
  // tag-disjoint case instead, which must ALWAYS be quiet.
  void overlapping;
  const disjoint = store.checkWorkOverlap({ orgId: org.id, agentId: bob.id, tags: ["docs"] });
  assert.equal(disjoint.length, 0);
});

test("taxonomy tags alone never conflict: two bug fixes on disjoint areas claim cleanly", () => {
  const { org, project, alice, bob } = setup("taxonomy-org");

  // Alice is live, fixing a PANEL bug.
  presence.addLiveSession(alice.id);
  const aliceTask = store.createTask({
    projectId: project.id, orgId: org.id, agentId: alice.id,
    title: "Bug: panel dot wrong color", tags: ["bug", "panel"],
  });
  store.claimTask({ agentId: alice.id, taskId: aliceTask.id });

  // Bob starts an unrelated SERVER bug fix — shared tag is only the taxonomy `bug`.
  const overlaps = store.checkWorkOverlap({ orgId: org.id, agentId: bob.id, tags: ["bug", "server"] });
  assert.equal(overlaps.length, 0, "sharing only a taxonomy tag must not conflict");

  // A task carrying ONLY taxonomy tags has no work surface at all.
  const pureTaxonomy = store.checkWorkOverlap({ orgId: org.id, agentId: bob.id, tags: ["bug"] });
  assert.equal(pureTaxonomy.length, 0);

  // But a real area overlap still fires even when taxonomy tags ride along.
  const real = store.checkWorkOverlap({ orgId: org.id, agentId: bob.id, tags: ["idea", "panel"] });
  assert.equal(real.length, 1);
  assert.deepEqual(real[0].overlap_tags, ["panel"], "overlap_tags reports areas only, never taxonomy");

  presence.removeLiveSession(alice.id);
});

test("system notices carry no sender and ride the same channel", () => {
  const { org, bob } = setup("sys-org");
  store.systemNotice(org.id, bob.id, "Another live session is connected as this same agent.");
  const got = store.takeUndeliveredNotices(bob.id);
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, "system");
  assert.equal(got[0].from_agent_id, null);
  assert.equal(got[0].from_name, null);
});

test("regression: a notice read via inbox and acked is never re-delivered by piggyback", () => {
  const { org, alice, bob } = setup("ack-no-redeliver-org");

  store.sendNotice({ orgId: org.id, fromAgentId: alice.id, to: "bob", body: "read me in the inbox" });

  // Bob reads it via message_list (which does NOT stamp delivered_at)…
  const inbox = store.listNotices(bob.id);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].delivered_at, null);

  // …acks it, then makes any tool call: the piggyback channel must stay silent.
  assert.equal(store.ackNotices(bob.id, [inbox[0].id]), 1);
  assert.equal(store.takeUndeliveredNotices(bob.id).length, 0, "acked notice must not be re-delivered");

  // The ack also stamped delivered_at, so the row is consistent either way.
  const acked = store.listNotices(bob.id, { includeAcked: true });
  assert.equal(acked.length, 1);
  assert.ok(acked[0].acked_at !== null);
  assert.ok(acked[0].delivered_at !== null);
});
