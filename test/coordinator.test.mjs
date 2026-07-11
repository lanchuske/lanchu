import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-coordinator-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;

const store = await import("../dist/core/store.js");
const presence = await import("../dist/core/presence.js");
const { ScopeError } = await import("../dist/core/types.js");

function setup(orgName) {
  const org = store.getOrCreateOrg(orgName);
  const role = store.getOrCreateRole(org.id, "generalist", { wildcard: true });
  const product = store.createAgent({ orgId: org.id, roleId: role.id, name: "product" });
  const builder = store.createAgent({ orgId: org.id, roleId: role.id, name: "builder" });
  return { org, product, builder };
}

test("exclusivity: a live holder blocks acquire; an idle holder can be taken over", () => {
  const { org, product, builder } = setup("coord-org");

  const lease = store.coordinatorAcquire({ orgId: org.id, agentId: product.id });
  assert.equal(lease.agent_name, "product");
  assert.equal(lease.expired, false);

  // Holder live → a second agent is refused, naming the holder.
  presence.addLiveSession(product.id);
  assert.throws(
    () => store.coordinatorAcquire({ orgId: org.id, agentId: builder.id }),
    (err) => err instanceof ScopeError && /held by 'product'/.test(err.message),
  );

  // Renewal by the holder keeps acquired_at, refreshes renewed_at.
  const renewed = store.coordinatorAcquire({ orgId: org.id, agentId: product.id });
  assert.equal(renewed.acquired_at, lease.acquired_at);

  // Holder goes idle (transport closed) → takeover grants.
  presence.removeLiveSession(product.id);
  const taken = store.coordinatorAcquire({ orgId: org.id, agentId: builder.id });
  assert.equal(taken.agent_name, "builder");
  const ev = store.listAuditEvents(org.id).find(
    (e) => e.type === "coordinator.acquired" && e.data?.took_over_from === "product",
  );
  assert.ok(ev, "takeover audited with provenance");
});

test("TTL expiry frees the lease lazily, audited as coordinator.expired", () => {
  const { org, product, builder } = setup("coord-ttl-org");

  presence.addLiveSession(product.id);
  store.coordinatorAcquire({ orgId: org.id, agentId: product.id, ttlSeconds: 0 }); // expires immediately
  assert.equal(store.getCoordinator(org.id).expired, true);

  // Even though product is live, the expired lease is up for grabs.
  const taken = store.coordinatorAcquire({ orgId: org.id, agentId: builder.id });
  assert.equal(taken.agent_name, "builder");
  assert.ok(store.listAuditEvents(org.id).some((e) => e.type === "coordinator.expired"));
  presence.removeLiveSession(product.id);
});

test("gating: the holder passes (and renews); non-holders get a rejection naming the coordinator", () => {
  const { org, product, builder } = setup("coord-gate-org");
  presence.addLiveSession(product.id);
  store.coordinatorAcquire({ orgId: org.id, agentId: product.id });

  assert.doesNotThrow(() => store.assertCoordinator(org.id, product.id, "broadcast (to:'*')"));
  assert.throws(
    () => store.assertCoordinator(org.id, builder.id, "spawn_agent"),
    (err) => err instanceof ScopeError && /'product' holds it/.test(err.message),
  );

  // Free lease: the rejection points at coordinator_acquire instead.
  store.coordinatorRelease({ orgId: org.id, agentId: product.id });
  assert.throws(
    () => store.assertCoordinator(org.id, builder.id, "broadcast (to:'*')"),
    /lease is free/,
  );
  presence.removeLiveSession(product.id);
});

test("release is holder-only; handoff moves the lease and notices the receiver; retire auto-releases", () => {
  const { org, product, builder } = setup("coord-hand-org");
  store.coordinatorAcquire({ orgId: org.id, agentId: product.id });

  assert.throws(() => store.coordinatorRelease({ orgId: org.id, agentId: builder.id }), ScopeError);
  assert.throws(
    () => store.coordinatorHandoff({ orgId: org.id, fromAgentId: builder.id, toAgentName: "product" }),
    /only the current coordinator/,
  );

  const handed = store.coordinatorHandoff({ orgId: org.id, fromAgentId: product.id, toAgentName: "builder" });
  assert.equal(handed.agent_name, "builder");
  const heard = store.takeUndeliveredNotices(builder.id);
  assert.ok(heard.some((n) => /coordinator lease/.test(n.body)));
  assert.ok(store.listAuditEvents(org.id).some((e) => e.type === "coordinator.handoff"));

  // Retiring the holder must never leave a ghost coordinator.
  store.retireAgent(builder.id);
  assert.equal(store.getCoordinator(org.id), null);
  const released = store.listAuditEvents(org.id).find((e) => e.type === "coordinator.released");
  assert.equal(released.data.reason, "holder retired");
});

test("supervisor override grants and clears regardless of holder", () => {
  const { org, product, builder } = setup("coord-override-org");
  presence.addLiveSession(product.id);
  store.coordinatorAcquire({ orgId: org.id, agentId: product.id });

  const granted = store.coordinatorOverride(org.id, "builder");
  assert.equal(granted.agent_name, "builder", "override wins over a live holder");
  assert.equal(store.coordinatorOverride(org.id, null), null);
  assert.equal(store.getCoordinator(org.id), null);
  presence.removeLiveSession(product.id);
});
