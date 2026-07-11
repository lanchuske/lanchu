import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state (set before importing anything that opens the DB).
const dir = path.join(os.tmpdir(), "lanchu-build-reload-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;
delete process.env.LANCHU_ACCESS_KEY;

const { createServer } = await import("../dist/server/server.js");
const { PANEL_BUILD_ID } = await import("../dist/server/panel.js");

const server = createServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

// Stale-client auto-reload (task-mrg6gltl3): the SSE stream announces the
// running build on every (re)connect, so a tab that survived a server restart
// learns its client code is stale within one reconnect and hard-reloads.

test("SSE /events announces the running build id as its first data frame", async () => {
  const res = await fetch(base + "/events?org=any-org");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

  // Read until the first data frame arrives (the ": connected" comment may
  // land in its own chunk).
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (!buf.includes("data:")) {
    const { value, done } = await reader.read();
    assert.ok(!done, "stream ended before a data frame");
    buf += decoder.decode(value, { stream: true });
  }
  await reader.cancel();

  const frame = buf.split("\n").find((l) => l.startsWith("data:"));
  const hello = JSON.parse(frame.slice(5));
  assert.equal(hello.type, "hello");
  assert.equal(hello.build, PANEL_BUILD_ID, "hello carries the running panel build id");
});
