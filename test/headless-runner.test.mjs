import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-test-headless-runner-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;

const store = await import("../dist/core/store.js");
const { createServer } = await import("../dist/server/server.js");
const { runHeadlessAgent } = await import("../dist/server/runner.js");

// Network mode Piece 2 Task 2 (task-mrl5t8of59): the hosted headless agent
// runner — an agent with an objective, no terminal, no human machine,
// completes REAL MCP tool calls and exits cleanly, bounded by turns and
// wall-clock. The fake claude's -p mode makes a genuine tools/call
// (task_create) against this very server using the runner-minted token, so
// the whole identity chain is exercised without invoking Claude. See
// "Design: hosted headless agent runner (network mode — Piece 2 Task 2)".

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakeClaude = path.join(root, "test", "fake-claude", process.platform === "win32" ? "claude.cmd" : "claude");

const server = createServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.LANCHU_PORT = String(server.address().port); // mcpUrl() must point the minted config at this instance
test.after(() => server.close());

const org = store.getOrCreateOrg("runner-org");
const project = store.getOrCreateProject(org.id, "runner-org");
const target = {
  orgId: org.id,
  orgName: org.name,
  projectId: project.id,
  projectName: project.name,
};

test("a headless run completes a real MCP tool call in the target org and exits cleanly", async () => {
  const result = await runHeadlessAgent({
    ...target,
    roleName: "moderator",
    objective: "Scope the submitted idea into roles and a first backlog.",
    maxTurns: 5,
    claudeBin: fakeClaude,
  });

  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.sessionId, "fake-session-1234");
  assert.equal(result.numTurns, 2);
  assert.equal(result.costUsd, 0.01);
  assert.match(result.resultText, /created:/);

  // The agent row exists with the spawn_agent shape: system-run, no Person.
  const agent = store.listAgents(org.id).find((a) => a.id === result.agentId);
  assert.equal(agent.name, "moderator");
  assert.equal(agent.kind, "ai");
  assert.equal(agent.person_id, null);
  assert.equal(agent.objective, "Scope the submitted idea into roles and a first backlog.");

  // The REAL tool call landed: the probe task exists in the target project,
  // created by the headless agent's own identity.
  const probe = store.listTasks(project.id).find((t) => t.title === "headless probe task");
  assert.ok(probe, "the headless agent's task_create must land in the target project");
  assert.equal(probe.created_by_agent_id, result.agentId);

  // Credentials retired and the per-run MCP config file cleaned up.
  const leftovers = fs.readdirSync(path.join(dir, "run")).filter((f) => f.endsWith(".mcp.json"));
  assert.deepEqual(leftovers, [], "no minted config file may outlive the run");

  // The audit trail exists on disk.
  assert.ok(fs.existsSync(result.logFile));
});

test("a hung process is SIGKILLed at the wall-clock backstop", async () => {
  process.env.FAKE_CLAUDE_P_MODE = "hang";
  try {
    const result = await runHeadlessAgent({
      ...target,
      roleName: "moderator",
      agentName: "moderator-hang",
      objective: "hang forever",
      timeoutMs: 500,
      claudeBin: fakeClaude,
    });
    assert.equal(result.timedOut, true);
    assert.equal(result.ok, false);
  } finally {
    delete process.env.FAKE_CLAUDE_P_MODE;
  }
});

test("a failing process reports ok:false with its exit code", async () => {
  process.env.FAKE_CLAUDE_P_MODE = "fail";
  try {
    const result = await runHeadlessAgent({
      ...target,
      roleName: "moderator",
      agentName: "moderator-fail",
      objective: "fail immediately",
      claudeBin: fakeClaude,
    });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
    assert.equal(result.timedOut, false);
  } finally {
    delete process.env.FAKE_CLAUDE_P_MODE;
  }
});

test("a second run for the same agent name is refused while one is live", async () => {
  process.env.FAKE_CLAUDE_P_MODE = "hang";
  try {
    const first = runHeadlessAgent({
      ...target,
      roleName: "moderator",
      agentName: "moderator-guard",
      objective: "hold the slot",
      timeoutMs: 2000,
      claudeBin: fakeClaude,
    });
    await new Promise((r) => setTimeout(r, 100)); // let the first run register
    await assert.rejects(
      runHeadlessAgent({
        ...target,
        roleName: "moderator",
        agentName: "moderator-guard",
        objective: "double submit",
        claudeBin: fakeClaude,
      }),
      /already live/,
    );
    await first;
  } finally {
    delete process.env.FAKE_CLAUDE_P_MODE;
  }
});

test("a missing claude binary fails cleanly instead of throwing", async () => {
  const result = await runHeadlessAgent({
    ...target,
    roleName: "moderator",
    agentName: "moderator-nobin",
    objective: "no binary",
    claudeBin: "/nonexistent/claude-binary",
  });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, null);
});
