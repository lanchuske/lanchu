import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated state dir per run — ensureContractSandbox lives under stateDir().
const dir = path.join(os.tmpdir(), "lanchu-test-contract-sandbox-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;

const { ensureContractSandbox } = await import("../dist/core/contract-sandbox.js");

// Network mode Piece 5 Task 2 (task-mrk1qvvt43): claiming a contract task
// never invokes `git worktree add` against the project repo; the sandbox
// contains exactly the seeded files and nothing else.

test("seeds a sandbox with exactly the contract fields it was given", () => {
  const sandbox = ensureContractSandbox("task-abc1", {
    contractSpec: "## Signature\n`add(a, b)`",
    contractTests: "test('adds', () => assert.equal(add(1,2), 3));",
    contractDeps: JSON.stringify(["task-other1"]),
  });

  assert.ok(sandbox.created);
  assert.equal(sandbox.path, path.join(dir, "contracts", "task-abc1"));
  assert.equal(fs.readFileSync(path.join(sandbox.path, "CONTRACT.md"), "utf8"), "## Signature\n`add(a, b)`");
  assert.match(fs.readFileSync(path.join(sandbox.path, "CONTRACT_TESTS"), "utf8"), /adds/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sandbox.path, "CONTRACT_DEPS.json"), "utf8")), ["task-other1"]);

  // Exactly the 3 seeded files, nothing else.
  assert.deepEqual(fs.readdirSync(sandbox.path).sort(), ["CONTRACT.md", "CONTRACT_DEPS.json", "CONTRACT_TESTS"]);
});

test("the sandbox is never a git worktree — no .git anywhere in it", () => {
  const sandbox = ensureContractSandbox("task-abc2", { contractSpec: "spec", contractTests: null, contractDeps: null });
  assert.equal(fs.existsSync(path.join(sandbox.path, ".git")), false);
});

test("omitted contract fields produce no file for them, not empty ones", () => {
  const sandbox = ensureContractSandbox("task-abc3", { contractSpec: "spec only", contractTests: null, contractDeps: null });
  assert.deepEqual(fs.readdirSync(sandbox.path), ["CONTRACT.md"]);
});

test("re-claiming the same task reuses the sandbox and re-seeds from the latest fields", () => {
  const first = ensureContractSandbox("task-abc4", { contractSpec: "v1", contractTests: "t1", contractDeps: null });
  assert.ok(first.created);

  // Fields changed (e.g. a definition edit) — and contractTests was dropped.
  const second = ensureContractSandbox("task-abc4", { contractSpec: "v2", contractTests: null, contractDeps: null });
  assert.equal(second.created, false); // reused, not recreated
  assert.equal(second.path, first.path);
  assert.equal(fs.readFileSync(path.join(second.path, "CONTRACT.md"), "utf8"), "v2");
  assert.equal(fs.existsSync(path.join(second.path, "CONTRACT_TESTS")), false); // stale file cleared
});

test("two different contract tasks get two disjoint sandboxes", () => {
  const a = ensureContractSandbox("task-disjoint-a", { contractSpec: "a", contractTests: null, contractDeps: null });
  const b = ensureContractSandbox("task-disjoint-b", { contractSpec: "b", contractTests: null, contractDeps: null });
  assert.notEqual(a.path, b.path);
  assert.equal(fs.readFileSync(path.join(a.path, "CONTRACT.md"), "utf8"), "a");
  assert.equal(fs.readFileSync(path.join(b.path, "CONTRACT.md"), "utf8"), "b");
});
