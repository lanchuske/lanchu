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
// Tests drive millisecond windows; disable the production 120s floor.
process.env.LANCHU_GREENZONE_MIN_MS = "0";

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

  // task-mrgqd61m19: a single fixed 150ms sleep raced the internal setTimeout
  // on a loaded windows-latest runner (PR #92 run 29164356374 — the deadline
  // hadn't fired yet at 150ms, identical commit passed clean on rerun).
  // Poll-until with a generous ceiling instead: deterministic regardless of
  // how late the runner schedules the timer, still genuinely exercises the
  // real deadline mechanism rather than mocking it away.
  const pollDeadline = Date.now() + 5000;
  while (executed === 0 && Date.now() < pollDeadline) {
    await new Promise((r) => setTimeout(r, 20));
  }

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

// ── old-session bridge: acking the request notice IS the confirmation ──
// Sessions minted before greenzone_ack existed can't see that tool (tool
// lists are fixed at session init) — but every session has message_ack.

test("acking the greenzone request notice confirms: old sessions are never stuck waiting out the timeout", () => {
  const { org, a, b } = setup("gz-bridge-org");
  let executed = 0;
  gz.requestGreenzone({ orgId: org.id, execute: () => executed++ });

  // The notice tells old sessions the fallback and is marked for the bridge.
  const heard = store.takeUndeliveredNotices(a.id);
  assert.equal(heard.length, 1);
  assert.equal(heard[0].ref, "greenzone");
  assert.match(heard[0].body, /message_ack this notice: it counts as your confirmation/);

  // A regular teammate message must NOT be mistaken for a confirmation.
  store.sendNotice({ orgId: org.id, fromAgentId: b.id, to: "a", body: "unrelated" });
  const unrelated = store.listNotices(a.id).find((n) => n.body === "unrelated");
  assert.deepEqual(store.greenzoneNoticeIds(a.id, [unrelated.id]), [], "plain messages don't confirm");

  // The bridge (mirrors the message_ack tool): resolve greenzone ids, then confirm.
  const gzIds = store.greenzoneNoticeIds(a.id, [heard[0].id, unrelated.id]);
  assert.deepEqual(gzIds, [heard[0].id]);
  store.ackNotices(a.id, [heard[0].id, unrelated.id]);
  const one = gz.ackGreenzone(org.id, a.id);
  assert.equal(one.confirmed, 1);
  assert.equal(executed, 0);

  // Cross-agent safety: b can't launder a's notice id into a confirmation for itself.
  assert.deepEqual(store.greenzoneNoticeIds(b.id, [heard[0].id]), [], "notice ids are per-recipient");

  const bNotice = store.takeUndeliveredNotices(b.id).find((n) => n.ref === "greenzone");
  store.ackNotices(b.id, [bNotice.id]);
  const two = gz.ackGreenzone(org.id, b.id);
  assert.equal(two.state, "done");
  assert.equal(executed, 1, "both confirmed via the bridge → executes early, no timeout wait");

  teardown(a, b);
});

// ── orphan fix: a stuck window self-expires; cancel is the supervisor override ──

test("orphan repro: a window whose timer died self-expires on the next touch and never blocks the org", async () => {
  const { org, a, b } = setup("gz-orphan-org");
  let executed = 0;

  // Shrink the expiry grace INSIDE this test only (expiryGraceMs reads the env
  // per call): a tiny file-global grace made every other greenzone test racy
  // on slow CI runners — any >60ms gap between request and the next touch
  // expired windows that were supposed to still be open (Windows CI red).
  process.env.LANCHU_GREENZONE_GRACE_MS = "10";
  try {
    gz.requestGreenzone({ orgId: org.id, timeoutMs: 30, execute: () => executed++ });
    gz.dropTimerForTest(org.id); // the 2026-07-11 incident: execution lost mid-window
    await new Promise((r) => setTimeout(r, 100)); // past deadline (30ms) + grace (10ms)

    assert.equal(executed, 0, "the lost op never ran");
    assert.equal(gz.isGreenzoneActive(org.id), false, "a stale window is not active");
    assert.equal(gz.greenzoneStatus(org.id).state, "expired");
    assert.ok(
      store.listAuditEvents(org.id).some((e) => e.type === "greenzone.expired"),
      "expiry is on the record",
    );

    // The whole point: the next request goes straight through.
    const next = gz.requestGreenzone({ orgId: org.id, execute: () => executed++ });
    assert.equal(next.state, "requested", "org is never blocked by a dead window");
  } finally {
    delete process.env.LANCHU_GREENZONE_GRACE_MS;
  }

  teardown(a, b);
});

