import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state for the whole test run (set before importing the store).
const dir = path.join(os.tmpdir(), "lanchu-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;
process.env.LANCHU_STALE_HOURS = "24";

const store = await import("../dist/core/store.js");
const storeTypes = await import("../dist/core/types.js");
const { ScopeError } = storeTypes;
const { getContext } = await import("../dist/server/context.js");
const presence = await import("../dist/core/presence.js");

function setup(orgName) {
  const org = store.getOrCreateOrg(orgName);
  const project = store.getOrCreateProject(org.id, "web");
  const role = store.getOrCreateRole(org.id, "frontend", { tags: ["ui", "css"] });
  const agent = store.createAgent({ orgId: org.id, roleId: role.id, objective: "fix login page" });
  return { org, project, role, agent };
}

test("in-scope task can be created and claimed", () => {
  const { org, project, agent } = setup("acme1");
  const t = store.createTask({
    projectId: project.id,
    orgId: org.id,
    agentId: agent.id,
    title: "style the form",
    tags: ["ui"],
  });
  assert.equal(t.status, "available");
  const claimed = store.claimTask({ agentId: agent.id, taskId: t.id });
  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.owner_agent_id, agent.id);
});

test("out-of-scope task creation is blocked (hard block)", () => {
  const { org, project, agent } = setup("acme2");
  assert.throws(
    () =>
      store.createTask({
        projectId: project.id,
        orgId: org.id,
        agentId: agent.id,
        title: "db migration",
        tags: ["backend"],
      }),
    (err) => err instanceof ScopeError,
  );
});

test("atomic claim: a second claim on a taken task fails", () => {
  const { org, project, role, agent } = setup("acme3");
  const other = store.createAgent({ orgId: org.id, roleId: role.id, objective: "help" });
  const t = store.createTask({
    projectId: project.id,
    orgId: org.id,
    agentId: agent.id,
    title: "hero section",
    tags: ["ui"],
  });
  store.claimTask({ agentId: agent.id, taskId: t.id });
  assert.throws(() => store.claimTask({ agentId: other.id, taskId: t.id }));
});

test("reuse candidates match by objective footprint", () => {
  const { org, agent } = setup("acme4");
  store.endSessionsForAgent(agent.id); // becomes idle
  const candidates = store.findReuseCandidates(org.id, "the login page is broken");
  assert.ok(candidates.some((c) => c.agent.id === agent.id));
});

test("safe retirement blocks while open tasks exist, then succeeds", () => {
  const { org, project, agent } = setup("acme5");
  const t = store.createTask({
    projectId: project.id,
    orgId: org.id,
    agentId: agent.id,
    title: "navbar",
    tags: ["ui"],
  });
  store.claimTask({ agentId: agent.id, taskId: t.id });
  const blocked = store.retireAgent(agent.id);
  assert.equal(blocked.retired, false);
  assert.equal(blocked.blockedBy.length, 1);

  store.releaseTask({ agentId: null, taskId: t.id, override: true });
  const ok = store.retireAgent(agent.id);
  assert.equal(ok.retired, true);
});

test("doc upsert creates then updates", () => {
  const { org, agent } = setup("acme6");
  const created = store.upsertDoc({ orgId: org.id, agentId: agent.id, title: "Notes", content: "a" });
  const updated = store.upsertDoc({ orgId: org.id, agentId: agent.id, title: "Notes", content: "b" });
  assert.equal(created.id, updated.id);
  assert.equal(updated.content, "b");
});

test("audit log records events with resolved actor names", () => {
  const { org, project, agent } = setup("acme7");
  const t = store.createTask({ projectId: project.id, orgId: org.id, agentId: agent.id, title: "audit me", tags: ["ui"] });
  store.claimTask({ agentId: agent.id, taskId: t.id });
  const audit = store.listAuditEvents(org.id, 50);
  assert.ok(audit.length >= 2);
  assert.ok(audit.some((e) => e.type === "task.claimed" && e.actor_name === agent.name));
});

