import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state; shrink the nudge grace window so tests don't wait.
const dir = path.join(os.tmpdir(), "lanchu-wake-v5-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;
process.env.LANCHU_NUDGE_AFTER_SECONDS = "1";

const store = await import("../dist/core/store.js");
const { runNudgeSweep, NUDGE_LINE } = await import("../dist/server/server.js");
const { bootstrapCommand, installStopHook } = await import("../dist/server/cockpit.js");

function setup(orgName) {
  const org = store.getOrCreateOrg(orgName);
  const project = store.getOrCreateProject(org.id, "core");
  const role = store.getOrCreateRole(org.id, "generalist", { wildcard: true });
  const sender = store.createAgent({ orgId: org.id, roleId: role.id, name: "sender" });
  const parked = store.createAgent({ orgId: org.id, roleId: role.id, name: "parked" });
  store.setAgentWorkspace(parked.id, { cwd: "/tmp/wt" });
  return { org, project, role, sender, parked };
}

const graceElapsed = () => new Promise((r) => setTimeout(r, 1100));

// ── session lifecycle (park / unpark) ───────────────────────────

test("SessionStart captures the session id and clears parked; SessionEnd parks once, audited", () => {
  const { org, parked } = setup("wake5-a");
  store.setAgentClaudeSession(parked.id, "sid-123");
  assert.equal(store.getAgent(parked.id).claude_session_id, "sid-123");
  assert.equal(store.getAgent(parked.id).parked_at, null);

  store.parkAgent(parked.id, "exit");
  const at = store.getAgent(parked.id).parked_at;
  assert.ok(at);
  store.parkAgent(parked.id, "exit"); // idempotent — one event, same stamp
  assert.equal(store.getAgent(parked.id).parked_at, at);
  const evs = store.listAuditEvents(org.id).filter((e) => e.type === "agent.parked");
  assert.equal(evs.length, 1);
  assert.equal(evs[0].data.reason, "exit");
  assert.equal(evs[0].data.claude_session_id, "sid-123");

  // A new session (resume fires SessionStart too) un-parks.
  store.setAgentClaudeSession(parked.id, "sid-123");
  assert.equal(store.getAgent(parked.id).parked_at, null);
});

// ── refire path ─────────────────────────────────────────────────

test("a parked agent with starved notices is refired via claude --resume, audited as transport runner", async () => {
  const { org, sender, parked } = setup("wake5-b");
  store.setAgentClaudeSession(parked.id, "sid-b");
  store.parkAgent(parked.id, "exit");
  store.sendNotice({ orgId: org.id, fromAgentId: sender.id, to: "parked", body: "new work: task-Y" });
  await graceElapsed();

  const fired = [];
  const r = runNudgeSweep({
    alive: () => false,
    transportLive: () => false,
    liveSessions: () => new Set(), // verified absent
    refire: (c, token) => { fired.push({ c, token }); return true; },
  });
  assert.deepEqual(r.refired, ["parked"]);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].c.claude_session_id, "sid-b");
  assert.equal(fired[0].c.cwd, "/tmp/wt");
  assert.ok(fired[0].token, "a fresh session token is minted for the refired terminal");

  const ev = store.listAuditEvents(org.id).find((e) => e.type === "agent.nudged");
  assert.ok(ev);
  assert.equal(ev.data.transport, "runner", "acceptance: audited transport 'runner' on agent.nudged");

  // Cooldown holds for refires too.
  const again = runNudgeSweep({
    alive: () => false, transportLive: () => false,
    liveSessions: () => new Set(), refire: () => { throw new Error("must not refire again"); },
  });
  assert.deepEqual(again.refired, []);
});

test("safety gates: a live MCP transport, a listed claude session, or an UNKNOWN answer all block the refire", async () => {
  const { org, sender, parked } = setup("wake5-c");
  store.setAgentClaudeSession(parked.id, "sid-c");
  store.parkAgent(parked.id);
  store.sendNotice({ orgId: org.id, fromAgentId: sender.id, to: "parked", body: "x" });
  await graceElapsed();

  const boom = () => { throw new Error("refire must not run"); };
  // Gate: live transport.
  let r = runNudgeSweep({ alive: () => false, transportLive: () => true, liveSessions: () => new Set(), refire: boom });
  assert.deepEqual(r.refired, []);
  // Gate: session still listed by `claude agents --json` (fork risk).
  r = runNudgeSweep({ alive: () => false, transportLive: () => false, liveSessions: () => new Set(["sid-c"]), refire: boom });
  assert.deepEqual(r.refired, []);
  // Gate: liveness unknown → fail CLOSED.
  r = runNudgeSweep({ alive: () => false, transportLive: () => false, liveSessions: () => null, refire: boom });
  assert.deepEqual(r.refired, []);
});

