import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-test-github-badge-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;

const store = await import("../dist/core/store.js");
const { ScopeError } = await import("../dist/core/types.js");
const { createServer } = await import("../dist/server/server.js");

// Network mode Piece 1 Task 5 (task-mrl5ilb357): a Person may self-declare a
// GitHub username on their profile (not OAuth-verified), authenticated by
// their own person_session cookie.

test("isValidGithubLogin enforces GitHub's own username rules", () => {
  assert.equal(store.isValidGithubLogin("octocat"), true);
  assert.equal(store.isValidGithubLogin("a"), true);
  assert.equal(store.isValidGithubLogin("a-b-c"), true);
  assert.equal(store.isValidGithubLogin("a".repeat(39)), true);
  assert.equal(store.isValidGithubLogin("a".repeat(40)), false, "too long");
  assert.equal(store.isValidGithubLogin("-octocat"), false, "leading hyphen");
  assert.equal(store.isValidGithubLogin("octocat-"), false, "trailing hyphen");
  assert.equal(store.isValidGithubLogin("octo--cat"), false, "consecutive hyphens");
  assert.equal(store.isValidGithubLogin(""), false, "empty");
  assert.equal(store.isValidGithubLogin("octo cat"), false, "space not allowed");
});

test("setPersonGithubLogin sets, clears (null), and rejects an invalid format", () => {
  const person = store.createPerson({ email: "linker@example.com", handle: "linker" });
  assert.equal(person.github_login, null);

  const linked = store.setPersonGithubLogin(person.id, "octocat");
  assert.equal(linked.github_login, "octocat");

  const cleared = store.setPersonGithubLogin(person.id, null);
  assert.equal(cleared.github_login, null);

  assert.throws(
    () => store.setPersonGithubLogin(person.id, "-bad"),
    (err) => err instanceof ScopeError,
  );
});

test("setPersonGithubLogin rejects an unknown personId", () => {
  assert.throws(
    () => store.setPersonGithubLogin("no-such-person", "octocat"),
    (err) => err instanceof ScopeError,
  );
});

const server = createServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

test("POST /api/person/github with no session cookie is rejected", async () => {
  const res = await fetch(`${base}/api/person/github`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ githubLogin: "octocat" }),
  });
  assert.equal(res.status, 401);
});

test("a signed-in Person can link, and the badge appears on their public profile", async () => {
  const request = store.requestPersonLogin("ghlink@example.com");
  const verify = store.verifyPersonLogin({ token: request.token, handle: "ghlinker" });
  const cookie = `person_session=${verify.session.token}`;

  const link = await fetch(`${base}/api/person/github`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ githubLogin: "octocat" }),
  });
  assert.equal(link.status, 200);
  const linkBody = await link.json();
  assert.equal(linkBody.person.github_login, "octocat");

  const profile = await fetch(`${base}/api/profile/ghlinker`);
  const profileBody = await profile.json();
  assert.equal(profileBody.github_login, "octocat");
});

test("an invalid GitHub username is rejected with 400, not silently stored", async () => {
  const request = store.requestPersonLogin("ghbad@example.com");
  const verify = store.verifyPersonLogin({ token: request.token, handle: "ghbad" });
  const cookie = `person_session=${verify.session.token}`;

  const res = await fetch(`${base}/api/person/github`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ githubLogin: "-not-valid" }),
  });
  assert.equal(res.status, 400);

  const profile = await fetch(`${base}/api/profile/ghbad`);
  assert.equal((await profile.json()).github_login, null);
});

test("passing githubLogin: null unlinks an existing badge", async () => {
  const request = store.requestPersonLogin("ghunlink@example.com");
  const verify = store.verifyPersonLogin({ token: request.token, handle: "ghunlink" });
  const cookie = `person_session=${verify.session.token}`;

  await fetch(`${base}/api/person/github`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ githubLogin: "octocat" }),
  });
  const unlink = await fetch(`${base}/api/person/github`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ githubLogin: null }),
  });
  assert.equal(unlink.status, 200);
  assert.equal((await unlink.json()).person.github_login, null);
});

test("a bogus/expired session cookie is rejected just like no cookie at all", async () => {
  const res = await fetch(`${base}/api/person/github`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "person_session=totally-made-up" },
    body: JSON.stringify({ githubLogin: "octocat" }),
  });
  assert.equal(res.status, 401);
});
