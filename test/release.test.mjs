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
