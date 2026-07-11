import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-greenzone-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;
delete process.env.LANCHU_ACCESS_KEY;

const store = await import("../dist/core/store.js");
const presence = await import("../dist/core/presence.js");
const gz = await import("../dist/core/greenzone.js");

/** An org with two live builders and one idle teammate. */
function setup(orgName) {
  const org = store.getOrCreateOrg(orgName);
  const role = store.getOrCreateRole(org.id, "generalist", { wildcard: true });
  const a = store.createAgent({ orgId: org.id, roleId: role.id, name: "a" });
  const b = store.createAgent({ orgId: org.id, roleId: role.id, name: "b" });
  const idle = store.createAgent({ orgId: org.id, roleId: role.id, name: "sleepy" });
  presence.addLiveSession(a.id);
  presence.addLiveSession(b.id);
  return { org, a, b, idle };
}
function teardown(...agents) {
  for (const a of agents) presence.removeLiveSession(a.id);
  gz.resetGreenzones();
}

test("request notices every live agent; all-confirmed executes early; idle agents never block", () => {
  const { org, a, b, idle } = setup("gz-org");
  let executed = 0;

  const status = gz.requestGreenzone({ orgId: org.id, action: "restart", execute: () => executed++ });
  assert.equal(status.state, "requested");
  assert.deepEqual(status.required.map((r) => r.name).sort(), ["a", "b"], "live agents only — sleepy not required");
  assert.equal(gz.isGreenzoneActive(org.id), true);

  for (const agent of [a, b]) {
    const heard = store.takeUndeliveredNotices(agent.id);
    assert.equal(heard.length, 1);
    assert.match(heard[0].body, /Greenzone requested .*greenzone_ack/);
  }
  assert.equal(store.takeUndeliveredNotices(idle.id).length, 0, "idle agents aren't nagged");

  const one = gz.ackGreenzone(org.id, a.id);
  assert.equal(one.confirmed, 1);
  assert.equal(one.state, "requested");
  assert.equal(executed, 0, "half-confirmed doesn't execute");

  const two = gz.ackGreenzone(org.id, b.id);
  assert.equal(two.state, "done");
  assert.equal(two.timed_out, false);
  assert.equal(executed, 1, "all live agents confirmed → executes once, early");
  assert.equal(gz.isGreenzoneActive(org.id), false);

  const events = store.listAuditEvents(org.id).map((e) => e.type);
  assert.ok(events.includes("greenzone.requested"));
  assert.ok(events.includes("greenzone.confirmed"));
  assert.ok(events.includes("greenzone.executed"));
  const done = store.listAuditEvents(org.id).find((e) => e.type === "greenzone.executed");
  assert.deepEqual([done.data.confirmed, done.data.required, done.data.timed_out], [2, 2, false]);

  teardown(a, b);
});

test("timeout executes with partial confirms and says so", async () => {
  const { org, a, b } = setup("gz-timeout-org");
  let executed = 0;

  gz.requestGreenzone({ orgId: org.id, timeoutMs: 60, execute: () => executed++ });
  gz.ackGreenzone(org.id, a.id); // only one of two confirms
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(executed, 1, "deadline fires the op anyway");
  const status = gz.greenzoneStatus(org.id);
  assert.equal(status.state, "done");
  assert.equal(status.timed_out, true);
  assert.equal(status.confirmed, 1);

  teardown(a, b);
});

test("no live agents → nothing to coordinate, executes immediately; double request while open is refused", () => {
  const org = store.getOrCreateOrg("gz-empty-org");
  let executed = 0;
  const status = gz.requestGreenzone({ orgId: org.id, execute: () => executed++ });
  assert.equal(status.state, "done");
  assert.equal(executed, 1);

  const busyOrg = setup("gz-busy-org");
  gz.requestGreenzone({ orgId: busyOrg.org.id, execute: () => {} });
  assert.throws(() => gz.requestGreenzone({ orgId: busyOrg.org.id, execute: () => {} }), /already in progress/);
  teardown(busyOrg.a, busyOrg.b);
});

test("HTTP surface: /greenzone/request opens the window and /api/greenzone reports it", async () => {
  const { createServer } = await import("../dist/server/server.js");
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { org, a, b } = setup("gz-http-org");
  try {
    // A live agent keeps the window open, so the restart executor never fires in-test.
    const res = await fetch(base + "/greenzone/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ org: "gz-http-org", action: "restart" }),
    });
    assert.equal(res.status, 200);
    const opened = await res.json();
    assert.equal(opened.state, "requested");
    assert.equal(opened.required.length, 2);

    const gzRes = await fetch(base + `/api/greenzone?org=gz-http-org`);
    const status = await gzRes.json();
    assert.equal(status.state, "requested");
    assert.equal(status.confirmed, 0);

    const dup = await fetch(base + "/greenzone/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ org: "gz-http-org" }),
    });
    assert.equal(dup.status, 409, "second request while open is refused");

    const bad = await fetch(base + "/greenzone/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ org: "gz-http-org", action: "migrate-the-moon" }),
    });
    assert.equal(bad.status, 400, "unknown actions are refused");
  } finally {
    teardown(a, b);
    void org;
    server.close();
  }
});
