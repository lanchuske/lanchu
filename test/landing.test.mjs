import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-landing-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;
delete process.env.LANCHU_SDLC; // default mode: assist

const store = await import("../dist/core/store.js");

/** An org with a product definer, two builders, and a qa specialist. */
function setup(orgName) {
  const org = store.getOrCreateOrg(orgName);
  const project = store.getOrCreateProject(org.id, "core");
  const product = store.createAgent({
    orgId: org.id, roleId: store.getOrCreateRole(org.id, "product", { wildcard: true }).id, name: "product",
  });
  const alice = store.createAgent({
    orgId: org.id, roleId: store.getOrCreateRole(org.id, "generalist", { wildcard: true }).id, name: "alice",
  });
  const bob = store.createAgent({
    orgId: org.id, roleId: store.getOrCreateRole(org.id, "generalist", { wildcard: true }).id, name: "bob",
  });
  const qa = store.createAgent({
    orgId: org.id, roleId: store.getOrCreateRole(org.id, "qa", { wildcard: true }).id, name: "qa",
  });
  return { org, project, product, alice, bob, qa };
}

/** A task carried to open-PR state (in_progress + prUrl → review lane). */
function openPr(ctx, owner, title, prNumber) {
  const task = store.createTask({
    projectId: ctx.project.id, orgId: ctx.org.id, agentId: ctx.product.id,
    title, tags: ["server"], stage: "build",
  });
  store.claimTask({ agentId: owner.id, taskId: task.id });
  store.updateTaskStatus({
    agentId: owner.id, taskId: task.id, status: "in_progress",
    prUrl: `https://github.com/x/y/pull/${prNumber}`,
  });
  return store.getTask(task.id);
}

