import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-archive-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;

const store = await import("../dist/core/store.js");
const storeTypes = await import("../dist/core/types.js");
const { ScopeError } = storeTypes;

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

// ── archive basics ──────────────────────────────────────────────

test("supervisor override archives a task; it leaves listTasks and enters listArchivedTasks", () => {
  const ctx = setup("arch1");
  const t = mkTask(ctx, "old tombstone");
  const archived = store.archiveTask({ taskId: t.id, reason: "board hygiene", override: true });
  assert.ok(archived.archived_at);
  assert.equal(archived.archived_reason, "board hygiene");
  assert.ok(!store.listTasks(ctx.project.id).some((x) => x.id === t.id));
  const arch = store.listArchivedTasks(ctx.project.id);
  assert.ok(arch.some((x) => x.id === t.id));
  // the row is still there — never hard-deleted
  assert.ok(store.getTask(t.id));
});

test("archive is idempotent and keeps the original stamp", () => {
  const ctx = setup("arch2");
  const t = mkTask(ctx, "junk");
  const first = store.archiveTask({ taskId: t.id, reason: "junk", override: true });
  const second = store.archiveTask({ taskId: t.id, reason: "different reason", override: true });
  assert.equal(second.archived_at, first.archived_at);
  assert.equal(second.archived_reason, "junk");
});

test("archived tasks are terminal: claim/update/release/reject all refuse", () => {
  const ctx = setup("arch3");
  const t = mkTask(ctx, "terminal check");
  store.archiveTask({ taskId: t.id, override: true });
  assert.throws(() => store.claimTask({ agentId: ctx.agent.id, taskId: t.id }), /archived/);
  assert.throws(
    () => store.updateTaskStatus({ agentId: ctx.agent.id, taskId: t.id, status: "in_progress" }),
    /archived/,
  );
  assert.throws(() => store.releaseTask({ agentId: ctx.agent.id, taskId: t.id }), /archived/);
  assert.throws(
    () => store.rejectTask({ agentId: ctx.agent.id, taskId: t.id, reason: "other", note: "x" }),
    /archived/,
  );
});

test("boardSnapshot hides archived tasks from lanes and carries them in `archived`", () => {
  const ctx = setup("arch4");
  const live = mkTask(ctx, "live work");
  const dead = mkTask(ctx, "dead probe");
  store.archiveTask({ taskId: dead.id, reason: "probe", override: true });
  const snap = store.boardSnapshot(ctx.org.id);
  assert.ok(snap.tasks.some((x) => x.id === live.id));
  assert.ok(!snap.tasks.some((x) => x.id === dead.id));
  assert.ok(snap.archived.some((x) => x.id === dead.id));
});

// ── permissions ─────────────────────────────────────────────────

test("a plain agent cannot archive someone's real task (ScopeError, audited)", () => {
  const ctx = setup("arch5");
  const other = store.createAgent({ orgId: ctx.org.id, roleId: ctx.role.id, objective: "other" });
  const t = mkTask(ctx, "real definition", { agentId: other.id });
  assert.throws(
    () => store.archiveTask({ taskId: t.id, byAgentId: ctx.agent.id }),
    (err) => err instanceof ScopeError,
  );
});

test("the creator can archive their own probe task", () => {
  const ctx = setup("arch6");
  const t = mkTask(ctx, "QA probe task — safe to delete");
  const archived = store.archiveTask({ taskId: t.id, byAgentId: ctx.agent.id, reason: "probe done" });
  assert.ok(archived.archived_at);
});

test("the creator cannot archive their own NON-probe task", () => {
  const ctx = setup("arch7");
  const t = mkTask(ctx, "a real feature definition");
  assert.throws(
    () => store.archiveTask({ taskId: t.id, byAgentId: ctx.agent.id }),
    (err) => err instanceof ScopeError,
  );
});

