import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state (set before importing anything that opens the DB).
const dir = path.join(os.tmpdir(), "lanchu-message-send-alias-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;
delete process.env.LANCHU_ACCESS_KEY;

const { createServer } = await import("../dist/server/server.js");
const store = await import("../dist/core/store.js");

const server = createServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const join = async (agentName) => {
  const res = await fetch(base + "/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ org: "msgalias-org", project: "core", agentName }),
  });
  assert.equal(res.status, 200);
  return res.json();
};

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

/** Speak just enough MCP to call a tool and unwrap its single-shot SSE response. */
const callTool = async (token, sid, name, args) => {
  const res = await fetch(base + "/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sid,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
  });
  assert.equal(res.status, 200);
  const raw = await res.text();
  const dataLine = raw.split("\n").find((l) => l.startsWith("data: "));
  const parsed = JSON.parse(dataLine.slice("data: ".length));
  const contentText = parsed.result?.content?.[0]?.text;
  return { isError: !!parsed.result?.isError, body: contentText ? JSON.parse(contentText) : contentText };
};

// ── task-mrg6tx5f9: message_send accepts both `text` and `body` ──

test("message_send accepts `text` (the original param name)", async () => {
  const a = await join("sender-text");
  await join("recv-text");
  const sid = await initialize(a.token);
  const r = await callTool(a.token, sid, "message_send", { to: "recv-text", text: "via text" });
  assert.equal(r.isError, false);
  assert.deepEqual(r.body, { sent: 1, to: ["recv-text"] });
  const org = store.getOrgByName("msgalias-org");
  const recv = store.findAgentByName(org.id, "recv-text");
  const heard = store.takeUndeliveredNotices(recv.id);
  assert.equal(heard.length, 1);
  assert.equal(heard[0].body, "via text");
});

test("message_send accepts `body` (the alias, matching what notices/store call it — task-mrg6tx5f9)", async () => {
  const a = await join("sender-body");
  await join("recv-body");
  const sid = await initialize(a.token);
  const r = await callTool(a.token, sid, "message_send", { to: "recv-body", body: "via body" });
  assert.equal(r.isError, false);
  assert.deepEqual(r.body, { sent: 1, to: ["recv-body"] });
  const org = store.getOrgByName("msgalias-org");
  const recv = store.findAgentByName(org.id, "recv-body");
  const heard = store.takeUndeliveredNotices(recv.id);
  assert.equal(heard.length, 1);
  assert.equal(heard[0].body, "via body");
});

test("message_send rejects when NEITHER text nor body is given, with a clear error", async () => {
  const a = await join("sender-neither");
  await join("recv-neither");
  const sid = await initialize(a.token);
  const r = await callTool(a.token, sid, "message_send", { to: "recv-neither" });
  assert.equal(r.isError, true, "the tool call itself reports failure, not a silent no-op");
  assert.match(JSON.stringify(r.body), /text.*or.*body.*required/i);
});
