import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-reconcile-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;
delete process.env.LANCHU_SDLC; // default mode: assist

const store = await import("../dist/core/store.js");
const { openDb } = await import("../dist/db/db.js");

/** An org with a product definer, a builder, and a qa specialist. */
function setup(orgName) {
  const org = store.getOrCreateOrg(orgName);
  const project = store.getOrCreateProject(org.id, "core");
  const product = store.createAgent({
    orgId: org.id, roleId: store.getOrCreateRole(org.id, "product", { wildcard: true }).id, name: "product",
  });
  const builder = store.createAgent({
    orgId: org.id, roleId: store.getOrCreateRole(org.id, "generalist", { wildcard: true }).id, name: "builder",
  });
  const qa = store.createAgent({
    orgId: org.id, roleId: store.getOrCreateRole(org.id, "qa", { wildcard: true }).id, name: "qa",
  });
  return { org, project, product, builder, qa };
}

/** A builder task carried to done-with-PR (parked in qa awaiting verification). */
function shipTask(ctx, title, prNumber) {
  const task = store.createTask({
    projectId: ctx.project.id, orgId: ctx.org.id, agentId: ctx.product.id,
    title, tags: ["server"], stage: "build",
  });
  store.claimTask({ agentId: ctx.builder.id, taskId: task.id });
  store.updateTaskStatus({
    agentId: ctx.builder.id, taskId: task.id, status: "done",
    prUrl: `https://github.com/x/y/pull/${prNumber}`,
  });
  return store.getTask(task.id);
}

test("a done batch verification flips every original its title covers (ranges + task ids)", () => {
  const ctx = setup("batch-flip-org");
  const a = shipTask(ctx, "Widget A", 10); // covered via range
  const b = shipTask(ctx, "Widget B", 11); // covered via range
  const c = shipTask(ctx, "Widget C", 12); // NOT covered
  const d = shipTask(ctx, "Widget D", 99); // covered via explicit task id
  assert.equal(a.stage, "qa");

  const batch = store.createTask({
    projectId: ctx.project.id, orgId: ctx.org.id, agentId: ctx.qa.id,
    title: `QA batch: verify PRs #10-#11 and ${d.id} against acceptance criteria`, tags: [], stage: "qa",
  });
  store.claimTask({ agentId: ctx.qa.id, taskId: batch.id });
  store.updateTaskStatus({ agentId: ctx.qa.id, taskId: batch.id, status: "done", note: "all pass" });

  for (const t of [a, b, d]) {
    const done = store.getTask(t.id);
    assert.equal(done.status, "done", `${t.title} flipped`);
    assert.equal(done.stage, "done", `${t.title} lane closed`);
    assert.equal(store.openVerificationTaskFor(t.id), null, `${t.title}'s per-task child superseded`);
  }
  assert.equal(store.getTask(c.id).stage, "qa", "uncovered original untouched");
  assert.ok(store.openVerificationTaskFor(c.id), "its verification child stays open");

  // The batch itself bypassed the gate: done/done, no verification-of-the-verifier.
  const doneBatch = store.getTask(batch.id);
  assert.equal(doneBatch.status, "done");
  assert.equal(doneBatch.stage, "done");
  assert.equal(store.openVerificationTaskFor(batch.id), null);

  // The builder hears each flip.
  const heard = store.takeUndeliveredNotices(ctx.builder.id);
  assert.equal(heard.filter((n) => /passed QA verification/.test(n.body)).length, 3);
});

test("refs named in a FAIL sentence of the note stay unverified", () => {
  const ctx = setup("batch-partial-org");
  const good = shipTask(ctx, "Solid feature", 20);
  const bad = shipTask(ctx, "Shaky feature", 21);

  const batch = store.createTask({
    projectId: ctx.project.id, orgId: ctx.org.id, agentId: ctx.qa.id,
    title: "QA batch: verify PRs #20-#21", tags: [], stage: "qa",
  });
  store.claimTask({ agentId: ctx.qa.id, taskId: batch.id });
  store.updateTaskStatus({
    agentId: ctx.qa.id, taskId: batch.id, status: "done",
    note: "1/2 PASS. PARTIAL FAIL: #21 crashes on empty input. Evidence in the QA doc.",
  });

  assert.equal(store.getTask(good.id).stage, "done", "#20 flipped");
  assert.equal(store.getTask(bad.id).stage, "qa", "#21 stays awaiting verification");
});

