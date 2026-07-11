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

const { createServer } = await import("../dist/server/server.js");
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

test("two terminals at steady state (past the grace window) still flag a duplicate session", async () => {
  process.env.LANCHU_RECONNECT_GRACE_MS = "0"; // the window has passed
  try {
    const { token, agentId } = await join("two-terminals");

    await initialize(token);
    await initialize(token);
    assert.equal(presence.liveSessionCount(agentId), 2, "both terminals stay counted");

    const org = store.getOrgByName("reconnect-org");
    const dup = store.listAuditEvents(org.id).find(
      (e) => e.type === "agent.duplicate_session" && e.subject_id === agentId,
    );
    assert.ok(dup, "duplicate session is audited");
    const heard = store.takeUndeliveredNotices(agentId);
    assert.equal(heard.length, 1);
    assert.match(heard[0].body, /Another live session/);
  } finally {
    delete process.env.LANCHU_RECONNECT_GRACE_MS;
  }
});
