import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state (set before importing anything that opens the DB).
const dir = path.join(os.tmpdir(), "lanchu-completion-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;
delete process.env.LANCHU_ACCESS_KEY;

const store = await import("../dist/core/store.js");
const { createServer } = await import("../dist/server/server.js");
const completion = await import("../dist/cli/completion.js");
const { COMMANDS, bashCompletionScript, zshCompletionScript, fishCompletionScript, completionValues, installCompletion } = completion;

test("the command tree covers the CLI surface and every generated script mentions it", () => {
  const names = COMMANDS.map((c) => c.name);
  for (const must of ["spawn", "tasks", "retire", "task", "roles", "orgs", "coordinator", "restart", "completion"]) {
    assert.ok(names.includes(must), `${must} in the tree`);
  }

  const bash = bashCompletionScript();
  const zsh = zshCompletionScript();
  const fish = fishCompletionScript();
  for (const name of names) {
    assert.ok(bash.includes(name), `bash lists ${name}`);
    assert.ok(zsh.includes(name), `zsh lists ${name}`);
    assert.ok(fish.includes(name), `fish lists ${name}`);
  }
  // Dynamic values ride the hidden hook in all three shells.
  for (const script of [bash, zsh, fish]) {
    assert.match(script, /lanchu completion values/);
    assert.match(script, /2>\/dev\/null/, "server-down fallback is silent");
  }
  // Descriptions reach the shells that render them.
  assert.ok(zsh.includes("safe agent retirement"), "zsh carries descriptions");
  assert.ok(fish.includes("safe agent retirement"), "fish carries descriptions");
  // Ghost-text guidance is written into the specs themselves.
  assert.match(zsh, /zsh-autosuggestions/);
  assert.match(fish, /natively/);
});

test("dynamic values come from the live server and fall back to empty when it's down", async () => {
  const org = store.getOrCreateOrg("comp-org");
  store.getOrCreateProject(org.id, "core");
  const role = store.getOrCreateRole(org.id, "reviewer", { wildcard: true });
  const agent = store.createAgent({ orgId: org.id, roleId: role.id, name: "zoe" });
  const project = store.listProjects(org.id)[0];
  const task = store.createTask({ projectId: project.id, orgId: org.id, agentId: agent.id, title: "t", tags: [] });

  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.LANCHU_SERVER = `http://127.0.0.1:${server.address().port}`;

  // The org comes from .lanchu/config.json, git-style upward search.
  const cwd = path.join(dir, "repo");
  fs.mkdirSync(path.join(cwd, ".lanchu"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".lanchu", "config.json"), JSON.stringify({ org: "comp-org", project: "core" }));
  const prevCwd = process.cwd();
  process.chdir(cwd);
  try {
    assert.deepEqual(await completionValues("agents"), ["zoe"]);
    assert.deepEqual(await completionValues("agent-ids"), [agent.id]);
    assert.deepEqual(await completionValues("tasks"), [task.id]);
    assert.ok((await completionValues("orgs")).includes("comp-org"));
    assert.deepEqual(await completionValues("roles"), ["reviewer"]);
    assert.deepEqual(await completionValues("models"), ["opus", "sonnet", "haiku"]);

    // Server gone → empty, fast, no throw.
    server.close();
    process.env.LANCHU_SERVER = "http://127.0.0.1:1";
    assert.deepEqual(await completionValues("agents"), []);
    assert.deepEqual(await completionValues("orgs"), []);
  } finally {
    process.chdir(prevCwd);
    delete process.env.LANCHU_SERVER;
  }
});

test("install is one step per shell and idempotent", () => {
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true });

  const zsh = installCompletion("zsh", home);
  assert.equal(zsh.installed, true);
  const rc = fs.readFileSync(path.join(home, ".zshrc"), "utf8");
  assert.match(rc, /lanchu completion zsh/);
  assert.match(zsh.ghostHint, /zsh-autosuggestions/);
  const again = installCompletion("zsh", home);
  assert.equal(again.installed, false, "second install is a no-op");
  assert.equal(
    (fs.readFileSync(path.join(home, ".zshrc"), "utf8").match(/lanchu completion zsh/g) || []).length,
    1,
    "rc line not duplicated",
  );

  const fish = installCompletion("fish", home);
  const fishFile = path.join(home, ".config", "fish", "completions", "lanchu.fish");
  assert.ok(fs.existsSync(fishFile), "fish completion file dropped in the autoload dir");
  assert.match(fs.readFileSync(fishFile, "utf8"), /complete -c lanchu/);
  assert.match(fish.ghostHint, /natively/);
});
