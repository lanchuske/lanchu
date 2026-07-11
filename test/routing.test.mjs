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
