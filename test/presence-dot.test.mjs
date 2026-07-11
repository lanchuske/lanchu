import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-presence-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;

const store = await import("../dist/core/store.js");
const presence = await import("../dist/core/presence.js");

function setup(orgName) {
  const org = store.getOrCreateOrg(orgName);
  const project = store.getOrCreateProject(org.id, "web");
  const role = store.getOrCreateRole(org.id, "builder", { tags: [] });
  const agent = store.createAgent({ orgId: org.id, roleId: role.id, objective: "build things" });
  return { org, project, role, agent };
}

const fresh = (id) => store.getAgent(id);
// Let a 1ms working window actually lapse before asserting staleness.
const lapse = () => new Promise((r) => setTimeout(r, 10));

// ── no terminal probe wired (CLI/test context): recency is the only fallback ──

test("live transport + fresh call = working", () => {
  const { agent } = setup("pres1");
  presence.addLiveSession(agent.id);
  store.touchSeen(agent.id);
  assert.equal(store.presenceOf(fresh(agent.id)), "working");
  presence.removeLiveSession(agent.id);
});

test("live transport but stale calls = idle (at the prompt)", async () => {
  const { agent } = setup("pres2");
  presence.addLiveSession(agent.id);
  store.touchSeen(agent.id);
  process.env.LANCHU_WORKING_WINDOW_MS = "1";
  await lapse();
  try {
    assert.equal(store.presenceOf(fresh(agent.id)), "idle");
  } finally {
    delete process.env.LANCHU_WORKING_WINDOW_MS;
  }
  presence.removeLiveSession(agent.id);
});

test("no transport, no terminal handle: fresh call = working (restart gap), stale = off", async () => {
  const { agent } = setup("pres3");
  store.touchSeen(agent.id);
  assert.equal(store.presenceOf(fresh(agent.id)), "working");
  process.env.LANCHU_WORKING_WINDOW_MS = "1";
  await lapse();
  try {
    assert.equal(store.presenceOf(fresh(agent.id)), "off");
  } finally {
    delete process.env.LANCHU_WORKING_WINDOW_MS;
  }
});

test("never-seen agent with nothing open = off", () => {
  const { agent } = setup("pres4");
  assert.equal(store.presenceOf(fresh(agent.id)), "off");
});

test("retired agents are off regardless of signals", () => {
  const { agent } = setup("pres5");
  presence.addLiveSession(agent.id);
  store.touchSeen(agent.id);
  store.setAgentState(agent.id, "retired");
  assert.equal(store.presenceOf(fresh(agent.id)), "off");
  presence.removeLiveSession(agent.id);
});

// ── probe wired (server context): the terminal decides reachability ──
// Registered after the no-probe tests above; module state persists per file.

test("alive terminal without transport = idle; working when calls are fresh", async () => {
  const { agent } = setup("pres6");
  store.setAgentTerminal(agent.id, { method: "tmux", id: "%alive-1" });
  store.setTerminalAliveProbe((ref) => ref.id.startsWith("%alive"));
  store.touchSeen(agent.id);
  assert.equal(store.presenceOf(fresh(agent.id)), "working");
  process.env.LANCHU_WORKING_WINDOW_MS = "1";
  await lapse();
  try {
    assert.equal(store.presenceOf(fresh(agent.id)), "idle");
  } finally {
    delete process.env.LANCHU_WORKING_WINDOW_MS;
  }
});

test("dead terminal without transport = off, even right after a call", () => {
  const { agent } = setup("pres7");
  store.setAgentTerminal(agent.id, { method: "tmux", id: "%dead-1" });
  store.setTerminalAliveProbe((ref) => ref.id.startsWith("%alive"));
  store.touchSeen(agent.id); // closed terminal must read gray immediately
  assert.equal(store.presenceOf(fresh(agent.id)), "off");
});

