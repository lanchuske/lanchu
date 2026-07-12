import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// task-mrgk65hj2: `lanchu doctor`/`lanchu reconnect` shell out to the real
// `claude` CLI (never hand-parse its config file). Tested here with a FAKE
// `claude` on PATH (test/fake-claude/claude) so nothing ever touches a real
// Claude Code config — real child-process invocation of the real lanchu CLI,
// same pattern as spawn-dry.test.mjs, extended with a controllable stand-in
// for the one external dependency this feature has.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "dist", "cli", "index.js");
const fakeClaudeDir = path.join(root, "test", "fake-claude");

const dir = path.join(os.tmpdir(), "lanchu-reconnect-cli-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const projectDir = path.join(dir, "project");
fs.mkdirSync(path.join(projectDir, ".lanchu"), { recursive: true });
fs.writeFileSync(path.join(projectDir, ".lanchu", "config.json"), JSON.stringify({ org: "reconnect-cli-org", project: "core" }));

const stateDir = path.join(dir, "state");
const logDir = path.join(dir, "fake-claude-log");
const entryFile = path.join(dir, "mcp-entry.txt");

const { createServer } = await import("../dist/server/server.js");
const store = await import("../dist/core/store.js");
process.env.LANCHU_STATE_DIR = stateDir;
delete process.env.LANCHU_ACCESS_KEY;
const server = createServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
test.after(() => server.close());

/**
 * MUST be async (spawn, not spawnSync): the CLI child process talks back to
 * THIS process's own in-process HTTP server. spawnSync blocks this process's
 * entire event loop until the child exits — the server couldn't answer a
 * single request, the child's health checks would all time out, and
 * ensureServer would spend ~24s retrying before giving up (exactly what
 * happened here first: every command needing the server hung for ~25s).
 */
function runCli(args, { entry } = {}) {
  fs.rmSync(logDir, { recursive: true, force: true });
  fs.mkdirSync(logDir, { recursive: true });
  if (entry === undefined) {
    fs.rmSync(entryFile, { force: true });
  } else {
    fs.writeFileSync(entryFile, entry);
  }
  return new Promise((resolve, reject) => {
    const child = spawn("node", [cli, ...args], {
      cwd: projectDir,
      env: {
        ...process.env,
        PATH: `${fakeClaudeDir}${path.delimiter}${process.env.PATH}`,
        LANCHU_STATE_DIR: stateDir,
        LANCHU_PORT: String(port),
        FAKE_CLAUDE_MCP_ENTRY: entryFile,
        FAKE_CLAUDE_LOG_DIR: logDir,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function mcpEntryText(token, scope = "local") {
  const scopeLine = scope === "local" ? "Local config (private to you in this project)" : scope;
  return [
    "lanchu:",
    `  Scope: ${scopeLine}`,
    "  Status: ✘ Failed to connect",
    "  Type: http",
    `  URL: http://127.0.0.1:${port}/mcp`,
    "  Headers:",
    `    Authorization: Bearer ${token}`,
    "",
    "To remove this server, run: claude mcp remove lanchu -s local",
  ].join("\n");
}

function logLines(name) {
  const file = path.join(logDir, `${name}.log`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// ── lanchu doctor ──

test("doctor reports no local MCP entry when there is none", async () => {
  const res = await runCli(["doctor"]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /mcp token\s+no 'lanchu' entry in this directory/);
});

test("doctor names an unknown token as dead, with the fix", async () => {
  const res = await runCli(["doctor"], { entry: mcpEntryText("lsk_never_minted") });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /mcp token\s+DEAD — unknown token/);
});

test("doctor reports a live token as live", async () => {
  const s = await join("doctor-live-agent");
  const res = await runCli(["doctor"], { entry: mcpEntryText(s.token) });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /mcp token\s+live/);
});

test("doctor names a retired agent's token and the fix", async () => {
  const s = await join("doctor-retired-agent");
  await fetch(`http://127.0.0.1:${port}/agent/retire`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: s.agentId }),
  });
  const res = await runCli(["doctor"], { entry: mcpEntryText(s.token) });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /mcp token\s+DEAD — agent 'doctor-retired-agent' was retired/);
  assert.match(res.stdout, /lanchu reconnect/);
});

// ── lanchu reconnect ──

test("reconnect with no local entry tells the user to onboard normally", async () => {
  const res = await runCli(["reconnect"]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /No 'lanchu' MCP entry found/);
  assert.deepEqual(logLines("remove"), []);
  assert.deepEqual(logLines("add"), []);
});

test("reconnect with an unknown token tells the user to onboard normally, touches nothing", async () => {
  const res = await runCli(["reconnect"], { entry: mcpEntryText("lsk_never_minted") });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /doesn't match any session/);
  assert.deepEqual(logLines("remove"), []);
  assert.deepEqual(logLines("add"), []);
});

test("reconnect on an ended (non-retired) session mints a fresh session and rewrites the MCP entry", async () => {
  const s = await join("reconnect-ended-agent");
  const org = store.getOrgByName("reconnect-cli-org");
  const agent = store.findAgentByName(org.id, "reconnect-ended-agent");
  store.endSessionsForAgent(agent.id); // rotated/restarted, NOT retired — no confirmation needed

  const res = await runCli(["reconnect"], { entry: mcpEntryText(s.token) });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Reconnected 'reconnect-ended-agent'/);
  assert.match(res.stdout, /\/mcp → reconnect/);

  const removeCalls = logLines("remove");
  assert.equal(removeCalls.length, 1, "always remove before add — never a bare add");
  assert.deepEqual(removeCalls[0].slice(0, 2), ["mcp", "remove"]);
  const addCalls = logLines("add");
  assert.equal(addCalls.length, 1);
  assert.ok(addCalls[0].includes("lanchu"));
  assert.ok(addCalls[0].some((a) => a.startsWith("http://127.0.0.1")));
  const headerIdx = addCalls[0].indexOf("--header");
  assert.ok(headerIdx >= 0);
  assert.match(addCalls[0][headerIdx + 1], /^Authorization: Bearer /);
  assert.ok(!addCalls[0][headerIdx + 1].includes(s.token), "the new token must differ from the dead one");
});

test("reconnect on a RETIRED agent, non-interactive, refuses without confirmation and touches nothing", async () => {
  const s = await join("reconnect-retired-agent");
  await fetch(`http://127.0.0.1:${port}/agent/retire`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: s.agentId }),
  });
  const res = await runCli(["reconnect"], { entry: mcpEntryText(s.token) });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /RETIRED/);
  assert.match(res.stdout, /needs an interactive terminal/);
  assert.deepEqual(logLines("remove"), [], "never touches the MCP entry without confirmation");
  assert.deepEqual(logLines("add"), []);
  const org = store.getOrgByName("reconnect-cli-org");
  assert.equal(store.getAgent(s.agentId).state, "retired", "still retired — reconnect did not silently revive it");
  void org;
});

async function join(agentName) {
  const res = await fetch(`http://127.0.0.1:${port}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ org: "reconnect-cli-org", project: "core", agentName }),
  });
  return res.json();
}
