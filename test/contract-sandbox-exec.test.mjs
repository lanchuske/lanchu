import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated state dir per run — runContractTestsSafely lives under stateDir().
const dir = path.join(os.tmpdir(), "lanchu-test-contract-exec-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;

const { ensureContractSandbox } = await import("../dist/core/contract-sandbox.js");
const { runContractTestsSafely } = await import("../dist/core/contract-sandbox-exec.js");

// Network mode Piece 6 Task 4 (task-mrk1rx7y50): a deliberately hostile
// contract_tests file (reads outside the sandbox, attempts a network
// call, tries to read env vars) is demonstrably contained in a live test.
// These are REAL child processes, not mocks — the whole point of this
// task is that containment is actually verified, not assumed.

// A secret file OUTSIDE any sandbox, and a secret env var, to prove
// neither is reachable from inside a running contract test.
const outsideSecret = path.join(os.tmpdir(), "lanchu-outside-secret-" + process.pid + ".txt");
fs.writeFileSync(outsideSecret, "top-secret-content");
process.env.LANCHU_TEST_SECRET_KEY = "leaked-if-this-appears";

test("a passing test reports passed:true, exit code 0", () => {
  ensureContractSandbox("task-exec1", {
    contractSpec: "spec",
    contractTests: "process.exit(0);",
    contractDeps: null,
  });
  const result = runContractTestsSafely("task-exec1");
  assert.equal(result.ranTests, true);
  assert.equal(result.passed, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
});

test("a failing test reports passed:false with a non-zero exit code", () => {
  ensureContractSandbox("task-exec2", {
    contractSpec: "spec",
    contractTests: "throw new Error('assertion failed: expected 3, got 4');",
    contractDeps: null,
  });
  const result = runContractTestsSafely("task-exec2");
  assert.equal(result.passed, false);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /assertion failed/);
});

test("HOSTILE: a test that tries to read a file outside the sandbox is blocked, not leaked", () => {
  ensureContractSandbox("task-exec3", {
    contractSpec: "spec",
    contractTests: `
      const fs = require('fs');
      try {
        const data = fs.readFileSync(${JSON.stringify(outsideSecret)}, 'utf8');
        console.log('LEAKED:' + data);
        process.exit(1);
      } catch (e) {
        console.log('BLOCKED:' + e.code);
        process.exit(0);
      }
    `,
    contractDeps: null,
  });
  const result = runContractTestsSafely("task-exec3");
  assert.doesNotMatch(result.stdout, /LEAKED/, "the outside secret must never appear in the output");
  assert.match(result.stdout, /BLOCKED:ERR_ACCESS_DENIED/);
  assert.equal(result.passed, true); // the test script itself caught the block and exited 0
});

test("HOSTILE: a test that tries to write outside the sandbox is blocked", () => {
  const target = path.join(os.tmpdir(), "lanchu-exec-write-attempt-" + process.pid + ".txt");
  ensureContractSandbox("task-exec4", {
    contractSpec: "spec",
    contractTests: `
      const fs = require('fs');
      try {
        fs.writeFileSync(${JSON.stringify(target)}, 'pwned');
        console.log('WROTE');
        process.exit(1);
      } catch (e) {
        console.log('BLOCKED:' + e.code);
        process.exit(0);
      }
    `,
    contractDeps: null,
  });
  const result = runContractTestsSafely("task-exec4");
  assert.equal(fs.existsSync(target), false, "the outside file must never be created");
  assert.match(result.stdout, /BLOCKED:ERR_ACCESS_DENIED/);
});

test("HOSTILE: a test that tries a network call is blocked by the guard, not left to hang", () => {
  ensureContractSandbox("task-exec5", {
    contractSpec: "spec",
    contractTests: `
      try {
        require('http').get('http://example.com', () => {});
        console.log('NET CALL DID NOT THROW');
        process.exit(1);
      } catch (e) {
        console.log('BLOCKED:' + e.message);
        process.exit(0);
      }
    `,
    contractDeps: null,
  });
  const start = Date.now();
  const result = runContractTestsSafely("task-exec5", 5000);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 4000, "the guard should block synchronously, never falling through to the network timeout");
  assert.match(result.stdout, /BLOCKED:network access/);
  assert.equal(result.passed, true);
});

test("HOSTILE: a test that tries fetch() is blocked too", () => {
  ensureContractSandbox("task-exec6", {
    contractSpec: "spec",
    contractTests: `
      (async () => {
        try {
          await fetch('http://example.com');
          console.log('FETCH DID NOT THROW');
          process.exit(1);
        } catch (e) {
          console.log('BLOCKED:' + e.message);
          process.exit(0);
        }
      })();
    `,
    contractDeps: null,
  });
  const result = runContractTestsSafely("task-exec6", 5000);
  assert.match(result.stdout, /BLOCKED:network access/);
});

test("HOSTILE: env vars are simply absent, not filtered — no secret to leak", () => {
  ensureContractSandbox("task-exec7", {
    contractSpec: "spec",
    contractTests: `console.log('SECRET_KEY=' + process.env.LANCHU_TEST_SECRET_KEY);`,
    contractDeps: null,
  });
  const result = runContractTestsSafely("task-exec7");
  assert.match(result.stdout, /SECRET_KEY=undefined/);
  assert.doesNotMatch(result.stdout, /leaked-if-this-appears/);
});

test("HOSTILE: a hanging test is killed at the timeout, not left running forever", () => {
  ensureContractSandbox("task-exec8", {
    contractSpec: "spec",
    contractTests: `setInterval(() => {}, 1000);`, // never exits on its own
    contractDeps: null,
  });
  const start = Date.now();
  const result = runContractTestsSafely("task-exec8", 800);
  const elapsed = Date.now() - start;
  assert.equal(result.timedOut, true);
  assert.equal(result.passed, false);
  assert.ok(elapsed < 3000, "the kill must actually happen near the timeout, not hang indefinitely");
});

test("legitimate work inside the sandbox (reading the deliverable, writing scratch files) still works", () => {
  ensureContractSandbox("task-exec9", {
    contractSpec: "spec",
    contractTests: `
      const fs = require('fs');
      const path = require('path');
      fs.writeFileSync(path.join(__dirname, 'scratch.txt'), 'ok');
      const readBack = fs.readFileSync(path.join(__dirname, 'scratch.txt'), 'utf8');
      process.exit(readBack === 'ok' ? 0 : 1);
    `,
    contractDeps: null,
  });
  const result = runContractTestsSafely("task-exec9");
  assert.equal(result.passed, true);
});

test("no contract_tests on the task: ranTests is false, nothing is executed", () => {
  ensureContractSandbox("task-exec10", { contractSpec: "spec only", contractTests: null, contractDeps: null });
  const result = runContractTestsSafely("task-exec10");
  assert.equal(result.ranTests, false);
});

test("no sandbox at all (task never claimed): throws a clear error rather than silently no-op'ing", () => {
  assert.throws(() => runContractTestsSafely("task-never-claimed"), /claim the task first/);
});
