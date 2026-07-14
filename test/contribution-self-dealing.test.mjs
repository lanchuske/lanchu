import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-test-self-dealing-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;
delete process.env.LANCHU_SDLC; // default mode: assist

const store = await import("../dist/core/store.js");

function setup(orgName, { networkMode } = {}) {
  const org = store.getOrCreateOrg(orgName);
  const project = store.getOrCreateProject(org.id, "web");
  if (networkMode) store.setProjectNetworkMode(project.id, { networkMode: true });
  const role = store.getOrCreateRole(org.id, "generalist", { wildcard: true });
  return { org, project, role };
}

function taskAwaitingVerification({ org, project, owner }) {
  const task = store.createTask({
    projectId: project.id, orgId: org.id, agentId: owner.id, title: "implement the contract", tags: [],
  });
  store.claimTask({ agentId: owner.id, taskId: task.id });
  store.updateTaskStatus({ agentId: owner.id, taskId: task.id, status: "done" });
  const verification = store.openVerificationTaskFor(task.id);
  return { task, verification };
}

// Network mode Piece 4 Task 3 (task-mrl5tz0666): a verification attempt
// where verifier and contributor resolve to the same person is rejected
// and audited before flipVerifiedOriginal runs; every other verification
// path is unaffected.

test("same Person as both contributor and verifier: rejected, audited, parent stays unverified", () => {
  const { org, project, role } = setup("self-deal-org-1", { networkMode: true });
  const person = store.createPerson({ email: "ada@example.com", handle: "ada" });
  // Two DIFFERENT agent rows, same Person — plausible if they run two
  // sessions, or (once Piece 6 Task 3 ships) two Memberships in one org.
  const ownerAgent = store.createAgent({ orgId: org.id, roleId: role.id, objective: "own it", personId: person.id });
  const verifierAgent = store.createAgent({ orgId: org.id, roleId: role.id, objective: "verify it", personId: person.id });
  const { task, verification } = taskAwaitingVerification({ org, project, owner: ownerAgent });

  store.updateTaskStatus({ agentId: verifierAgent.id, taskId: verification.id, status: "done", note: "looks good to me" });

  // The verification task's own completion recorded (it happened)...
  assert.equal(store.getTask(verification.id).status, "done");
  // ...but the parent was NOT flipped: assist mode already marks the owner's
  // own "done" as status=done (parked awaiting verification), so the real
  // signal that flipVerifiedOriginal never ran is the stage staying "qa"
  // instead of moving to "rc".
  assert.equal(store.getTask(task.id).stage, "qa");
  // No credit was recorded.
  assert.equal(store.listContributionEventsForTask(task.id).length, 0);
  // Audited as a rejected scope.violation.
  const violation = store
    .listAuditEvents(org.id)
    .find((e) => e.type === "scope.violation" && e.subject_id === verification.id);
  assert.ok(violation, "self-dealing recorded as an audited scope.violation");
  assert.equal(violation.outcome, "rejected");
  assert.equal(violation.data.reason, "self-dealing");
  // The resolver was told why.
  const heard = store.takeUndeliveredNotices(verifierAgent.id);
  assert.ok(heard.some((n) => /can't verify your own contribution/.test(n.body)));
});

test("different Persons on each side: verifies normally", () => {
  const { org, project, role } = setup("self-deal-org-2", { networkMode: true });
  const contributor = store.createPerson({ email: "ping@example.com", handle: "ping" });
  const verifierPerson = store.createPerson({ email: "pong@example.com", handle: "pong" });
  const ownerAgent = store.createAgent({ orgId: org.id, roleId: role.id, objective: "own it", personId: contributor.id });
  const verifierAgent = store.createAgent({ orgId: org.id, roleId: role.id, objective: "verify it", personId: verifierPerson.id });
  const { task, verification } = taskAwaitingVerification({ org, project, owner: ownerAgent });

  store.updateTaskStatus({ agentId: verifierAgent.id, taskId: verification.id, status: "done" });

  assert.equal(store.getTask(task.id).stage, "rc"); // flipped — verification passed
  assert.equal(store.listContributionEventsForTask(task.id).length, 1);
});

test("local-mode project: the same-agent case is untouched (no Person concept, no block)", () => {
  const { org, project, role } = setup("self-deal-org-3"); // network_mode off
  const owner = store.createAgent({ orgId: org.id, roleId: role.id, objective: "own it" });
  const { task, verification } = taskAwaitingVerification({ org, project, owner });

  // Same agent completes its own verification — allowed today, unrelated to
  // network mode's self-dealing rule (which requires two Persons to compare).
  store.updateTaskStatus({ agentId: owner.id, taskId: verification.id, status: "done" });

  assert.equal(store.getTask(task.id).stage, "rc"); // flipped normally
});

test("network-mode project but no Person on either side: unaffected, verifies normally", () => {
  const { org, project, role } = setup("self-deal-org-4", { networkMode: true });
  const owner = store.createAgent({ orgId: org.id, roleId: role.id, objective: "own it" }); // no person_id
  const { task, verification } = taskAwaitingVerification({ org, project, owner });

  store.updateTaskStatus({ agentId: owner.id, taskId: verification.id, status: "done" });

  assert.equal(store.getTask(task.id).stage, "rc"); // flipped normally
  assert.equal(store.listContributionEventsForTask(task.id).length, 0); // no Person to credit
});

test("batch verification: a self-dealing original is skipped, the rest of the batch resolves normally", () => {
  const { org, project, role } = setup("self-deal-org-5", { networkMode: true });
  const samePerson = store.createPerson({ email: "same@example.com", handle: "same" });
  const otherContributor = store.createPerson({ email: "other@example.com", handle: "other" });
  const selfDealer = store.createAgent({ orgId: org.id, roleId: role.id, objective: "own+verify", personId: samePerson.id });
  const legitOwner = store.createAgent({ orgId: org.id, roleId: role.id, objective: "own it", personId: otherContributor.id });
  const qa = store.createAgent({ orgId: org.id, roleId: role.id, objective: "qa", personId: samePerson.id });

  const selfDealt = store.createTask({
    projectId: project.id, orgId: org.id, agentId: selfDealer.id, title: "self-dealt work", tags: [],
  });
  store.claimTask({ agentId: selfDealer.id, taskId: selfDealt.id });
  store.updateTaskStatus({
    agentId: selfDealer.id, taskId: selfDealt.id, status: "done",
    prUrl: "https://github.com/x/y/pull/1",
  });

  const legit = store.createTask({
    projectId: project.id, orgId: org.id, agentId: legitOwner.id, title: "legit work", tags: [],
  });
  store.claimTask({ agentId: legitOwner.id, taskId: legit.id });
  store.updateTaskStatus({
    agentId: legitOwner.id, taskId: legit.id, status: "done",
    prUrl: "https://github.com/x/y/pull/2",
  });

  const batch = store.createTask({
    projectId: project.id, orgId: org.id, agentId: qa.id,
    title: `QA verify batch — covers ${selfDealt.id} and ${legit.id}`, tags: [],
  });
  store.updateTaskStatus({ agentId: qa.id, taskId: batch.id, status: "done", note: "all checked" });

  assert.equal(store.getTask(selfDealt.id).stage, "qa"); // rejected — never flipped to rc
  assert.equal(store.getTask(legit.id).stage, "rc"); // resolved normally
  assert.equal(store.listContributionEventsForTask(legit.id).length, 1);
  assert.equal(store.listContributionEventsForTask(selfDealt.id).length, 0);
});
