import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-test-profile-page-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;

const store = await import("../dist/core/store.js");
const { createServer } = await import("../dist/server/server.js");

// Network mode Piece 1 Task 3 (task-mrl5i96p55): a public profile page at
// /@handle, a new web surface (not the panel). /api/profile/:handle backs
// it with public-only fields (no email); the HTML shell is a static
// template that fetches this endpoint client-side.

const server = createServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

test("getPersonByHandle finds an existing Person and returns null for an unknown handle", () => {
  const person = store.createPerson({ email: "ada@example.com", handle: "ada" });
  assert.equal(store.getPersonByHandle("ada").id, person.id);
  assert.equal(store.getPersonByHandle("nobody-here"), null);
});

test("GET /api/profile/:handle returns 404 for an unknown handle", async () => {
  const res = await fetch(`${base}/api/profile/does-not-exist`);
  assert.equal(res.status, 404);
});

test("GET /api/profile/:handle returns only public fields — no email", async () => {
  store.createPerson({ email: "secret@example.com", handle: "grace", bio: "Compiler pioneer.", githubLogin: "gracehopper" });

  const res = await fetch(`${base}/api/profile/grace`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.handle, "grace");
  assert.equal(body.bio, "Compiler pioneer.");
  assert.equal(body.github_login, "gracehopper");
  assert.ok(body.created_at);
  assert.equal("email" in body, false, "email must never appear on the public profile response");
});

test("a Person with no bio or github_login returns null for those fields, not an error", async () => {
  store.createPerson({ email: "noextra@example.com", handle: "noextra" });
  const res = await fetch(`${base}/api/profile/noextra`);
  const body = await res.json();
  assert.equal(body.bio, null);
  assert.equal(body.github_login, null);
});

test("the raw bio is returned as-is, unescaped — the page relies on client-side textContent, not server-side HTML escaping", async () => {
  store.createPerson({ email: "raw@example.com", handle: "rawbio", bio: "<script>alert(1)</script> & stuff" });
  const res = await fetch(`${base}/api/profile/rawbio`);
  const body = await res.json();
  assert.equal(body.bio, "<script>alert(1)</script> & stuff");
});

test("GET /@handle serves an HTML shell — same static template regardless of handle", async () => {
  const known = await fetch(`${base}/@grace`);
  assert.equal(known.status, 200);
  assert.match(known.headers.get("content-type"), /text\/html/);
  const html = await known.text();
  assert.match(html, /<html/);
  assert.match(html, /api\/profile\//, "shell must fetch the profile API client-side");
  assert.doesNotMatch(html, /<script>alert\(1\)/, "no bio content is ever server-rendered into the HTML");

  const unknown = await fetch(`${base}/@nobody-such-handle`);
  assert.equal(unknown.status, 200, "shell is served even for a handle that doesn't exist — the client resolves not-found");
});

test("GET /@ with no handle segment is rejected", async () => {
  const res = await fetch(`${base}/@`);
  assert.equal(res.status, 404);
});

test("GET /@handle/extra (path with an extra segment) is rejected, not treated as a handle", async () => {
  const res = await fetch(`${base}/@grace/extra`);
  assert.equal(res.status, 404);
});
