import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-knowledge-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;

const store = await import("../dist/core/store.js");

function setup(orgName) {
  const org = store.getOrCreateOrg(orgName);
  const project = store.getOrCreateProject(org.id, "core");
  const role = store.getOrCreateRole(org.id, "generalist", { wildcard: true });
  const agent = store.createAgent({ orgId: org.id, roleId: role.id, name: "builder" });
  return { org, project, role, agent };
}

const PANEL_DOC = [
  "# Panel philosophy",
  "",
  "The panel observes and guides; provisioning stays in the terminal.",
  "",
  "## Why provisioning must stay in the terminal",
  "A record must bind to a real folder.",
  "Names drift otherwise.",
  "",
  "## What the panel MAY do",
  "Focus terminals, retire agents.",
].join("\n");

test("docAbstract: first heading + lead, tightly capped", () => {
  const a = store.docAbstract(PANEL_DOC);
  assert.equal(a, "Panel philosophy — The panel observes and guides; provisioning stays in the terminal.");
  const long = store.docAbstract("# T\n\n" + "x".repeat(500));
  assert.ok(long.length <= 220);
  assert.ok(long.endsWith("…"));
});

test("docSection: one heading's section, headings hint, null on miss", () => {
  const sec = store.docSection(PANEL_DOC, "why provisioning");
  assert.match(sec, /^## Why provisioning/);
  assert.match(sec, /Names drift/);
  assert.equal(sec.includes("What the panel MAY do"), false, "stops at the next same-level heading");
  assert.equal(store.docSection(PANEL_DOC, "nope"), null);
  assert.deepEqual(store.docHeadings(PANEL_DOC), [
    "Panel philosophy",
    "Why provisioning must stay in the terminal",
    "What the panel MAY do",
  ]);
});

test("docsIndexFor: lane filter by tags, abstracts only, graceful fallback", () => {
  const { org, agent } = setup("kn1");
  store.upsertDoc({ orgId: org.id, agentId: agent.id, title: "Panel design", content: PANEL_DOC, category: "design" });
  store.upsertDoc({ orgId: org.id, agentId: agent.id, title: "Server auth", content: "# Auth\n\nBearer keys.", category: "technical" });

  const lane = store.docsIndexFor(org.id, ["panel"]);
  assert.deepEqual(lane.map((d) => d.title), ["Panel design"], "only lane-relevant docs");
  assert.ok(lane[0].abstract.length > 0);
  assert.equal("content" in lane[0], false, "abstracts, never bodies");

  const all = store.docsIndexFor(org.id, ["something-no-doc-mentions"]);
  assert.equal(all.length, 2, "zero matches falls back to the full index");
  assert.equal(store.docsIndexFor(org.id).length, 2, "no tags → full index");
});

test("memoriesForContext: lane-filters project/org entries, agent-own always rides", () => {
  const { org, project, agent } = setup("kn2");
  store.memorySet({ orgId: org.id, scope: "agent", subjectId: agent.id, key: "own", value: "unrelated personal note", actorAgentId: agent.id });
  store.memorySet({ orgId: org.id, scope: "project", subjectId: project.id, key: "hot-zone:panel", value: "panel is contested" });
  store.memorySet({ orgId: org.id, scope: "project", subjectId: project.id, key: "pr:task-1", value: "PR 9 addressed webhooks" });
  store.memorySet({ orgId: org.id, scope: "org", subjectId: org.id, key: "role:backend", value: "backend covers server" });

  const lane = store.memoriesForContext(org.id, agent.id, project.id, 15, ["panel"]);
  const keys = lane.map((m) => m.key).sort();
  assert.deepEqual(keys, ["hot-zone:panel", "own"], "agent-own + tag-matching only");

  const untagged = store.memoriesForContext(org.id, agent.id, project.id);
  assert.equal(untagged.length, 4, "no tags → previous behavior");
});

test("context spend: measured off-bus, aggregated, hidden from Activity, and NEVER counted as budget tokens", () => {
  const { org, role, agent } = setup("kn3");
  store.updateRole(org.id, role.name, { quota: 1000 });
  const before = store.roleTokenUsage(role.id);

  store.recordToolSpend(org.id, agent.id, "org_context", 4000);
  store.recordToolSpend(org.id, agent.id, "doc_read", 6000);
  store.recordToolSpend(org.id, agent.id, "doc_read", 2000);

  const spend = store.contextSpend(org.id);
  const docRead = spend.by_tool.find((t) => t.tool === "doc_read");
  assert.deepEqual({ calls: docRead.calls, chars: docRead.chars }, { calls: 2, chars: 8000 });
  assert.equal(spend.by_tool.find((t) => t.tool === "org_context").chars, 4000);
  assert.equal(spend.by_agent[0].agent, "builder");
  assert.equal(spend.by_agent[0].chars, 12000);

  assert.equal(store.listAuditEvents(org.id).some((e) => e.type === "tool.response"), false, "off the default Activity feed");
  assert.equal(store.roleTokenUsage(role.id), before, "spend chars must not pollute the self-reported token budget");
});
