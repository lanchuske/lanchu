import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-docs-lifecycle-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;

const store = await import("../dist/core/store.js");

function setup(orgName) {
  const org = store.getOrCreateOrg(orgName);
  const role = store.getOrCreateRole(org.id, "generalist", { wildcard: true });
  const agent = store.createAgent({ orgId: org.id, roleId: role.id, objective: "write things" });
  return { org, role, agent };
}

// ── inference (title-pattern fallback) ──────────────────────────

test("inferDocLifecycle: records are QA/Incident/Bug/Report prefixes, logs, postmortems, dated titles", () => {
  const record = [
    "QA batch 2026-07-11 FINAL",
    "QA: verify the panel",
    "Incident: two-agents-one-worktree collision (2026-07-11)",
    "Bug: panel shows agents but wrong state",
    "Report: weekly distribution",
    "User feedback log",
    "Postmortem of the restart loop",
    "npm distribution health 2026-07-11",
  ];
  for (const t of record) assert.equal(store.inferDocLifecycle(t), "record", t);

  const living = [
    "Vision: AI thinks — infrastructure coordinates",
    "Roadmap",
    "Design: SDLC state machine",
    "Design: orchestrating agents on Claude Code",
    "Competitive landscape & positioning (2026-07)", // month, not a full date
    "Launch — Show HN",
    "Landing queue — merge-train coordination (decision + contract)",
  ];
  for (const t of living) assert.equal(store.inferDocLifecycle(t), "living", t);
});

// ── upsert behavior ─────────────────────────────────────────────

test("new docs get the producer's lifecycle, or the title inference as fallback", () => {
  const { org, agent } = setup("docsv2-a");
  const inferred = store.upsertDoc({
    orgId: org.id, agentId: agent.id,
    title: "QA batch 2026-07-11 b9", content: "evidence",
  });
  assert.equal(inferred.lifecycle, "record");

  const explicit = store.upsertDoc({
    orgId: org.id, agentId: agent.id,
    title: "QA playbook", content: "how we verify", lifecycle: "living",
  });
  assert.equal(explicit.lifecycle, "living");

  const design = store.upsertDoc({
    orgId: org.id, agentId: agent.id,
    title: "Design: memory architecture", content: "three scopes",
  });
  assert.equal(design.lifecycle, "living");
});

test("updating a doc keeps its lifecycle unless explicitly changed", () => {
  const { org, agent } = setup("docsv2-b");
  const d = store.upsertDoc({
    orgId: org.id, agentId: agent.id,
    title: "Roadmap", content: "v1", lifecycle: "living",
  });
  const updated = store.upsertDoc({ orgId: org.id, agentId: agent.id, id: d.id, title: "Roadmap", content: "v2" });
  assert.equal(updated.lifecycle, "living");
  const flipped = store.upsertDoc({
    orgId: org.id, agentId: agent.id, id: d.id, title: "Roadmap", content: "v3", lifecycle: "record",
  });
  assert.equal(flipped.lifecycle, "record");
});

// ── ordering & archive ──────────────────────────────────────────

test("listDocs puts living docs before records", () => {
  const { org, agent } = setup("docsv2-c");
  store.upsertDoc({ orgId: org.id, agentId: agent.id, title: "QA batch 2026-07-11 z", content: "r" });
  store.upsertDoc({ orgId: org.id, agentId: agent.id, title: "Vision", content: "l" });
  const docs = store.listDocs(org.id);
  assert.equal(docs.length, 2);
  assert.equal(docs[0].lifecycle, "living");
  assert.equal(docs[1].lifecycle, "record");
});

test("archiveDoc soft-hides: gone from listDocs/searchDocs, still in the DB, idempotent", () => {
  const { org, agent } = setup("docsv2-d");
  const d = store.upsertDoc({ orgId: org.id, agentId: agent.id, title: "QA batch 2026-07-01 old", content: "stale evidence" });
  const archived = store.archiveDoc({ docId: d.id, reason: "superseded by the cycle-2 gate doc" });
  assert.ok(archived.archived_at);

  assert.ok(!store.listDocs(org.id).some((x) => x.id === d.id));
  assert.ok(!store.searchDocs(org.id, "stale evidence").some((x) => x.id === d.id));
  assert.ok(store.listDocs(org.id, { includeArchived: true }).some((x) => x.id === d.id));
  assert.ok(store.getDoc(d.id), "row survives — soft-hide, never delete");

  const again = store.archiveDoc({ docId: d.id });
  assert.equal(again.archived_at, archived.archived_at);
});
