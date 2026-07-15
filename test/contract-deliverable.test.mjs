import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-test-contract-deliverable-" + process.pid);
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
  const outsider = store.createAgent({ orgId: org.id, roleId: role.id, objective: "unrelated" });
  return { org, project, role, owner, contributor, outsider };
}

function claimedContractTask({ org, project, owner, contributor }) {
  const task = store.createTask({
    projectId: project.id, orgId: org.id, agentId: owner.id, title: "implement isValidEmail", tags: [],
    kind: "contract", contractSpec: "spec", contractTests: "some tests",
  });
  store.claimTask({ agentId: contributor.id, taskId: task.id });
  return task;
}

// Network mode Piece 5 Task 3 (task-mrk1qzcn44): a submission failing the
// test suite is blocked from done (via the existing FAIL-note convention);
// a passing one reaches QA-pass with the result recorded.

test("submitting a deliverable stores it and marks the task done (parked in qa, gated as usual)", () => {
  const { org, project, owner, contributor } = setup("deliver-org-1");
  const task = claimedContractTask({ org, project, owner, contributor });

  const result = store.submitContractDeliverable({
    taskId: task.id,
    agentId: contributor.id,
    content: "diff --git a/email.js b/email.js\n+export function isValidEmail(s) { return /@/.test(s); }",
  });

  assert.equal(result.status, "done"); // assist mode: done recorded immediately
  assert.equal(result.stage, "qa"); // parked awaiting verification
  assert.ok(store.openVerificationTaskFor(task.id), "a verification task was spun up, same as any task");

  const deliverable = store.latestContractDeliverable(task.id);
  assert.match(deliverable.content, /isValidEmail/);
  assert.equal(deliverable.submitted_by_agent_id, contributor.id);
});

test("only the task's own assigned contributor can submit — an outsider is rejected and audited", () => {
  const { org, project, owner, contributor, outsider } = setup("deliver-org-2");
  const task = claimedContractTask({ org, project, owner, contributor });

  assert.throws(
    () => store.submitContractDeliverable({ taskId: task.id, agentId: outsider.id, content: "sneaky" }),
    (err) => err instanceof ScopeError,
  );
  assert.equal(store.listContractDeliverables(task.id).length, 0);

  const violation = store
    .listAuditEvents(org.id)
    .find((e) => e.type === "scope.violation" && e.data?.action === "submit_contract");
  assert.ok(violation, "the rejected attempt is audited");
  assert.equal(violation.outcome, "rejected");
});

test("submitting to an internal (non-contract) task is rejected — use task_update/pr_url instead", () => {
  const { org, project, owner } = setup("deliver-org-3");
  const task = store.createTask({
    projectId: project.id, orgId: org.id, agentId: owner.id, title: "ordinary work", tags: [],
  });
  store.claimTask({ agentId: owner.id, taskId: task.id });

  assert.throws(
    () => store.submitContractDeliverable({ taskId: task.id, agentId: owner.id, content: "n/a" }),
    (err) => err instanceof ScopeError,
  );
});

test("an unclaimed contract task rejects submission — nobody is its assigned contributor yet", () => {
  const { org, project, owner, contributor } = setup("deliver-org-4");
  const task = store.createTask({
    projectId: project.id, orgId: org.id, agentId: owner.id, title: "not yet claimed", tags: [],
    kind: "contract", contractSpec: "spec",
  });

  assert.throws(
    () => store.submitContractDeliverable({ taskId: task.id, agentId: contributor.id, content: "n/a" }),
    (err) => err instanceof ScopeError,
  );
});

test("the existing FAIL-note convention blocks a bad submission from ever reaching done — no new mechanism needed", () => {
  const { org, project, owner, contributor } = setup("deliver-org-5");
  store.setProjectOwner(project.id, owner.id);
  const task = claimedContractTask({ org, project, owner, contributor });

  store.submitContractDeliverable({ taskId: task.id, agentId: contributor.id, content: "broken implementation" });
  const verification = store.openVerificationTaskFor(task.id);

  store.updateTaskStatus({
    agentId: owner.id, taskId: verification.id, status: "done",
    note: "FAIL — contract_tests: isValidEmail('nope') should be false, got true",
  });

  assert.equal(store.getTask(task.id).stage, "build"); // bounced back, never reached rc
});

test("resubmission after a FAIL bounce works — the contributor is still the assigned owner", () => {
  const { org, project, owner, contributor } = setup("deliver-org-6");
  store.setProjectOwner(project.id, owner.id);
  const task = claimedContractTask({ org, project, owner, contributor });

  store.submitContractDeliverable({ taskId: task.id, agentId: contributor.id, content: "v1, broken" });
  const v1 = store.openVerificationTaskFor(task.id);
  store.updateTaskStatus({ agentId: owner.id, taskId: v1.id, status: "done", note: "FAIL — bad" });

  // Resubmit — same contributor, still allowed.
  store.submitContractDeliverable({ taskId: task.id, agentId: contributor.id, content: "v2, fixed" });
  const v2 = store.openVerificationTaskFor(task.id);
  store.updateTaskStatus({ agentId: owner.id, taskId: v2.id, status: "done", note: "looks right now" });

  assert.equal(store.getTask(task.id).stage, "rc"); // flipped on the second, passing verification
  assert.equal(store.listContractDeliverables(task.id).length, 2);
  assert.equal(store.latestContractDeliverable(task.id).content, "v2, fixed");
});

test("a passing verification on a network-mode project's contract task still records a contribution_event (Piece 4 untouched)", () => {
  const { org, project, owner, role } = setup("deliver-org-7");
  store.setProjectNetworkMode(project.id, { networkMode: true });
  store.setProjectOwner(project.id, owner.id);
  const person = store.createPerson({ email: "ada@example.com", handle: "ada" });
  const contributorWithPerson = store.createAgent({
    orgId: org.id, roleId: role.id, objective: "contribute", personId: person.id,
  });
  const task = store.createTask({
    projectId: project.id, orgId: org.id, agentId: owner.id, title: "implement X", tags: [],
    kind: "contract", contractSpec: "spec",
  });
  store.claimTask({ agentId: contributorWithPerson.id, taskId: task.id });

  store.submitContractDeliverable({ taskId: task.id, agentId: contributorWithPerson.id, content: "the fix" });
  const verification = store.openVerificationTaskFor(task.id);
  store.updateTaskStatus({ agentId: owner.id, taskId: verification.id, status: "done", weight: 3 });

  const events = store.listContributionEventsForTask(task.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].weight, 3);
  assert.equal(events[0].person_id, person.id);
});
