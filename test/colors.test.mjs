import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated on-disk state — MUST be set before the store import below opens the DB.
const stateDir = path.join(os.tmpdir(), "lanchu-colors-test-" + process.pid);
fs.rmSync(stateDir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = stateDir;

const { AGENT_PALETTE, agentColor, ansiColorize, tintedBg16, contrastRatio16 } = await import("../dist/core/colors.js");
const { tintTerminalWindow, TINT_MIN_CONTRAST } = await import("../dist/server/cockpit.js");

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

test("ansi helper produces usable output", () => {
  const c = agentColor("product");
  assert.match(ansiColorize("product", c), new RegExp("\\u001b\\[38;5;\\d+mproduct\\u001b\\[0m"));
});

// -- tint contrast fix (bug: light pastel under light-on-dark profiles was unreadable) --

const BLACK = [0, 0, 0];
const WHITE = [65535, 65535, 65535];
const DARK_BG = [3000, 3200, 3600]; // a typical dark profile background
const LIGHT_BG = [65535, 65535, 65535];

test("the tint derives from the profile: dark stays dark, light stays light - text contrast survives on every hue", () => {
  for (const p of AGENT_PALETTE) {
    const dark = tintedBg16(DARK_BG, p.hex);
    const light = tintedBg16(LIGHT_BG, p.hex);
    for (const v of [...dark, ...light]) assert.ok(v >= 0 && v <= 65535, "16-bit AppleScript RGB range");
    assert.ok(
      contrastRatio16(dark, WHITE) >= TINT_MIN_CONTRAST,
      `dark-profile tint of ${p.name} must stay readable under white text`,
    );
    assert.ok(
      contrastRatio16(light, BLACK) >= TINT_MIN_CONTRAST,
      `light-profile tint of ${p.name} must stay readable over black text`,
    );
    assert.notDeepEqual(dark, DARK_BG, "some hue must actually be visible");
  }
});

test("bug repro: the old blend-toward-white pastel fails the readability bar under white text", () => {
  // What Dario saw: a light pastel background behind a light-on-dark profile's
  // white text. The new contrast gate must reject that combination.
  const oldPastel = tintedBg16(WHITE, agentColor("builder-core-2").hex, 0.15); // ~= pastelRgb16
  assert.ok(contrastRatio16(oldPastel, WHITE) < TINT_MIN_CONTRAST, "the old behavior is exactly what the gate blocks");
});

test("tintTerminalWindow applies only readable tints and leaves unreadable/unreadable-to-us profiles alone", () => {
  const applied = [];
  const runFor = (probeReply) => (osa) => {
    if (osa.includes("normal text color")) return probeReply;
    applied.push(osa);
    return "";
  };

  // Dark profile, white text: tint applied (dark shade of the hue).
  assert.equal(tintTerminalWindow("1", "#009e73", { run: runFor("3000, 3200, 3600, 65535, 65535, 65535") }), true);
  assert.equal(applied.length, 1);
  assert.match(applied[0], /set background color/);

  // A profile whose tint would sink below the bar: untouched.
  const mid = "32768, 32768, 32768, 38000, 38000, 38000"; // low-contrast gray-on-gray profile
  assert.equal(tintTerminalWindow("2", "#009e73", { run: runFor(mid) }), false);

  // Unparseable probe (locale weirdness, closed window): untouched.
  assert.equal(tintTerminalWindow("3", "#009e73", { run: runFor("not, a, color") }), false);
  assert.equal(applied.length, 1, "no further background writes happened");
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

test("bug repro: retired agents must not count as slot occupancy — two live agents shared green while dead ones 'held' the other hues", () => {
  const org = store.getOrCreateOrg("color-org4");
  const role = store.getOrCreateRole(org.id, "generalist", { wildcard: true });

  // One live teammate…
  const live = store.createAgent({ orgId: org.id, roleId: role.id, name: "builder-core-2" });
  const liveSlot = store.agentColorOf(store.getAgent(live.id)).slot;

  // …then a day of churn: ten teammates come and go, spreading their persisted
  // slots across the palette before retiring.
  for (let i = 0; i < 10; i++) {
    const ghost = store.createAgent({ orgId: org.id, roleId: role.id, name: `ghost-${i}` });
    store.retireAgent(ghost.id);
  }

  // A fresh live teammate arrives. With retired rows counted (the bug), every
  // hue looks equally busy and the newcomer can land on the live agent's slot.
  // Counting only the live roster, 9 hues are free — it must take one of them.
  const fresh = store.createAgent({ orgId: org.id, roleId: role.id, name: "qa-gate-2" });
  const freshSlot = store.agentColorOf(store.getAgent(fresh.id)).slot;
  assert.notEqual(freshSlot, liveSlot, "two live teammates must never share a hue while others are free");
});
