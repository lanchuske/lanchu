import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-release-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;
delete process.env.LANCHU_SDLC;
delete process.env.LANCHU_RELEASE_MAX_CHANGES; // default 5
delete process.env.LANCHU_RELEASE_MAX_AGE_HOURS; // default 48

const store = await import("../dist/core/store.js");

const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();

function setup(orgName) {
  const org = store.getOrCreateOrg(orgName);
  const project = store.getOrCreateProject(org.id, "core");
  const product = store.createAgent({
    orgId: org.id, roleId: store.getOrCreateRole(org.id, "product", { wildcard: true }).id, name: "product",
  });
  return { org, project, product };
}

const releaseTasks = (projectId) =>
  store.listTasks(projectId).filter((t) => t.title.startsWith("Release train:"));

test("below both thresholds: pressure is visible but no task fires", () => {
  const ctx = setup("release-calm-org");
  const { created } = store.runReleaseSweep({
    releaseInfo: (p) => (p.id === ctx.project.id ? { lastTag: "v0.5.11", unreleased: 3, oldestIso: hoursAgo(5) } : null),
  });
  assert.deepEqual(created, []);
  assert.equal(releaseTasks(ctx.project.id).length, 0);

  const snap = store.boardSnapshot(ctx.org.id);
  assert.equal(snap.release.length, 1, "pressure rides the board");
  assert.equal(snap.release[0].unreleased, 3);
  assert.equal(snap.release[0].last_tag, "v0.5.11");
  assert.equal(snap.release[0].threshold_hit, false);
});

test("5+ unreleased changes queue ONE release checklist task, deduped per tag", () => {
  const ctx = setup("release-count-org");
  const info = (p) => (p.id === ctx.project.id ? { lastTag: "v0.6.0", unreleased: 6, oldestIso: hoursAgo(10) } : null);

  const first = store.runReleaseSweep({ releaseInfo: info });
  assert.equal(first.created.length, 1);
  const tasks = releaseTasks(ctx.project.id);
  assert.equal(tasks.length, 1);
  assert.match(tasks[0].title, /since v0\.6\.0/);
  assert.match(tasks[0].title, /NEVER auto-published/);
  assert.equal(tasks[0].status, "available", "queued for a human/authorized agent — not executed");

  // product hears about the pressure.
  const heard = store.takeUndeliveredNotices(ctx.product.id);
  assert.ok(heard.some((n) => /Release pressure on core: 6 unreleased/.test(n.body)));

  // Same episode (same tag): the sweep never duplicates the checklist.
  const second = store.runReleaseSweep({ releaseInfo: info });
  assert.deepEqual(second.created, []);
  assert.equal(releaseTasks(ctx.project.id).length, 1);
});

test("age alone crosses the threshold (1 change older than 48h)", () => {
  const ctx = setup("release-age-org");
  const { created } = store.runReleaseSweep({
    releaseInfo: (p) => (p.id === ctx.project.id ? { lastTag: "v1.0.0", unreleased: 1, oldestIso: hoursAgo(49) } : null),
  });
  assert.equal(created.length, 1);
  assert.equal(store.boardSnapshot(ctx.org.id).release[0].threshold_hit, true);
});

test("a new tag starts a new episode: counter resets, a later burst fires again", () => {
  const ctx = setup("release-episode-org");
  store.runReleaseSweep({
    releaseInfo: (p) => (p.id === ctx.project.id ? { lastTag: "v2.0.0", unreleased: 7, oldestIso: hoursAgo(3) } : null),
  });
  assert.equal(releaseTasks(ctx.project.id).length, 1);

  // The team ships: new tag, zero unreleased. No new task, pressure clears.
  const afterShip = store.runReleaseSweep({
    releaseInfo: (p) => (p.id === ctx.project.id ? { lastTag: "v2.0.1", unreleased: 0, oldestIso: null } : null),
  });
  assert.deepEqual(afterShip.created, []);
  const snap = store.boardSnapshot(ctx.org.id);
  assert.equal(snap.release[0].unreleased, 0);
  assert.equal(snap.release[0].threshold_hit, false);

  // Debt builds again on the NEW tag → a fresh checklist fires (old one is done history).
  const nextBurst = store.runReleaseSweep({
    releaseInfo: (p) => (p.id === ctx.project.id ? { lastTag: "v2.0.1", unreleased: 5, oldestIso: hoursAgo(1) } : null),
  });
  assert.equal(nextBurst.created.length, 1);
  assert.equal(releaseTasks(ctx.project.id).length, 2);
  assert.match(releaseTasks(ctx.project.id)[1].title, /since v2\.0\.1/);
});

test("untagged repos are skipped entirely", () => {
  const ctx = setup("release-untagged-org");
  const { created } = store.runReleaseSweep({ releaseInfo: () => null });
  assert.deepEqual(created, []);
  assert.equal(store.boardSnapshot(ctx.org.id).release.length, 0);
});

// ── Work board v3: release stamping (rc → released by tag coverage) ──

function shipVerified(ctx, title, doneIso) {
  const raw = (globalThis.__openDb ??= null);
  const t = store.createTask({ projectId: ctx.project.id, orgId: ctx.org.id, agentId: ctx.product.id, title, tags: [] });
  store.claimTask({ agentId: ctx.product.id, taskId: t.id });
  // Manufacture a QA-passed row directly: status done, stage rc, done_at set.
  const { openDb } = awaitedDb;
  openDb()
    .prepare("UPDATE task SET status = 'done', stage = 'rc', done_at = ? WHERE id = ?")
    .run(doneIso, t.id);
  return t;
}
const awaitedDb = await import("../dist/db/db.js");

