import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-sdlc-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;
delete process.env.LANCHU_SDLC; // default mode: assist

const store = await import("../dist/core/store.js");

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
  const task = store.createTask({
    projectId: project.id, orgId: org.id, agentId: product.id,
    title: "Build the widget", tags: ["server"], stage: "build",
  });
  store.claimTask({ agentId: builder.id, taskId: task.id });
  return { org, project, product, builder, qa, task };
}

test("attaching a PR moves the task to review and notices the reviewer (product)", () => {
  const { org, product, builder, task } = setup("sdlc-review-org");

  store.updateTaskStatus({
    agentId: builder.id, taskId: task.id, status: "in_progress", prUrl: "https://github.com/x/y/pull/1",
  });
  assert.equal(store.getTask(task.id).stage, "review");

  const heard = store.takeUndeliveredNotices(product.id);
  assert.equal(heard.length, 1);
  assert.match(heard[0].body, /moved to review/);
  assert.equal(heard[0].ref, task.id);

  const ev = store.listAuditEvents(org.id).find((e) => e.type === "task.stage_changed");
  assert.ok(ev, "forward move audited");
  assert.deepEqual([ev.data.from_stage, ev.data.to_stage], ["build", "review"]);
});

test("assist: done on unverified work records done, parks it in qa, and spins up the verification task", () => {
  const { org, builder, qa, task } = setup("sdlc-gate-org");

  const updated = store.updateTaskStatus({ agentId: builder.id, taskId: task.id, status: "done" });
  assert.equal(updated.status, "done", "assist never blocks the agent's status");
  assert.equal(updated.stage, "qa", "but the lane says verification pending");

  const verification = store.openVerificationTaskFor(task.id);
  assert.ok(verification, "verification task auto-created");
  assert.equal(verification.parent_task_id, task.id);
  assert.match(verification.title, /^QA: verify/);
  assert.deepEqual(verification.tags, [], "untagged — claimable by the qa role");

  const heard = store.takeUndeliveredNotices(qa.id);
  assert.equal(heard.length, 1);
  assert.match(heard[0].body, /Verification ready/);

  // Saying done again doesn't mint a second verification task.
  store.updateTaskStatus({ agentId: builder.id, taskId: task.id, status: "done" });
  const children = store.listTasks(task.project_id).filter((t) => t.parent_task_id === task.id);
  assert.equal(children.length, 1);
});

test("verification pass flips the original to done; the builder hears about it", () => {
  const { builder, qa, task } = setup("sdlc-pass-org");

  store.updateTaskStatus({ agentId: builder.id, taskId: task.id, status: "done" });
  const verification = store.openVerificationTaskFor(task.id);
  store.claimTask({ agentId: qa.id, taskId: verification.id });
  store.updateTaskStatus({ agentId: qa.id, taskId: verification.id, status: "done", note: "pass — all criteria hold" });

  const done = store.getTask(task.id);
  assert.equal(done.status, "done");
  assert.equal(done.stage, "rc"); // QA pass parks it in Release Candidate

  const heard = store.takeUndeliveredNotices(builder.id);
  assert.ok(heard.some((n) => /passed QA verification/.test(n.body)));
});

test("verification FAIL bounces the original back to build, to its builder, audited with a counter", () => {
  const { org, builder, qa, task } = setup("sdlc-fail-org");

  store.updateTaskStatus({ agentId: builder.id, taskId: task.id, status: "done" });
  const verification = store.openVerificationTaskFor(task.id);
  store.claimTask({ agentId: qa.id, taskId: verification.id });
  store.updateTaskStatus({
    agentId: qa.id, taskId: verification.id, status: "done", note: "FAIL: the widget crashes on empty input",
  });

  const bounced = store.getTask(task.id);
  assert.equal(bounced.stage, "build");
  assert.equal(bounced.status, "claimed", "handed back, not pooled");
  assert.equal(bounced.owner_agent_id, builder.id, "back with the original builder");
  assert.equal(bounced.done_at, null, "no longer done");
  assert.equal(bounced.bounce_count, 1);
  assert.match(bounced.last_bounce.reason, /crashes on empty input/);

  const heard = store.takeUndeliveredNotices(builder.id);
  assert.ok(heard.some((n) => /bounced qa → build/.test(n.body)));

  const ev = store.listAuditEvents(org.id).find((e) => e.type === "task.bounced");
  assert.ok(ev, "bounce audited");
  assert.equal(ev.data.to, builder.id, "graph edge target = receiving agent");
  assert.deepEqual([ev.data.from_stage, ev.data.to_stage], ["qa", "build"]);

  // The builder fixes it and dones again → a FRESH verification round.
  store.updateTaskStatus({ agentId: builder.id, taskId: task.id, status: "done" });
  const second = store.openVerificationTaskFor(task.id);
  assert.ok(second && second.id !== verification.id, "new verification task for the retry");
});

