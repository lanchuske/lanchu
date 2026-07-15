import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-test-network-intake-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;

const store = await import("../dist/core/store.js");
const { createServer } = await import("../dist/server/server.js");

// Network mode Piece 2 Task 1 (task-mrl5t4z958): idea intake → exactly one
// org + one project, 1:1:1, network-mode from birth, local_path NULL. The
// form at /idea is a static shell posting to /api/network/idea. See
// "Design: Idea intake & the moderator (network mode — Piece 2)".

const server = createServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

test("createIdeaIntake produces exactly one org + one project, network-mode on, no local path", () => {
  const result = store.createIdeaIntake({
    title: "Recipe Sharing App",
    description: "A site where people share and rate recipes.",
  });
  assert.equal(result.org.name, "recipe-sharing-app");
  const projects = store.listProjects(result.org.id);
  assert.equal(projects.length, 1, "one idea = one org = one project");
  assert.equal(projects[0].id, result.project.id);
  assert.equal(result.project.network_mode, true);
  assert.equal(result.project.local_path, null);
  assert.equal(result.project.repo_url, null);
  assert.equal(result.project.name, result.org.name);
});

test("a title collision appends a suffix — a second idea never lands in an existing org", () => {
  const first = store.createIdeaIntake({ title: "Todo List", description: "The first todo idea." });
  const second = store.createIdeaIntake({ title: "Todo List", description: "A different todo idea." });
  assert.equal(first.org.name, "todo-list");
  assert.equal(second.org.name, "todo-list-2");
  assert.notEqual(second.org.id, first.org.id);
  assert.equal(store.listProjects(second.org.id).length, 1);
});

test("the submitted idea is stored as a doc in the new org for the moderator to read", () => {
  const result = store.createIdeaIntake({
    title: "Bird Atlas",
    description: "Crowdsourced sightings map for birds.",
  });
  const doc = store.getDoc(result.ideaDocId);
  assert.equal(doc.org_id, result.org.id);
  assert.equal(doc.title, "Idea: Bird Atlas");
  assert.equal(doc.content, "Crowdsourced sightings map for birds.");
});

test("an optional repo_url is stored; local_path stays NULL either way", () => {
  const result = store.createIdeaIntake({
    title: "With Repo",
    description: "Idea that already has a repository.",
    repoUrl: "https://github.com/example/with-repo",
  });
  assert.equal(result.project.repo_url, "https://github.com/example/with-repo");
  assert.equal(result.project.local_path, null);
});

test("empty or oversize submissions are rejected before any org/project row is created", () => {
  const orgsBefore = store.listOrgs().length;
  assert.throws(() => store.createIdeaIntake({ title: "  ", description: "desc" }), /title required/);
  assert.throws(() => store.createIdeaIntake({ title: "ok", description: "" }), /description required/);
  assert.throws(
    () => store.createIdeaIntake({ title: "x".repeat(201), description: "desc" }),
    /title too long/,
  );
  assert.throws(
    () => store.createIdeaIntake({ title: "ok", description: "x".repeat(10_001) }),
    /description too long/,
  );
  assert.equal(store.listOrgs().length, orgsBefore, "rejected submissions must not create orgs");
});

test("POST /api/network/idea creates the records and returns the org slug + project id", async () => {
  const res = await fetch(`${base}/api/network/idea`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Plant Care Bot",
      description:
        "A bot that reminds people to water their plants: each user registers their plants with a species and a location, and the bot messages them a watering schedule tuned to each species.",
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.org, "plant-care-bot");
  assert.ok(body.project_id);
  const project = store.getProject(body.project_id);
  assert.equal(project.network_mode, true);
  assert.equal(project.local_path, null);
});

// Piece 2 Task 4 (task-mrl5tg9y61): a vague description is asked ONE
// follow-up question before any org/project is created; a well-specified
// one passes straight through; the resubmission always proceeds.

test("ideaClarifyingQuestion asks for short/detail-free text and passes well-specified or linked text", () => {
  assert.ok(store.ideaClarifyingQuestion("an app for dogs"));
  assert.ok(store.ideaClarifyingQuestion("something with AI that makes money fast please"));
  assert.equal(
    store.ideaClarifyingQuestion(
      "A marketplace where local bakers list tomorrow's surplus bread and neighbors reserve a loaf for pickup, with a waitlist when a bakery sells out.",
    ),
    undefined,
  );
  assert.equal(
    store.ideaClarifyingQuestion("Like the prototype at https://example.com/demo but multiplayer"),
    undefined,
    "a URL counts as concrete detail",
  );
});

test("a vague POST gets clarification_needed and creates nothing", async () => {
  const orgsBefore = store.listOrgs().length;
  const res = await fetch(`${base}/api/network/idea`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Dog App", description: "an app for dogs" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.clarification_needed, true);
  assert.ok(body.question);
  assert.equal("org" in body, false);
  assert.equal(store.listOrgs().length, orgsBefore, "a clarification round must not create orgs");
});

test("resubmitting with a clarification proceeds and lands the clarification in the idea doc", async () => {
  const res = await fetch(`${base}/api/network/idea`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Dog App",
      description: "an app for dogs",
      clarification: "Owners log walks and get a weekly activity report per dog.",
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.org, "dog-app");
  const org = store.getOrgByName("dog-app");
  const doc = store
    .docsIndexFor(org.id)
    .map((d) => store.getDoc(d.id))
    .find((d) => d.title === "Idea: Dog App");
  assert.match(doc.content, /an app for dogs/);
  assert.match(doc.content, /Clarification: Owners log walks/);
});

test("the intake shell carries the clarification step renderer", async () => {
  const res = await fetch(`${base}/idea`);
  const html = await res.text();
  assert.match(html, /clarification_needed/, "form must handle the one-question round client-side");
});

test("the created project is discoverable in the Piece 6 network directory", async () => {
  const created = store.createIdeaIntake({ title: "Directory Visible", description: "Should show up." });
  const res = await fetch(`${base}/api/network/projects`);
  const body = await res.json();
  assert.ok(
    body.projects.some((p) => p.projectId === created.project.id),
    "an intake-created project must appear in /api/network/projects",
  );
});

test("POST /api/network/idea rejects a missing description with 400 and creates nothing", async () => {
  const orgsBefore = store.listOrgs().length;
  const res = await fetch(`${base}/api/network/idea`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "No Description" }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /description required/);
  assert.equal(store.listOrgs().length, orgsBefore);
});

test("GET /idea serves a static HTML shell that posts to the API client-side", async () => {
  const res = await fetch(`${base}/idea`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  const html = await res.text();
  assert.match(html, /<html/);
  assert.match(html, /api\/network\/idea/, "shell must post to the intake API client-side");
});
