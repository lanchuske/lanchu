import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state (set before importing anything that opens the DB).
const dir = path.join(os.tmpdir(), "lanchu-session-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;
delete process.env.LANCHU_ACCESS_KEY;

const { createServer } = await import("../dist/server/server.js");
const store = await import("../dist/core/store.js");

const server = createServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const join = async (body) => {
  const res = await fetch(base + "/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ org: "sess-org", project: "web", ...body }),
  });
  assert.equal(res.status, 200);
  return res.json();
};

test("repeated /session joins with the same agentName reuse the same agent", async () => {
  const first = await join({ agentName: "product" });
  const second = await join({ agentName: "product" });
  assert.equal(second.agentId, first.agentId, "same durable agent");
  assert.equal(second.agentName, "product", "no phantom dedupe (product-2)");

  const org = store.getOrgByName("sess-org");
  const agents = store.listAgents(org.id).filter((a) => a.name.startsWith("product"));
  assert.equal(agents.length, 1, "no phantom agents minted by repeated joins");

  const reused = store.listAuditEvents(org.id).find((e) => e.type === "agent.reused");
  assert.ok(reused, "reuse is audited");
  assert.equal(reused.subject_id, first.agentId);
});

test("create:true keeps dedupe-on-collision for spawn", async () => {
  const first = await join({ agentName: "builder", create: true });
  const second = await join({ agentName: "builder", create: true });
  assert.notEqual(second.agentId, first.agentId, "spawn mints a fresh teammate");
  assert.equal(second.agentName, "builder-2", "collision gets the dedupe suffix");
});

test("a retired agent is not reused — a fresh one is created", async () => {
  const first = await join({ agentName: "old-timer" });
  const r = store.retireAgent(first.agentId);
  assert.equal(r.retired, true);
  const second = await join({ agentName: "old-timer" });
  assert.notEqual(second.agentId, first.agentId, "retired agents stay retired");
});

test("explicit reuseAgentId still wins over agentName", async () => {
  const a = await join({ agentName: "alpha" });
  const b = await join({ reuseAgentId: a.agentId, agentName: "ignored" });
  assert.equal(b.agentId, a.agentId);
  assert.equal(b.agentName, "alpha");
});
