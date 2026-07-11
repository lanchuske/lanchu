import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-retire-gate-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;

const store = await import("../dist/core/store.js");
const storeTypes = await import("../dist/core/types.js");
const { ScopeError } = storeTypes;

function setup(orgName) {
  const org = store.getOrCreateOrg(orgName);
  const project = store.getOrCreateProject(org.id, "core");
  const role = store.getOrCreateRole(org.id, "generalist", { wildcard: true });
  const coordinator = store.createAgent({ orgId: org.id, roleId: role.id, name: "lead" });
  const worker = store.createAgent({ orgId: org.id, roleId: role.id, name: "worker" });
  return { org, project, role, coordinator, worker };
}

test("with no active lease, retirement executes directly (solo orgs unchanged)", () => {
  const { worker } = setup("retire-a");
  const r = store.retireAgent(worker.id);
  assert.equal(r.retired, true);
  assert.equal(store.getAgent(worker.id).state, "retired");
});

test("under an active lease, a non-forced retire becomes a request — the team cannot dissolve itself", () => {
  const { org, coordinator, worker } = setup("retire-b");
  store.coordinatorAcquire({ orgId: org.id, agentId: coordinator.id });

  const r = store.retireAgent(worker.id);
  assert.equal(r.retired, false);
  assert.equal(r.requested, true);
  assert.equal(r.coordinator, "lead");
  assert.equal(store.getAgent(worker.id).state, "active", "the agent survives");

  // The request is visible (panel Needs-attention) and the coordinator was noticed.
  const pending = store.pendingRetirements(org.id);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].agent_name, "worker");
  const heard = store.takeUndeliveredNotices(coordinator.id);
  assert.ok(heard.some((n) => /Retirement requested for worker/.test(n.body)));

  // Re-attempts don't spam: still one pending request, no second notice.
  store.retireAgent(worker.id);
  assert.equal(store.pendingRetirements(org.id).length, 1);
  assert.equal(store.takeUndeliveredNotices(coordinator.id).length, 0);
});

test("the lease holder can still retire themselves directly", () => {
  const { org, coordinator } = setup("retire-c");
  store.coordinatorAcquire({ orgId: org.id, agentId: coordinator.id });
  const r = store.retireAgent(coordinator.id);
  assert.equal(r.retired, true);
});

test("deny keeps the teammate standing by; approve retires for real — both audited paths work", () => {
  const { org, coordinator, worker } = setup("retire-d");
  store.coordinatorAcquire({ orgId: org.id, agentId: coordinator.id });
  store.retireAgent(worker.id);
  store.takeUndeliveredNotices(coordinator.id);

  const denied = store.resolveRetirement({ agentId: worker.id, byAgentId: coordinator.id, approve: false, note: "queue refills at 9am" });
  assert.equal(denied.retired, false);
  assert.equal(store.getAgent(worker.id).state, "active");
  assert.equal(store.pendingRetirements(org.id).length, 0, "denial clears the pending request");
  const heard = store.takeUndeliveredNotices(worker.id);
  assert.ok(heard.some((n) => /denied.*Stand by/is.test(n.body)));

  // A later, confirmed retirement goes through on approve.
  store.retireAgent(worker.id);
  const approved = store.resolveRetirement({ agentId: worker.id, byAgentId: coordinator.id, approve: true });
  assert.equal(approved.retired, true);
  assert.equal(store.getAgent(worker.id).state, "retired");
  assert.equal(store.pendingRetirements(org.id).length, 0);
});

test("a random peer cannot resolve someone's retirement", () => {
  const { org, coordinator, worker, role } = setup("retire-e");
  const peer = store.createAgent({ orgId: org.id, roleId: role.id, name: "peer" });
  store.coordinatorAcquire({ orgId: org.id, agentId: coordinator.id });
  store.retireAgent(worker.id);
  assert.throws(
    () => store.resolveRetirement({ agentId: worker.id, byAgentId: peer.id, approve: true }),
    (err) => err instanceof ScopeError,
  );
  assert.equal(store.getAgent(worker.id).state, "active");
});

test("supervisor force bypasses the gate (panel button / CLI --force)", () => {
  const { org, coordinator, worker } = setup("retire-f");
  store.coordinatorAcquire({ orgId: org.id, agentId: coordinator.id });
  const r = store.retireAgent(worker.id, { override: true });
  assert.equal(r.retired, true);
});

test("an expired lease does not gate retirement", () => {
  const { org, coordinator, worker } = setup("retire-g");
  store.coordinatorAcquire({ orgId: org.id, agentId: coordinator.id, ttlSeconds: -1 });
  const r = store.retireAgent(worker.id);
  assert.equal(r.retired, true);
});

// ── attribution (task-mrgpswtk14): the 18:38:41Z bypass was undiagnosable ──
// agent.retired always said actor=subject with no override on record, so a
// forced retire was indistinguishable from a self-retire. Now every path
// carries its initiator and its via.

test("a forced retire is audited as an override with its source — never mistaken for a self-retire", () => {
  const { org, coordinator, worker } = setup("retire-h");
  store.coordinatorAcquire({ orgId: org.id, agentId: coordinator.id });
  const r = store.retireAgent(worker.id, { override: true, source: "panel" });
  assert.equal(r.retired, true);
  const ev = store.listAuditEvents(org.id).find((e) => e.type === "agent.retired" && e.subject_id === worker.id);
  assert.equal(ev.data.override, true, "the override is on the record");
  assert.equal(ev.data.via, "panel", "the path that forced it is on the record");
});

test("a plain self-retire (no lease) is audited as via self, no override", () => {
  const { org, worker } = setup("retire-i");
  store.retireAgent(worker.id);
  const ev = store.listAuditEvents(org.id).find((e) => e.type === "agent.retired" && e.subject_id === worker.id);
  assert.equal(ev.data.via, "self");
  assert.equal(ev.data.override, undefined);
});

test("a coordinator-approved retirement names the coordinator as the actor", () => {
  const { org, coordinator, worker } = setup("retire-j");
  store.coordinatorAcquire({ orgId: org.id, agentId: coordinator.id });
  store.retireAgent(worker.id); // files the request
  store.resolveRetirement({ agentId: worker.id, byAgentId: coordinator.id, approve: true });
  const ev = store.listAuditEvents(org.id).find((e) => e.type === "agent.retired" && e.subject_id === worker.id);
  assert.equal(ev.actor_name, "lead", "the resolver, not the subject, is the actor");
  assert.equal(ev.data.via, "coordinator-resolve");
});