test("the queue orders open PRs by number and the owner hears their position on attach", () => {
  const ctx = setup("landing-order-org");
  const second = openPr(ctx, ctx.alice, "Later PR", 72);
  const first = openPr(ctx, ctx.bob, "Earlier PR", 71);

  const queue = store.landingQueue(ctx.project.id);
  assert.deepEqual(queue.map((s) => s.task_id), [first.id, second.id], "FIFO by PR number");
  assert.deepEqual(queue.map((s) => s.position), [1, 2]);
  assert.equal(queue[0].owner_name, "bob");

  // alice attached #72 when the queue was empty → she was head at the time.
  const aliceHeard = store.takeUndeliveredNotices(ctx.alice.id);
  assert.ok(aliceHeard.some((n) => /Landing queue: your PR #72 is at the HEAD/.test(n.body)));
  // bob attached #71 with #72 already queued → position by PR number is 1 (head).
  const bobHeard = store.takeUndeliveredNotices(ctx.bob.id);
  assert.ok(bobHeard.some((n) => /your PR #71 is at the HEAD/.test(n.body)));
});

test("a queued PR behind others is told its position and to hold", () => {
  const ctx = setup("landing-hold-org");
  openPr(ctx, ctx.alice, "Head PR", 80);
  store.takeUndeliveredNotices(ctx.alice.id); // drain
  openPr(ctx, ctx.bob, "Waiting PR", 81);

  const heard = store.takeUndeliveredNotices(ctx.bob.id);
  assert.ok(
    heard.some((n) => /position 2 \(1 ahead\)/.test(n.body) && /Hold your merge/.test(n.body)),
    "position + hold instruction delivered",
  );
});

test("the sweep detects a landed head, advances review → qa, and notices the new turn", () => {
  const ctx = setup("landing-sweep-org");
  const landed = openPr(ctx, ctx.alice, "About to land", 90);
  const nextUp = openPr(ctx, ctx.bob, "Next in line", 91);
  const later = openPr(ctx, ctx.alice, "Way later", 92);
  store.takeUndeliveredNotices(ctx.alice.id);
  store.takeUndeliveredNotices(ctx.bob.id);

  const subjects = ["feat(core): about to land (#90)", "chore: unrelated commit"];
  const { merged } = store.runLandingSweep({ logSubjects: () => subjects });
  assert.deepEqual(merged, [landed.id]);

  const done = store.getTask(landed.id);
  assert.equal(done.stage, "qa", "merge is the review-passed signal");

  const ev = store.listAuditEvents(ctx.org.id).find((e) => e.type === "pr.merged");
  assert.ok(ev, "merge audited");
  assert.equal(ev.subject_id, landed.id);
  assert.equal(ev.data.pr_number, 90);

  // bob (#91) is the new head: clear to land. alice (#92) is next-in-line.
  const bobHeard = store.takeUndeliveredNotices(ctx.bob.id);
  assert.ok(bobHeard.some((n) => /#91 is CLEAR TO LAND/.test(n.body) && n.ref === nextUp.id));
  const aliceHeard = store.takeUndeliveredNotices(ctx.alice.id);
  assert.ok(aliceHeard.some((n) => /you're next/.test(n.body) && n.ref === later.id));
});

test("no merge observed → the sweep stays silent (restart-safe)", () => {
  const ctx = setup("landing-quiet-org");
  openPr(ctx, ctx.alice, "Still open", 95);
  store.takeUndeliveredNotices(ctx.alice.id);

  const r1 = store.runLandingSweep({ logSubjects: () => ["chore: nothing relevant"] });
  const r2 = store.runLandingSweep({ logSubjects: () => ["chore: nothing relevant"] });
  assert.deepEqual([r1.merged.length, r2.merged.length], [0, 0]);
  assert.equal(store.takeUndeliveredNotices(ctx.alice.id).length, 0, "no repeat notices");
});

test("a merged PR whose task already sits in qa just leaves the queue", () => {
  const ctx = setup("landing-qa-org");
  const task = store.createTask({
    projectId: ctx.project.id, orgId: ctx.org.id, agentId: ctx.product.id,
    title: "Done and parked", tags: ["server"], stage: "build",
  });
  store.claimTask({ agentId: ctx.alice.id, taskId: task.id });
  // done + PR in one call → gated to the qa lane with the PR attached.
  store.updateTaskStatus({
    agentId: ctx.alice.id, taskId: task.id, status: "done",
    prUrl: "https://github.com/x/y/pull/96",
  });
  assert.equal(store.getTask(task.id).stage, "qa");
  assert.equal(store.landingQueue(ctx.project.id).length, 1, "qa-parked open PR is queued");

  const { merged } = store.runLandingSweep({ logSubjects: () => ["fix: parked (#96)"] });
  assert.deepEqual(merged, [task.id]);
  assert.equal(store.getTask(task.id).stage, "qa", "stage untouched — verification still owns the flip");
  assert.equal(store.landingQueue(ctx.project.id).length, 0, "left the queue");
});

test("the board snapshot carries the landing queue", () => {
  const ctx = setup("landing-board-org");
  openPr(ctx, ctx.alice, "On the board", 97);
  const snap = store.boardSnapshot(ctx.org.id);
  assert.equal(snap.landing.length, 1);
  assert.equal(snap.landing[0].pr_number, 97);
  assert.equal(snap.landing[0].position, 1);
});

// ── merge-while-QA gate (task-mrg7ejet22): advisory hold + audited bypass ──
// Evidence: PR #51 merged mid-verification; the FAIL landed on main and
// needed a follow-up PR instead of an amend on the open PR.

test("a head slot with QA in flight says HOLD (advisory), and the merge audits the bypass + tells QA", () => {
  const ctx = setup("landing-bypass-org");
  const task = store.createTask({
    projectId: ctx.project.id, orgId: ctx.org.id, agentId: ctx.product.id,
    title: "Racy feature", tags: ["server"], stage: "build",
  });
  store.claimTask({ agentId: ctx.alice.id, taskId: task.id });
  // done + PR → parked in qa with an open verification; the PR is unmerged.
  store.updateTaskStatus({
    agentId: ctx.alice.id, taskId: task.id, status: "done",
    prUrl: "https://github.com/x/y/pull/98",
  });
  const verification = store.openVerificationTaskFor(task.id);
  assert.ok(verification, "verification is in flight");

  // The queue exposes the pending verification, and the head notice says HOLD.
  const slot = store.landingQueue(ctx.project.id)[0];
  assert.equal(slot.qa_pending, verification.id);
  const heard = store.takeUndeliveredNotices(ctx.alice.id).filter((n) => /Landing queue/.test(n.body));
  assert.ok(heard.length >= 1);
  assert.match(heard[heard.length - 1].body, /HOLD — QA verification/);
  assert.match(heard[heard.length - 1].body, /audited as a QA bypass/, "advisory, never a hard block");

  // Landing anyway: the pr.merged event carries the bypass, QA gets a heads-up.
  const { merged } = store.runLandingSweep({ logSubjects: () => ["feat: racy (#98)"] });
  assert.deepEqual(merged, [task.id]);
  const ev = store.listAuditEvents(ctx.org.id).find((e) => e.type === "pr.merged" && e.subject_id === task.id);
  assert.equal(ev.data.qa_bypass, true);
  assert.equal(ev.data.verification_task_id, verification.id);
  const qaHeard = store.takeUndeliveredNotices(ctx.qa.id);
  assert.ok(qaHeard.some((n) => /merged while .* was in flight — verify against merged main/.test(n.body)));
});

test("a clean head (no verification in flight) still reads CLEAR TO LAND and merges without bypass data", () => {
  const ctx = setup("landing-clean-org");
  openPr(ctx, ctx.alice, "Clean feature", 99);
  const slot = store.landingQueue(ctx.project.id)[0];
  assert.equal(slot.qa_pending, null);
  const heard = store.takeUndeliveredNotices(ctx.alice.id).filter((n) => /Landing queue/.test(n.body));
  assert.match(heard[heard.length - 1].body, /at the HEAD — clear to land once green/);

  store.runLandingSweep({ logSubjects: () => ["feat: clean (#99)"] });
  const ev = store.listAuditEvents(ctx.org.id).find((e) => e.type === "pr.merged" && e.subject_id !== null);
  assert.equal(ev.data.qa_bypass, undefined, "no bypass noise on clean merges");
});
