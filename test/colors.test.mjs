import { test } from "node:test";
import assert from "node:assert/strict";

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