test("cancel aborts the pending op, notices the agents, audits, and frees the org", async () => {
  const { org, a, b } = setup("gz-cancel-org");
  let executed = 0;

  // Cancel IMMEDIATELY after the request — any bookkeeping in between gave
  // slow CI runners time to hit the 50ms deadline before the cancel arrived
  // ("no greenzone in progress" on windows-latest). The timeout is generous;
  // the sleep below still proves the armed timer was cleared, not just slow.
  gz.requestGreenzone({ orgId: org.id, timeoutMs: 500, execute: () => executed++ });
  const status = gz.cancelGreenzone(org.id, a.id);
  assert.equal(status.state, "cancelled");
  assert.equal(gz.isGreenzoneActive(org.id), false);

  // The armed op must never fire, even past its original deadline.
  await new Promise((r) => setTimeout(r, 650));
  assert.equal(executed, 0, "cancelled means the op does not run");

  store.takeUndeliveredNotices(a.id); // drain a's request+cancelled notices
  const bNotices = store.takeUndeliveredNotices(b.id);
  assert.equal(bNotices.length, 2, "request notice + cancellation notice");
  const cancelled = bNotices.find((n) => /Greenzone cancelled/.test(n.body));
  assert.ok(cancelled, "cancellation notice reached the agent");
  assert.match(cancelled.body, /resume normal work/);

  const ev = store.listAuditEvents(org.id).find((e) => e.type === "greenzone.cancelled");
  assert.ok(ev, "cancellation is on the record");

  assert.throws(() => gz.ackGreenzone(org.id, b.id), /no greenzone in progress/, "acks after cancel are refused");
  assert.throws(() => gz.cancelGreenzone(org.id), /no greenzone in progress/, "nothing left to cancel");
  assert.equal(gz.requestGreenzone({ orgId: org.id, execute: () => {} }).state, "requested", "org is free again");

  teardown(a, b);
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

    // Supervisor override over HTTP: cancel clears the window; a second cancel
    // has nothing to act on; unknown orgs 404.
    const cancel = await fetch(base + "/greenzone/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ org: "gz-http-org" }),
    });
    assert.equal(cancel.status, 200);
    assert.equal((await cancel.json()).state, "cancelled");
    const again = await fetch(base + "/greenzone/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ org: "gz-http-org" }),
    });
    assert.equal(again.status, 409, "nothing left to cancel");
    const ghost = await fetch(base + "/greenzone/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ org: "no-such-org" }),
    });
    assert.equal(ghost.status, 404);
  } finally {
    teardown(a, b);
    void org;
    server.close();
  }
});

// ── adaptive window (task-mrg7x5je9): floor + delivery-aware extension ──
// Evidence: 45-60s windows expired before the request notice even reached
// idle agents (piggyback delivery), so acks raced the timeout.

test("the window floor applies while confirmations are required", () => {
  process.env.LANCHU_GREENZONE_MIN_MS = "300000"; // 5 min floor
  try {
    const { org, a, b } = setup("gz-floor-org");
    const status = gz.requestGreenzone({ orgId: org.id, timeoutMs: 45_000, execute: () => {} });
    const windowMs = new Date(status.deadline).getTime() - new Date(status.requested_at).getTime();
    assert.ok(windowMs >= 300000, "a 45s request is floored to the configured minimum");
    teardown(a, b);

    // With nobody to confirm, the floor is pointless — immediate execution stands.
    const empty = store.getOrCreateOrg("gz-floor-empty");
    let executed = 0;
    assert.equal(gz.requestGreenzone({ orgId: empty.id, timeoutMs: 10, execute: () => executed++ }).state, "done");
    assert.equal(executed, 1);
  } finally {
    process.env.LANCHU_GREENZONE_MIN_MS = "0";
    gz.resetGreenzones();
  }
});

test("deadline with UNDELIVERED request notices extends once instead of executing over absent agents", async () => {
  const { org, a, b } = setup("gz-extend-org");
  let executed = 0;
  gz.requestGreenzone({ orgId: org.id, timeoutMs: 60, execute: () => executed++ });
  // Nobody takes their notices: delivery never happened.
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(executed, 0, "first deadline extends rather than executes");
  const mid = gz.greenzoneStatus(org.id);
  assert.equal(mid.state, "requested");
  assert.equal(mid.extended, 1);
  assert.ok(mid.undelivered >= 1, "status shows who never heard the request");
  const ext = store.listAuditEvents(org.id).find((e) => e.type === "greenzone.extended");
  assert.ok(ext, "the extension is audited");
  assert.ok(ext.data.undelivered.length >= 1);

  await new Promise((r) => setTimeout(r, 90));
  assert.equal(executed, 1, "the second deadline executes regardless — idle agents never block forever");
  assert.equal(gz.greenzoneStatus(org.id).timed_out, true);
  teardown(a, b);
});

test("deadline with everyone DELIVERED executes at the first deadline — no pointless extension", async () => {
  const { org, a, b } = setup("gz-nodeliver-ext-org");
  let executed = 0;
  gz.requestGreenzone({ orgId: org.id, timeoutMs: 60, execute: () => executed++ });
  // Both agents receive (piggyback) their notices but never confirm.
  store.takeUndeliveredNotices(a.id);
  store.takeUndeliveredNotices(b.id);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(executed, 1, "delivered-but-silent agents don't earn an extension");
  assert.equal(gz.greenzoneStatus(org.id).extended, undefined);
  teardown(a, b);
});
