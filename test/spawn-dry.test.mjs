import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// task-mrg3xi2x2: `lanchu spawn --dry` must touch NOTHING — no agent, no
// session, no worktree, no leaked mcp-config token file — and never even
// contact the server. Real child-process invocation (not a unit test of an
// unexported function bound to process.argv) is the only way to prove this:
// point LANCHU_PORT at a closed port so any accidental server call fails
// loudly instead of silently succeeding against something else running.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "dist", "cli", "index.js");

const dir = path.join(os.tmpdir(), "lanchu-spawn-dry-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
spawnSync("git", ["init", "-q"], { cwd: dir });
spawnSync("git", ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "seed"], { cwd: dir });
fs.mkdirSync(path.join(dir, ".lanchu"), { recursive: true });
fs.writeFileSync(path.join(dir, ".lanchu", "config.json"), JSON.stringify({ org: "dry-org", project: "dry-project" }));

const stateDir = path.join(dir, "state");
const runDir = path.join(stateDir, "run");

function run(extraArgs) {
  return spawnSync("node", [cli, "spawn", "dry-agent", "--role", "generalist", "--dry", ...(extraArgs ?? [])], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      LANCHU_STATE_DIR: stateDir,
      LANCHU_PORT: "1", // a port nothing listens on — any real network call fails loudly
    },
  });
}

test("lanchu spawn --dry touches nothing: no token file, no server call, prints a preview", () => {
  const before = fs.existsSync(runDir) ? fs.readdirSync(runDir) : [];
  const res = run();
  assert.equal(res.status, 0, `dry run must succeed without a server: ${res.stderr}`);
  assert.match(res.stdout, /Would open/, "acceptance: says 'Would open...', not 'Opened...'");
  assert.match(res.stdout, /Command:/, "acceptance: prints the would-run command");
  assert.match(res.stdout, /worktree/, "isolate defaults true — the preview names the worktree it would create");

  // The real bug: writeMcpConfigFile used to write a token file to disk just
  // to compute the preview string, and cmdSpawn used to POST /session before
  // ever checking --dry. Neither can have happened.
  const after = fs.existsSync(runDir) ? fs.readdirSync(runDir) : [];
  assert.deepEqual(after, before, "no mcp-config token file was written under run/");
  assert.ok(!fs.existsSync(path.join(dir, ".lanchu", "worktrees")), "no worktree directory was created");
});

test("lanchu spawn --dry --no-isolate previews the shared directory, still touches nothing", () => {
  const res = run(["--no-isolate"]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /share this directory/);
  assert.ok(!fs.existsSync(path.join(dir, ".lanchu", "worktrees")));
});