test("strict: done is held at in_progress until verification passes", () => {
  process.env.LANCHU_SDLC = "strict";
  try {
    const { builder, qa, task } = setup("sdlc-strict-org");

    const held = store.updateTaskStatus({ agentId: builder.id, taskId: task.id, status: "done" });
    assert.equal(held.status, "in_progress", "strict holds the done");
    assert.equal(held.stage, "qa");
    assert.equal(held.done_at, null);

    const verification = store.openVerificationTaskFor(task.id);
    assert.ok(verification);

    // Only the qa role resolves it in strict mode (the org has one).
    store.claimTask({ agentId: builder.id, taskId: verification.id });
    store.updateTaskStatus({ agentId: builder.id, taskId: verification.id, status: "done", note: "pass" });
    assert.notEqual(store.getTask(task.id).status, "done", "builder can't self-verify in strict");

    // QA re-runs the verification round and passes it.
    store.updateTaskStatus({ agentId: builder.id, taskId: task.id, status: "done" });
    const second = store.openVerificationTaskFor(task.id);
    store.claimTask({ agentId: qa.id, taskId: second.id });
    store.updateTaskStatus({ agentId: qa.id, taskId: second.id, status: "done", note: "pass" });
    assert.equal(store.getTask(task.id).status, "done");
    assert.equal(store.getTask(task.id).stage, "rc");
  } finally {
    delete process.env.LANCHU_SDLC;
  }
});

test("off: no gate, no verification tasks — done is done", () => {
  process.env.LANCHU_SDLC = "off";
  try {
    const { builder, task } = setup("sdlc-off-org");
    const done = store.updateTaskStatus({ agentId: builder.id, taskId: task.id, status: "done" });
    assert.equal(done.status, "done");
    assert.equal(done.stage, "done");
    assert.equal(store.openVerificationTaskFor(task.id), null);
  } finally {
    delete process.env.LANCHU_SDLC;
  }
});

// ── verification router eligibility (task-mrgplp6v10) ──
// Real verifications were routed to a PARKED disposable probe, where they sat
// undelivered until the wake-v5 drill happened to refire it.

test("verification notices skip parked and probe qa agents — the active gate gets the work", () => {
  const org = store.getOrCreateOrg("router-elig-org");
  const project = store.getOrCreateProject(org.id, "core");
  const qaRole = store.getOrCreateRole(org.id, "qa", { wildcard: true });
  const genRole = store.getOrCreateRole(org.id, "generalist", { wildcard: true });
  const builder = store.createAgent({ orgId: org.id, roleId: genRole.id, name: "builder" });
  const gate = store.createAgent({ orgId: org.id, roleId: qaRole.id, name: "qa-gate-active" });
  const probe = store.createAgent({ orgId: org.id, roleId: qaRole.id, name: "probe-park-drill", objective: "disposable drill fixture — never claim tasks" });
  store.setAgentClaudeSession(probe.id, "sid-probe");
  store.parkAgent(probe.id, "exit");

  // A done under the gate mints the verification and routes the qa notice.
  const task = store.createTask({ projectId: project.id, orgId: org.id, agentId: builder.id, title: "feature", tags: ["server"], stage: "build" });
  store.claimTask({ agentId: builder.id, taskId: task.id });
  store.updateTaskStatus({ agentId: builder.id, taskId: task.id, status: "done", prUrl: "https://github.com/x/y/pull/200" });

  const gateHeard = store.takeUndeliveredNotices(gate.id);
  assert.ok(gateHeard.some((n) => /Verification ready/.test(n.body)), "the active gate is noticed");
  assert.equal(store.takeUndeliveredNotices(probe.id).filter((n) => /Verification ready/.test(n.body)).length, 0, "the parked probe hears nothing");
});

test("with only a parked probe in qa, the notice falls back to product — never a dead fixture", () => {
  const org = store.getOrCreateOrg("router-fallback-org");
  const project = store.getOrCreateProject(org.id, "core");
  const qaRole = store.getOrCreateRole(org.id, "qa", { wildcard: true });
  const prodRole = store.getOrCreateRole(org.id, "product", { wildcard: true });
  const genRole = store.getOrCreateRole(org.id, "generalist", { wildcard: true });
  const builder = store.createAgent({ orgId: org.id, roleId: genRole.id, name: "builder" });
  const pm = store.createAgent({ orgId: org.id, roleId: prodRole.id, name: "pm" });
  const probe = store.createAgent({ orgId: org.id, roleId: qaRole.id, name: "probe-only", objective: "probe fixture" });
  store.setAgentClaudeSession(probe.id, "sid-probe2");
  store.parkAgent(probe.id, "exit");

  const task = store.createTask({ projectId: project.id, orgId: org.id, agentId: builder.id, title: "feature 2", tags: ["server"], stage: "build" });
  store.claimTask({ agentId: builder.id, taskId: task.id });
  store.updateTaskStatus({ agentId: builder.id, taskId: task.id, status: "done" });

  assert.ok(store.takeUndeliveredNotices(pm.id).some((n) => /Verification ready/.test(n.body)), "product catches the fallback");
  assert.equal(store.takeUndeliveredNotices(probe.id).filter((n) => /Verification ready/.test(n.body)).length, 0, "the probe stays silent");
});
