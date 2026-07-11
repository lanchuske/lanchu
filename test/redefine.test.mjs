import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-redefine-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;

const store = await import("../dist/core/store.js");
const storeTypes = await import("../dist/core/types.js");
const { ScopeError } = storeTypes;

function setup(orgName) {
  const org = store.getOrCreateOrg(orgName);
  const project = store.getOrCreateProject(org.id, "core");
  const role = store.getOrCreateRole(org.id, "generalist", { wildcard: true });
  const creator = store.createAgent({ orgId: org.id, roleId: role.id, name: "definer" });
  const other = store.createAgent({ orgId: org.id, roleId: role.id, name: "other" });
  return { org, project, role, creator, other };
}

function mkTask(ctx, title, stage) {
  return store.createTask({
    projectId: ctx.project.id, orgId: ctx.org.id, agentId: ctx.creator.id,
    title, tags: [], stage,
  });
}

test("the creator refines a definition-stage title in place; identity and audit survive", () => {
  const ctx = setup("redef-a");
  const t = mkTask(ctx, "vague idea", "definition");
  const updated = store.redefineTask({ taskId: t.id, title: "Precise definition with acceptance criteria", byAgentId: ctx.creator.id });
  assert.equal(updated.id, t.id, "same task — identity survives");
  assert.equal(updated.title, "Precise definition with acceptance criteria");
  assert.equal(store.redefineCounts(ctx.org.id).get(t.id), 1);
});

test("backlog (null stage) is editable too; build+ stages reject", () => {
  const ctx = setup("redef-b");
  const backlog = mkTask(ctx, "backlog seed");
  assert.equal(store.redefineTask({ taskId: backlog.id, title: "backlog seed, refined", byAgentId: ctx.creator.id }).title, "backlog seed, refined");

  const building = mkTask(ctx, "already building", "build");
  assert.throws(
    () => store.redefineTask({ taskId: building.id, title: "too late", byAgentId: ctx.creator.id }),
    /definition\/backlog/,
  );
});

test("a stranger cannot redefine; the coordinator lease holder can; the owner is noticed", () => {
  const ctx = setup("redef-c");
  const t = mkTask(ctx, "someone's brief", "definition");
  assert.throws(
    () => store.redefineTask({ taskId: t.id, title: "hijack", byAgentId: ctx.other.id }),
    (err) => err instanceof ScopeError,
  );

  // Owner claims it; the coordinator then refines it — the owner hears about it.
  store.claimTask({ agentId: ctx.other.id, taskId: t.id });
  store.coordinatorAcquire({ orgId: ctx.org.id, agentId: ctx.creator.id });
  store.takeUndeliveredNotices(ctx.other.id);
  store.redefineTask({ taskId: t.id, title: "matured brief", byAgentId: ctx.creator.id });
  const heard = store.takeUndeliveredNotices(ctx.other.id);
  assert.ok(heard.some((n) => /redefined.*matured brief/s.test(n.body)), "owner is told to re-read");
});

test("the audit event preserves the old title (definition history)", () => {
  const ctx = setup("redef-d");
  const t = mkTask(ctx, "v1 of the idea", "definition");
  store.redefineTask({ taskId: t.id, title: "v2 of the idea", byAgentId: ctx.creator.id });
  const events = store.listAuditEvents(ctx.org.id, 50);
  const ev = events.find((e) => e.type === "task.redefined" && e.subject_id === t.id);
  assert.ok(ev, "task.redefined audited");
  assert.equal(ev.data.from_title, "v1 of the idea");
  assert.equal(ev.data.to_title, "v2 of the idea");
});

test("no-op titles record nothing; archived tasks refuse; empty titles refuse", () => {
  const ctx = setup("redef-e");
  const t = mkTask(ctx, "stable", "definition");
  store.redefineTask({ taskId: t.id, title: "stable", byAgentId: ctx.creator.id });
  assert.equal(store.redefineCounts(ctx.org.id).get(t.id), undefined);
  assert.throws(() => store.redefineTask({ taskId: t.id, title: "  ", byAgentId: ctx.creator.id }), /empty/);
  store.archiveTask({ taskId: t.id, override: true });
  assert.throws(() => store.redefineTask({ taskId: t.id, title: "zombie edit", override: true }), /archived/);
});
