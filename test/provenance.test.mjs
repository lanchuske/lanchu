import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state (server import opens the DB).
const dir = path.join(os.tmpdir(), "lanchu-provenance-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;
delete process.env.LANCHU_ACCESS_KEY;

const prov = await import("../dist/core/provenance.js");
const { createServer } = await import("../dist/server/server.js");

test("isStaleBuild: a commit newer than the build is stale; missing data never flags", () => {
  assert.equal(prov.isStaleBuild("2026-07-11T10:00:00Z", "2026-07-11T07:12:00Z"), true, "the 10:13Z incident shape");
  assert.equal(prov.isStaleBuild("2026-07-11T07:00:00Z", "2026-07-11T07:12:00Z"), false, "build after commit = fresh");
  assert.equal(prov.isStaleBuild(null, "2026-07-11T07:12:00Z"), false, "plain npm install (no repo) never flags");
  assert.equal(prov.isStaleBuild("2026-07-11T10:00:00Z", null), false, "no dist to compare");
});

test("buildProvenance reads this checkout: version, a real commit, a real build time", () => {
  const p = prov.buildProvenance("9.9.9-test");
  assert.equal(p.version, "9.9.9-test");
  assert.match(p.commit ?? "", /^[0-9a-f]{40}$/, "dogfooding runs from a git checkout");
  assert.ok(p.built_at, "dist exists — the tests just ran a build");
  assert.equal(typeof p.stale, "boolean");
});

test("/health answers who is live: version + commit + built_at + stale", async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/health`);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.version, "health names the running version");
    assert.match(body.commit ?? "", /^[0-9a-f]{40}$/, "health names the exact live commit");
    assert.ok(body.built_at, "health names when the running dist was compiled");
    assert.equal(typeof body.stale, "boolean", "staleness is visible, not discovered by DB diffing");
  } finally {
    server.close();
  }
});
