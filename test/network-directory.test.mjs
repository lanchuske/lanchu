import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-test-network-directory-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;

const store = await import("../dist/core/store.js");

function setup(orgName) {
  const org = store.getOrCreateOrg(orgName);
  const project = store.getOrCreateProject(org.id, "web");
  const role = store.getOrCreateRole(org.id, "generalist", { wildcard: true });
  const owner = store.createAgent({ orgId: org.id, roleId: role.id, objective: "own it" });
  return { org, project, role, owner };
}

// Network mode Piece 6 Task 2 (task-mrk1rd3w48): the endpoint returns
// correct, live aggregate stats for every opted-in project and nothing
// else — no name, no concept, no task titles.

test("a local-mode (non-network) project never appears in the directory", () => {
  const { project } = setup("dir-org-1"); // network_mode left off
  const dirEntries = store.listNetworkDirectory();
  assert.ok(!dirEntries.some((e) => e.projectId === project.id));
});

test("a freshly opted-in project with no activity appears with zero stats", () => {
  const { project } = setup("dir-org-2");
  store.setProjectNetworkMode(project.id, { networkMode: true });

  const entry = store.listNetworkDirectory().find((e) => e.projectId === project.id);
  assert.ok(entry);
  assert.equal(entry.verifiedContributions, 0);
  assert.equal(entry.ledgerSize, 0);
  assert.equal(entry.openTaskCount, 0);
  assert.equal(entry.compensationTerms, null);
});

test("no name, title, or concept field ever appears on a directory entry — the whole anonymization boundary", () => {
  const { project } = setup("dir-org-3");
  store.setProjectNetworkMode(project.id, { networkMode: true });
  const entry = store.listNetworkDirectory().find((e) => e.projectId === project.id);

  const keys = Object.keys(entry);
  for (const forbidden of ["name", "title", "concept", "description", "repoUrl", "repo_url", "localPath"]) {
    assert.ok(!keys.includes(forbidden), `directory entry must never carry '${forbidden}'`);
  }
  assert.deepEqual(
    keys.sort(),
    ["compensationTerms", "ledgerSize", "openTaskCount", "projectId", "publishedAt", "verifiedContributions"].sort(),
  );
});

test("verified contributions and ledger size reflect real contribution_event rows", () => {
  const { org, project, owner } = setup("dir-org-4");
  store.setProjectNetworkMode(project.id, { networkMode: true });
  const person1 = store.createPerson({ email: "a@example.com", handle: "a" });
  const person2 = store.createPerson({ email: "b@example.com", handle: "b" });
  const taskX = store.createTask({
    projectId: project.id, orgId: org.id, agentId: owner.id, title: "task x", tags: [],
  });
  const taskY = store.createTask({
    projectId: project.id, orgId: org.id, agentId: owner.id, title: "task y", tags: [],
  });

  store.createContributionEvent({ personId: person1.id, projectId: project.id, taskId: taskX.id, weight: 3 });
  store.createContributionEvent({ personId: person2.id, projectId: project.id, taskId: taskY.id, weight: 5 });

  const entry = store.listNetworkDirectory().find((e) => e.projectId === project.id);
  assert.equal(entry.verifiedContributions, 2);
  assert.equal(entry.ledgerSize, 8);
});

test("open task count only includes published AND available (unclaimed) tasks", () => {
  const { org, project, owner } = setup("dir-org-5");
  store.setProjectNetworkMode(project.id, { networkMode: true });

  const published = store.createTask({
    projectId: project.id, orgId: org.id, agentId: owner.id, title: "published, open", tags: [],
  });
  store.setTaskPublished(published.id, true);

  const unpublished = store.createTask({
    projectId: project.id, orgId: org.id, agentId: owner.id, title: "not published", tags: [],
  });

  const publishedButClaimed = store.createTask({
    projectId: project.id, orgId: org.id, agentId: owner.id, title: "published, claimed", tags: [],
  });
  store.setTaskPublished(publishedButClaimed.id, true);
  store.claimTask({ agentId: owner.id, taskId: publishedButClaimed.id });

  const entry = store.listNetworkDirectory().find((e) => e.projectId === project.id);
  assert.equal(entry.openTaskCount, 1); // only `published`
  void unpublished; // created only to prove it does NOT count
});

test("compensation terms pass through when set", () => {
  const { project } = setup("dir-org-6");
  store.setProjectNetworkMode(project.id, {
    networkMode: true,
    compensationTerms: "10% of net revenue, prorated by ledger share",
  });
  const entry = store.listNetworkDirectory().find((e) => e.projectId === project.id);
  assert.equal(entry.compensationTerms, "10% of net revenue, prorated by ledger share");
});

test("multiple opted-in projects are all listed, newest first", () => {
  const older = setup("dir-org-7a");
  store.setProjectNetworkMode(older.project.id, { networkMode: true });
  const newer = setup("dir-org-7b");
  store.setProjectNetworkMode(newer.project.id, { networkMode: true });

  const ids = store.listNetworkDirectory().map((e) => e.projectId);
  assert.ok(ids.indexOf(newer.project.id) < ids.indexOf(older.project.id));
});
