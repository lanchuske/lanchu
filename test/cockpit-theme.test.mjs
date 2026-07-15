import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// task-mrljlmk64: the tmux cockpit read as one glued-together blob — Claude
// Code rewrites every pane's title with its own status, so the org·agent
// title Lanchu set disappeared seconds after spawn, the per-agent border
// tint had no name next to it, and nothing marked the active pane. The
// stable identity now lives in the @lanchu_agent pane user option, rendered
// by pane-border-format with Claude's dynamic title as a truncated suffix.
// These are the pure arg builders; spawnTerminal/tileTerminals execute them.

const dir = path.join(os.tmpdir(), "lanchu-cockpit-theme-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;

const { tmuxCockpitThemeArgs, tmuxPaneIdentityArgs } = await import("../dist/server/cockpit.js");

const findValue = (argsList, option) => {
  const args = argsList.find((a) => a.includes(option));
  return args ? args[args.length - 1] : undefined;
};

test("theme: border format leads with the stable @lanchu_agent, keeps the dynamic title truncated", () => {
  const fmt = findValue(tmuxCockpitThemeArgs(), "pane-border-format");
  assert.ok(fmt, "pane-border-format is set");
  const agentIdx = fmt.indexOf("@lanchu_agent");
  const titleIdx = fmt.indexOf("pane_title");
  assert.ok(agentIdx >= 0, "format renders the agent user option");
  assert.ok(titleIdx > agentIdx, "Claude's dynamic pane_title stays, after the agent name");
  assert.match(fmt, /#\{=\|\d+\|…:pane_title\}/, "the rewritten title is truncated, not unbounded");
  assert.match(fmt, /#\{\?pane_active,/, "the active pane's name chip renders differently");
});

test("theme: every option targets the lanchu session and separation options are present", () => {
  const argsList = tmuxCockpitThemeArgs();
  for (const args of argsList) {
    assert.equal(args[0], "set-option");
    assert.ok(args.includes("lanchu"), `targets the lanchu session: ${args.join(" ")}`);
  }
  assert.equal(findValue(argsList, "pane-border-status"), "top");
  assert.equal(findValue(argsList, "pane-border-lines"), "heavy");
  assert.equal(findValue(argsList, "pane-border-indicators"), "both");
});

test("theme: each option is its own invocation so an older tmux only loses that one refinement", () => {
  const argsList = tmuxCockpitThemeArgs();
  const options = argsList.map((a) => a[a.length - 2]);
  assert.equal(new Set(options).size, options.length, "no option is bundled into another call");
});

test("pane identity: stable name, tinted border, same-hue bold active border, all pane-scoped", () => {
  const argsList = tmuxPaneIdentityArgs("%7", "lanchu·qa", "#f0e442");
  for (const args of argsList) {
    assert.ok(args.includes("-p") && args.includes("%7"), `pane-scoped on %7: ${args.join(" ")}`);
  }
  assert.equal(findValue(argsList, "@lanchu_agent"), "lanchu·qa");
  assert.equal(findValue(argsList, "pane-border-style"), "fg=#f0e442");
  assert.equal(findValue(argsList, "pane-active-border-style"), "fg=#f0e442,bold");
});
