import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-test-person-login-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;

const store = await import("../dist/core/store.js");
const { ScopeError } = await import("../dist/core/types.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Network mode Piece 1 Task 2 (task-mrl5i5vd54): a new email can sign up,
// verify, pick a handle, and receive a working person_session; a second
// request within the rate-limit window is rejected; an expired or
// already-consumed token is rejected.

test("requestPersonLogin rejects an invalid email", () => {
  assert.throws(() => store.requestPersonLogin("not-an-email"));
});

test("a new email signs up: request, verify with a handle, get a working session", () => {
  const request = store.requestPersonLogin("ada@example.com");
  assert.ok(request.token);
  assert.equal(request.email, "ada@example.com");
  assert.equal(request.consumed_at, null);

  const { person, session } = store.verifyPersonLogin({ token: request.token, handle: "ada" });
  assert.equal(person.email, "ada@example.com");
  assert.equal(person.handle, "ada");
  assert.ok(session.token);

  const resolved = store.personForSessionToken(session.token);
  assert.equal(resolved.id, person.id);
});

test("verifying without a handle for a brand-new email is rejected", () => {
  const request = store.requestPersonLogin("nohandle@example.com");
  assert.throws(
    () => store.verifyPersonLogin({ token: request.token }),
    (err) => err instanceof ScopeError,
  );
});

test("an invalid handle format is rejected at signup", () => {
  const request = store.requestPersonLogin("badhandle@example.com");
  assert.throws(
    () => store.verifyPersonLogin({ token: request.token, handle: "AB" }), // too short, uppercase
    (err) => err instanceof ScopeError,
  );
});

test("an EXISTING Person doesn't need a handle to log back in", () => {
  process.env.LANCHU_PERSON_LOGIN_COOLDOWN_SECONDS = "0.001"; // effectively none — irrelevant to what this test checks
  try {
    const first = store.requestPersonLogin("returning@example.com");
    store.verifyPersonLogin({ token: first.token, handle: "returning" });

    const second = store.requestPersonLogin("returning@example.com");
    const { person } = store.verifyPersonLogin({ token: second.token }); // no handle needed
    assert.equal(person.handle, "returning");
  } finally {
    delete process.env.LANCHU_PERSON_LOGIN_COOLDOWN_SECONDS;
  }
});

test("a token can only be used once — replay is rejected", () => {
  const request = store.requestPersonLogin("onceonly@example.com");
  store.verifyPersonLogin({ token: request.token, handle: "onceonly" });

  assert.throws(
    () => store.verifyPersonLogin({ token: request.token }),
    (err) => err instanceof ScopeError,
  );
});

test("an unknown token is rejected", () => {
  assert.throws(
    () => store.verifyPersonLogin({ token: "totally-made-up-token" }),
    (err) => err instanceof ScopeError,
  );
});

test("a second request for the same email within the cooldown window is rejected", () => {
  process.env.LANCHU_PERSON_LOGIN_COOLDOWN_SECONDS = "60"; // the real default, explicit for clarity
  store.requestPersonLogin("ratelimited@example.com");
  assert.throws(
    () => store.requestPersonLogin("ratelimited@example.com"),
    (err) => err instanceof ScopeError,
  );
  delete process.env.LANCHU_PERSON_LOGIN_COOLDOWN_SECONDS;
});

test("a second request for the same email AFTER the cooldown window succeeds", async () => {
  process.env.LANCHU_PERSON_LOGIN_COOLDOWN_SECONDS = "0.05"; // 50ms — fast, deterministic
  store.requestPersonLogin("cooldownpasses@example.com");
  await sleep(120);
  const second = store.requestPersonLogin("cooldownpasses@example.com"); // no throw
  assert.ok(second.token);
  delete process.env.LANCHU_PERSON_LOGIN_COOLDOWN_SECONDS;
});

test("an expired token is rejected", async () => {
  process.env.LANCHU_PERSON_LOGIN_TTL_MINUTES = "0.001"; // 60ms — fast, deterministic
  const request = store.requestPersonLogin("expired@example.com");
  delete process.env.LANCHU_PERSON_LOGIN_TTL_MINUTES;
  await sleep(150);
  assert.throws(
    () => store.verifyPersonLogin({ token: request.token, handle: "expired" }),
    (err) => err instanceof ScopeError,
  );
});

test("personForSessionToken returns null for an unknown or garbage token", () => {
  assert.equal(store.personForSessionToken("nope"), null);
});

test("isValidHandle enforces the design doc's format: lowercase, [a-z0-9-], 3-24 chars", () => {
  assert.equal(store.isValidHandle("ada"), true);
  assert.equal(store.isValidHandle("ada-lovelace-99"), true);
  assert.equal(store.isValidHandle("ab"), false); // too short
  assert.equal(store.isValidHandle("a".repeat(25)), false); // too long
  assert.equal(store.isValidHandle("Ada"), false); // uppercase
  assert.equal(store.isValidHandle("ada_lovelace"), false); // underscore not allowed
});
