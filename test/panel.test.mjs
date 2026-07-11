import { test } from "node:test";
import assert from "node:assert/strict";

// panelHtml() is a pure render — these tests pin the panel-philosophy surface
// shipped in #19 (observe & guide, provision from the terminal) so a future
// panel refactor can't silently drop the guidance or grow a creation UI.
const { panelHtml } = await import("../dist/server/panel.js");
const html = panelHtml();

test("panel guides provisioning to the terminal with copyable commands", () => {
  // Empty states hand the supervisor the exact command instead of a create button.
  assert.match(html, /No projects yet\..*created from inside that folder/s);
  assert.match(html, /No agents yet\. Agents are started from the terminal/);
  assert.ok(html.includes("lanchu init"), "expected the init command in empty-state guidance");
  assert.ok(html.includes('lanchu spawn "your objective"'), "expected the spawn command in the Team empty state");
  // The reusable snippet + clipboard copy that every empty state relies on.
  assert.ok(html.includes("cmdSnippet"), "expected the copyable command snippet helper");
  assert.ok(html.includes("navigator.clipboard"), "expected clipboard wiring for the copy button");
  // Persistent sidebar help.
  assert.ok(html.includes("How do I add an org or project?"), "expected the standing sidebar help entry");
  // Org picker warns instead of creating.
  assert.ok(html.includes("only picks existing orgs"), "expected the unknown-org warning in the picker");
});

test("panel surfaces orphans under Needs attention with the existing actions", () => {
  assert.ok(html.includes("Needs attention"), "expected the Needs attention section");
  assert.match(html, /No agents and no tasks\./, "expected the orphan-org explanation");
  // Cleanup reuses the existing endpoints — Remove for orphan orgs, Retire for idle agents.
  assert.ok(html.includes("/org/delete"), "expected orphan Remove to call /org/delete");
  assert.ok(html.includes("/agent/retire"), "expected idle-agent Retire to call /agent/retire");
});

test("panel has no creation UI — provisioning is terminal-only", () => {
  // The panel must never call the explicit create endpoint (CLI/automation only).
  assert.ok(!html.includes("/org/create"), "panel must not call /org/create");
});

test("agent cards show the who-is-where fields (worktree, branch, active task)", () => {
  // Board fields shipped in #16; the card renders them so the supervisor can
  // see what each agent is on without opening its terminal.
  assert.ok(html.includes("active_task_title"), "expected the active-task line on agent cards");
  assert.ok(html.includes("worktree"), "expected the worktree on agent cards");
  assert.ok(html.includes("branch"), "expected the branch on agent cards");
});

test("panel client script is syntactically valid JavaScript", () => {
  // Regression for the #27 unescaped-apostrophe bug: one bad quote in any
  // embedded string breaks the ENTIRE panel script in the browser. Extract the
  // client script and parse it — new Function throws on a syntax error.
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(m, "expected an inline client script");
  assert.doesNotThrow(() => new Function(m[1]));
});

test("docs cards carry knowledge analytics (reads, readers, freshness flags)", () => {
  assert.ok(html.includes("read_count"), "expected read-count rendering");
  assert.ok(html.includes("never read"), "expected the never-read prune flag");
  assert.ok(html.includes("stale but hot"), "expected the refresh-candidate flag");
  assert.ok(html.includes("consulted by"), "expected the who-consulted-what list");
});

// Batch-3 QA follow-up (task-mrg3o05x1): #28 shipped panel-only with no
// coverage — pin the roles/activity polish surface.

test("roles view shows holders and collapses unused roles; activity clamps and links (#28)", () => {
  assert.ok(html.includes("Unused roles"), "expected the muted unused-roles chip row");
  assert.ok(html.includes("holders"), "expected role cards to carry their holders");
  assert.ok(html.includes("more ▼") && html.includes("less ▲"), "expected the note clamp expand/collapse affordance");
  const renders = html.match(/renderAuditRows/g) ?? [];
  assert.ok(renders.length >= 2, "activity rows must render through the single shared renderAuditRows");
});
