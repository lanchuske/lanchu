import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-test-weight-capture-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;
delete process.env.LANCHU_SDLC; // default mode: assist

const store = await import("../dist/core/store.js");

/** An org with a role wildcard-tagged so claim/create scope checks never get in the way. */
function setup(orgName, { networkMode } = {}) {
  const org = store.getOrCreateOrg(orgName);
  const project = store.getOrCreateProject(org.id, "web");
  if (networkMode) store.setProjectNetworkMode(project.id, { networkMode: true });
  const role = store.getOrCreateRole(org.id, "generalist", { wildcard: true });
  const owner = store.createAgent({ orgId: org.id, roleId: role.id, objective: "own it" });
  const verifier = store.createAgent({ orgId: org.id, roleId: role.id, objective: "verify it" });
  return { org, project, role, owner, verifier };
}

/** Carries a task, owned by `owner`, to done-with-a-PR — parked in qa awaiting its verification child. */
function taskAwaitingVerification({ org, project, owner }) {
  const task = store.createTask({
    projectId: project.id,
    orgId: org.id,
    agentId: owner.id,
    title: "implement the contract",
    tags: [],
  });
  store.claimTask({ agentId: owner.id, taskId: task.id });
  store.updateTaskStatus({ agentId: owner.id, taskId: task.id, status: "done" });
  const verification = store.openVerificationTaskFor(task.id);
  return { task, verification };
}

// Network mode Piece 4 Task 2 (task-mrl5tvmr65): completing a "QA: verify"
// task on a network-mode project's original writes a contribution_event;
// completing one on a local-mode project writes nothing.

test("QA-pass on a network-mode task with a Person owner writes a contribution_event", () => {
  const ctx = setup("weight-org-1", { networkMode: true });
  const contributor = store.createPerson({ email: "ada@example.com", handle: "ada" });
  const verifierPerson = store.createPerson({ email: "grace@example.com", handle: "grace" });
  const owner = store.createAgent({
    orgId: ctx.org.id, roleId: ctx.role.id, objective: "own it", personId: contributor.id, kind: "human",
  });
  const verifier = store.createAgent({
    orgId: ctx.org.id, roleId: ctx.role.id, objective: "verify it", personId: verifierPerson.id, kind: "human",
  });
  const { task, verification } = taskAwaitingVerification({ ...ctx, owner });

  store.updateTaskStatus({ agentId: verifier.id, taskId: verification.id, status: "done", note: "looks good", weight: 5 });

  assert.equal(store.getTask(task.id).status, "done");
  const events = store.listContributionEventsForTask(task.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].person_id, contributor.id);
  assert.equal(events[0].weight, 5);
  assert.equal(events[0].verified_by, verifierPerson.id);
});

test("omitting weight defaults to 1", () => {
  const ctx = setup("weight-org-2", { networkMode: true });
  const contributor = store.createPerson({ email: "ping@example.com", handle: "ping" });
  const owner = store.createAgent({
    orgId: ctx.org.id, roleId: ctx.role.id, objective: "own it", personId: contributor.id,
  });
  const { task, verification } = taskAwaitingVerification({ ...ctx, owner });

  store.updateTaskStatus({ agentId: ctx.verifier.id, taskId: verification.id, status: "done" });

  const events = store.listContributionEventsForTask(task.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].weight, 1);
  assert.equal(events[0].verified_by, null); // ctx.verifier has no person_id
});

test("a local-mode project's QA-pass writes nothing — zero behavior change", () => {
  const ctx = setup("weight-org-3"); // network_mode left off
  const { task, verification } = taskAwaitingVerification(ctx);

  store.updateTaskStatus({ agentId: ctx.verifier.id, taskId: verification.id, status: "done" });

  assert.equal(store.getTask(task.id).status, "done"); // the normal SDLC flip still happens
  assert.equal(store.listContributionEventsForTask(task.id).length, 0);
});

test("a network-mode project's task owned by a person-less (plain AI) agent writes nothing", () => {
  const ctx = setup("weight-org-4", { networkMode: true });
  // ctx.owner has no person_id — an ordinary local agent, not a network Membership.
  const { task, verification } = taskAwaitingVerification(ctx);

  store.updateTaskStatus({ agentId: ctx.verifier.id, taskId: verification.id, status: "done" });

  assert.equal(store.listContributionEventsForTask(task.id).length, 0);
});