test("a live transport wins over a dead terminal handle", () => {
  const { agent } = setup("pres8");
  store.setAgentTerminal(agent.id, { method: "tmux", id: "%dead-2" });
  store.setTerminalAliveProbe(() => false);
  presence.addLiveSession(agent.id);
  store.touchSeen(agent.id);
  assert.equal(store.presenceOf(fresh(agent.id)), "working");
  presence.removeLiveSession(agent.id);
});

test("probe answers are cached per terminal handle (one spawn per window, not per poll)", () => {
  const { agent } = setup("pres9");
  store.setAgentTerminal(agent.id, { method: "tmux", id: "%cached-1" });
  let probes = 0;
  store.setTerminalAliveProbe(() => {
    probes++;
    return true;
  });
  const a = fresh(agent.id);
  store.presenceOf(a);
  store.presenceOf(a);
  store.presenceOf(a);
  assert.equal(probes, 1);
});

// ── the tri-state must ride every surface snapshot ──

test("boardSnapshot, graph and mcpAgentStatus carry presence", () => {
  const { org, agent } = setup("pres10");
  store.setTerminalAliveProbe(() => false);
  presence.addLiveSession(agent.id);
  store.touchSeen(agent.id);

  const board = store.boardSnapshot(org.id);
  const onBoard = board.agents.find((a) => a.id === agent.id);
  assert.equal(onBoard.presence, "working");

  const mcp = store.mcpAgentStatus(org.id).find((a) => a.id === agent.id);
  assert.equal(mcp.presence, "working");

  // The graph only adds an agent node when the audit window references it —
  // touch a task so the agent shows up.
  const project = store.getOrCreateProject(org.id, "web");
  const t = store.createTask({ projectId: project.id, orgId: org.id, agentId: agent.id, title: "x", tags: [] });
  store.claimTask({ agentId: agent.id, taskId: t.id });
  const graph = store.orgGraph(org.id, 24);
  const node = graph.nodes.find((n) => n.id === agent.id);
  if (node) assert.equal(node.presence, "working");
  presence.removeLiveSession(agent.id);
});

// ── presence v3: PARKED (wake v5 park & refire) ──

test("a parked agent reads parked — even with a Terminal window still open at a shell prompt", () => {
  const { agent } = setup("pres-parked1");
  store.setAgentTerminal(agent.id, { method: "tmux", id: "%alive-parked" });
  store.setTerminalAliveProbe((ref) => ref.id.startsWith("%alive")); // window alive ≠ agent reachable
  store.touchSeen(agent.id);
  store.parkAgent(agent.id);
  assert.equal(store.presenceOf(fresh(agent.id)), "parked");
});

test("a live transport outranks a stale parked flag; SessionStart clears it for real", () => {
  const { agent } = setup("pres-parked2");
  store.parkAgent(agent.id);
  presence.addLiveSession(agent.id);
  store.touchSeen(agent.id);
  assert.equal(store.presenceOf(fresh(agent.id)), "working", "live transport wins over parked_at");
  presence.removeLiveSession(agent.id);
  assert.equal(store.presenceOf(fresh(agent.id)), "parked", "transport gone — parked again");
  store.setAgentClaudeSession(agent.id, "sess-123"); // the refire path
  store.touchSeen(agent.id);
  assert.equal(store.presenceOf(fresh(agent.id)), "working", "refired agent flips to working");
});

test("parked beats off; retired beats parked", () => {
  const { agent } = setup("pres-parked3");
  store.setTerminalAliveProbe(() => false);
  store.setAgentTerminal(agent.id, { method: "tmux", id: "%dead-parked" });
  store.parkAgent(agent.id);
  assert.equal(store.presenceOf(fresh(agent.id)), "parked", "dead terminal + parked flag = parked, not off");
  store.setAgentState(agent.id, "retired");
  assert.equal(store.presenceOf(fresh(agent.id)), "off");
});

test("boardSnapshot carries parked presence", () => {
  const { org, agent } = setup("pres-parked4");
  store.parkAgent(agent.id);
  const onBoard = store.boardSnapshot(org.id).agents.find((a) => a.id === agent.id);
  assert.equal(onBoard.presence, "parked");
});
