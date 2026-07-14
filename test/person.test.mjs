import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-test-person-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;

const store = await import("../dist/core/store.js");

function setup(orgName) {
  const org = store.getOrCreateOrg(orgName);
  const project = store.getOrCreateProject(org.id, "web");
  const role = store.getOrCreateRole(org.id, "backend", { tags: ["backend"] });
  return { org, project, role };
}

// Network mode Piece 1 (task-mrl5i20b53): a person row can be created and an
// agent row can reference it via person_id.

test("a person can be created and read back", () => {
  const person = store.createPerson({ email: "ada@example.com", handle: "ada" });
  assert.ok(person.id);
  assert.equal(person.email, "ada@example.com");
  assert.equal(person.handle, "ada");
  assert.equal(person.bio, null);
  assert.equal(person.github_login, null);

  const fetched = store.getPerson(person.id);
  assert.deepEqual(fetched, person);
});

test("getPerson returns null for an unknown id", () => {
  assert.equal(store.getPerson("nope"), null);
});

test("an agent row can reference a person via person_id, kind defaults to human when set", () => {
  const { org, role } = setup("person-org-1");
  const person = store.createPerson({ email: "grace@example.com", handle: "grace" });
  const agent = store.createAgent({
    orgId: org.id,
    roleId: role.id,
    objective: "contribute",
    personId: person.id,
    kind: "human",
  });
  assert.equal(agent.person_id, person.id);
  assert.equal(agent.kind, "human");

  // Round-trips through a fresh read, not just the create-time return value.
  const fetched = store.getAgent(agent.id);
  assert.equal(fetched.person_id, person.id);
  assert.equal(fetched.kind, "human");
});

test("every existing agent-creation path is unaffected — person_id null, kind 'ai' by default", () => {
  const { org, role } = setup("person-org-2");
  const agent = store.createAgent({ orgId: org.id, roleId: role.id, objective: "build" });
  assert.equal(agent.person_id, null);
  assert.equal(agent.kind, "ai");
});

test("email and handle are unique across people", () => {
  store.createPerson({ email: "dup@example.com", handle: "dup-handle" });
  assert.throws(() => store.createPerson({ email: "dup@example.com", handle: "someone-else" }));
  assert.throws(() => store.createPerson({ email: "someone-else@example.com", handle: "dup-handle" }));
});
