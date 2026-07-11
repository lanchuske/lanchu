import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state — MUST be set before the store import below opens the DB.
const stateDir = path.join(os.tmpdir(), "lanchu-colors-test-" + process.pid);
fs.rmSync(stateDir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = stateDir;

const { AGENT_PALETTE, agentColor, ansiColorize, pastelRgb16 } = await import("../dist/core/colors.js");

test("agent colors are deterministic and stable across respawns", () => {
  const a = agentColor("builder-core");
  const b = agentColor("builder-core");
  assert.deepEqual(a, b, "same name → same color, always");
  assert.ok(a.slot >= 0 && a.slot < AGENT_PALETTE.length);
  assert.match(a.hex, /^#[0-9a-f]{6}$/);
});

test("common agent/role names all get visibly different colors", () => {
  // The palette cycles beyond 10 agents, so distinctness can't hold for ALL
  // pairs — the salted hash is tuned so the names real teams actually use
  // spread across all 10 hues. If you rename SALT/palette, retune this set.
  const names = [
    "product", "builder", "builder-2", "builder-core", "web-page",
    "qa", "generalist", "frontend", "backend", "docs",
  ];
  const slots = names.map((n) => agentColor(n).slot);
  assert.equal(new Set(slots).size, names.length, `collision in ${JSON.stringify(slots)}`);
});

test("palette stays colorblind-friendly sized (~10 hues) and panel mirror can't drift silently", () => {
  assert.equal(AGENT_PALETTE.length, 10);
  // Guard the exact hex list: src/server/panel.ts mirrors these values in its
  // client-side JS — if this list changes, update the panel mirror too.
  assert.deepEqual(
    AGENT_PALETTE.map((c) => c.hex),
    ["#e69f00", "#56b4e9", "#009e73", "#f0e442", "#0072b2", "#d55e00", "#cc79a7", "#9467bd", "#17becf", "#999999"],
  );
});

test("ansi and pastel helpers produce usable output", () => {
  const c = agentColor("product");
  assert.match(ansiColorize("product", c), /\[38;5;\d+mproduct\[0m/);
  const [r, g, b] = pastelRgb16(c);
  for (const v of [r, g, b]) {
    assert.ok(v >= 0 && v <= 65535, "16-bit AppleScript RGB range");
    assert.ok(v >= 0.7 * 65535, "pastel stays light enough for dark text");
  }
});

// ── de-collision fix (bug: qa-gate vs product shared slot 3) ──
const store = await import("../dist/core/store.js");

test("bug repro: qa-gate and product hash to the same slot — persisted org slots de-collide them", () => {
  // The raw hash still collides (that's the bug's mechanism)…
  assert.equal(agentColor("qa-gate").slot, agentColor("product").slot);

  // …but durable agents get de-collided persisted slots at creation.
  const org = store.getOrCreateOrg("color-org");
  const role = store.getOrCreateRole(org.id, "generalist", { wildcard: true });
  const product = store.createAgent({ orgId: org.id, roleId: role.id, name: "product" });
  const qaGate = store.createAgent({ orgId: org.id, roleId: role.id, name: "qa-gate" });
  const a = store.agentColorOf(store.getAgent(product.id));
  const b = store.agentColorOf(store.getAgent(qaGate.id));
  assert.notEqual(a.hex, b.hex, "the two live teammates must be visually distinct");
  assert.equal(a.slot, agentColor("product").slot, "first sight keeps the hash-preferred hue");
});

test("persisted slots are stable and first-collision-free up to a full palette", () => {
  const org = store.getOrCreateOrg("color-org2");
  const role = store.getOrCreateRole(org.id, "generalist", { wildcard: true });
  const names = ["product", "qa-gate", "builder-core", "builder-panel", "builder-gov",
                 "web-page", "qa", "docs", "frontend", "backend"];
  const agents = names.map((n) => store.createAgent({ orgId: org.id, roleId: role.id, name: n }));
  const slots = agents.map((a) => store.agentColorOf(store.getAgent(a.id)).slot);
  assert.equal(new Set(slots).size, names.length, "10 agents → 10 distinct hues, no matter the names");

  // Stability: re-reading (respawn = same durable row) never re-rolls the color.
  const again = agents.map((a) => store.agentColorOf(store.getAgent(a.id)).slot);
  assert.deepEqual(again, slots);

  // 11th agent: palette exhausted — reuses a least-used slot instead of failing.
  const eleventh = store.createAgent({ orgId: org.id, roleId: role.id, name: "one-more" });
  const s11 = store.agentColorOf(store.getAgent(eleventh.id)).slot;
  assert.ok(s11 >= 0 && s11 < 10);
});

test("pre-existing agents (rows without color_slot) get backfilled without collisions", async () => {
  const org = store.getOrCreateOrg("color-org3");
  const role = store.getOrCreateRole(org.id, "generalist", { wildcard: true });
  const a1 = store.createAgent({ orgId: org.id, roleId: role.id, name: "product" });
  const a2 = store.createAgent({ orgId: org.id, roleId: role.id, name: "qa-gate" });

  // Simulate rows minted before the column existed (migration leaves NULLs).
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(path.join(stateDir, "lanchu.db"));
  raw.prepare("UPDATE agent SET color_slot = NULL WHERE org_id = ?").run(org.id);
  raw.close();

  store.ensureColorSlots(org.id);
  const s1 = store.agentColorOf(store.getAgent(a1.id));
  const s2 = store.agentColorOf(store.getAgent(a2.id));
  assert.notEqual(s1.hex, s2.hex, "backfill de-collides too");
  assert.equal(s1.slot, agentColor("product").slot, "older row wins the hash-preferred hue");
});
