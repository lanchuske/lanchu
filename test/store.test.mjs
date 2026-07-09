import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;
process.env.LANCHU_STALE_HOURS = "24";

const store = await import("../dist/core/store.js");
const { ScopeError } = await import("../dist/core/types.js");

function setup(orgName) {
  const org = store.getOrCreateOrg(orgName);
  const project = store.getOrCreateProject(org.id, "web");
  const role = store.getOrCreateRole(org.id, "frontend", { tags: ["ui", "css"] });
  const agent = store.createAgent({ orgId: org.id, roleId: role.id, objective: "fix login page" });
  return { org, project, role, agent };
}

test("in-scope task can be created and claimed", () => {
  const { org, project, agent } = setup("acme1");
  const t = store.createTask({
    projectId: project.id,
    orgId: org.id,
    agentId: agent.id,
    title: "style the form",
    tags: ["ui"],
  });
  assert.equal(t.status, "available");
  const claimed = store.claimTask({ agentId: agent.id, taskId: t.id });
  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.owner_agent_id, agent.id);
});

test("out-of-scope task creation is blocked (hard block)", () => {
  const { org, project, agent } = setup("acme2");
  assert.throws(
    () =>
      store.createTask({
        projectId: project.id,
        orgId: org.id,
        agentId: agent.id,
        title: "db migration",
        tags: ["backend"],
      }),
    (err) => err instanceof ScopeError,
  );
});

test("atomic claim: a second claim on a taken task fails", () => {
  const { org, project, role, agent } = setup("acme3");
  const other = store.createAgent({ orgId: org.id, roleId: role.id, objective: "help" });
  const t = store.createTask({
    projectId: project.id,
    orgId: org.id,
    agentId: agent.id,
    title: "hero section",
    tags: ["ui"],
  });
  store.claimTask({ agentId: agent.id, taskId: t.id });
  assert.throws(() => store.claimTask({ agentId: other.id, taskId: t.id }));
});

test("reuse candidates match by objective footprint", () => {
  const { org, agent } = setup("acme4");
  store.endSessionsForAgent(agent.id); // becomes idle
  const candidates = store.findReuseCandidates(org.id, "the login page is broken");
  assert.ok(candidates.some((c) => c.agent.id === agent.id));
});

test("safe retirement blocks while open tasks exist, then succeeds", () => {
  const { org, project, agent } = setup("acme5");
  const t = store.createTask({
    projectId: project.id,
    orgId: org.id,
    agentId: agent.id,
    title: "navbar",
    tags: ["ui"],
  });
  store.claimTask({ agentId: agent.id, taskId: t.id });
  const blocked = store.retireAgent(agent.id);
  assert.equal(blocked.retired, false);
  assert.equal(blocked.blockedBy.length, 1);

  store.releaseTask({ agentId: null, taskId: t.id, override: true });
  const ok = store.retireAgent(agent.id);
  assert.equal(ok.retired, true);
});

test("doc upsert creates then updates", () => {
  const { org, agent } = setup("acme6");
  const created = store.upsertDoc({ orgId: org.id, agentId: agent.id, title: "Notes", content: "a" });
  const updated = store.upsertDoc({ orgId: org.id, agentId: agent.id, title: "Notes", content: "b" });
  assert.equal(created.id, updated.id);
  assert.equal(updated.content, "b");
});

test("audit log records events with resolved actor names", () => {
  const { org, project, agent } = setup("acme7");
  const t = store.createTask({ projectId: project.id, orgId: org.id, agentId: agent.id, title: "audit me", tags: ["ui"] });
  store.claimTask({ agentId: agent.id, taskId: t.id });
  const audit = store.listAuditEvents(org.id, 50);
  assert.ok(audit.length >= 2);
  assert.ok(audit.some((e) => e.type === "task.claimed" && e.actor_name === agent.name));
});

test("board enriches agents (role, open count, workspace) and task owner name", () => {
  const { org, project, agent } = setup("acme8");
  const t = store.createTask({ projectId: project.id, orgId: org.id, agentId: agent.id, title: "enrich", tags: ["ui"] });
  store.claimTask({ agentId: agent.id, taskId: t.id, workspace: "feat/x" });
  const b = store.boardSnapshot(org.id);
  const ba = b.agents.find((a) => a.id === agent.id);
  assert.equal(ba.role_name, "frontend");
  assert.equal(ba.open_tasks, 1);
  assert.equal(ba.workspace, "feat/x");
  const bt = b.tasks.find((x) => x.id === t.id);
  assert.equal(bt.owner_name, agent.name);
});
