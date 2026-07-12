import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state (set before importing anything that opens the DB).
const dir = path.join(os.tmpdir(), "lanchu-shutdown-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;
process.env.LANCHU_GREENZONE_MIN_MS = "0";
process.env.LANCHU_SHUTDOWN_DELAY_MS = "0"; // don't make every test wait 2s
delete process.env.LANCHU_ACCESS_KEY;

const store = await import("../dist/core/store.js");
const gz = await import("../dist/core/greenzone.js");
const { createServer } = await import("../dist/server/server.js");

function setup(orgName) {
  const org = store.getOrCreateOrg(orgName);
  const project = store.getOrCreateProject(org.id, "core");
  const role = store.getOrCreateRole(org.id, "generalist", { wildcard: true });
  const a = store.createAgent({ orgId: org.id, roleId: role.id, name: "a" });
  const b = store.createAgent({ orgId: org.id, roleId: role.id, name: "b" });
  return { org, project, role, a, b };
}

// ── store-level: pure guard/notice logic (task-mrgjh7uk1) ──

test("shutdownBlockers reports every claimed/in_progress task org-wide, empty when clear", () => {
  const { org, project, a, b } = setup("sd-store-org");
  assert.deepEqual(store.shutdownBlockers(org.id), []);

  const t = store.createTask({ projectId: project.id, orgId: org.id, agentId: a.id, title: "in flight", tags: [] });
  store.claimTask({ agentId: b.id, taskId: t.id });
  const blocked = store.shutdownBlockers(org.id);
  assert.equal(blocked.length, 1);
  assert.deepEqual(blocked[0], { agent: "b", task_id: t.id, task_title: "in flight" });

  store.updateTaskStatus({ agentId: b.id, taskId: t.id, status: "done" });
  assert.deepEqual(store.shutdownBlockers(org.id), []);
});

test("noticeOrgShutdown queues one notice per non-retired agent, wording differs on retire", () => {
  const { org, a, b } = setup("sd-notice-org");
  store.retireAgent(b.id, { override: true });

  const n = store.noticeOrgShutdown(org.id, { retire: false });
  assert.equal(n, 1, "only the non-retired agent is notified");
  const heard = store.takeUndeliveredNotices(a.id);
  assert.equal(heard.length, 1);
  assert.match(heard[0].body, /stay durable/);
  assert.equal(heard[0].is_broadcast, true);
  assert.equal(store.takeUndeliveredNotices(b.id).length, 0, "the retired hear nothing");

  const n2 = store.noticeOrgShutdown(org.id, { retire: true });
  assert.equal(n2, 1);
  assert.match(store.takeUndeliveredNotices(a.id)[0].body, /you will be retired/);
});

// ── server-level: the real /org/shutdown and /agent/close routes ──

const server = createServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

async function shutdown(org, extra = {}) {
  const res = await fetch(base + "/org/shutdown", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ org, ...extra }),
  });
  return { status: res.status, body: await res.json() };
}

test("shutdown with no open work closes cleanly and audits org.shutdown", async () => {
  const { org, a, b } = setup("sd-clean-org");
  const { status, body } = await shutdown(org.name);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.notified, 2);
  assert.deepEqual(body.closed, [], "neither agent had a terminal_ref");
  assert.deepEqual(body.retired, []);
  assert.equal(body.serverStopping, false);
  assert.deepEqual(body.survives, { db: true, worktrees: true, identities: true });

  const ev = store.listAuditEvents(org.id).find((e) => e.type === "org.shutdown");
  assert.ok(ev, "org.shutdown audited");
  assert.equal(ev.data.closed, 0);
  void a; void b;
});

test("shutdown refuses when a task is claimed, unless --force", async () => {
  const { org, project, a, b } = setup("sd-blocked-org");
  const t = store.createTask({ projectId: project.id, orgId: org.id, agentId: a.id, title: "wip", tags: [] });
  store.claimTask({ agentId: b.id, taskId: t.id });

  const blocked = await shutdown(org.name);
  assert.equal(blocked.body.ok, false);
  assert.equal(blocked.body.greenzoneActive, false);
  assert.deepEqual(blocked.body.blockedBy, [{ agent: "b", task_id: t.id, task_title: "wip" }]);
  assert.equal(store.getAgentTerminal(a.id), null, "nothing closed while blocked");

  const forced = await shutdown(org.name, { force: true });
  assert.equal(forced.body.ok, true, "--force bypasses the open-task guard");
});

test("shutdown refuses while a greenzone is active, unless --force", async () => {
  const { org, a, b } = setup("sd-gz-org");
  store.setAgentClaudeSession(a.id, "sid-a"); // presence.addLiveSession isn't required for greenzone
  const presence = await import("../dist/core/presence.js");
  presence.addLiveSession(a.id);
  presence.addLiveSession(b.id);
  try {
    gz.requestGreenzone({ orgId: org.id, execute: () => {} });
    const blocked = await shutdown(org.name);
    assert.equal(blocked.body.ok, false);
    assert.equal(blocked.body.greenzoneActive, true);

    const forced = await shutdown(org.name, { force: true });
    assert.equal(forced.body.ok, true);
  } finally {
    presence.removeLiveSession(a.id);
    presence.removeLiveSession(b.id);
    gz.resetGreenzones();
  }
});

test("shutdown --retire retires eligible agents and reports who couldn't be", async () => {
  const { org, project, a, b } = setup("sd-retire-org");
  const t = store.createTask({ projectId: project.id, orgId: org.id, agentId: a.id, title: "wip", tags: [] });
  store.claimTask({ agentId: a.id, taskId: t.id });

  const r = await shutdown(org.name, { retire: true, force: true });
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.retired.sort(), ["b"], "b had nothing open, retires cleanly");
  assert.equal(r.body.retireBlocked.length, 1);
  assert.equal(r.body.retireBlocked[0].agent, "a");
  assert.deepEqual(r.body.retireBlocked[0].blockedBy, [t.id]);
  assert.notEqual(store.getAgent(a.id).state, "retired", "a keeps its open task, stays alive");
  assert.equal(store.getAgent(b.id).state, "retired");
});

test("close notifies, closes the terminal via the real closeTerminal path, and leaves the agent durable", async () => {
  const { org, a } = setup("sd-close-org");
  store.setAgentTerminal(a.id, { method: "tmux", id: "%nonexistent-pane" });

  const res = await fetch(base + "/agent/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: a.id }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.agent, "a");
  // closeTerminal("tmux") runs `tmux kill-pane -t <id>`; a bogus pane id fails
  // (non-zero exit) — proves the real code path ran without touching a real
  // window, rather than asserting a specific boolean the OS controls.
  assert.equal(typeof body.closed, "boolean");
  assert.equal(store.getAgentTerminal(a.id), null, "terminal_ref cleared either way");
  assert.notEqual(store.getAgent(a.id).state, "retired", "close leaves the agent durable-idle");

  const ev = store.listAuditEvents(org.id).find((e) => e.type === "agent.terminal_closed" && e.subject_id === a.id);
  assert.ok(ev, "agent.terminal_closed audited");
});
