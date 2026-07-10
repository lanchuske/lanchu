import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state (set before importing anything that opens the DB).
const dir = path.join(os.tmpdir(), "lanchu-remote-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;
delete process.env.LANCHU_ACCESS_KEY;

const { createServer } = await import("../dist/server/server.js");

// One server for the whole file; auth is decided per-request from the env, so we
// flip LANCHU_ACCESS_KEY between requests rather than restarting.
const server = createServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const req = (p, init) => fetch(base + p, init);
const KEY = "s3cret-key";

test("no access key: the admin surface is open", async () => {
  delete process.env.LANCHU_ACCESS_KEY;
  assert.equal((await req("/api/orgs")).status, 200);
  assert.equal((await req("/health")).status, 200);
});

test("with an access key: admin surface is gated, health/shell/mcp stay reachable", async () => {
  process.env.LANCHU_ACCESS_KEY = KEY;
  try {
    // /health is always open — it's how the CLI probes liveness before it has a key.
    assert.equal((await req("/health")).status, 200);
    // The panel shell is public so the browser can load it and prompt for the key.
    assert.equal((await req("/", { headers: { accept: "text/html" } })).status, 200);

    // The API requires the key, presented any of three ways.
    assert.equal((await req("/api/orgs")).status, 401);
    assert.equal((await req("/api/orgs", { headers: { authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await req("/api/orgs", { headers: { authorization: `Bearer ${KEY}` } })).status, 200);
    assert.equal((await req("/api/orgs", { headers: { "x-lanchu-key": KEY } })).status, 200);
    assert.equal((await req(`/api/orgs?key=${encodeURIComponent(KEY)}`)).status, 200);

    // /mcp is exempt from the access-key gate (it carries per-agent session tokens),
    // but still rejects a request with no/invalid session token.
    const mcp = await req("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(mcp.status, 401);
  } finally {
    delete process.env.LANCHU_ACCESS_KEY;
  }
});

test("session minting is gated by the key and advertises a reachable mcp url", async () => {
  process.env.LANCHU_ACCESS_KEY = KEY;
  try {
    const body = JSON.stringify({ org: "remote-acme", project: "web", objective: "x" });
    const headers = { "content-type": "application/json" };

    assert.equal((await req("/session", { method: "POST", headers, body })).status, 401);

    const res = await req("/session", {
      method: "POST",
      headers: { ...headers, authorization: `Bearer ${KEY}` },
      body,
    });
    assert.equal(res.status, 200);
    const s = await res.json();
    assert.ok(s.token, "returns a session token");
    // The advertised mcp url follows the request's Host (the ephemeral test port),
    // not the configured default port — so a remote laptop gets a reachable URL.
    assert.equal(s.mcpUrl, `${base}/mcp`);
  } finally {
    delete process.env.LANCHU_ACCESS_KEY;
  }
});

test("LANCHU_PUBLIC_URL overrides the advertised mcp url", async () => {
  process.env.LANCHU_ACCESS_KEY = KEY;
  process.env.LANCHU_PUBLIC_URL = "https://lanchu.example.com/";
  try {
    const res = await req("/session", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}`, host: "internal:4319" },
      body: JSON.stringify({ org: "remote-acme", project: "web" }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).mcpUrl, "https://lanchu.example.com/mcp");
  } finally {
    delete process.env.LANCHU_ACCESS_KEY;
    delete process.env.LANCHU_PUBLIC_URL;
  }
});