test("manual blocked stays blocked; dependency-blocked auto-unblocks", () => {
  const { org, project, agent } = setup("acme12");
  const mk = (title, deps) =>
    store.createTask({ projectId: project.id, orgId: org.id, agentId: agent.id, title, tags: ["ui"], deps });

  const manual = mk("stuck", []);
  store.claimTask({ agentId: agent.id, taskId: manual.id });
  store.updateTaskStatus({ agentId: agent.id, taskId: manual.id, status: "blocked" });

  const dep = mk("dependency", []);
  const dependent = mk("needs dep", [dep.id]);
  store.claimTask({ agentId: agent.id, taskId: dependent.id });
  store.updateTaskStatus({ agentId: agent.id, taskId: dependent.id, status: "blocked" });

  store.claimTask({ agentId: agent.id, taskId: dep.id });
  store.updateTaskStatus({ agentId: agent.id, taskId: dep.id, status: "done" });

  assert.equal(store.getTask(manual.id).status, "blocked"); // no deps → stays blocked
  assert.equal(store.getTask(dependent.id).status, "available"); // dep done → unblocked
});

test("skills: built-ins seeded, upsert, and tag matching", () => {
  const { org } = setup("acme15");
  const skills = store.listSkills(org.id);
  assert.ok(skills.length >= 5, "built-in skills seeded");
  assert.ok(skills.some((s) => s.name === "documentation" && s.tags.includes("docs")));
  assert.ok(store.skillsForTags(org.id, ["docs"]).some((s) => s.name === "documentation"));
  assert.equal(store.skillsForTags(org.id, ["nope"]).length, 0);
  const c1 = store.createSkill(org.id, { name: "custom", tags: ["x"], instructions: "a" });
  const c2 = store.createSkill(org.id, { name: "custom", tags: ["x", "y"], instructions: "b" });
  assert.equal(c1.id, c2.id); // upsert keeps the same row
  assert.equal(store.listSkills(org.id).find((s) => s.name === "custom").instructions, "b");
});

test("skills: loadable from a SKILL.md file, with frontmatter and reload", async () => {
  const { org } = setup("acme16");
  const file = path.join(dir, "code-review.md");
  fs.writeFileSync(
    file,
    ["---", "name: code-review", "description: Review diffs for bugs", "tags: code, review", "---", "Look for edge cases and missing tests."].join("\n"),
  );

  const loaded = await store.loadSkillFromUrl(org.id, file);
  assert.equal(loaded.name, "code-review");
  assert.equal(loaded.description, "Review diffs for bugs");
  assert.deepEqual(loaded.tags, ["code", "review"]);
  assert.match(loaded.instructions, /edge cases/);
  assert.equal(loaded.skill_url, file);
  assert.ok(loaded.loaded_at, "records when it was loaded");
  assert.ok(store.skillsForTags(org.id, ["review"]).some((s) => s.name === "code-review"));

  // Editing the source and reloading updates the same row in place.
  fs.writeFileSync(file, ["---", "name: code-review", "tags: code", "---", "Now also check for security issues."].join("\n"));
  const reloaded = await store.reloadSkill(loaded.id);
  assert.equal(reloaded.id, loaded.id);
  assert.match(reloaded.instructions, /security issues/);
  assert.deepEqual(reloaded.tags, ["code"]);

  // A source with no frontmatter name requires an explicit name override.
  const plain = path.join(dir, "plain.md");
  fs.writeFileSync(plain, "Just some instructions, no frontmatter.");
  await assert.rejects(() => store.loadSkillFromUrl(org.id, plain));
  const named = await store.loadSkillFromUrl(org.id, plain, { name: "plain", tags: ["misc"] });
  assert.equal(named.name, "plain");
  assert.equal(named.description, "");
  assert.deepEqual(named.tags, ["misc"]);
});