test("the coordinator lease holder can archive any task", () => {
  const ctx = setup("arch8");
  const other = store.createAgent({ orgId: ctx.org.id, roleId: ctx.role.id, objective: "other" });
  const t = mkTask(ctx, "somebody's task", { agentId: other.id });
  store.coordinatorAcquire({ orgId: ctx.org.id, agentId: ctx.agent.id });
  const archived = store.archiveTask({ taskId: t.id, byAgentId: ctx.agent.id, reason: "coordinator sweep" });
  assert.ok(archived.archived_at);
});

test("the product role can archive any task", () => {
  const ctx = setup("arch9");
  const productRole = store.getOrCreateRole(ctx.org.id, "product", { wildcard: true });
  const pm = store.createAgent({ orgId: ctx.org.id, roleId: productRole.id, objective: "define" });
  const t = mkTask(ctx, "obsolete definition");
  const archived = store.archiveTask({ taskId: t.id, byAgentId: pm.id, reason: "obsolete" });
  assert.ok(archived.archived_at);
});

// task-mrgpb0a15: the accountable OWNER of a claimed task can resolve it —
// same trust level task_reject and task_update(done) already give owners —
// even when they are neither its creator nor holding the coordinator lease.
test("the owner of a claimed (non-probe) task can archive it, without being its creator or coordinator", () => {
  const ctx = setup("arch9b");
  const creator = store.createAgent({ orgId: ctx.org.id, roleId: ctx.role.id, objective: "files work" });
  const owner = store.createAgent({ orgId: ctx.org.id, roleId: ctx.role.id, objective: "does work" });
  const t = mkTask(ctx, "a real feature definition", { agentId: creator.id });
  store.claimTask({ agentId: owner.id, taskId: t.id });
  const archived = store.archiveTask({ taskId: t.id, byAgentId: owner.id, reason: "resolved, evidence attached" });
  assert.ok(archived.archived_at);
});

test("an agent who is neither owner, creator, nor coordinator still cannot archive it", () => {
  const ctx = setup("arch9c");
  const creator = store.createAgent({ orgId: ctx.org.id, roleId: ctx.role.id, objective: "files work" });
  const owner = store.createAgent({ orgId: ctx.org.id, roleId: ctx.role.id, objective: "does work" });
  const stranger = store.createAgent({ orgId: ctx.org.id, roleId: ctx.role.id, objective: "uninvolved" });
  const t = mkTask(ctx, "a real feature definition", { agentId: creator.id });
  store.claimTask({ agentId: owner.id, taskId: t.id });
  assert.throws(
    () => store.archiveTask({ taskId: t.id, byAgentId: stranger.id }),
    (err) => err instanceof ScopeError,
  );
});

// ── supersede ───────────────────────────────────────────────────

test("supersede archives old with a link to new and retargets dependents", () => {
  const ctx = setup("arch10");
  const oldT = mkTask(ctx, "feedback loop v1");
  const dep = mkTask(ctx, "depends on v1", { deps: [oldT.id] });
  const newT = mkTask(ctx, "feedback loop v2");
  const archived = store.supersedeTask({
    oldTaskId: oldT.id,
    newTaskId: newT.id,
    byAgentId: ctx.agent.id, // creator of the old task
    note: "v2 replaces it",
  });
  assert.ok(archived.archived_at);
  assert.equal(archived.superseded_by_task_id, newT.id);
  // dependent now waits on the successor: completing newT must unblock it
  store.claimTask({ agentId: ctx.agent.id, taskId: dep.id });
  store.updateTaskStatus({ agentId: ctx.agent.id, taskId: dep.id, status: "blocked" });
  process.env.LANCHU_SDLC = "off";
  try {
    store.claimTask({ agentId: ctx.agent.id, taskId: newT.id });
    store.updateTaskStatus({ agentId: ctx.agent.id, taskId: newT.id, status: "done" });
  } finally {
    delete process.env.LANCHU_SDLC;
  }
  assert.equal(store.getTask(dep.id).status, "available");
});

