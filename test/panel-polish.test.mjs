import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-panel-polish-test-" + process.pid);
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

function mkTask(ctx, title) {
  return store.createTask({
    projectId: ctx.project.id,
    orgId: ctx.org.id,
    agentId: ctx.agent.id,
    title,
    tags: [],
  });
}

// ── active-task pick order (PR #72): in_progress > claimed, blocked is parked ─

test("boardSnapshot activeTask prefers in_progress over claimed and never shows blocked", () => {
  const ctx = setup("polish1");
  const tBlocked = mkTask(ctx, "blocked tombstone");
  const tClaimed = mkTask(ctx, "merely claimed");
  const tProg = mkTask(ctx, "actively building");
  for (const t of [tBlocked, tClaimed, tProg]) store.claimTask({ agentId: ctx.agent.id, taskId: t.id });
  store.updateTaskStatus({ agentId: ctx.agent.id, taskId: tBlocked.id, status: "blocked" });
  store.updateTaskStatus({ agentId: ctx.agent.id, taskId: tProg.id, status: "in_progress" });

  const me = () => store.boardSnapshot(ctx.org.id).agents.find((a) => a.id === ctx.agent.id);
  assert.equal(me().active_task_id, tProg.id, "in_progress wins");

  process.env.LANCHU_SDLC = "off";
  try {
    store.updateTaskStatus({ agentId: ctx.agent.id, taskId: tProg.id, status: "done" });
    assert.equal(me().active_task_id, tClaimed.id, "claimed is next");
    store.updateTaskStatus({ agentId: ctx.agent.id, taskId: tClaimed.id, status: "done" });
    assert.equal(me().active_task_id, null, "a blocked task is parked, not active");
  } finally {
    delete process.env.LANCHU_SDLC;
  }
});

// ── audit subject resolution (PR #72): the panel must never show raw ids ─────

test("listAuditEvents resolves agent subjects to names and memory subjects to keys", () => {
  const ctx = setup("polish2");
  const subjectAgent = store.createAgent({ orgId: ctx.org.id, roleId: ctx.role.id, objective: "to retire" });
  store.retireAgent(subjectAgent.id);

  const events = store.listAuditEvents(ctx.org.id, 50);
  const retired = events.find((e) => e.type === "agent.retired" && e.subject_id === subjectAgent.id);
  assert.ok(retired, "agent.retired event recorded");
  assert.equal(retired.subject_agent_name, subjectAgent.name);

  store.memorySet({
    orgId: ctx.org.id,
    scope: "agent",
    subjectId: ctx.agent.id,
    key: "note:polish",
    value: "a learning",
    actorAgentId: ctx.agent.id,
  });
  const memEv = store
    .listAuditEvents(ctx.org.id, 50)
    .find((e) => e.subject_kind === "memory" && e.subject_memory_key === "note:polish");
  assert.ok(memEv, "memory event carries its key, not just the uuid");
});