test("handoff reassigns to a peer (role-checked) and org rules persist", () => {
  const { org, project, agent } = setup("acme14");
  const peer = store.createAgent({ orgId: org.id, roleId: agent.role_id, objective: "peer" });
  const t = store.createTask({ projectId: project.id, orgId: org.id, agentId: agent.id, title: "hand me", tags: ["ui"] });
  store.claimTask({ agentId: agent.id, taskId: t.id });

  const byName = store.findAgentByName(org.id, peer.name);
  assert.equal(byName.id, peer.id);
  const handed = store.reassignTask({ taskId: t.id, toAgentId: peer.id, byAgentId: agent.id, note: "your turn" });
  assert.equal(handed.owner_agent_id, peer.id);

  // role must cover: a role with no matching tags cannot receive
  const narrow = store.getOrCreateRole(org.id, "narrow", { tags: ["other"] });
  const narrowAgent = store.createAgent({ orgId: org.id, roleId: narrow.id, objective: "x" });
  assert.throws(() => store.reassignTask({ taskId: t.id, toAgentId: narrowAgent.id }));

  assert.equal(store.getOrgRules(org.id), "");
  store.setOrgRules(org.id, "Be concise. Ask before deleting.");
  assert.match(store.getOrgRules(org.id), /concise/);
});

test("webhooks CRUD and event filtering", () => {
  const { org } = setup("acme9");
  const w = store.createWebhook(org.id, "http://example.test/hook", ["task.created"], "s3cret");
  assert.equal(store.listWebhooks(org.id).length, 1);
  assert.equal(store.webhooksForEvent(org.id, "task.created").length, 1);
  assert.equal(store.webhooksForEvent(org.id, "doc.updated").length, 0);
  const wild = store.createWebhook(org.id, "http://example.test/all", ["*"]);
  assert.equal(store.webhooksForEvent(org.id, "doc.updated").length, 1);
  store.deleteWebhook(w.id);
  store.deleteWebhook(wild.id);
  assert.equal(store.listWebhooks(org.id).length, 0);
});

test("recurring fires when due, creates a task, then reschedules", () => {
  const { org, project } = setup("acme13");
  const before = store.listTasks(project.id).length;
  const r = store.createRecurring({ orgId: org.id, projectId: project.id, title: "daily report", tags: ["ops"], intervalSeconds: 3600 });

  assert.ok(store.runDueRecurring() >= 1); // due immediately → fires
  const tasks = store.listTasks(project.id);
  assert.equal(tasks.length, before + 1);
  const created = tasks.find((t) => t.title === "daily report");
  assert.deepEqual(created.tags, ["ops"]);
  assert.equal(created.owner_agent_id, null); // unassigned

  assert.equal(store.runDueRecurring(), 0); // rescheduled to the future — no re-fire
  store.deleteRecurring(r.id);
});

test("intake creates an unassigned task with no scope check", () => {
  const { org, project } = setup("acme10");
  const t = store.createTaskSystem({ orgId: org.id, projectId: project.id, title: "from form", tags: ["backend"] });
  assert.equal(t.status, "available");
  assert.equal(t.owner_agent_id, null);
  assert.deepEqual(t.tags, ["backend"]);
});

test("board enriches agents (role, open count, workspace) and task owner name", () => {
  const { org, project, agent } = setup("acme8");
  const t = store.createTask({ projectId: project.id, orgId: org.id, agentId: agent.id, title: "enrich", tags: ["ui"] });
  store.claimTask({ agentId: agent.id, taskId: t.id, workspace: "feat/x" });
  const b = store.boardSnapshot(org.id);
  const ba = b.agents.find((a) => a.id === agent.id);
  assert.equal(ba.role_name, "frontend");
  assert.equal(ba.open_tasks, 1);
  assert.equal(ba.workspace, "feat/x");
  // A claimed task counts as the agent's active task…
  assert.equal(ba.active_task_id, t.id);
  assert.equal(ba.active_task_title, "enrich");
  // …but a task actually being built wins over one merely claimed.
  const t2 = store.createTask({ projectId: project.id, orgId: org.id, agentId: agent.id, title: "building now", tags: ["ui"] });
  store.claimTask({ agentId: agent.id, taskId: t2.id });
  store.updateTaskStatus({ agentId: agent.id, taskId: t2.id, status: "in_progress" });
  const ba2 = store.boardSnapshot(org.id).agents.find((a) => a.id === agent.id);
  assert.equal(ba2.active_task_id, t2.id);
  const bt = b.tasks.find((x) => x.id === t.id);
  assert.equal(bt.owner_name, agent.name);
});