test("stamping: rc work covered by a tag becomes released with that version; later work stays rc", () => {
  const ctx = setup("stamp-org");
  const early = shipVerified(ctx, "shipped before the tag", "2026-07-10T10:00:00.000Z");
  const late = shipVerified(ctx, "merged after the tag", "2026-07-12T10:00:00.000Z");

  store.runReleaseSweep({
    releaseInfo: (p) => (p.id === ctx.project.id ? { lastTag: "v0.9.0", unreleased: 1, oldestIso: hoursAgo(1) } : null),
    tagList: (p) => (p.id === ctx.project.id
      ? [
          { tag: "v0.8.0", dateIso: "2026-07-09T00:00:00.000Z" },
          { tag: "v0.9.0", dateIso: "2026-07-11T00:00:00.000Z" },
        ]
      : null),
  });

  const a = store.getTask(early.id);
  assert.equal(a.stage, "released");
  assert.equal(a.release_version, "v0.9.0", "earliest covering tag, not the newest");
  const b = store.getTask(late.id);
  assert.equal(b.stage, "rc", "post-tag work awaits the next release");
  assert.equal(b.release_version, null);

  // The stamp is audited with the version.
  const ev = store
    .listAuditEvents(ctx.org.id, 50)
    .find((e) => e.type === "task.stage_changed" && e.subject_id === early.id);
  assert.ok(ev, "stamp audited");
  assert.equal(ev.data.release_version, "v0.9.0");
  assert.equal(ev.data.to_stage, "released");
});

test("stamping backfill: legacy stage=done rows get a version or normalize to rc; instruments untouched", () => {
  const ctx = setup("stamp-backfill-org");
  const db = awaitedDb.openDb();
  const legacyShipped = shipVerified(ctx, "old feature shipped in v1", "2026-07-01T00:00:00.000Z");
  const legacyPending = shipVerified(ctx, "old feature not yet shipped", "2026-07-12T00:00:00.000Z");
  db.prepare("UPDATE task SET stage = 'done' WHERE id IN (?, ?)").run(legacyShipped.id, legacyPending.id);
  // A verification instrument: done/done, must never join a release.
  const instrument = store.createTask({
    projectId: ctx.project.id, orgId: ctx.org.id, agentId: ctx.product.id,
    title: "QA: verify task-x against its acceptance criteria", tags: [],
  });
  db.prepare("UPDATE task SET status='done', stage='done', done_at=?, parent_task_id=? WHERE id = ?")
    .run("2026-07-01T00:00:00.000Z", legacyShipped.id, instrument.id);

  store.runReleaseSweep({
    releaseInfo: (p) => (p.id === ctx.project.id ? { lastTag: "v1.0.0", unreleased: 0, oldestIso: null } : null),
    tagList: (p) => (p.id === ctx.project.id ? [{ tag: "v1.0.0", dateIso: "2026-07-05T00:00:00.000Z" }] : null),
  });

  assert.equal(store.getTask(legacyShipped.id).stage, "released");
  assert.equal(store.getTask(legacyShipped.id).release_version, "v1.0.0");
  assert.equal(store.getTask(legacyPending.id).stage, "rc", "unreleased legacy done normalizes to rc");
  assert.equal(store.getTask(instrument.id).stage, "done", "gate instruments never enter the pipeline");
  assert.equal(store.getTask(instrument.id).release_version, null);

  // Idempotent: a second sweep changes nothing further.
  const before = JSON.stringify(store.listTasks(ctx.project.id));
  store.runReleaseSweep({
    releaseInfo: (p) => (p.id === ctx.project.id ? { lastTag: "v1.0.0", unreleased: 0, oldestIso: null } : null),
    tagList: (p) => (p.id === ctx.project.id ? [{ tag: "v1.0.0", dateIso: "2026-07-05T00:00:00.000Z" }] : null),
  });
  assert.equal(JSON.stringify(store.listTasks(ctx.project.id)), before);
});

test("stamping prefers the recorded pr.merged time over done_at", () => {
  const ctx = setup("stamp-merge-time-org");
  // QA verified AFTER the tag (done_at late), but the PR merged BEFORE it —
  // the work shipped in the tag and must be stamped with it.
  const t = shipVerified(ctx, "merged early, verified late", "2026-07-12T09:00:00.000Z");
  store.recordEvent({
    org_id: ctx.org.id, project_id: ctx.project.id, type: "pr.merged",
    actor_agent_id: null, subject_kind: "task", subject_id: t.id, data: { pr_number: 42 },
  });
  awaitedDb.openDb()
    .prepare("UPDATE event SET created_at = ? WHERE type = 'pr.merged' AND subject_id = ?")
    .run("2026-07-10T00:00:00.000Z", t.id);

  store.runReleaseSweep({
    releaseInfo: (p) => (p.id === ctx.project.id ? { lastTag: "v2.0.0", unreleased: 0, oldestIso: null } : null),
    tagList: (p) => (p.id === ctx.project.id ? [{ tag: "v2.0.0", dateIso: "2026-07-11T00:00:00.000Z" }] : null),
  });

  assert.equal(store.getTask(t.id).stage, "released");
  assert.equal(store.getTask(t.id).release_version, "v2.0.0");
});
