import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// task-mrg75clh15 (tile v2): on an ODD count of org terminals, the
// coordinator's window gets a full-height double-width pane instead of an
// equal grid cell. Scope note: creating/switching to a dedicated empty macOS
// Space needs Accessibility-gated System Events keystrokes, which conflicts
// with this codebase's hard no-Accessibility/no-keystroke-injection rule
// (Wake v5.1) — so this ships the coordinator-gets-the-larger-pane grid math
// and the strict id allowlist (inherited from task-mrg6z88g13/#112) over the
// CURRENT screen, same as today's tile, with Space-isolation left as a known,
// documented gap rather than silently faked or force-added via Accessibility.

const dir = path.join(os.tmpdir(), "lanchu-tile-v2-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;
delete process.env.LANCHU_ACCESS_KEY;

const { tileTerminals } = await import("../dist/server/cockpit.js");
const store = await import("../dist/core/store.js");

const macNoTmux = { hasTmux: () => false, isMac: () => true };

test("odd count + a known coordinator among the refs: the coordinator's window gets the big-pane branch", () => {
  let seenScript = "";
  const refs = [
    { method: "terminal.app", id: "10" },
    { method: "terminal.app", id: "20" },
    { method: "terminal.app", id: "30" },
  ];
  const r = tileTerminals(refs, false, {
    ...macNoTmux,
    coordinatorRefId: "20",
    run: (osa) => { seenScript = osa; return "3"; },
  });
  assert.match(seenScript, /\{20, 10, 30\}/, "the coordinator's id is moved to the front of the match list");
  assert.match(seenScript, /set hasBig to \(true and n is 3 and n > 1 and \(n mod 2 is 1\)\)/);
  assert.match(seenScript, /if hasBig then/);
  assert.match(r.note, /coordinator gets the larger pane/);
});

test("even count: no big pane, even with a known coordinator", () => {
  let seenScript = "";
  const refs = [
    { method: "terminal.app", id: "1" },
    { method: "terminal.app", id: "2" },
    { method: "terminal.app", id: "3" },
    { method: "terminal.app", id: "4" },
  ];
  const r = tileTerminals(refs, false, {
    ...macNoTmux,
    coordinatorRefId: "2",
    run: (osa) => { seenScript = osa; return "4"; },
  });
  assert.match(seenScript, /set hasBig to \(true and n is 4 and n > 1 and \(n mod 2 is 1\)\)/, "hasBig's own guard evaluates false at runtime — n mod 2 is 1 fails for 4");
  assert.doesNotMatch(r.note, /coordinator gets the larger pane/);
});

test("odd count but a window is closed (partial match): big pane is skipped rather than risk the wrong agent", () => {
  const refs = [
    { method: "terminal.app", id: "1" },
    { method: "terminal.app", id: "2" },
    { method: "terminal.app", id: "3" },
  ];
  const r = tileTerminals(refs, false, {
    ...macNoTmux,
    coordinatorRefId: "2",
    run: () => "2", // only 2 of 3 ids resolved — the coordinator's own position is no longer certain
  });
  assert.equal(r.count, 2);
  assert.doesNotMatch(r.note, /coordinator gets the larger pane/);
  assert.match(r.note, /2 of 3 known agent Terminal\.app windows/);
});

test("no coordinatorRefId supplied: plain grid, no big-pane note, id order unchanged", () => {
  let seenScript = "";
  const refs = [{ method: "terminal.app", id: "5" }, { method: "terminal.app", id: "6" }, { method: "terminal.app", id: "7" }];
  const r = tileTerminals(refs, false, { ...macNoTmux, run: (osa) => { seenScript = osa; return "3"; } });
  assert.match(seenScript, /\{5, 6, 7\}/);
  assert.match(seenScript, /set hasBig to \(false and /);
  assert.doesNotMatch(r.note, /coordinator gets the larger pane/);
});

test("coordinatorRefId not among the known refs: ignored, no reorder, no big pane", () => {
  let seenScript = "";
  const refs = [{ method: "terminal.app", id: "5" }, { method: "terminal.app", id: "6" }, { method: "terminal.app", id: "7" }];
  const r = tileTerminals(refs, false, {
    ...macNoTmux,
    coordinatorRefId: "999", // not in refs — e.g. the coordinator has no Terminal.app window
    run: (osa) => { seenScript = osa; return "3"; },
  });
  assert.match(seenScript, /\{5, 6, 7\}/);
  assert.match(seenScript, /set hasBig to \(false and /);
  assert.doesNotMatch(r.note, /coordinator gets the larger pane/);
});

// ── store.resolveTileCoordinator: lease holder wins, else product/supervisor role, else null ──

test("resolveTileCoordinator: prefers the live coordinator lease holder", () => {
  const org = store.getOrCreateOrg("tile-v2-org-1");
  const role = store.getOrCreateRole(org.id, "generalist", { wildcard: true });
  const agent = store.createAgent({ orgId: org.id, roleId: role.id, name: "lease-holder" });
  store.coordinatorAcquire({ orgId: org.id, agentId: agent.id });
  assert.equal(store.resolveTileCoordinator(org.id), agent.id);
});

test("resolveTileCoordinator: falls back to a product/supervisor role when no live lease", () => {
  const org = store.getOrCreateOrg("tile-v2-org-2");
  const genRole = store.getOrCreateRole(org.id, "generalist", { wildcard: true });
  store.createAgent({ orgId: org.id, roleId: genRole.id, name: "builder-1" });
  const productRole = store.getOrCreateRole(org.id, "product");
  const product = store.createAgent({ orgId: org.id, roleId: productRole.id, name: "product-1" });
  assert.equal(store.resolveTileCoordinator(org.id), product.id);
});

test("resolveTileCoordinator: null when there is neither a lease nor a product/supervisor agent", () => {
  const org = store.getOrCreateOrg("tile-v2-org-3");
  const role = store.getOrCreateRole(org.id, "generalist", { wildcard: true });
  store.createAgent({ orgId: org.id, roleId: role.id, name: "solo-builder" });
  assert.equal(store.resolveTileCoordinator(org.id), null);
});

// ── /api/terminals: now also reports the resolved coordinator (real HTTP route) ──

test("/api/terminals reports coordinator_agent_id alongside the refs", async () => {
  const { createServer } = await import("../dist/server/server.js");
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const org = store.getOrCreateOrg("tile-v2-org-http");
    const role = store.getOrCreateRole(org.id, "generalist", { wildcard: true });
    const agent = store.createAgent({ orgId: org.id, roleId: role.id, name: "coord-agent" });
    store.setAgentTerminal(agent.id, { method: "terminal.app", id: "7001" });
    store.coordinatorAcquire({ orgId: org.id, agentId: agent.id });

    const res = await fetch(`${base}/api/terminals?org=tile-v2-org-http`);
    const body = await res.json();
    assert.equal(body.coordinator_agent_id, agent.id);
    assert.equal(body.terminals[0].ref.id, "7001");

    const missing = await fetch(`${base}/api/terminals?org=unknown-org`);
    assert.equal((await missing.json()).coordinator_agent_id, null);
  } finally {
    server.close();
  }
});