test("a crashed session (no SessionEnd) refires only when its terminal is verifiably dead", async () => {
  const { org, sender, parked } = setup("wake5-d");
  store.setAgentClaudeSession(parked.id, "sid-d"); // NOT parked — crash scenario
  store.setAgentTerminal(parked.id, { method: "tmux", id: "%42" });
  store.sendNotice({ orgId: org.id, fromAgentId: sender.id, to: "parked", body: "x" });
  await graceElapsed();

  // Terminal still alive → the nudge rung owns it; refire must not fire for
  // THIS agent (the sweep spans every org, so filter by session id).
  const fired = [];
  let r = runNudgeSweep({
    alive: () => true,
    transportLive: () => false,
    liveSessions: () => new Set(),
    nudge: () => "tmux",
    refire: (c) => { fired.push(c.claude_session_id); return true; },
  });
  assert.ok(r.nudged.includes("parked"), "live terminal → classic nudge");
  assert.ok(!fired.includes("sid-d"), "nudged agent is never double-handled by refire");

  // Fresh starvation, terminal dead → the crash case refires.
  store.sendNotice({ orgId: org.id, fromAgentId: sender.id, to: "parked", body: "y" });
  await graceElapsed();
  // Wait out the cooldown from the nudge above by resetting it: use a fresh org instead.
  const org2 = setup("wake5-d2");
  store.setAgentClaudeSession(org2.parked.id, "sid-d2");
  store.setAgentTerminal(org2.parked.id, { method: "tmux", id: "%43" });
  store.sendNotice({ orgId: org2.org.id, fromAgentId: org2.sender.id, to: "parked", body: "z" });
  await graceElapsed();
  r = runNudgeSweep({
    alive: () => false,
    transportLive: () => false,
    liveSessions: () => new Set(),
    refire: (c) => { fired.push(c.claude_session_id); return true; },
  });
  assert.ok(fired.includes("sid-d2"), "dead terminal + absent session → refire");
});

// ── spawn plumbing ──────────────────────────────────────────────

test("bootstrapCommand carries --resume with the prompt as a CLI arg after --", () => {
  const cmd = bootstrapCommand("/tmp/wt", "tok", NUDGE_LINE, "parked", "parked", undefined, "sid-x");
  assert.match(cmd, /--resume 'sid-x' /);
  assert.match(cmd, /-- 'You have Lanchu notices/, "prompt rides as a CLI arg — a bare resume never triggers a turn");
  const plain = bootstrapCommand("/tmp/wt", "tok", "hi", "a", "a");
  assert.ok(!plain.includes("--resume"));
});

test("installStopHook installs Stop + SessionStart + SessionEnd hooks, idempotently", () => {
  const wt = path.join(dir, "hook-wt");
  fs.mkdirSync(wt, { recursive: true });
  assert.equal(installStopHook(wt, "tok-1", "parked"), true);
  assert.equal(installStopHook(wt, "tok-2", "parked"), true); // respawn — no duplicates
  const settings = JSON.parse(fs.readFileSync(path.join(wt, ".claude", "settings.local.json"), "utf8"));
  for (const ev of ["Stop", "SessionStart", "SessionEnd"]) {
    assert.equal(settings.hooks[ev].length, 1, ev + " installed exactly once");
  }
  const start = settings.hooks.SessionStart[0].hooks[0].command;
  assert.match(start, /\/hooks\/agent\/session-start/);
  assert.match(start, /--data-binary @-/, "relays the hook's stdin JSON (session_id) verbatim");
  assert.match(start, /exit 0$/, "lifecycle reporting never blocks the session");
  assert.match(settings.hooks.SessionEnd[0].hooks[0].command, /\/hooks\/agent\/session-end/);
});