test("a note that STARTS with FAIL flips nothing", () => {
  const ctx = setup("batch-fail-org");
  const t = shipTask(ctx, "Some feature", 30);

  const batch = store.createTask({
    projectId: ctx.project.id, orgId: ctx.org.id, agentId: ctx.qa.id,
    title: "QA batch: verify PRs #30", tags: [], stage: "qa",
  });
  store.claimTask({ agentId: ctx.qa.id, taskId: batch.id });
  store.updateTaskStatus({
    agentId: ctx.qa.id, taskId: batch.id, status: "done", note: "FAIL: environment broken, nothing verified",
  });

  assert.equal(store.getTask(t.id).stage, "qa", "original untouched");
});

test("reconcile: verified done/review rows land in done, unverified ones in qa with a verification task", () => {
  const ctx = setup("reconcile-org");
  const verified = shipTask(ctx, "Verified long ago", 40);
  const orphan = shipTask(ctx, "Never verified", 41);

  // A done batch that covers #40 only (completed BEFORE the flip existed —
  // manufacture that history: batch done, original stranded in review).
  const batch = store.createTask({
    projectId: ctx.project.id, orgId: ctx.org.id, agentId: ctx.qa.id,
    title: "QA batch: verify PRs #40", tags: [], stage: "qa",
  });
  const raw = openDb();
  raw.prepare("UPDATE task SET status = 'done', stage = 'done' WHERE id = ?").run(batch.id);
  // Remove the gate's children and strand the originals so the rows look
  // exactly like pre-batch-flip history: status=done, stage=review, no child.
  raw.prepare("DELETE FROM task WHERE parent_task_id IN (?, ?)").run(verified.id, orphan.id);
  const strand = raw.prepare("UPDATE task SET status = 'done', stage = 'review' WHERE id = ?");
  strand.run(verified.id);
  strand.run(orphan.id);

  const { toDone, toQa } = store.reconcileSdlcStages();
  assert.deepEqual(toDone, [verified.id]);
  assert.deepEqual(toQa, [orphan.id]);

  const v = store.getTask(verified.id);
  assert.equal(v.stage, "done");
  assert.equal(v.status, "done");

  const o = store.getTask(orphan.id);
  assert.equal(o.stage, "qa");
  assert.equal(o.status, "done", "status untouched — only the lane heals");
  assert.ok(store.openVerificationTaskFor(orphan.id), "verification task minted for the orphan");

  const events = store.listAuditEvents(ctx.org.id).filter((e) => e.type === "task.stage_reconciled");
  assert.equal(events.length, 2);
  const byId = Object.fromEntries(events.map((e) => [e.subject_id, e.data]));
  assert.equal(byId[verified.id].to_stage, "done");
  assert.equal(byId[verified.id].via, batch.id);
  assert.equal(byId[orphan.id].to_stage, "qa");
  assert.match(byId[orphan.id].reason, /without verification/);

  // Idempotent: a second pass finds nothing.
  const again = store.reconcileSdlcStages();
  assert.deepEqual([again.toDone.length, again.toQa.length], [0, 0]);
});

test("reconcile honors FAIL exclusions recorded in the batch's completion note", () => {
  const ctx = setup("reconcile-fail-org");
  const failed = shipTask(ctx, "Failed in batch", 50);

  const batch = store.createTask({
    projectId: ctx.project.id, orgId: ctx.org.id, agentId: ctx.qa.id,
    title: "QA batch: verify PRs #50", tags: [], stage: "qa",
  });
  store.claimTask({ agentId: ctx.qa.id, taskId: batch.id });
  // Completing with a FAIL sentence naming #50 — the live flip already skips it…
  store.updateTaskStatus({
    agentId: ctx.qa.id, taskId: batch.id, status: "done", note: "0/1 PASS, FAIL: #50 broken.",
  });
  assert.equal(store.getTask(failed.id).stage, "qa");

  // …and if that row had been stranded in review, reconcile must not flip it either.
  const raw = openDb();
  raw.prepare("DELETE FROM task WHERE parent_task_id = ?").run(failed.id);
  raw.prepare("UPDATE task SET status = 'done', stage = 'review' WHERE id = ?").run(failed.id);
  const { toDone, toQa } = store.reconcileSdlcStages();
  assert.deepEqual(toDone, []);
  assert.deepEqual(toQa, [failed.id]);
  assert.equal(store.getTask(failed.id).stage, "qa");
});