test("a task cannot supersede itself, and an archived task cannot supersede", () => {
  const ctx = setup("arch11");
  const a = mkTask(ctx, "task a");
  const b = mkTask(ctx, "task b");
  assert.throws(() => store.supersedeTask({ oldTaskId: a.id, newTaskId: a.id, override: true }), /itself/);
  store.archiveTask({ taskId: b.id, override: true });
  assert.throws(() => store.supersedeTask({ oldTaskId: a.id, newTaskId: b.id, override: true }), /archived/);
});

test("a random agent cannot supersede someone else's task", () => {
  const ctx = setup("arch12");
  const other = store.createAgent({ orgId: ctx.org.id, roleId: ctx.role.id, objective: "other" });
  const oldT = mkTask(ctx, "not yours", { agentId: other.id });
  const stranger = store.createAgent({ orgId: ctx.org.id, roleId: ctx.role.id, objective: "stranger" });
  const newT = mkTask(ctx, "replacement", { agentId: other.id });
  assert.throws(
    () => store.supersedeTask({ oldTaskId: oldT.id, newTaskId: newT.id, byAgentId: stranger.id }),
    (err) => err instanceof ScopeError,
  );
});

// task-mrgpb0a15 (builder-gov-3, 2026-07-11 18:30): resolving a task per
// product's instruction ("supersede it against wake v5 with evidence") was
// blocked because the owner wasn't its creator and the coordinator lease was
// held elsewhere — needed a product round-trip just to close it out.
test("the owner (not the creator) of a claimed task can supersede it", () => {
  const ctx = setup("arch12b");
  const creator = store.createAgent({ orgId: ctx.org.id, roleId: ctx.role.id, objective: "files work" });
  const owner = store.createAgent({ orgId: ctx.org.id, roleId: ctx.role.id, objective: "does work" });
  const oldT = mkTask(ctx, "wake v5 draft", { agentId: creator.id });
  store.claimTask({ agentId: owner.id, taskId: oldT.id });
  const newT = mkTask(ctx, "wake v5.1, with evidence", { agentId: creator.id });
  const archived = store.supersedeTask({
    oldTaskId: oldT.id,
    newTaskId: newT.id,
    byAgentId: owner.id, // owner, NOT the creator, NOT the coordinator
    note: "superseded against v5.1 with drill evidence",
  });
  assert.ok(archived.archived_at);
  assert.equal(archived.superseded_by_task_id, newT.id);
});

// ── archived dependencies never block ───────────────────────────

test("archiving a dependency unblocks its dependents", () => {
  const ctx = setup("arch13");
  const depOn = mkTask(ctx, "will be junked");
  const t = mkTask(ctx, "waits on junk", { deps: [depOn.id] });
  store.claimTask({ agentId: ctx.agent.id, taskId: t.id });
  store.updateTaskStatus({ agentId: ctx.agent.id, taskId: t.id, status: "blocked" });
  store.archiveTask({ taskId: depOn.id, reason: "junk", override: true });
  assert.equal(store.getTask(t.id).status, "available");
});

// ── QA probe auto-archive ───────────────────────────────────────

test("retiring a qa agent auto-archives its probe fixtures", () => {
  const ctx = setup("arch14");
  const qaRole = store.getOrCreateRole(ctx.org.id, "qa", { wildcard: true });
  const qa = store.createAgent({ orgId: ctx.org.id, roleId: qaRole.id, objective: "verify" });
  const probe = mkTask(ctx, "QA b3 probe — safe to delete", { agentId: qa.id });
  const real = mkTask(ctx, "QA regression suite for release", { agentId: qa.id });
  const r = store.retireAgent(qa.id);
  assert.equal(r.retired, true);
  assert.ok(store.getTask(probe.id).archived_at, "probe should be archived");
  assert.equal(store.getTask(real.id).archived_at, null, "real task must stay");
});

test("retiring a NON-qa agent leaves its probe-titled tasks alone", () => {
  const ctx = setup("arch15");
  const dev = store.createAgent({ orgId: ctx.org.id, roleId: ctx.role.id, objective: "dev" });
  const t = mkTask(ctx, "probe the flaky API", { agentId: dev.id });
  store.retireAgent(dev.id);
  assert.equal(store.getTask(t.id).archived_at, null);
});
