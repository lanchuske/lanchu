import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-runtimes-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;

const { detectRuntimes, findOnPath } = await import("../dist/core/runtimes.js");
const store = await import("../dist/core/store.js");
const presence = await import("../dist/core/presence.js");

test("detectRuntimes finds a present CLI with version+path and skips absent ones", () => {
  // `node` is guaranteed present wherever these tests run; the other is not.
  const list = detectRuntimes({
    known: [
      { name: "Node.js", cmd: "node" },
      { name: "Ghost CLI", cmd: "definitely-not-a-real-agent-cli" },
    ],
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].cmd, "node");
  assert.ok(list[0].path.length > 0, "resolved to a PATH location");
  assert.match(list[0].version ?? "", /v?\d+\./, "captured a version line");
});

test("findOnPath resolves real commands and returns null for missing ones", () => {
  assert.ok(findOnPath("node"));
  assert.equal(findOnPath("definitely-not-a-real-agent-cli"), null);
});

test("availableTeammates lists idle non-retired agents with role and open count", async () => {
  // "Idle" means no live transport AND no activity within the presence window
  // (same isPresent semantics as findReuseCandidates). Shrink the window so
  // the claim we make below doesn't keep the agent "present" for 45s.
  process.env.LANCHU_ACTIVE_SECONDS = "1";
  test.after(() => { delete process.env.LANCHU_ACTIVE_SECONDS; });
  const org = store.getOrCreateOrg("avail-org");
  const project = store.getOrCreateProject(org.id, "core");
  const role = store.getOrCreateRole(org.id, "generalist", { wildcard: true });

  const idle = store.createAgent({ orgId: org.id, roleId: role.id, name: "idle-one" });
  const t = store.createTask({ projectId: project.id, orgId: org.id, agentId: idle.id, title: "parked work", tags: [] });
  store.claimTask({ agentId: idle.id, taskId: t.id });
  store.endSessionsForAgent(idle.id);

  const busy = store.createAgent({ orgId: org.id, roleId: role.id, name: "busy-one" });
  presence.addLiveSession(busy.id);

  const gone = store.createAgent({ orgId: org.id, roleId: role.id, name: "gone-one" });
  store.endSessionsForAgent(gone.id);
  store.retireAgent(gone.id);

  // Let the (shrunk) presence window elapse past the claim's activity touch.
  await new Promise((r) => setTimeout(r, 1200));
  const list = store.availableTeammates(org.id);
  const names = list.map((a) => a.name);
  assert.ok(names.includes("idle-one"), "idle agent is reusable");
  assert.equal(names.includes("busy-one"), false, "live agent is not");
  assert.equal(names.includes("gone-one"), false, "retired agent is not");

  const mine = list.find((a) => a.name === "idle-one");
  assert.equal(mine.role, "generalist");
  assert.equal(mine.open_tasks, 1);
  presence.removeLiveSession(busy.id);
});