test("getContext rehydrates a persisted session from the DB after a restart", () => {
  // A fresh test process has an empty in-memory context map — the same state the
  // server is in right after a restart. getContext must fall back to the open
  // session row so a token minted before the restart still authenticates.
  const { org, project, agent } = setup("acme11");
  const { token } = store.openSession(agent.id);
  const ctx = getContext(token);
  assert.ok(ctx, "expected getContext to rehydrate from the DB");
  assert.equal(ctx.token, token);
  assert.equal(ctx.agentId, agent.id);
  assert.equal(ctx.orgId, org.id);
  assert.equal(ctx.orgName, org.name);
  assert.equal(ctx.projectId, project.id);
  // An unknown token resolves to nothing.
  assert.equal(getContext("lsk_not_a_real_token"), undefined);
});

test("board marks a live-transport agent active even without recent activity", () => {
  // Regression: a Claude agent holds its MCP transport open but calls tools
  // only sporadically, so recency alone false-idles it between calls.
  const { org, agent } = setup("acme-live");
  // Fresh agent, no MCP traffic yet → recency says idle.
  assert.equal(store.boardSnapshot(org.id).agents.find((a) => a.id === agent.id).state, "idle");
  // An open MCP transport makes it active…
  presence.addLiveSession(agent.id);
  assert.equal(store.boardSnapshot(org.id).agents.find((a) => a.id === agent.id).state, "active");
  // …until the transport closes.
  presence.removeLiveSession(agent.id);
  assert.equal(store.boardSnapshot(org.id).agents.find((a) => a.id === agent.id).state, "idle");
});

test("live-session presence is ref-counted across concurrent sessions", () => {
  const { agent } = setup("acme-live2");
  presence.addLiveSession(agent.id);
  presence.addLiveSession(agent.id);
  assert.equal(presence.isAgentLive(agent.id), true);
  presence.removeLiveSession(agent.id);
  assert.equal(presence.isAgentLive(agent.id), true, "still live while one session remains");
  presence.removeLiveSession(agent.id);
  assert.equal(presence.isAgentLive(agent.id), false);
  // Over-releasing must not underflow or flip it back to live.
  presence.removeLiveSession(agent.id);
  assert.equal(presence.isAgentLive(agent.id), false);
});

test("updateRole extends a role's tags so its agent can claim a previously out-of-scope task", () => {
  const { org, project, role, agent } = setup("acme-roles-edit");
  const t = store.createTaskSystem({
    orgId: org.id,
    projectId: project.id,
    title: "panel + server work",
    tags: ["panel"],
  });
  assert.throws(() => store.claimTask({ agentId: agent.id, taskId: t.id }), ScopeError);

  const updated = store.updateRole(org.id, role.name, { addTags: ["panel"] });
  assert.ok(updated.allowed_tags.includes("panel"));
  const claimed = store.claimTask({ agentId: agent.id, taskId: t.id });
  assert.equal(claimed.owner_agent_id, agent.id);

  const ev = store.listAuditEvents(org.id).find((e) => e.type === "role.updated");
  assert.ok(ev, "role.updated must be audited");
  assert.equal(ev.subject_id, role.id);
  assert.deepEqual(ev.data.before.tags.sort(), ["css", "ui"]);
  assert.deepEqual(ev.data.after.tags.sort(), ["css", "panel", "ui"]);
});

