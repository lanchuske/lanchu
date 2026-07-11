import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state — MUST be set before the imports below open the DB.
const dir = path.join(os.tmpdir(), "lanchu-stophook-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;
delete process.env.LANCHU_ACCESS_KEY;

const store = await import("../dist/core/store.js");
const { installStopHook } = await import("../dist/server/cockpit.js");

// ── wake v4 (A): the Stop hook — an agent never idles with unread notices ──

test("installStopHook writes a blocking Stop hook wired to /api/agent/pending, with the token OUT of the worktree", () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "lanchu-hook-wt-"));
  const ok = installStopHook(wt, "lsk_test_token_123", "builder-x");
  assert.equal(ok, true);

  const file = path.join(wt, ".claude", "settings.local.json");
  const settings = JSON.parse(fs.readFileSync(file, "utf8"));
  const stop = settings.hooks.Stop;
  assert.equal(stop.length, 1);
  const command = stop[0].hooks[0].command;
  assert.equal(stop[0].hooks[0].type, "command");
  assert.match(command, /\/api\/agent\/pending/);
  assert.match(command, /exit 2/, "a pending count blocks the stop");
  assert.match(command, /message_list/, "the reason points at the inbox");

  // The token never lands in the worktree (it could get committed): the hook
  // reads it from a user-only file in the state dir.
  assert.ok(!command.includes("lsk_test_token_123"), "no token in the hook command");
  assert.ok(!fs.readFileSync(file, "utf8").includes("lsk_test_token_123"), "no token in the settings file");
  const tokenFile = path.join(dir, "run", "builder-x.stop-hook-token");
  assert.equal(fs.readFileSync(tokenFile, "utf8"), "lsk_test_token_123");
  assert.ok(command.includes(tokenFile), "the hook reads the token file");

  fs.rmSync(wt, { recursive: true, force: true });
});

test("installStopHook is idempotent per agent, refreshes the token, and never clobbers user settings", () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "lanchu-hook-wt2-"));
  const file = path.join(wt, ".claude", "settings.local.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ model: "opus", hooks: { PreToolUse: [{ hooks: [] }] } }));

  installStopHook(wt, "token-one", "builder-y");
  installStopHook(wt, "token-two", "builder-y"); // respawn: same agent, new token

  const settings = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(settings.model, "opus", "existing settings survive");
  assert.ok(settings.hooks.PreToolUse, "other hooks survive");
  assert.equal(settings.hooks.Stop.length, 1, "one entry per agent, however many respawns");
  const tokenFile = path.join(dir, "run", "builder-y.stop-hook-token");
  assert.equal(fs.readFileSync(tokenFile, "utf8"), "token-two", "respawn refreshes the token in place");

  // Corrupt user file → hands off, reports failure, file untouched.
  fs.writeFileSync(file, "{not json");
  assert.equal(installStopHook(wt, "t", "builder-y"), false);
  assert.equal(fs.readFileSync(file, "utf8"), "{not json");

  fs.rmSync(wt, { recursive: true, force: true });
});

test("GET /api/agent/pending: bare unheard-count under the agent's own token; 401 otherwise", async () => {
  const { createServer } = await import("../dist/server/server.js");
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // Mint a real session the way a spawned agent would.
    const sess = await (await fetch(base + "/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ org: "hook-org", project: "core", agentName: "hooked", role: "generalist", wildcard: true, isolate: false }),
    })).json();
    assert.ok(sess.token, "session minted");
    const pending = (auth) =>
      fetch(base + "/api/agent/pending", { headers: auth ? { authorization: `Bearer ${auth}` } : {} });

    assert.equal(await (await pending(sess.token)).text(), "0", "clean inbox");

    const org = store.getOrgByName("hook-org");
    const sender = store.createAgent({
      orgId: org.id,
      roleId: store.getOrCreateRole(org.id, "generalist", { wildcard: true }).id,
      name: "sender",
    });
    store.sendNotice({ orgId: org.id, fromAgentId: sender.id, to: "hooked", body: "wake up" });
    assert.equal(await (await pending(sess.token)).text(), "1", "unheard notice counted");

    // Heard via piggyback → the hook must let the turn end (no idle-trap).
    const hooked = store.findAgentByName(org.id, "hooked");
    store.takeUndeliveredNotices(hooked.id);
    assert.equal(await (await pending(sess.token)).text(), "0", "delivered notices don't trap the agent");

    assert.equal((await pending("not-a-token")).status, 401);
    assert.equal((await pending(null)).status, 401);
  } finally {
    server.close();
  }
});
