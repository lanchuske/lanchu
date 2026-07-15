import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-test-network-claim-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;

const store = await import("../dist/core/store.js");
const { ScopeError } = await import("../dist/core/types.js");

/** A network-mode org with one published task, ready to be claimed by an outsider. */
function publishedTaskOrg(orgName) {
  const org = store.getOrCreateOrg(orgName);
  const project = store.getOrCreateProject(org.id, "web");
  store.setProjectNetworkMode(project.id, { networkMode: true });
  const role = store.getOrCreateRole(org.id, "generalist", { wildcard: true });
  const owner = store.createAgent({ orgId: org.id, roleId: role.id, objective: "own it" });
  const task = store.createTask({
    projectId: project.id, orgId: org.id, agentId: owner.id, title: "implement isValidEmail", tags: [],
  });
  store.setTaskPublished(task.id, true);
  return { org, project, owner, task };
}

// Network mode Piece 6 Task 3 + Piece 1 Task 4 (task-mrk1rq9m49,
// task-mrl5ii7856): a brand-new Person claims a task in an org they've
// never been in, and it behaves identically to any existing agent claiming
// a task today.

test("a brand-new Person claiming a published task auto-provisions a Membership and claims it", () => {
  const { org, task } = publishedTaskOrg("net-claim-org-1");
  const person = store.createPerson({ email: "ada@example.com", handle: "ada" });

  const result = store.claimNetworkTask({ personId: person.id, taskId: task.id, kind: "ai" });

  assert.equal(result.membershipCreated, true);
  assert.equal(result.agent.org_id, org.id);
  assert.equal(result.agent.person_id, person.id);
  assert.equal(result.agent.kind, "ai");
  assert.equal(result.task.status, "claimed");
  assert.equal(result.task.owner_agent_id, result.agent.id);
});

test("kind='ai' mints a fresh, working MCP session", () => {
  const { task } = publishedTaskOrg("net-claim-org-2");
  const person = store.createPerson({ email: "grace@example.com", handle: "grace" });

  const result = store.claimNetworkTask({ personId: person.id, taskId: task.id, kind: "ai" });

  assert.ok(result.session);
  assert.ok(result.session.token);
  assert.equal(store.agentIdForToken(result.session.token), result.agent.id);
});

test("kind='human' mints no session — authorized elsewhere via person_session (not yet built)", () => {
  const { task } = publishedTaskOrg("net-claim-org-3");
  const person = store.createPerson({ email: "ping@example.com", handle: "ping" });

  const result = store.claimNetworkTask({ personId: person.id, taskId: task.id, kind: "human" });

  assert.equal(result.session, null);
  assert.equal(result.agent.kind, "human");
});

test("a Person who already has a Membership in that org reuses it — no duplicate agent", () => {
  const { org, project, owner } = publishedTaskOrg("net-claim-org-4");
  const person = store.createPerson({ email: "ada2@example.com", handle: "ada2" });

  const first = store.createTask({
    projectId: project.id, orgId: org.id, agentId: owner.id, title: "task one", tags: [],
  });
  store.setTaskPublished(first.id, true);
  const second = store.createTask({
    projectId: project.id, orgId: org.id, agentId: owner.id, title: "task two", tags: [],
  });
  store.setTaskPublished(second.id, true);

  const r1 = store.claimNetworkTask({ personId: person.id, taskId: first.id, kind: "ai" });
  const r2 = store.claimNetworkTask({ personId: person.id, taskId: second.id, kind: "ai" });

  assert.equal(r1.membershipCreated, true);
  assert.equal(r2.membershipCreated, false);
  assert.equal(r1.agent.id, r2.agent.id); // same Membership, two tasks claimed with it
});

test("the same Person gets DIFFERENT agent rows in different orgs — no cross-org interference", () => {
  const orgA = publishedTaskOrg("net-claim-org-5a");
  const orgB = publishedTaskOrg("net-claim-org-5b");
  const person = store.createPerson({ email: "multi@example.com", handle: "multi" });

  const inA = store.claimNetworkTask({ personId: person.id, taskId: orgA.task.id, kind: "ai" });
  const inB = store.claimNetworkTask({ personId: person.id, taskId: orgB.task.id, kind: "ai" });

  assert.notEqual(inA.agent.id, inB.agent.id);
  assert.equal(inA.agent.person_id, person.id);
  assert.equal(inB.agent.person_id, person.id);
  assert.equal(inA.agent.org_id, orgA.org.id);
  assert.equal(inB.agent.org_id, orgB.org.id);
});

test("claiming in a non-network-mode project is rejected", () => {
  const org = store.getOrCreateOrg("net-claim-org-6");
  const project = store.getOrCreateProject(org.id, "local"); // network_mode left off
  const role = store.getOrCreateRole(org.id, "generalist", { wildcard: true });
  const owner = store.createAgent({ orgId: org.id, roleId: role.id, objective: "own it" });
  const task = store.createTask({
    projectId: project.id, orgId: org.id, agentId: owner.id, title: "local-only work", tags: [],
  });
  store.setTaskPublished(task.id, true); // published flag alone isn't enough
  const person = store.createPerson({ email: "outsider@example.com", handle: "outsider" });

  assert.throws(
    () => store.claimNetworkTask({ personId: person.id, taskId: task.id, kind: "ai" }),
    (err) => err instanceof ScopeError,
  );
});

test("claiming an unpublished task is rejected, even in a network-mode project", () => {
  const { org, project, owner } = publishedTaskOrg("net-claim-org-7");
  const unpublished = store.createTask({
    projectId: project.id, orgId: org.id, agentId: owner.id, title: "not published yet", tags: [],
  });
  const person = store.createPerson({ email: "outsider2@example.com", handle: "outsider2" });

  assert.throws(
    () => store.claimNetworkTask({ personId: person.id, taskId: unpublished.id, kind: "ai" }),
    (err) => err instanceof ScopeError,
  );
});

test("task_claim's own scope/conflict logic is completely untouched — the network-contributor role is a wildcard", () => {
  const { task } = publishedTaskOrg("net-claim-org-8");
  const person = store.createPerson({ email: "wild@example.com", handle: "wild" });

  // No special tags on the task, no special handling needed — claimTask
  // runs exactly as it does for any other agent.
  const result = store.claimNetworkTask({ personId: person.id, taskId: task.id, kind: "ai" });
  assert.equal(result.task.status, "claimed");
});