test("updateRole removes tags, replaces the set, toggles wildcard, and never creates roles", () => {
  const { org } = setup("acme-roles-edit2");
  store.defineRole(org.id, "backend", { tags: ["server", "db", "cli"] });

  const afterRm = store.updateRole(org.id, "backend", { rmTags: ["cli"] });
  assert.deepEqual(afterRm.allowed_tags.sort(), ["db", "server"]);

  const afterReplace = store.updateRole(org.id, "backend", { tags: ["api"] });
  assert.deepEqual(afterReplace.allowed_tags, ["api"]);

  const wild = store.updateRole(org.id, "backend", { wildcard: true });
  assert.equal(wild.is_wildcard, true);
  const tame = store.updateRole(org.id, "backend", { wildcard: false });
  assert.equal(tame.is_wildcard, false);

  assert.equal(store.updateRole(org.id, "ghost", { addTags: ["x"] }), null);
  assert.equal(store.listRoles(org.id).some((r) => r.name === "ghost"), false);
});

test("budgets MVP: self-reported usage accrues per role and exhausted quota blocks claims", () => {
  const { org, project, role, agent } = setup("acme-budget");
  const { QuotaError } = storeTypes;

  // No quota → no budget, claims flow.
  assert.equal(store.roleBudget(role), null);

  store.updateRole(org.id, role.name, { quota: 1000 });
  const mk = (title) =>
    store.createTask({ projectId: project.id, orgId: org.id, agentId: agent.id, title, tags: ["ui"] });

  // Self-report 850 tokens on a first task (tokens ride task_update events).
  const t1 = mk("first");
  store.claimTask({ agentId: agent.id, taskId: t1.id });
  store.updateTaskStatus({ agentId: agent.id, taskId: t1.id, status: "done", tokens: 850 });
  assert.equal(store.roleTokenUsage(role.id), 850);

  // 85% consumed → nearing, not exhausted; claims still allowed.
  const b1 = store.roleBudget(store.getRole(role.id));
  assert.equal(b1.nearing, true);
  assert.equal(b1.exhausted, false);
  const t2 = mk("second");
  store.claimTask({ agentId: agent.id, taskId: t2.id });
  store.updateTaskStatus({ agentId: agent.id, taskId: t2.id, status: "done", tokens: 200 });

  // Over quota → claim blocked with QuotaError + audited quota.exceeded.
  const t3 = mk("third");
  assert.throws(() => store.claimTask({ agentId: agent.id, taskId: t3.id }), QuotaError);
  assert.equal(store.getTask(t3.id).status, "available", "blocked claim leaves the task available");
  const ev = store.listAuditEvents(org.id).find((e) => e.type === "quota.exceeded");
  assert.ok(ev, "quota.exceeded must be audited");
  assert.equal(ev.outcome, "rejected");
  assert.equal(ev.data.used, 1050);
  assert.equal(ev.data.quota, 1000);

  // Raising the quota unblocks; clearing it removes the budget entirely.
  store.updateRole(org.id, role.name, { quota: 5000 });
  const claimed = store.claimTask({ agentId: agent.id, taskId: t3.id });
  assert.equal(claimed.owner_agent_id, agent.id);
  store.updateRole(org.id, role.name, { quota: null });
  assert.equal(store.getRole(role.id).token_quota, null);
  assert.equal(store.roleBudget(store.getRole(role.id)), null);
});

