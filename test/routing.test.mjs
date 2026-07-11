import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-routing-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;

const { suggestModel, sameModelTier } = await import("../dist/core/routing.js");
const store = await import("../dist/core/store.js");
const { bootstrapCommand } = await import("../dist/server/cockpit.js");
const { createServer } = await import("../dist/server/server.js");

test("static tier map: definition/review → opus, mechanical → haiku, default sonnet", () => {
  assert.equal(suggestModel(["server"], "definition").model, "opus");
  assert.equal(suggestModel(["panel"], "review").model, "opus");
  assert.equal(suggestModel(["design", "core"], "build").model, "opus", "architecture tag wins");
  assert.equal(suggestModel(["docs"], "build").model, "haiku");
  assert.equal(suggestModel(["qa", "smoke"], null).model, "haiku");
  assert.equal(suggestModel(["qa", "server"], "build").model, "sonnet", "mixed tags are not mechanical-only");
  assert.equal(suggestModel(["server", "cli"], "build").model, "sonnet");
  assert.equal(suggestModel([], null).model, "sonnet", "default tier");
});

test("sameModelTier compares alias families and never nags on unknowns", () => {
  assert.equal(sameModelTier("sonnet", "claude-sonnet-5"), true);
  assert.equal(sameModelTier("opus", "sonnet"), false);
  assert.equal(sameModelTier(null, "haiku"), true, "unknown current model → no hint");
  assert.equal(sameModelTier("claude-opus-4-8", "opus"), true);
});

test("role.preferred_model persists, audits, and defaults the agent's model", () => {
  const org = store.getOrCreateOrg("route-org");
  store.defineRole(org.id, "qa", { tags: ["qa"] });
  const role = store.updateRole(org.id, "qa", { preferredModel: "haiku" });
  assert.equal(role.preferred_model, "haiku");
  const ev = store.listAuditEvents(org.id).find((e) => e.type === "role.updated");
  assert.equal(ev.data.after.model, "haiku", "model change is on the audit record");

  const agent = store.createAgent({ orgId: org.id, roleId: role.id, name: "qa-bot" });
  store.setAgentModel(agent.id, role.preferred_model);
  assert.equal(store.getAgent(agent.id).model, "haiku");

  const cleared = store.updateRole(org.id, "qa", { preferredModel: null });
  assert.equal(cleared.preferred_model, null);
});

test("bootstrapCommand launches claude with --model when one is chosen", () => {
  const withModel = bootstrapCommand("/tmp/x", "tok", "hello", "qa-bot", "org·qa-bot", "haiku");
  assert.match(withModel, /claude --model 'haiku' /);
  const without = bootstrapCommand("/tmp/x", "tok", "hello", "qa-bot", "org·qa-bot");
  assert.equal(without.includes("--model"), false, "no flag when no tier chosen");
});

// QA follow-up (batch 4, task-mrg535ea2): end-to-end /session coverage for the
// precedence rule (explicit > agent's own > role default) that only existed as
// direct store calls above — a real spawn goes through handleSession, not
// store.setAgentModel directly.
{
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  test.after(() => server.close());

  const join = async (body) => {
    const res = await fetch(`${base}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ org: "route-session-org", project: "core", ...body }),
    });
    assert.equal(res.status, 200);
    return res.json();
  };

  test("a fresh role with no preferred_model does not auto-default any tier", async () => {
    const { agentId } = await join({ agentName: "plain-role-agent", role: "unconfigured-role" });
    assert.equal(store.getAgent(agentId).model, null, "no tier without an explicit --model or a configured role.preferred_model");
  });

  test("/session inherits the role's preferred_model on a fresh spawn", async () => {
    const org = store.getOrCreateOrg("route-session-org");
    store.defineRole(org.id, "cheap-role", {});
    store.updateRole(org.id, "cheap-role", { preferredModel: "haiku" });
    const { agentId } = await join({ agentName: "cheap-agent", role: "cheap-role" });
    assert.equal(store.getAgent(agentId).model, "haiku");
  });

  test("/session's explicit model overrides the role default", async () => {
    const { agentId } = await join({ agentName: "override-agent", role: "cheap-role", model: "opus" });
    assert.equal(store.getAgent(agentId).model, "opus");
  });

  test("respawn keeps the agent's own model even if the role default later changes", async () => {
    const org = store.getOrCreateOrg("route-session-org");
    store.defineRole(org.id, "drifting-role", {});
    store.updateRole(org.id, "drifting-role", { preferredModel: "sonnet" });
    const first = await join({ agentName: "durable-agent", role: "drifting-role" });
    assert.equal(store.getAgent(first.agentId).model, "sonnet");

    store.updateRole(org.id, "drifting-role", { preferredModel: "opus" });
    const second = await join({ agentName: "durable-agent" }); // plain rejoin, no role/model passed
    assert.equal(second.agentId, first.agentId, "same durable agent");
    assert.equal(store.getAgent(second.agentId).model, "sonnet", "keeps its own model, not the role's new default");
  });
}
