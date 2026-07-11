import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-bugs-view-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;
process.env.LANCHU_SDLC = "assist";

const store = await import("../dist/core/store.js");

function setup(orgName) {
  const org = store.getOrCreateOrg(orgName);
  const project = store.getOrCreateProject(org.id, "core");
  const role = store.getOrCreateRole(org.id, "generalist", { wildcard: true });
  const agent = store.createAgent({ orgId: org.id, roleId: role.id, objective: "fix bugs" });
  return { org, project, role, agent };
}

function boardBug(orgId, taskId) {
  return store.boardSnapshot(orgId).tasks.find((t) => t.id === taskId);
}

test("a fixed-unverified bug carries its open verification; a verified one carries the evidence", () => {
  const { org, project, agent } = setup("bugsv2-a");
  const bug = store.createTask({
    projectId: project.id, orgId: org.id, agentId: agent.id,
    title: "Bug: dot shows the wrong color", tags: ["bug", "panel"],
  });
  store.claimTask({ agentId: agent.id, taskId: bug.id });
  store.updateTaskStatus({ agentId: agent.id, taskId: bug.id, status: "done", note: "fixed in PR" });

  // Gate parked it in qa with a verification child: QA evidence link is the open child.
  let row = boardBug(org.id, bug.id);
  assert.equal(row.status, "done");
  assert.equal(row.stage, "qa");
  assert.equal(row.verified_via, null);
  assert.ok(row.verification_task_id, "open verification rides the bug card");

  // QA passes the verification: the bug becomes VERIFIED with the evidence linked.
  const verification = store.getTask(row.verification_task_id);
  store.claimTask({ agentId: agent.id, taskId: verification.id });
  store.updateTaskStatus({ agentId: agent.id, taskId: verification.id, status: "done", note: "acceptance holds" });

  row = boardBug(org.id, bug.id);
  assert.equal(row.stage, "rc"); // verified work parks in Release Candidate until a tag ships it
  assert.equal(row.verified_via, verification.id, "QA evidence is the done verification");
  assert.equal(row.verification_task_id, null);
});

test("non-bug tasks don't pay for (or carry) the bug lifecycle fields", () => {
  const { org, project, agent } = setup("bugsv2-b");
  const feat = store.createTask({
    projectId: project.id, orgId: org.id, agentId: agent.id,
    title: "Feature: add a lane", tags: ["panel"],
  });
  const row = boardBug(org.id, feat.id);
  assert.ok(!("verified_via" in row), "bug lifecycle fields are bug-only");
});
