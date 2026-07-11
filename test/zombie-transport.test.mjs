import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state; shrink the nudge grace window so tests don't wait.
const dir = path.join(os.tmpdir(), "lanchu-zombie-transport-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;
process.env.LANCHU_NUDGE_AFTER_SECONDS = "1";
delete process.env.LANCHU_ACCESS_KEY;

const { createServer, runNudgeSweep, setSessionPingProbe } = await import("../dist/server/server.js");
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
    body: JSON.stringify({ org: "zombie-org", project: "core", agentName }),
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

const graceElapsed = () => new Promise((r) => setTimeout(r, 1100));

// ── task-mrgqz4p05: zombie MCP transport refcount blocks park & refire ──

test("SessionEnd proactively forgets the session — no transport-close event needed", async () => {
  const { token, agentId } = await join("clean-exit");
  await initialize(token);
  assert.equal(presence.liveSessionCount(agentId), 1, "the live MCP session is counted");

  // The process exits cleanly (Stop-hook fires session-end) but a hard-killed
  // streamable-HTTP client never sends a close frame — the server must not
  // wait for one it was never going to get.
  const res = await fetch(base + "/hooks/agent/session-end", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ reason: "exit" }),
  });
  assert.equal(res.status, 200);

  assert.equal(presence.liveSessionCount(agentId), 0, "the session is forgotten immediately, not on a close event that never fires");
  const agent = store.getAgent(agentId);
  assert.ok(agent.parked_at, "parkAgent still runs as before");
  assert.equal(store.presenceOf(agent), "parked", "acceptance: presence falls through to parked once the live hold is gone (coordinates with #92)");
});

test("the nudge sweep reaps a zombie transport that fails to answer a ping, then refires", async () => {
  const { token, agentId } = await join("zombie");
  await initialize(token);
  assert.equal(presence.liveSessionCount(agentId), 1);

  // Simulate the leak this bug describes: the agent is parked directly (as a
  // crash-without-clean-SessionEnd would leave things, or a race would), so
  // the MCP transport refcount is NEVER proactively forgotten — isAgentLive
  // stays stuck true exactly like the reported bug, with no other path to
  // clear it than the reaper backstop under test here.
  const org = store.getOrgByName("zombie-org");
  store.setAgentClaudeSession(agentId, "sid-zombie");
  store.parkAgent(agentId, "exit");
  store.setAgentWorkspace(agentId, { cwd: "/tmp/wt" });
  const sender = store.createAgent({
    orgId: org.id,
    roleId: store.getOrCreateRole(org.id, "generalist", { wildcard: true }).id,
    name: "sender",
  });
  store.sendNotice({ orgId: org.id, fromAgentId: sender.id, to: "zombie", body: "new work" });
  await graceElapsed();

  assert.equal(presence.liveSessionCount(agentId), 1, "the leak: still counted live despite being parked");

  setSessionPingProbe(async () => false); // the zombie never answers
  try {
    const fired = [];
    const r = await runNudgeSweep({
      alive: () => false,
      liveSessions: () => new Set(), // verified absent from `claude agents --json`
      refire: (c, tok) => { fired.push({ c, tok }); return true; },
    });
    assert.deepEqual(r.refired, ["zombie"], "the reaper clears the stale hold and the refire gates pass");
    assert.equal(fired.length, 1);
    assert.equal(presence.liveSessionCount(agentId), 0, "the zombie session was reaped as a side effect");

    const ev = store.listAuditEvents(org.id).find((e) => e.type === "agent.nudged");
    assert.ok(ev, "agent.nudged audited — no narrative, the sweep either proves it or doesn't");
    assert.equal(ev.data.transport, "runner");
  } finally {
    setSessionPingProbe(null);
  }
});

test("a transport that DOES answer the ping is never reaped or refired — genuinely live beats a stale parked flag", async () => {
  const { token, agentId } = await join("genuinely-live");
  await initialize(token);

  const org = store.getOrgByName("zombie-org");
  store.setAgentClaudeSession(agentId, "sid-live");
  store.parkAgent(agentId, "exit");
  store.setAgentWorkspace(agentId, { cwd: "/tmp/wt" });
  const sender = store.createAgent({
    orgId: org.id,
    roleId: store.getOrCreateRole(org.id, "generalist", { wildcard: true }).id,
    name: "sender2",
  });
  store.sendNotice({ orgId: org.id, fromAgentId: sender.id, to: "genuinely-live", body: "new work" });
  await graceElapsed();

  setSessionPingProbe(async () => true); // a real second terminal, answers fine
  try {
    const r = await runNudgeSweep({
      alive: () => false,
      liveSessions: () => new Set(),
      refire: () => { throw new Error("a genuinely live transport must never be refired"); },
    });
    assert.deepEqual(r.refired, []);
    assert.equal(presence.liveSessionCount(agentId), 1, "an answering session is never reaped");
  } finally {
    setSessionPingProbe(null);
  }
});