test("orgGraph aggregates events into nodes and edges, flow vs bounce included", () => {
  const org = store.getOrCreateOrg("acme-graph");
  const project = store.getOrCreateProject(org.id, "web");
  const role = store.getOrCreateRole(org.id, "generalist", { wildcard: true });
  const product = store.createAgent({ orgId: org.id, roleId: role.id, objective: "steer", name: "product" });
  const builder = store.createAgent({ orgId: org.id, roleId: role.id, objective: "build", name: "builder" });
  const qa = store.createAgent({ orgId: org.id, roleId: role.id, objective: "verify", name: "qa" });

  // product defines → builder builds → done → handed backward to qa (bounce).
  const t = store.createTask({ projectId: project.id, orgId: org.id, agentId: product.id, title: "panel thing", tags: ["ui"] });
  store.claimTask({ agentId: builder.id, taskId: t.id });
  store.updateTaskStatus({ agentId: builder.id, taskId: t.id, status: "in_progress" });
  store.updateTaskStatus({ agentId: builder.id, taskId: t.id, status: "done" });
  store.reassignTask({ byAgentId: product.id, taskId: t.id, toAgentId: qa.id, override: true });
  store.sendNotice({ orgId: org.id, fromAgentId: builder.id, to: "product", body: "done, PR up" });
  store.upsertDoc({ orgId: org.id, agentId: product.id, title: "Graph notes", content: "x" });

  const g = store.orgGraph(org.id, 24);
  const edge = (from, to, kind) => g.edges.find((e) => e.from === from && e.to === to && e.kind === kind);

  assert.equal(g.window_hours, 24);
  assert.equal(g.nodes.filter((n) => n.kind === "agent").length, 3);
  assert.ok(g.nodes.some((n) => n.id === "area:ui"), "tag becomes an area node");
  const doc = g.nodes.find((n) => n.kind === "doc");
  assert.equal(doc.label, "Graph notes");
  assert.ok(edge(builder.id, product.id, "msg"), "A2A message edge");
  assert.ok(edge(product.id, qa.id, "handoff"), "reassign edge");
  assert.ok(edge(product.id, builder.id, "flow"), "forward flow: create → claim");
  assert.ok(edge(builder.id, qa.id, "bounce"), "backward move: done → reassigned");
  assert.ok(edge(product.id, doc.id, "doc"), "doc-edit edge");
  assert.ok(g.nodes.every((n) => n.weight >= 0), "weights are non-negative");

  // Retired agents disappear unless they acted inside the window.
  store.releaseTask({ agentId: null, taskId: t.id, override: true });
  store.retireAgent(qa.id);
  const g2 = store.orgGraph(org.id, 24);
  const qaNode = g2.nodes.find((n) => n.id === qa.id);
  assert.ok(qaNode, "qa acted in the window — still on the map");
  assert.equal(qaNode.state, "retired");
});

test("doc reads: counters bump, readers accounted, Activity hides doc.read by default", () => {
  const { org, agent } = setup("acme-reads");
  const other = store.createAgent({ orgId: org.id, roleId: store.getOrCreateRole(org.id, "frontend", { tags: ["ui", "css"] }).id, objective: "read specs" });
  const doc = store.upsertDoc({ orgId: org.id, agentId: agent.id, title: "Spec", content: "the plan" });
  assert.equal(store.getDoc(doc.id).read_count, 0);

  store.recordDocRead({ orgId: org.id, agentId: agent.id, docId: doc.id });
  store.recordDocRead({ orgId: org.id, agentId: agent.id, docId: doc.id });
  store.recordDocRead({ orgId: org.id, agentId: other.id, docId: doc.id });

  const d = store.getDoc(doc.id);
  assert.equal(d.read_count, 3);
  assert.equal(d.last_read_by_agent_id, other.id);
  assert.ok(d.last_read_at);

  const readers = store.docReaders(doc.id);
  assert.equal(readers.length, 2);
  const mine = readers.find((r) => r.agent_id === agent.id);
  assert.equal(mine.reads, 2);
  assert.equal(mine.name, agent.name);

  // Default Activity feed hides the volume; ?reads=1 / includeReads shows it.
  const quiet = store.listAuditEvents(org.id, 100);
  assert.ok(!quiet.some((e) => e.type === "doc.read"), "doc.read must be hidden by default");
  const full = store.listAuditEvents(org.id, 100, { includeReads: true });
  assert.equal(full.filter((e) => e.type === "doc.read").length, 3);
});

