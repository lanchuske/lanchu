import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-comms-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;
delete process.env.LANCHU_SDLC; // default mode: assist

const store = await import("../dist/core/store.js");

function setup(orgName) {
  const org = store.getOrCreateOrg(orgName);
  const project = store.getOrCreateProject(org.id, "core");
  const product = store.createAgent({
    orgId: org.id, roleId: store.getOrCreateRole(org.id, "product", { wildcard: true }).id, name: "product",
  });
  const builder = store.createAgent({
    orgId: org.id, roleId: store.getOrCreateRole(org.id, "generalist", { wildcard: true }).id, name: "builder",
  });
  const qa = store.createAgent({
    orgId: org.id, roleId: store.getOrCreateRole(org.id, "qa", { wildcard: true }).id, name: "qa",
  });
  // A distribution lane: explicit-tag role (NOT wildcard) held by web.
  const webRole = store.getOrCreateRole(org.id, "web", { tags: ["distribution", "docs", "content"] });
  const web = store.createAgent({ orgId: org.id, roleId: webRole.id, name: "web" });
  return { org, project, product, builder, qa, web };
}

function ship(ctx, title, tags) {
  const task = store.createTask({
    projectId: ctx.project.id, orgId: ctx.org.id, agentId: ctx.product.id, title, tags, stage: "build",
  });
  store.claimTask({ agentId: ctx.builder.id, taskId: task.id });
  store.updateTaskStatus({ agentId: ctx.builder.id, taskId: task.id, status: "done" });
  return store.getTask(task.id);
}

const commsChildren = (projectId, parentId) =>
  store.listTasks(projectId).filter((t) => t.parent_task_id === parentId && t.title.startsWith("Communicate "));

test("QA pass on a user-facing task queues ONE comms task in the distribution lane", () => {
  const ctx = setup("comms-gate-org");
  const task = ship(ctx, "Panel: shiny new graph view", ["server", "user-facing"]);
  assert.equal(commsChildren(ctx.project.id, task.id).length, 0, "not before verification");

  const verification = store.openVerificationTaskFor(task.id);
  store.claimTask({ agentId: ctx.qa.id, taskId: verification.id });
  store.updateTaskStatus({ agentId: ctx.qa.id, taskId: verification.id, status: "done", note: "pass" });

  const comms = commsChildren(ctx.project.id, task.id);
  assert.equal(comms.length, 1);
  assert.equal(comms[0].status, "available");
  assert.equal(comms[0].stage, "build");
  assert.deepEqual([...comms[0].tags].sort(), ["distribution", "docs"], "lands in the distribution lane");
  assert.match(comms[0].title, /changelog entry/);
  assert.match(comms[0].title, /distribution pause governs publishing/);

  // The distribution-lane agent hears it; a second pass never duplicates.
  const heard = store.takeUndeliveredNotices(ctx.web.id);
  assert.ok(heard.some((n) => /queues its comms/.test(n.body) && n.ref === comms[0].id));
  store.updateTaskStatus({ agentId: ctx.builder.id, taskId: task.id, status: "done" });
  assert.equal(commsChildren(ctx.project.id, task.id).length, 1, "deduped");
});

test("tasks without the user-facing tag ship silently", () => {
  const ctx = setup("comms-silent-org");
  const task = ship(ctx, "Refactor internals", ["server"]);
  const verification = store.openVerificationTaskFor(task.id);
  store.claimTask({ agentId: ctx.qa.id, taskId: verification.id });
  store.updateTaskStatus({ agentId: ctx.qa.id, taskId: verification.id, status: "done", note: "pass" });
  assert.equal(commsChildren(ctx.project.id, task.id).length, 0);
});

test("gate off: plain done still queues the comms task", () => {
  process.env.LANCHU_SDLC = "off";
  try {
    const ctx = setup("comms-off-org");
    const task = ship(ctx, "CLI: new command users will love", ["cli", "user-facing"]);
    assert.equal(task.stage, "done");
    assert.equal(commsChildren(ctx.project.id, task.id).length, 1);
  } finally {
    delete process.env.LANCHU_SDLC;
  }
});

test("the verification task carries the docs/learnings checklist (the nudge that used to scroll away)", () => {
  const ctx = setup("comms-checklist-org");
  const task = ship(ctx, "Any old feature", ["server"]);
  const verification = store.openVerificationTaskFor(task.id);
  assert.match(verification.title, /^QA: verify/);
  assert.match(verification.title, /Checklist: \(1\) acceptance criteria hold; \(2\) docs updated .*doc_update.*; \(3\) learnings persisted/);
});

test("the release checklist aggregates comms tasks into its release-notes line", () => {
  const ctx = setup("comms-release-org");
  const task = ship(ctx, "User-visible thing", ["server", "user-facing"]);
  const verification = store.openVerificationTaskFor(task.id);
  store.claimTask({ agentId: ctx.qa.id, taskId: verification.id });
  store.updateTaskStatus({ agentId: ctx.qa.id, taskId: verification.id, status: "done", note: "pass" });
  const comms = commsChildren(ctx.project.id, task.id)[0];

  const { created } = store.runReleaseSweep({
    releaseInfo: (p) =>
      p.id === ctx.project.id
        ? { lastTag: "v9.9.9", unreleased: 6, oldestIso: new Date(Date.now() - 3_600_000).toISOString() }
        : null,
  });
  assert.equal(created.length, 1);
  const checklist = store.getTask(created[0]);
  assert.match(checklist.title, new RegExp(`Release notes: aggregate from .*${comms.id}`));
});
