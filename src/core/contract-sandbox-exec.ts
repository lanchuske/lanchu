import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { contractSandboxPath } from "./contract-sandbox.js";

/**
 * Network mode (Piece 6, Task 4): running a contract task's `contract_tests`
 * is running project-owner-supplied, UNTRUSTED code inside a contributor's
 * execution environment. Piece 5 deliberately never auto-runs this on the
 * server; this module is what makes it safe for a contributor (or their
 * agent) to run it themselves instead of trusting it in their own shell.
 * See "Design: Cross-org task marketplace", Piece 6, "A risk the vision
 * doc didn't cover."
 *
 * What this actually contains, verified live against Node 22 before being
 * relied on (not assumed from docs):
 * - Filesystem: Node's `--experimental-permission` model DOES enforce
 *   `--allow-fs-read`/`--allow-fs-write` — a read/write outside the granted
 *   path throws `ERR_ACCESS_DENIED`. Real, verified containment.
 * - Network: Node's permission model has NO network flag — `http.get()`
 *   to a real host neither throws nor is blocked; it just attempts the
 *   connection (and can hang). This module patches `http`/`https`/`net`/
 *   `tls`/`dns`/global `fetch` to throw via a `--require`'d guard script,
 *   written fresh into the sandbox on every run.
 * - Environment variables: the child process receives an explicit, minimal
 *   `env` — never `process.env` — so nothing needs "blocking"; secrets
 *   simply aren't there to read.
 * - Runaway processes: a hard timeout kills the child (SIGKILL) — the
 *   network gap above means an unpatched call can hang otherwise.
 * - `--allow-child-process`/`--allow-worker`/`--allow-addons` are left at
 *   their default (denied) — a hostile script can't spawn its own
 *   unrestricted subprocess, worker thread, or native addon to route
 *   around any of the above.
 *
 * What this does NOT claim to contain: this is process-level isolation
 * within the same OS user Lanchu's server runs as — not a container or VM.
 * A kernel/Node-runtime exploit could still escape it. Treated as a real,
 * meaningful barrier against a merely-adversarial `contract_tests` file
 * (the stated threat model), not as protection against a sophisticated
 * 0-day. Said plainly here rather than implied to be more than it is.
 */

const GUARD_FILENAME = ".guard.cjs";
const TEST_ENTRY_FILENAME = "CONTRACT_TESTS";
const DEFAULT_TIMEOUT_MS = 10_000;

const GUARD_SCRIPT = `'use strict';
function blocked(name) {
  throw new Error("network access ('" + name + "') is blocked inside a contract-test sandbox");
}
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const dns = require('dns');
for (const mod of [http, https]) {
  mod.request = function () { blocked(mod === http ? 'http.request' : 'https.request'); };
  mod.get = function () { blocked(mod === http ? 'http.get' : 'https.get'); };
}
net.connect = net.createConnection = function () { blocked('net.connect'); };
tls.connect = function () { blocked('tls.connect'); };
for (const k of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
  dns[k] = function () { blocked('dns.' + k); };
}
if (typeof globalThis.fetch === 'function') {
  globalThis.fetch = function () { blocked('fetch'); };
}
`;

export interface ContractTestRunResult {
  /** false when the task has no contract_tests to run — nothing was executed. */
  ranTests: boolean;
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Run a contract task's `CONTRACT_TESTS` (already seeded into its sandbox
 * by `ensureContractSandbox`) in a locked-down child process. Exit code 0
 * is a pass; anything else — including a timeout — is a fail. This never
 * throws for a failing/hostile test; it only throws if the sandbox itself
 * doesn't exist yet (claim the task first).
 */
export function runContractTestsSafely(taskId: string, timeoutMs = DEFAULT_TIMEOUT_MS): ContractTestRunResult {
  const sandboxPath = contractSandboxPath(taskId);
  if (!fs.existsSync(sandboxPath)) {
    throw new Error(`no sandbox for ${taskId} — claim the task first.`);
  }
  const testFile = path.join(sandboxPath, TEST_ENTRY_FILENAME);
  if (!fs.existsSync(testFile)) {
    return { ranTests: false, passed: false, exitCode: null, timedOut: false, stdout: "", stderr: "" };
  }

  // Node's permission model checks the RESOLVED path — an unresolved grant
  // silently fails to cover it whenever the state dir sits behind a
  // symlink (e.g. macOS's /tmp → /private/tmp). Verified live: resolving
  // both the sandbox root and the entry script before building the
  // command line is not optional.
  const realSandbox = fs.realpathSync(sandboxPath);
  fs.writeFileSync(path.join(realSandbox, GUARD_FILENAME), GUARD_SCRIPT, "utf8");
  const realTestFile = fs.realpathSync(path.join(realSandbox, TEST_ENTRY_FILENAME));

  const result = spawnSync(
    process.execPath,
    [
      "--experimental-permission",
      `--allow-fs-read=${realSandbox}/*`,
      `--allow-fs-write=${realSandbox}/*`,
      "--require",
      path.join(realSandbox, GUARD_FILENAME),
      realTestFile,
    ],
    {
      cwd: realSandbox,
      // Explicit, minimal env — never process.env. Nothing to leak because
      // nothing sensitive is here to begin with.
      env: { PATH: process.env.PATH ?? "" },
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    },
  );

  const timedOut = result.signal === "SIGKILL" || result.error?.message?.includes("ETIMEDOUT") === true;
  return {
    ranTests: true,
    passed: !timedOut && result.status === 0,
    exitCode: result.status,
    timedOut,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? String(result.error.message) : ""),
  };
}
