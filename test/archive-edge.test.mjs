import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-archive-edge-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;

const store = await import("../dist/core/store.js");

function setup(orgName) {
  const org = store.getOrCreateOrg(orgName);
  const project = store.getOrCreateProject(org.id, "web");
  const role = store.getOrCreateRole(org.id, "generalist", { wildcard: true });
  const agent = store.createAgent({ orgId: org.id, roleId: role.id, objective: "build things" });
  return { org, project, role, agent };
}

function mkTask(ctx, title, opts = {}) {
  return store.createTask({
    projectId: ctx.project.id,
    orgId: ctx.org.id,
    agentId: opts.agentId ?? ctx.agent.id,
    title,
    tags: opts.tags ?? [],
    deps: opts.deps ?? [],
  });
}

// ── supersede when the successor itself depended on the old task ─
// The retarget rewrites every dep old → new; if the successor carried a dep on
// the old task (v2 "builds on" v1), a blind rewrite would leave it depending
// on itself — blocked forever. Found as an uncovered edge in QA of PR #67.

test("supersede never creates a self-dependency on the successor", () => {
  const ctx = setup("archedge1");
  const oldT = mkTask(ctx, "feedback loop v1");
  const newT = mkTask(ctx, "feedback loop v2", { deps: [oldT.id] });
  const third = mkTask(ctx, "waits on v1", { deps: [oldT.id] });
  store.supersedeTask({ oldTaskId: oldT.id, newTaskId: newT.id, byAgentId: ctx.agent.id });
  // the successor must be workable, not waiting on itself or a tombstone
  assert.equal(store.getTask(newT.id).status, "available");
  store.claimTask({ agentId: ctx.agent.id, taskId: newT.id });
  // the bystander dependent now waits on the successor instead
  store.claimTask({ agentId: ctx.agent.id, taskId: third.id });
  store.updateTaskStatus({ agentId: ctx.agent.id, taskId: third.id, status: "blocked" });
  process.env.LANCHU_SDLC = "off";
  try {
    store.updateTaskStatus({ agentId: ctx.agent.id, taskId: newT.id, status: "done" });
  } finally {
    delete process.env.LANCHU_SDLC;
  }
  assert.equal(store.getTask(third.id).status, "available");
});

test("superseding a task with duplicate dep rows collapses them instead of failing", () => {
  const ctx = setup("archedge2");
  const oldT = mkTask(ctx, "v1");
  const newT = mkTask(ctx, "v2");
  // dependent waits on BOTH old and new: the retarget of old → new would
  // collide with the existing (dep, new) row — UPDATE OR IGNORE must absorb it.
  const dep = mkTask(ctx, "waits on both", { deps: [oldT.id, newT.id] });
  const archived = store.supersedeTask({ oldTaskId: oldT.id, newTaskId: newT.id, byAgentId: ctx.agent.id });
  assert.ok(archived.archived_at);
  store.claimTask({ agentId: ctx.agent.id, taskId: dep.id });
  store.updateTaskStatus({ agentId: ctx.agent.id, taskId: dep.id, status: "blocked" });
  process.env.LANCHU_SDLC = "off";
  try {
    store.claimTask({ agentId: ctx.agent.id, taskId: newT.id });
    store.updateTaskStatus({ agentId: ctx.agent.id, taskId: newT.id, status: "done" });
  } finally {
    delete process.env.LANCHU_SDLC;
  }
  assert.equal(store.getTask(dep.id).status, "available", "no ghost dep on the archived task may remain");
});
