import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-test-contribution-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;

const store = await import("../dist/core/store.js");

function setup(orgName) {
  const org = store.getOrCreateOrg(orgName);
  const project = store.getOrCreateProject(org.id, "web");
  const role = store.getOrCreateRole(org.id, "backend", { tags: ["backend"] });
  const owner = store.createAgent({ orgId: org.id, roleId: role.id, objective: "own it" });
  const task = store.createTask({
    projectId: project.id,
    orgId: org.id,
    agentId: owner.id,
    title: "implement the contract",
    tags: ["backend"],
  });
  return { org, project, role, owner, task };
}

// Network mode Piece 4 (task-mrl5trjf64): a contribution_event row can be
// inserted and read back.

test("a contribution_event can be created and read back", () => {
  const { project, task } = setup("contrib-org-1");
  const contributor = store.createPerson({ email: "ada@example.com", handle: "ada" });
  const verifier = store.createPerson({ email: "grace@example.com", handle: "grace" });

  const event = store.createContributionEvent({
    personId: contributor.id,
    projectId: project.id,
    taskId: task.id,
    weight: 5,
    verifiedBy: verifier.id,
  });

  assert.ok(event.id);
  assert.equal(event.person_id, contributor.id);
  assert.equal(event.project_id, project.id);
  assert.equal(event.task_id, task.id);
  assert.equal(event.weight, 5);
  assert.equal(event.verified_by, verifier.id);

  const fetched = store.getContributionEvent(event.id);
  assert.deepEqual(fetched, event);
});

test("verified_by is optional — an unverified/automated event can omit it", () => {
  const { project, task } = setup("contrib-org-2");
  const contributor = store.createPerson({ email: "ping@example.com", handle: "ping" });

  const event = store.createContributionEvent({
    personId: contributor.id,
    projectId: project.id,
    taskId: task.id,
    weight: 1,
  });

  assert.equal(event.verified_by, null);
});

test("getContributionEvent returns null for an unknown id", () => {
  assert.equal(store.getContributionEvent("nope"), null);
});
