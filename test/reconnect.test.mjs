import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state (set before importing anything that opens the DB).
const dir = path.join(os.tmpdir(), "lanchu-reconnect-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;
delete process.env.LANCHU_ACCESS_KEY;
delete process.env.LANCHU_RECONNECT_GRACE_MS;

const { createServer, setSessionPingProbe } = await import("../dist/server/server.js");
const store = await import("../dist/core/store.js");
const presence = await import("../dist/core/presence.js");

const server = createServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const join = async (agentName) => {
  const res = await fetch(base + "/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ org: "reconnect-org", project: "core", agentName }),
  });
  assert.equal(res.status, 200);
  return res.json();
};

/** Speak just enough MCP: POST an initialize with the launcher token, like a client (re)connecting. */
const initialize = async (token) => {
  const res = await fetch(base + "/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    }),
  });
  assert.equal(res.status, 200);
  const sid = res.headers.get("mcp-session-id");
  assert.ok(sid, "initialize assigns an mcp session id");
  await res.body?.cancel();
  return sid;
};

test("regression: a reconnect within the grace window replaces the old session — no duplicate flag", async () => {
  const { token, agentId } = await join("one-terminal");

  const first = await initialize(token);
  assert.equal(presence.liveSessionCount(agentId), 1);

  // The same terminal re-establishes its transport (restart blip / retry race):
  // same launcher token, new MCP session, old one left half-open.
  const second = await initialize(token);
  assert.notEqual(second, first);
  assert.equal(presence.liveSessionCount(agentId), 1, "replaced, not counted");

  const org = store.getOrgByName("reconnect-org");
  const dup = store.listAuditEvents(org.id).find(
    (e) => e.type === "agent.duplicate_session" && e.subject_id === agentId,
  );
  assert.equal(dup, undefined, "no duplicate-session audit event for a reconnect");
  assert.equal(store.takeUndeliveredNotices(agentId).length, 0, "no alarming notice for a reconnect");
});

const settled = () => new Promise((r) => setTimeout(r, 60));

test("two REAL terminals at steady state (the old session answers the ping) still flag a duplicate", async () => {
  process.env.LANCHU_RECONNECT_GRACE_MS = "0"; // the window has passed
  setSessionPingProbe(async () => true); // the other terminal is alive and answers
  try {
    const { token, agentId } = await join("two-terminals");

    await initialize(token);
    await initialize(token);
    await settled(); // verification is async — the flag lands within a tick of the ping
    assert.equal(presence.liveSessionCount(agentId), 2, "both terminals stay counted");

    const org = store.getOrgByName("reconnect-org");
    const dup = store.listAuditEvents(org.id).find(
      (e) => e.type === "agent.duplicate_session" && e.subject_id === agentId,
    );
    assert.ok(dup, "duplicate session is audited");
    assert.equal(dup.data.verified_by_ping, true, "the accusation carries its evidence");
    const heard = store.takeUndeliveredNotices(agentId);
    assert.equal(heard.length, 1);
    assert.match(heard[0].body, /Another live session/);
  } finally {
    delete process.env.LANCHU_RECONNECT_GRACE_MS;
    setSessionPingProbe(null);
  }
});

// ── task-mrgk65hj2: /session/diagnose and the actionable 401 body ──

test("/session/diagnose distinguishes unknown / live / retired for a real minted token", async () => {
  const diagnose = async (token) => {
    const res = await fetch(base + "/session/diagnose", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }),
    });
    return { status: res.status, body: await res.json() };
  };

  const unknown = await diagnose("lsk_never_minted_anywhere");
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.body, { kind: "unknown" });

  const { token } = await join("diag-live-agent");
  const live = await diagnose(token);
  assert.equal(live.body.kind, "live");
  assert.equal(live.body.agent_name, "diag-live-agent");

  const org = store.getOrgByName("reconnect-org");
  const agent = store.findAgentByName(org.id, "diag-live-agent");
  store.retireAgent(agent.id, { override: true });
  const retired = await diagnose(token);
  assert.equal(retired.body.kind, "retired");
  assert.equal(retired.body.agent_name, "diag-live-agent");
  assert.ok(retired.body.ended_at);
});

test("/mcp 401 names the cause and the fix instead of a bare rejection", async () => {
  const post401 = async (token) => {
    const res = await fetch(base + "/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      }),
    });
    return { status: res.status, body: await res.json() };
  };

  const unknown = await post401("lsk_totally_bogus");
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.diagnosis.kind, "unknown");
  assert.match(unknown.body.remedy, /re-onboard/);

  const { token, agentId } = await join("diag-401-agent");
  // Through the real /agent/retire route, not store.retireAgent directly —
  // this is what actually clears the in-memory context cache (see below).
  const retireRes = await fetch(base + "/agent/retire", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId }),
  });
  assert.equal((await retireRes.json()).retired, true);
  const retired = await post401(token);
  assert.equal(retired.status, 401);
  assert.equal(retired.body.diagnosis.kind, "retired");
  assert.equal(retired.body.diagnosis.agent_name, "diag-401-agent");
  assert.match(retired.body.remedy, /lanchu reconnect/);
});

test("regression (task-mrgmbqyv2): a LAZY reconnect past the grace window — dead old session — replaces silently", async () => {
  process.env.LANCHU_RECONNECT_GRACE_MS = "0"; // minutes after the restart
  setSessionPingProbe(async () => false); // the old session is a half-open ghost
  try {
    const { token, agentId } = await join("lazy-reconnect");

    const first = await initialize(token);
    const second = await initialize(token);
    assert.notEqual(second, first);
    await settled();
    assert.equal(presence.liveSessionCount(agentId), 1, "the ghost is replaced, not counted");

    const org = store.getOrgByName("reconnect-org");
    const dup = store.listAuditEvents(org.id).find(
      (e) => e.type === "agent.duplicate_session" && e.subject_id === agentId,
    );
    assert.equal(dup, undefined, "no duplicate flag without ping evidence");
    assert.equal(store.takeUndeliveredNotices(agentId).length, 0, "no alarming notice for a reconnect");
  } finally {
    delete process.env.LANCHU_RECONNECT_GRACE_MS;
    setSessionPingProbe(null);
  }
});
