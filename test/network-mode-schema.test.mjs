import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-test-network-schema-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;

const store = await import("../dist/core/store.js");

function setup(orgName) {
  const org = store.getOrCreateOrg(orgName);
  const project = store.getOrCreateProject(org.id, "web");
  const role = store.getOrCreateRole(org.id, "backend", { tags: ["backend"] });
  const agent = store.createAgent({ orgId: org.id, roleId: role.id, objective: "own it" });
  return { org, project, role, agent };
}

// Network mode Piece 6 (task-mrk1r9k447): a project can opt into network
// mode and publish a task; nothing changes for projects that don't opt in.

test("a project defaults to network_mode false and no compensation terms", () => {
  const { project } = setup("net-org-1");
  assert.equal(project.network_mode, false);
  assert.equal(project.compensation_terms, null);
});

test("a project can opt into network mode and declare compensation terms", () => {
  const { org, project } = setup("net-org-2");
  store.setProjectNetworkMode(project.id, {
    networkMode: true,
    compensationTerms: "10% of net revenue, prorated by ledger share",
  });
  const [reloaded] = store.listProjects(org.id);
  assert.equal(reloaded.network_mode, true);
  assert.equal(reloaded.compensation_terms, "10% of net revenue, prorated by ledger share");
});

test("network_mode can be toggled independently of compensation_terms", () => {
  const { org, project } = setup("net-org-3");
  store.setProjectNetworkMode(project.id, { networkMode: true });
  let [reloaded] = store.listProjects(org.id);
  assert.equal(reloaded.network_mode, true);
  assert.equal(reloaded.compensation_terms, null);

  store.setProjectNetworkMode(project.id, { compensationTerms: "reputation only" });
  [reloaded] = store.listProjects(org.id);
  assert.equal(reloaded.network_mode, true); // unaffected by the second call
  assert.equal(reloaded.compensation_terms, "reputation only");
});

test("a task defaults unpublished (published_at null)", () => {
  const { org, project, agent } = setup("net-org-4");
  const task = store.createTask({
    projectId: project.id,
    orgId: org.id,
    agentId: agent.id,
    title: "build the thing",
    tags: ["backend"],
  });
  assert.equal(task.published_at, null);
});

test("a task can be published, then unpublished", () => {
  const { org, project, agent } = setup("net-org-5");
  const task = store.createTask({
    projectId: project.id,
    orgId: org.id,
    agentId: agent.id,
    title: "build the other thing",
    tags: ["backend"],
  });
  store.setTaskPublished(task.id, true);
  assert.ok(store.getTask(task.id).published_at);

  store.setTaskPublished(task.id, false);
  assert.equal(store.getTask(task.id).published_at, null);
});

test("every existing project/task-creation path is unaffected by the new columns", () => {
  const { org, project, agent } = setup("net-org-6");
  assert.equal(project.network_mode, false);
  const task = store.createTask({
    projectId: project.id,
    orgId: org.id,
    agentId: agent.id,
    title: "unrelated local-mode work",
    tags: ["backend"],
  });
  assert.equal(task.status, "available");
  assert.equal(task.published_at, null);
});
