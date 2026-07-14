import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-test-contract-schema-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;

const store = await import("../dist/core/store.js");

function setup(orgName) {
  const org = store.getOrCreateOrg(orgName);
  const project = store.getOrCreateProject(org.id, "web");
  const role = store.getOrCreateRole(org.id, "generalist", { wildcard: true });
  const agent = store.createAgent({ orgId: org.id, roleId: role.id, objective: "moderate" });
  return { org, project, role, agent };
}

// Network mode Piece 5 (task-mrk1qrnn42): a contract task can be created
// and read back with its contract fields; the full existing test suite
// still passes unchanged.

test("a contract task can be created and read back with its contract fields", () => {
  const { org, project, agent } = setup("contract-schema-org-1");
  const task = store.createTask({
    projectId: project.id,
    orgId: org.id,
    agentId: agent.id,
    title: "implement isValidEmail(s: string): boolean",
    tags: [],
    kind: "contract",
    contractSpec: "## Signature\n`isValidEmail(s: string): boolean`\n\nReturns true iff `s` is a syntactically valid email.",
    contractTests: "test('rejects missing @', () => assert.equal(isValidEmail('nope'), false));",
    contractDeps: JSON.stringify(["task-other1", "task-other2"]),
  });

  assert.equal(task.kind, "contract");
  assert.match(task.contract_spec, /isValidEmail/);
  assert.match(task.contract_tests, /rejects missing @/);
  assert.deepEqual(JSON.parse(task.contract_deps), ["task-other1", "task-other2"]);

  // Round-trips through a fresh read, not just the create-time return value.
  const fetched = store.getTask(task.id);
  assert.equal(fetched.kind, "contract");
  assert.equal(fetched.contract_spec, task.contract_spec);
  assert.equal(fetched.contract_tests, task.contract_tests);
  assert.equal(fetched.contract_deps, task.contract_deps);
});

test("every existing task-creation path defaults to kind='internal' with null contract fields", () => {
  const { org, project, agent } = setup("contract-schema-org-2");
  const task = store.createTask({
    projectId: project.id,
    orgId: org.id,
    agentId: agent.id,
    title: "ordinary local-mode work",
    tags: [],
  });

  assert.equal(task.kind, "internal");
  assert.equal(task.contract_spec, null);
  assert.equal(task.contract_tests, null);
  assert.equal(task.contract_deps, null);
  assert.equal(task.status, "available"); // unaffected otherwise
});

test("a contract task can omit contractTests/contractDeps — only the spec is required in practice", () => {
  const { org, project, agent } = setup("contract-schema-org-3");
  const task = store.createTask({
    projectId: project.id,
    orgId: org.id,
    agentId: agent.id,
    title: "implement add(a, b)",
    tags: [],
    kind: "contract",
    contractSpec: "`add(a: number, b: number): number` — returns a + b.",
  });

  assert.equal(task.kind, "contract");
  assert.match(task.contract_spec, /add/);
  assert.equal(task.contract_tests, null);
  assert.equal(task.contract_deps, null);
});
