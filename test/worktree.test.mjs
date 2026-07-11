import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const { ensureAgentWorktree, removeAgentWorktree, slugify } = await import("../dist/core/worktree.js");

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/** A fresh throwaway repo with one commit, so worktrees have a base to branch from. */
function makeRepo(name) {
  // realpath, native flavor: on macOS tmpdir is a symlink (/var → /private/var) and on
  // Windows it can be an 8.3 short name (RUNNER~1); git reports fully resolved paths.
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `lanchu-wt-${name}-`)));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@lanchu.dev");
  git(repo, "config", "user.name", "lanchu-test");
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

test("slugify produces fs/branch-safe names", () => {
  assert.equal(slugify("QA rev.2"), "qa-rev-2");
  assert.equal(slugify("builder-2"), "builder-2");
  assert.equal(slugify("···"), "agent");
});

test("spawning N agents yields N isolated worktrees and branches", () => {
  const repo = makeRepo("iso");
  const a = ensureAgentWorktree(repo, "alice");
  const b = ensureAgentWorktree(repo, "bob");
  assert.ok(a && b);
  assert.equal(a.path, path.join(repo, ".lanchu", "worktrees", "alice"));
  assert.equal(a.branch, "agent/alice");
  assert.equal(b.branch, "agent/bob");
  assert.notEqual(a.path, b.path);
  assert.ok(a.created && b.created);

  // One agent's edits never show up in the other's git status.
  fs.writeFileSync(path.join(a.path, "alice.txt"), "mine\n");
  assert.match(git(a.path, "status", "--porcelain"), /alice\.txt/);
  assert.equal(git(b.path, "status", "--porcelain"), "");
  assert.doesNotMatch(git(repo, "status", "--porcelain"), /alice\.txt/);
});

test("worktrees dir stays out of the main checkout's git status", () => {
  const repo = makeRepo("excl");
  ensureAgentWorktree(repo, "alice");
  assert.equal(git(repo, "status", "--porcelain"), "");
});

test("reattach reuses the existing worktree instead of duplicating", () => {
  const repo = makeRepo("reuse");
  const first = ensureAgentWorktree(repo, "alice");
  const again = ensureAgentWorktree(repo, "alice");
  assert.ok(first && again);
  assert.equal(again.path, first.path);
  assert.equal(again.created, false);
});

test("spawning from inside an agent worktree anchors at the main repo", () => {
  const repo = makeRepo("nest");
  const a = ensureAgentWorktree(repo, "alice");
  const b = ensureAgentWorktree(a.path, "bob");
  assert.equal(b.path, path.join(repo, ".lanchu", "worktrees", "bob"));
});

test("non-repo directory falls back to null (shared-dir mode)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lanchu-wt-norepo-"));
  assert.equal(ensureAgentWorktree(dir, "alice"), null);
});

test("remove prunes a clean worktree but keeps its branch", () => {
  const repo = makeRepo("rm");
  const a = ensureAgentWorktree(repo, "alice");
  const r = removeAgentWorktree(a.path);
  assert.equal(r.removed, true);
  assert.equal(fs.existsSync(a.path), false);
  assert.match(git(repo, "branch", "--list", "agent/alice"), /agent\/alice/);

  // After a prune, ensure recreates the worktree on the surviving branch.
  const again = ensureAgentWorktree(repo, "alice");
  assert.ok(again?.created);
  assert.equal(again.branch, "agent/alice");
});

test("remove refuses to drop uncommitted work", () => {
  const repo = makeRepo("dirty");
  const a = ensureAgentWorktree(repo, "alice");
  fs.writeFileSync(path.join(a.path, "wip.txt"), "unsaved\n");
  const r = removeAgentWorktree(a.path);
  assert.equal(r.removed, false);
  assert.equal(fs.existsSync(a.path), true);
});

test("remove never touches paths outside .lanchu/worktrees", () => {
  const repo = makeRepo("guard");
  const r = removeAgentWorktree(repo);
  assert.equal(r.removed, false);
  assert.equal(fs.existsSync(repo), true);
});
