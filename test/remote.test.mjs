import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

// Isolated on-disk state (set before importing anything that opens the DB).
const dir = path.join(os.tmpdir(), "lanchu-remote-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;
delete process.env.LANCHU_ACCESS_KEY;

const { createServer } = await import("../dist/server/server.js");
const store = await import("../dist/core/store.js");

// One server for the whole file; auth is decided per-request from the env, so we
// flip LANCHU_ACCESS_KEY between requests rather than restarting.
const server = createServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const req = (p, init) => fetch(base + p, init);
const KEY = "s3cret-key";

test("no access key: the admin surface is open", async () => {
  delete process.env.LANCHU_ACCESS_KEY;
  assert.equal((await req("/api/orgs")).status, 200);
  assert.equal((await req("/health")).status, 200);
});

test("with an access key: admin surface is gated, health/shell/mcp stay reachable", async () => {
  process.env.LANCHU_ACCESS_KEY = KEY;
  try {
    // /health is always open — it's how the CLI probes liveness before it has a key.
    assert.equal((await req("/health")).status, 200);
    // The panel shell is public so the browser can load it and prompt for the key.
    assert.equal((await req("/", { headers: { accept: "text/html" } })).status, 200);

    // The API requires the key, presented any of three ways.
    assert.equal((await req("/api/orgs")).status, 401);
    assert.equal((await req("/api/orgs", { headers: { authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await req("/api/orgs", { headers: { authorization: `Bearer ${KEY}` } })).status, 200);
    assert.equal((await req("/api/orgs", { headers: { "x-lanchu-key": KEY } })).status, 200);
    assert.equal((await req(`/api/orgs?key=${encodeURIComponent(KEY)}`)).status, 200);

    // /mcp is exempt from the access-key gate (it carries per-agent session tokens),
    // but still rejects a request with no/invalid session token.
    const mcp = await req("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(mcp.status, 401);
  } finally {
    delete process.env.LANCHU_ACCESS_KEY;
  }
});

// Regression for task-mrlgnhl086: with a key set, every network-mode surface
// meant for a Person acting directly (no panel key, by definition) must stay
// reachable — a magic-link login, a profile page, the cross-org directory.
// Each one 401'd before the fix because accessGate only exempted the panel's
// own surface, and every new network-mode endpoint quietly inherited the bug.
test("with an access key: public network-mode surfaces stay open, everything else still 401s", async () => {
  process.env.LANCHU_ACCESS_KEY = KEY;
  try {
    store.createPerson({ email: "gategrace@example.com", handle: "gategrace" });

    assert.equal((await req("/api/network/projects")).status, 200);
    assert.equal((await req("/api/profile/gategrace")).status, 200);
    assert.equal((await req("/api/profile/no-such-handle")).status, 404, "unknown handle: 404, not 401");
    assert.equal((await req("/@gategrace")).status, 200);
    assert.equal((await req("/@no-such-handle")).status, 200, "shell serves even for an unknown handle");

    const loginReq = await req("/api/person/login/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "gate-login@example.com" }),
    });
    assert.equal(loginReq.status, 200);
    const loginVerify = await req("/api/person/login/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "not-a-real-token" }),
    });
    assert.equal(loginVerify.status, 400, "reaches real login logic (invalid token), not a 401 from the gate");

    // Piece 1 Task 5: the GitHub-link endpoint is also exempt from the panel
    // key — but it's gated by its OWN auth (the person_session cookie), so a
    // request with no session still 401s, just for a different reason.
    const githubLink = await req("/api/person/github", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ githubLogin: "octocat" }),
    });
    assert.equal(githubLink.status, 401);
    assert.equal(
      (await githubLink.json()).error,
      "not signed in",
      "reaches real cookie-auth logic, not a 401 from the panel-key gate",
    );

    // A sibling API surface with no public exemption is still properly gated.
    assert.equal((await req("/api/orgs")).status, 401);
  } finally {
    delete process.env.LANCHU_ACCESS_KEY;
  }
});

test("session minting is gated by the key and advertises a reachable mcp url", async () => {
  process.env.LANCHU_ACCESS_KEY = KEY;
  try {
    const body = JSON.stringify({ org: "remote-acme", project: "web", objective: "x" });
    const headers = { "content-type": "application/json" };

    assert.equal((await req("/session", { method: "POST", headers, body })).status, 401);

    const res = await req("/session", {
      method: "POST",
      headers: { ...headers, authorization: `Bearer ${KEY}` },
      body,
    });
    assert.equal(res.status, 200);
    const s = await res.json();
    assert.ok(s.token, "returns a session token");
    // The advertised mcp url follows the request's Host (the ephemeral test port),
    // not the configured default port — so a remote laptop gets a reachable URL.
    assert.equal(s.mcpUrl, `${base}/mcp`);
  } finally {
    delete process.env.LANCHU_ACCESS_KEY;
  }
});

test("LANCHU_PUBLIC_URL overrides the advertised mcp url", async () => {
  process.env.LANCHU_ACCESS_KEY = KEY;
  process.env.LANCHU_PUBLIC_URL = "https://lanchu.example.com/";
  try {
    const res = await req("/session", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}`, host: "internal:4319" },
      body: JSON.stringify({ org: "remote-acme", project: "web" }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).mcpUrl, "https://lanchu.example.com/mcp");
  } finally {
    delete process.env.LANCHU_ACCESS_KEY;
    delete process.env.LANCHU_PUBLIC_URL;
  }
});

// Regression for the attribution bug: the launcher sends its `cwd` on /session,
// so the agent's real directory/branch/worktree are captured (panel showed a
// stale, inherited dir before — e.g. an agent in ~/repos/lanchu on `main`
// displayed as ~/repos/local-mcp on `master`). Guards the /session→captureWorkspace
// contract that the run.ts fix depends on.
test("session records the agent's real cwd/branch/worktree from the request", async () => {
  delete process.env.LANCHU_ACCESS_KEY;
  // native realpath: Windows tmpdir can be an 8.3 short name (RUNNER~1) and git
  // reports fully resolved paths; plain realpathSync doesn't expand short names.
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "lanchu-ws-")));
  const git = (...a) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  git("init", "-q", "-b", "trunk");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "README"), "x");
  git("add", "-A");
  git("commit", "-qm", "init");

  const res = await req("/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ org: "ws-acme", project: "web", objective: "attribution", cwd: repo }),
  });
  assert.equal(res.status, 200);
  const agent = store.getAgent((await res.json()).agentId);
  assert.equal(agent.cwd, repo, "cwd is recorded from the session request");
  assert.equal(agent.branch, "trunk", "branch is read from the working tree's git");
  assert.equal(fs.realpathSync(agent.worktree), fs.realpathSync(repo), "worktree root is captured");
});
