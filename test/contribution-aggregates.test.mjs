import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-test-contribution-aggregates-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;

const store = await import("../dist/core/store.js");
const { createServer } = await import("../dist/server/server.js");

// Network mode Piece 4 Task 4 (task-mrl5u2dy67): aggregate ledger queries —
// a Person's cross-project total + per-project breakdown, surfaced on the
// public profile. The project-scoped aggregate (directory card) shipped
// with Piece 6 Task 2; this covers the Person side and the profile wiring.

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

const server = createServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

test("contributionStatsForPerson sums across projects and breaks down per project", () => {
  const a = setup("agg-org-1");
  const b = setup("agg-org-2");
  const ada = store.createPerson({ email: "ada@agg.test", handle: "agg-ada" });
  const grace = store.createPerson({ email: "grace@agg.test", handle: "agg-grace" });

  store.createContributionEvent({ personId: ada.id, projectId: a.project.id, taskId: a.task.id, weight: 5, verifiedBy: grace.id });
  store.createContributionEvent({ personId: ada.id, projectId: a.project.id, taskId: a.task.id, weight: 2, verifiedBy: grace.id });
  store.createContributionEvent({ personId: ada.id, projectId: b.project.id, taskId: b.task.id, weight: 3, verifiedBy: grace.id });
  // Someone else's event must never leak into ada's stats.
  store.createContributionEvent({ personId: grace.id, projectId: a.project.id, taskId: a.task.id, weight: 8, verifiedBy: ada.id });

  const stats = store.contributionStatsForPerson(ada.id);
  assert.equal(stats.count, 3);
  assert.equal(stats.totalWeight, 10);
  assert.equal(stats.projects.length, 2);
  // Ordered by per-project weight, heaviest first.
  assert.deepEqual(stats.projects[0], { projectId: a.project.id, count: 2, totalWeight: 7 });
  assert.deepEqual(stats.projects[1], { projectId: b.project.id, count: 1, totalWeight: 3 });
});

test("a Person with no contributions gets zeros and an empty breakdown, not an error", () => {
  const nobody = store.createPerson({ email: "zero@agg.test", handle: "agg-zero" });
  assert.deepEqual(store.contributionStatsForPerson(nobody.id), { count: 0, totalWeight: 0, projects: [] });
});

test("GET /api/profile/:handle carries the real ledger — total and per-project breakdown", async () => {
  const { project, task } = setup("agg-org-3");
  const lin = store.createPerson({ email: "lin@agg.test", handle: "agg-lin" });
  const ver = store.createPerson({ email: "ver@agg.test", handle: "agg-ver" });
  store.createContributionEvent({ personId: lin.id, projectId: project.id, taskId: task.id, weight: 5, verifiedBy: ver.id });

  const res = await fetch(`${base}/api/profile/agg-lin`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.contributions.count, 1);
  assert.equal(body.contributions.totalWeight, 5);
  assert.deepEqual(body.contributions.projects, [{ projectId: project.id, count: 1, totalWeight: 5 }]);
  assert.equal("email" in body, false, "email must never appear on the public profile response");
});

test("a contribution-free profile still carries a zeroed ledger object", async () => {
  store.createPerson({ email: "fresh@agg.test", handle: "agg-fresh" });
  const res = await fetch(`${base}/api/profile/agg-fresh`);
  const body = await res.json();
  assert.deepEqual(body.contributions, { count: 0, totalWeight: 0, projects: [] });
});

test("the profile shell renders the ledger client-side — no ledger data is server-rendered", async () => {
  const res = await fetch(`${base}/@agg-lin`);
  const html = await res.text();
  assert.match(html, /Contributions/, "shell must contain the ledger section renderer");
  assert.doesNotMatch(html, /agg-lin/, "no profile data is ever server-rendered into the HTML");
});
