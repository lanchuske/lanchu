import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-test-contract-visibility-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;

const store = await import("../dist/core/store.js");

function setup(orgName) {
  const org = store.getOrCreateOrg(orgName);
  const project = store.getOrCreateProject(org.id, "web");
  const role = store.getOrCreateRole(org.id, "generalist", { wildcard: true });
  const owner = store.createAgent({ orgId: org.id, roleId: role.id, objective: "own the project" });
  const contributorA = store.createAgent({ orgId: org.id, roleId: role.id, objective: "contribute A" });
  const contributorB = store.createAgent({ orgId: org.id, roleId: role.id, objective: "contribute B" });
  return { org, project, role, owner, contributorA, contributorB };
}

// Network mode Piece 5 Task 5 (task-mrk1r6gw46): a contract task's
// visibility is locked to the project owner and its own assigned
// contributor. No `task_list`/`task_get`-equivalent call, however crafted,
// returns another task on the same project to a non-owner contributor.

test("an internal task is visible to anyone — unchanged, no lockdown", () => {
  const { org, project, owner, contributorA } = setup("vis-org-1");
  const task = store.createTask({
    projectId: project.id, orgId: org.id, agentId: owner.id, title: "ordinary local-mode work", tags: [],
  });
  assert.ok(store.taskVisibleTo(task, owner.id));
  assert.ok(store.taskVisibleTo(task, contributorA.id));
});

test("a contract task is visible to the declared project owner, even unclaimed", () => {
  const { org, project, owner } = setup("vis-org-2");
  store.setProjectOwner(project.id, owner.id);
  const task = store.createTask({
    projectId: project.id, orgId: org.id, agentId: owner.id, title: "implement X", tags: [],
    kind: "contract", contractSpec: "spec",
  });
  assert.ok(store.taskVisibleTo(task, owner.id));
});

test("a contract task is visible to its own assigned contributor", () => {
  const { org, project, owner, contributorA } = setup("vis-org-3");
  store.setProjectOwner(project.id, owner.id);
  const task = store.createTask({
    projectId: project.id, orgId: org.id, agentId: owner.id, title: "implement X", tags: [],
    kind: "contract", contractSpec: "spec",
  });
  store.claimTask({ agentId: contributorA.id, taskId: task.id });
  const fetched = store.getTask(task.id);
  assert.ok(store.taskVisibleTo(fetched, contributorA.id));
});

test("adversarial: a contract task assigned to one contributor is invisible to a different, unrelated contributor", () => {
  const { org, project, owner, contributorA, contributorB } = setup("vis-org-4");
  store.setProjectOwner(project.id, owner.id);
  const task = store.createTask({
    projectId: project.id, orgId: org.id, agentId: owner.id, title: "implement X — secret concept detail", tags: [],
    kind: "contract", contractSpec: "spec",
  });
  store.claimTask({ agentId: contributorA.id, taskId: task.id });
  const fetched = store.getTask(task.id);

  assert.equal(store.taskVisibleTo(fetched, contributorB.id), null);
});

test("an unclaimed contract task is invisible to non-owners — discovery happens outside task_list", () => {
  const { org, project, owner, contributorA } = setup("vis-org-5");
  store.setProjectOwner(project.id, owner.id);
  const task = store.createTask({
    projectId: project.id, orgId: org.id, agentId: owner.id, title: "not yet claimed", tags: [],
    kind: "contract", contractSpec: "spec",
  });
  assert.equal(store.taskVisibleTo(task, contributorA.id), null);
});

test("fail-closed default: with no declared project owner, contract tasks are locked down for everyone but their contributor", () => {
  const { org, project, owner, contributorA } = setup("vis-org-6");
  // No setProjectOwner call — owner_agent_id stays NULL.
  const task = store.createTask({
    projectId: project.id, orgId: org.id, agentId: owner.id, title: "implement X", tags: [],
    kind: "contract", contractSpec: "spec",
  });
  // Not even the task's own creator (who isn't the declared owner) can see it.
  assert.equal(store.taskVisibleTo(task, owner.id), null);

  store.claimTask({ agentId: contributorA.id, taskId: task.id });
  const fetched = store.getTask(task.id);
  assert.ok(store.taskVisibleTo(fetched, contributorA.id)); // still visible to its own contributor
});

test("listTasksVisibleTo: the owner sees everything, a contributor sees only their own contract task plus every internal task", () => {
  const { org, project, owner, contributorA, contributorB } = setup("vis-org-7");
  store.setProjectOwner(project.id, owner.id);
  const internal = store.createTask({
    projectId: project.id, orgId: org.id, agentId: owner.id, title: "internal work", tags: [],
  });
  const contractA = store.createTask({
    projectId: project.id, orgId: org.id, agentId: owner.id, title: "contract for A", tags: [],
    kind: "contract", contractSpec: "spec A",
  });
  const contractB = store.createTask({
    projectId: project.id, orgId: org.id, agentId: owner.id, title: "contract for B", tags: [],
    kind: "contract", contractSpec: "spec B",
  });
  store.claimTask({ agentId: contributorA.id, taskId: contractA.id });
  store.claimTask({ agentId: contributorB.id, taskId: contractB.id });

  const ownerView = store.listTasksVisibleTo(project.id, owner.id).map((t) => t.id).sort();
  assert.deepEqual(ownerView, [contractA.id, contractB.id, internal.id].sort());

  const aView = store.listTasksVisibleTo(project.id, contributorA.id).map((t) => t.id).sort();
  assert.deepEqual(aView, [contractA.id, internal.id].sort());
  assert.ok(!aView.includes(contractB.id), "contributor A never sees contributor B's contract task");
});

test("listArchivedTasksVisibleTo applies the same lockdown to the archive", () => {
  const { org, project, owner, contributorA, contributorB } = setup("vis-org-8");
  store.setProjectOwner(project.id, owner.id);
  const contractA = store.createTask({
    projectId: project.id, orgId: org.id, agentId: owner.id, title: "contract for A", tags: [],
    kind: "contract", contractSpec: "spec A",
  });
  store.claimTask({ agentId: contributorA.id, taskId: contractA.id });
  store.archiveTask({ taskId: contractA.id, reason: "superseded", override: true });

  assert.equal(store.listArchivedTasksVisibleTo(project.id, contributorB.id).length, 0);
  assert.equal(store.listArchivedTasksVisibleTo(project.id, contributorA.id).length, 1);
  assert.equal(store.listArchivedTasksVisibleTo(project.id, owner.id).length, 1);
});
