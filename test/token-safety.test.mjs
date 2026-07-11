import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-token-safety-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;

const store = await import("../dist/core/store.js");
const { bootstrapCommand, spawnTerminal } = await import("../dist/server/cockpit.js");

const TOKEN = "lsk_test-secret-token-value";

test("the spawn command never carries the token — it lives in a mode-600 config file the shell removes on exit", () => {
  const cmd = bootstrapCommand("/tmp/wt", TOKEN, "do the thing", "builder", "lanchu·builder");

  assert.ok(!cmd.includes(TOKEN), "token must not appear in the command line (ps/window-title exposure)");
  assert.ok(!cmd.includes("lsk_"), "no token-shaped string in the command line");

  const m = /--mcp-config '([^']+)'/.exec(cmd);
  assert.ok(m, "command references a config file path");
  const file = m[1];
  assert.ok(file.startsWith(path.join(dir, "run")), "config lives in the user-only state dir");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, "config file is owner-read/write only");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(config.mcpServers.lanchu.headers.Authorization, `Bearer ${TOKEN}`);

  assert.match(cmd, /trap 'rm -f /, "launched shell shreds the config on exit");
  assert.ok(cmd.includes("lanchu·builder"), "sets an explicit clean window title");
});

test("spawnTerminal dry-run plans a token-free command too", () => {
  const plan = spawnTerminal({
    title: "org·agent", agentName: "agent", cwd: "/tmp/wt", token: TOKEN, prompt: "go", dry: true,
  });
  assert.ok(!plan.command.includes(TOKEN));
});

test("rotate-tokens ends every open session in the org, and only that org", () => {
  const org = store.getOrCreateOrg("rotate-org");
  const other = store.getOrCreateOrg("other-org");
  const role = store.getOrCreateRole(org.id, "generalist", { wildcard: true });
  const otherRole = store.getOrCreateRole(other.id, "generalist", { wildcard: true });
  const a = store.createAgent({ orgId: org.id, roleId: role.id, name: "a" });
  const b = store.createAgent({ orgId: org.id, roleId: role.id, name: "b" });
  const c = store.createAgent({ orgId: other.id, roleId: otherRole.id, name: "c" });

  const t1 = store.openSession(a.id).token;
  const t2 = store.openSession(a.id).token; // two exposed terminals for one agent
  const t3 = store.openSession(b.id).token;
  const t4 = store.openSession(c.id).token; // different org — untouched

  const r = store.rotateOrgSessions(org.id);
  assert.deepEqual(r, { agents: 2, sessions: 3 });

  for (const dead of [t1, t2, t3]) {
    assert.equal(store.agentIdForToken(dead), null, "rotated token no longer authenticates");
  }
  assert.equal(store.agentIdForToken(t4), c.id, "other org's sessions survive");

  // Fresh registration works immediately, and the rotation is on the record.
  const fresh = store.openSession(a.id).token;
  assert.equal(store.agentIdForToken(fresh), a.id);
  const ev = store.listAuditEvents(org.id).find((e) => e.type === "session.rotated");
  assert.ok(ev, "session.rotated audited");
  assert.equal(ev.data.sessions, 3);
});
