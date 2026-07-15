import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-test-contract-integrate-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;
delete process.env.LANCHU_SDLC; // default mode: assist

const store = await import("../dist/core/store.js");
const { ScopeError } = await import("../dist/core/types.js");

function setup(orgName) {
  const org = store.getOrCreateOrg(orgName);
  const project = store.getOrCreateProject(org.id, "web");
  const role = store.getOrCreateRole(org.id, "generalist", { wildcard: true });
  const owner = store.createAgent({ orgId: org.id, roleId: role.id, objective: "own the project" });
  const contributor = store.createAgent({ orgId: org.id, roleId: role.id, objective: "contribute" });
  return { org, project, role, owner, contributor };
}

/** A contract task verified through to stage 'rc', ready to integrate. */
function verifiedContractTask({ org, project, owner, contributor }) {
  const task = store.createTask({
    projectId: project.id, orgId: org.id, agentId: owner.id, title: "implement isValidEmail", tags: [],
    kind: "contract", contractSpec: "spec",
  });
  store.claimTask({ agentId: contributor.id, taskId: task.id });
  store.submitContractDeliverable({ taskId: task.id, agentId: contributor.id, content: "the fix" });
  const verification = store.openVerificationTaskFor(task.id);
  store.updateTaskStatus({ agentId: owner.id, taskId: verification.id, status: "done" });
  return store.getTask(task.id);
}

// Network mode Piece 5 Task 4 (task-mrk1r2yy45): a non-owner attempting to
// mark a contract task 'integrated' is rejected and audited; only the
// project's declared owner, and only after QA-pass (stage 'rc'), may do it.

test("the declared owner can integrate a verified contract task", () => {
  const ctx = setup("integrate-org-1");
  store.setProjectOwner(ctx.project.id, ctx.owner.id);
  const task = verifiedContractTask(ctx);
  assert.equal(task.stage, "rc");

  const integrated = store.integrateContractTask({ taskId: task.id, agentId: ctx.owner.id });
  assert.equal(integrated.stage, "integrated");
});

test("the contributor who did the work cannot integrate their own task — only the owner", () => {
  const ctx = setup("integrate-org-2");
  store.setProjectOwner(ctx.project.id, ctx.owner.id);
  const task = verifiedContractTask(ctx);

  assert.throws(
    () => store.integrateContractTask({ taskId: task.id, agentId: ctx.contributor.id }),
    (err) => err instanceof ScopeError,
  );
  assert.equal(store.getTask(task.id).stage, "rc"); // unchanged

  const violation = store
    .listAuditEvents(ctx.org.id)
    .find((e) => e.type === "scope.violation" && e.data?.action === "integrate");
  assert.ok(violation, "the rejected attempt is audited");
  assert.equal(violation.outcome, "rejected");
});

test("an unverified contract task (not yet at stage 'rc') cannot be integrated", () => {
  const ctx = setup("integrate-org-3");
  store.setProjectOwner(ctx.project.id, ctx.owner.id);
  const task = store.createTask({
    projectId: ctx.project.id, orgId: ctx.org.id, agentId: ctx.owner.id, title: "not verified yet", tags: [],
    kind: "contract", contractSpec: "spec",
  });
  store.claimTask({ agentId: ctx.contributor.id, taskId: task.id });
  // Claimed, but never submitted/verified — still at stage 'build' or null.

  assert.throws(
    () => store.integrateContractTask({ taskId: task.id, agentId: ctx.owner.id }),
    (err) => err instanceof ScopeError,
  );
});

test("an internal (non-contract) task cannot be integrated — the concept doesn't apply", () => {
  const ctx = setup("integrate-org-4");
  store.setProjectOwner(ctx.project.id, ctx.owner.id);
  const task = store.createTask({
    projectId: ctx.project.id, orgId: ctx.org.id, agentId: ctx.owner.id, title: "ordinary work", tags: [],
  });

  assert.throws(
    () => store.integrateContractTask({ taskId: task.id, agentId: ctx.owner.id }),
    (err) => err instanceof ScopeError,
  );
});

test("fail-closed: with no declared project owner, nobody can integrate — not even the task's creator", () => {
  const ctx = setup("integrate-org-5");
  // No setProjectOwner call.
  const task = verifiedContractTask(ctx);

  assert.throws(
    () => store.integrateContractTask({ taskId: task.id, agentId: ctx.owner.id }),
    (err) => err instanceof ScopeError,
  );
});

test("full lifecycle: claim → submit → verify → integrate", () => {
  const ctx = setup("integrate-org-6");
  store.setProjectOwner(ctx.project.id, ctx.owner.id);

  const task = store.createTask({
    projectId: ctx.project.id, orgId: ctx.org.id, agentId: ctx.owner.id, title: "implement add(a, b)", tags: [],
    kind: "contract", contractSpec: "`add(a, b)` returns a + b.",
  });
  assert.equal(task.stage, null);

  store.claimTask({ agentId: ctx.contributor.id, taskId: task.id });
  const submitted = store.submitContractDeliverable({
    taskId: task.id, agentId: ctx.contributor.id, content: "export const add = (a, b) => a + b;",
  });
  assert.equal(submitted.stage, "qa");

  const verification = store.openVerificationTaskFor(task.id);
  const verified = store.updateTaskStatus({ agentId: ctx.owner.id, taskId: verification.id, status: "done" });
  assert.equal(verified.status, "done"); // the verification task itself

  const original = store.getTask(task.id);
  assert.equal(original.stage, "rc");

  const integrated = store.integrateContractTask({ taskId: task.id, agentId: ctx.owner.id });
  assert.equal(integrated.stage, "integrated");
  assert.equal(integrated.status, "done");
});
