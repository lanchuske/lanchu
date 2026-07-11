import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

// `lanchu init` is pure local config — no server needed. Run the real binary
// in throwaway directories and assert on what it writes (or refuses to).
const BIN = path.resolve("dist/cli/index.js");
const root = path.join(os.tmpdir(), "lanchu-prov-test-" + process.pid);
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;
function freshDir(name) {
  const dir = path.join(root, `${++n}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function init(cwd, ...args) {
  const r = spawnSync(process.execPath, [BIN, "init", ...args], { cwd, encoding: "utf8" });
  return { out: (r.stdout ?? "") + (r.stderr ?? ""), status: r.status };
}
const configOf = (dir) => {
  const f = path.join(dir, ".lanchu", "config.json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
};

test("init without --org refuses to invent an org (no more silent 'acme')", () => {
  const dir = freshDir("no-org");
  const { out } = init(dir);
  assert.match(out, /usage: lanchu init --org/);
  assert.equal(configOf(dir), null, "nothing written");
});

test("init defaults the project name from the folder", () => {
  const dir = freshDir("myapp");
  const { out } = init(dir, "--org", "demo");
  assert.match(out, /Wrote /);
  const cfg = configOf(dir);
  assert.equal(cfg.org, "demo");
  assert.equal(cfg.project, path.basename(dir));
});

test("init inside a git repo defaults the project to the repo root's folder name", () => {
  const repo = freshDir("realrepo");
  spawnSync("git", ["init", "-q"], { cwd: repo });
  const sub = path.join(repo, "packages", "deep");
  fs.mkdirSync(sub, { recursive: true });
  const { out } = init(sub, "--org", "demo");
  assert.match(out, /Wrote /);
  assert.equal(configOf(sub).project, path.basename(repo), "repo root name, not the subfolder");
});

test("a project name that doesn't match its checkout warns but writes", () => {
  const dir = freshDir("actual-folder");
  const { out } = init(dir, "--org", "demo", "--project", "totally-different");
  assert.match(out, /does not match this checkout/);
  assert.match(out, /Wrote /, "warning, not a block — the human may mean it");
  assert.equal(configOf(dir).project, "totally-different");
});

test("rebinding an already-bound directory requires --force", () => {
  const dir = freshDir("bound");
  init(dir, "--org", "one");
  const refused = init(dir, "--org", "two");
  assert.match(refused.out, /already bound to org 'one'/);
  assert.match(refused.out, /--force/);
  assert.equal(configOf(dir).org, "one", "binding unchanged without --force");

  const forced = init(dir, "--org", "two", "--force");
  assert.match(forced.out, /Wrote /);
  assert.equal(configOf(dir).org, "two");
});

test("init with no flags on a bound directory reports the binding and changes nothing", () => {
  const dir = freshDir("report");
  init(dir, "--org", "demo");
  const { out } = init(dir);
  assert.match(out, /already bound to org 'demo'/);
  assert.equal(configOf(dir).org, "demo");
});
