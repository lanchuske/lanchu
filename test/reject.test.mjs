import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-reject-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;

const store = await import("../dist/core/store.js");
const { ScopeError } = await import("../dist/core/types.js");
const { definitionHint } = await import("../dist/server/mcp.js");

/** An org with a product definer, a product-role teammate, and a builder. */
function setup(orgName) {
  const org = store.getOrCreateOrg(orgName);
  const project = store.getOrCreateProject(org.id, "core");
  const productRole = store.getOrCreateRole(org.id, "product", { wildcard: true });
  const builderRole = store.getOrCreateRole(org.id, "generalist", { wildcard: true });
  const definer = store.createAgent({ orgId: org.id, roleId: productRole.id, name: "definer" });
  const pm = store.createAgent({ orgId: org.id, roleId: productRole.id, name: "pm" });
  const builder = store.createAgent({ orgId: org.id, roleId: builderRole.id, name: "builder" });
  return { org, project, definer, pm, builder };
}

test("reject bounces the task to definition and notifies the creator and the product role", () => {
  const { org, project, definer, pm, builder } = setup("reject-org");

  const t = store.createTask({
    projectId: project.id, orgId: org.id, agentId: definer.id,
    title: "Vague thing", tags: ["server"],
  });
  store.claimTask({ agentId: builder.id, taskId: t.id });

  const rejected = store.rejectTask({
    agentId: builder.id, taskId: t.id,
    reason: "underspecified", note: "No acceptance criteria; which endpoint?",
  });

  assert.equal(rejected.status, "available");
  assert.equal(rejected.owner_agent_id, null);
  assert.equal(rejected.stage, "definition");
  assert.equal(rejected.rejection_count, 1);
  assert.equal(rejected.last_rejection.reason, "underspecified");
  assert.equal(rejected.last_rejection.by, "builder");
  assert.match(rejected.last_rejection.note, /acceptance criteria/);

  // Creator (who is product) gets ONE notice — recipients are deduped — and
  // the other product-role agent hears too. The rejecter hears nothing.
  const definerHeard = store.takeUndeliveredNotices(definer.id);
  assert.equal(definerHeard.length, 1);
  assert.match(definerHeard[0].body, /builder rejected .* \(underspecified\)/);
  assert.equal(definerHeard[0].ref, t.id);
  assert.equal(store.takeUndeliveredNotices(pm.id).length, 1);
  assert.equal(store.takeUndeliveredNotices(builder.id).length, 0);

  // On the record: task.rejected in the audit log.
  const ev = store.listAuditEvents(org.id).find((e) => e.type === "task.rejected");
  assert.ok(ev, "task.rejected event recorded");
  assert.equal(ev.subject_id, t.id);
  assert.equal(ev.data.reason, "underspecified");
  assert.equal(ev.data.rejections, 1);
});

test("second rejection flags needs-definition in the counter and the notice", () => {
  const { org, project, definer, builder } = setup("reject-twice-org");

  const t = store.createTask({
    projectId: project.id, orgId: org.id, agentId: definer.id,
    title: "Still vague", tags: ["server"],
  });
  store.claimTask({ agentId: builder.id, taskId: t.id });
  store.rejectTask({ agentId: builder.id, taskId: t.id, reason: "missing_docs", note: "no design doc" });
  store.takeUndeliveredNotices(definer.id); // drain round 1

  store.claimTask({ agentId: builder.id, taskId: t.id });
  const second = store.rejectTask({ agentId: builder.id, taskId: t.id, reason: "missing_docs", note: "still no doc" });

  assert.equal(second.rejection_count, 2);
  const heard = store.takeUndeliveredNotices(definer.id);
  assert.equal(heard.length, 1);
  assert.match(heard[0].body, /rejection #2/);
  assert.match(heard[0].body, /needs definition/);
});

test("only the owner can reject an owned task; done tasks can't be rejected", () => {
  const { org, project, definer, pm, builder } = setup("reject-guard-org");

  const t = store.createTask({
    projectId: project.id, orgId: org.id, agentId: definer.id,
    title: "Owned elsewhere", tags: ["server"],
  });
  store.claimTask({ agentId: builder.id, taskId: t.id });
  assert.throws(
    () => store.rejectTask({ agentId: pm.id, taskId: t.id, reason: "other", note: "not mine" }),
    ScopeError,
  );

  store.updateTaskStatus({ agentId: builder.id, taskId: t.id, status: "done" });
  assert.throws(
    () => store.rejectTask({ agentId: builder.id, taskId: t.id, reason: "other", note: "too late" }),
    /done/,
  );
});

test("definition-of-ready hint fires only on long prose without doc links or criteria", () => {
  const longVague = "Do the thing with the stuff and then some more of it ".repeat(6); // >200 chars, no spec markers
  assert.match(definitionHint(longVague), /doc link or acceptance criteria/);

  assert.equal(definitionHint("Short and sweet"), undefined);
  assert.equal(definitionHint(longVague + ' per the design doc "SDLC state machine"'), undefined);
  assert.equal(definitionHint(longVague + " acceptance criteria: returns 200"), undefined);
  assert.equal(definitionHint(longVague + " see https://example.com/spec"), undefined);
});