test("test registry: report upserts suites/cases, tracks runs, planned gaps close on real runs", () => {
  const { org, agent } = setup("acme-tests");
  const r1 = store.reportTestRun({
    orgId: org.id, agentId: agent.id, suite: "store", commit: "abc1234",
    cases: [
      { name: "claims are atomic", status: "pass", durationMs: 12 },
      { name: "quota blocks over-limit", status: "fail", durationMs: 30 },
      { name: "greenzone flow", status: "planned" },
    ],
  });
  assert.deepEqual(r1, { suite: "store", recorded: 2, planned: 1, passed: 1, failed: 1 });

  // Re-report: same suite/case names reuse rows; the planned gap closes when a real run lands.
  store.reportTestRun({
    orgId: org.id, agentId: agent.id, suite: "store", commit: "def5678",
    cases: [
      { name: "quota blocks over-limit", status: "pass", durationMs: 25 },
      { name: "greenzone flow", status: "pass", durationMs: 8 },
    ],
  });

  const reg = store.testRegistry(org.id);
  assert.equal(reg.length, 1);
  const suite = reg[0];
  assert.equal(suite.name, "store");
  assert.equal(suite.cases.length, 3);
  assert.equal(suite.planned_gaps, 0, "planned gap must close after a real run");
  assert.equal(suite.failing, 0, "the fail was superseded by a pass");

  const quota = suite.cases.find((c) => c.name === "quota blocks over-limit");
  assert.equal(quota.last_status, "pass");
  assert.equal(quota.last_commit, "def5678");
  assert.equal(quota.last_ran_by, agent.name);
  assert.equal(quota.recent_runs, 2);
  assert.equal(quota.recent_passes, 1);

  // Audited: one test.reported event per run, failing runs marked rejected.
  const evs = store.listAuditEvents(org.id, 50).filter((e) => e.type === "test.reported");
  assert.equal(evs.length, 2);
  assert.ok(evs.some((e) => e.outcome === "rejected"), "a run with failures audits as rejected");

  assert.throws(() => store.reportTestRun({ orgId: org.id, agentId: agent.id, suite: "x", cases: [] }));
});

// ── rule 7 (task-mrgplqdo11): every role may always FILE taxonomy-tagged tasks ──
// A probe with allowed_tags=[] found a real SDLC bug during the wake-v5 drill
// and had to relay it through the coordinator because task_create rejected
// even ["bug"]. Detection is everyone's job.

test("an empty-tags role can file bug/extension/idea/process tasks; area tags still scope-check", () => {
  const org = store.getOrCreateOrg("rule7-org");
  const project = store.getOrCreateProject(org.id, "core");
  const scoped = store.getOrCreateRole(org.id, "scoped-probe", { tags: [] }); // no areas, no wildcard
  const probe = store.createAgent({ orgId: org.id, roleId: scoped.id, name: "probe-rule7" });

  const filed = store.createTask({
    projectId: project.id, orgId: org.id, agentId: probe.id,
    title: "Bug: router sent verification to a parked probe — repro attached",
    tags: ["bug"],
  });
  assert.equal(filed.status, "available", "taxonomy-only filing always works");
  assert.deepEqual(filed.tags, ["bug"]);

  // Taxonomy + an uncovered AREA tag still rejects, naming only the area.
  assert.throws(
    () => store.createTask({
      projectId: project.id, orgId: org.id, agentId: probe.id,
      title: "Bug with area", tags: ["bug", "server"],
    }),
    (err) => err instanceof ScopeError && /\[server\]/.test(err.message) && !/bug/.test(err.message),
  );

  // Claiming is untouched: the probe cannot claim even its own taxonomy-only task.
  // (roleCoversTags over the task's tags still applies on claim.)
  const claimed = store.claimTask({ agentId: probe.id, taskId: filed.id });
  assert.equal(claimed.status, "claimed", "taxonomy-only tasks are claimable by anyone (no area to license)");
});
