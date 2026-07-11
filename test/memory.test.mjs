import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-memory-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;

const store = await import("../dist/core/store.js");

function setup(orgName) {
  const org = store.getOrCreateOrg(orgName);
  const project = store.getOrCreateProject(org.id, "core");
  const role = store.getOrCreateRole(org.id, "generalist", { wildcard: true });
  const agent = store.createAgent({ orgId: org.id, roleId: role.id, name: "builder" });
  return { org, project, role, agent };
}

test("memory_set upserts by scope+subject+key, audits, and records the writer", () => {
  const { org, agent } = setup("mem1");
  const first = store.memorySet({
    orgId: org.id, scope: "agent", subjectId: agent.id,
    key: "flaky:worktree", value: "worktree tests flake on CI", actorAgentId: agent.id,
  });
  const second = store.memorySet({
    orgId: org.id, scope: "agent", subjectId: agent.id,
    key: "flaky:worktree", value: "fixed since PR #11", actorAgentId: agent.id,
  });
  assert.equal(second.id, first.id, "same key updates in place");
  assert.equal(second.value, "fixed since PR #11");
  assert.equal(second.source_ref, agent.id, "agent-written entries carry their author");

  const ev = store.listAuditEvents(org.id).find((e) => e.type === "memory.written");
  assert.ok(ev, "writes are audited");
  assert.equal(ev.data.key, "flaky:worktree");
});

test("memoryGet filters by scope/subject/query; caps evict oldest-updated first", () => {
  const { org, agent } = setup("mem2");
  for (let i = 0; i < 55; i++) {
    store.memorySet({
      orgId: org.id, scope: "agent", subjectId: agent.id,
      key: `k${i}`, value: `learning number ${i}`, actorAgentId: agent.id,
    });
  }
  const all = store.memoryGet(org.id, { scope: "agent", subjectId: agent.id });
  assert.equal(all.length, 50, "agent scope is capped at 50 (LRU)");
  assert.equal(all.some((m) => m.key === "k0"), false, "oldest evicted");
  assert.equal(all.some((m) => m.key === "k54"), true, "newest kept");

  const hits = store.memoryGet(org.id, { query: "number 54" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].key, "k54");
});

test("org_context injection: own + project + org memories, capped, compact", () => {
  const { org, project, agent } = setup("mem3");
  store.memorySet({ orgId: org.id, scope: "agent", subjectId: agent.id, key: "a", value: "mine", actorAgentId: agent.id });
  store.memorySet({ orgId: org.id, scope: "project", subjectId: project.id, key: "p", value: "ours" });
  store.memorySet({ orgId: org.id, scope: "org", subjectId: org.id, key: "o", value: "everyone's" });
  // Another agent's memories must NOT leak into this agent's context block.
  const other = store.createAgent({ orgId: org.id, roleId: agent.role_id, name: "other" });
  store.memorySet({ orgId: org.id, scope: "agent", subjectId: other.id, key: "x", value: "theirs", actorAgentId: other.id });

  const block = store.memoriesForContext(org.id, agent.id, project.id);
  const keys = block.map((m) => m.key).sort();
  assert.deepEqual(keys, ["a", "o", "p"]);
  for (const m of block) assert.deepEqual(Object.keys(m).sort(), ["key", "scope", "value"], "compact shape");

  for (let i = 0; i < 30; i++) {
    store.memorySet({ orgId: org.id, scope: "org", subjectId: org.id, key: `bulk${i}`, value: "filler" });
  }
  assert.equal(store.memoriesForContext(org.id, agent.id, project.id).length, 15, "capped at 15");
});

test("Layer 1: completing a task with a PR distills a project memory", () => {
  const { org, project, agent } = setup("mem4");
  const t = store.createTask({ projectId: project.id, orgId: org.id, agentId: agent.id, title: "ship the thing", tags: [] });
  store.claimTask({ agentId: agent.id, taskId: t.id });
  store.updateTaskStatus({
    agentId: agent.id, taskId: t.id, status: "done",
    prUrl: "https://github.com/x/y/pull/9",
  });
  const entries = store.memoryGet(org.id, { scope: "project", subjectId: project.id });
  const pr = entries.find((m) => m.key === `pr:${t.id}`);
  assert.ok(pr, "pr memory distilled");
  assert.match(pr.value, /pull\/9 addressed: ship the thing/);
  assert.equal(pr.source, "event");
});

test("Layer 1: a role change distills an org memory with before/after", () => {
  const { org } = setup("mem5");
  store.defineRole(org.id, "backend", { tags: ["server"] });
  store.updateRole(org.id, "backend", { addTags: ["db"] });
  const entries = store.memoryGet(org.id, { scope: "org", subjectId: org.id });
  const rm = entries.find((m) => m.key === "role:backend");
  assert.ok(rm, "role memory distilled");
  assert.match(rm.value, /scope changed/);
});

test("Layer 1: repeated conflicts on a tag distill a hot-zone project memory", () => {
  const { org, project, role, agent } = setup("mem6");
  const rival = store.createAgent({ orgId: org.id, roleId: role.id, name: "rival" });
  // Three rounds of overlapping claimed work on the same tag.
  for (let i = 0; i < 3; i++) {
    const theirs = store.createTask({ projectId: project.id, orgId: org.id, agentId: rival.id, title: `their work ${i}`, tags: ["panel"] });
    store.claimTask({ agentId: rival.id, taskId: theirs.id });
    const mine = store.createTask({ projectId: project.id, orgId: org.id, agentId: agent.id, title: `my work ${i}`, tags: ["panel"] });
    store.warnWorkConflicts({ orgId: org.id, agentId: agent.id, taskId: mine.id, tags: ["panel"] });
  }
  const entries = store.memoryGet(org.id, { scope: "project", subjectId: project.id });
  const hot = entries.find((m) => m.key === "hot-zone:panel");
  assert.ok(hot, "hot-zone memory distilled after threshold");
  assert.match(hot.value, /panel/);
});

test("memoryDelete removes the entry and leaves an audited snapshot", () => {
  const { org, agent } = setup("mem-del");
  const entry = store.memorySet({
    orgId: org.id, scope: "org", subjectId: org.id,
    key: "test:delete", value: "to be removed", actorAgentId: agent.id,
  });
  assert.equal(store.memoryDelete(org.id, entry.id, agent.id), true);
  assert.ok(!store.memoryGet(org.id).find((m) => m.id === entry.id), "entry gone");
  const ev = store.listAuditEvents(org.id, 20).find((e) => e.type === "memory.deleted");
  assert.ok(ev, "deletion audited");
  assert.equal(ev.data.key, "test:delete");
  assert.equal(ev.data.value, "to be removed");
  assert.equal(store.memoryDelete(org.id, "no-such-id"), false, "unknown id is a no-op");
});
