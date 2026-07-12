import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// task-mrg7b6oz19: spawned terminals must open with a short, human title —
// nothing else. #36 already set an OSC-0 title, but Terminal.app profiles
// still compose their own title-bar text (shell path, dimensions, command
// name) around the tab's `custom title` unless `title displays custom title`
// is ALSO set — that second property was missing, so the noise stayed even
// though a custom title was set. terminalTitle() also makes the format
// configurable via LANCHU_TERM_TITLE for a just-agent/just-role preference.

const dir = path.join(os.tmpdir(), "lanchu-title-test-" + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
process.env.LANCHU_STATE_DIR = dir;

const { terminalTitle, spawnTerminal } = await import("../dist/server/cockpit.js");

test("terminalTitle: default is org·agent regardless of role", () => {
  delete process.env.LANCHU_TERM_TITLE;
  assert.equal(terminalTitle("lanchu", "builder-core-2", "builder"), "lanchu·builder-core-2");
  assert.equal(terminalTitle("lanchu", "builder-core-2", null), "lanchu·builder-core-2");
});

test("terminalTitle: LANCHU_TERM_TITLE=agent is just the agent name", () => {
  process.env.LANCHU_TERM_TITLE = "agent";
  try {
    assert.equal(terminalTitle("lanchu", "builder-core-2", "builder"), "builder-core-2");
  } finally {
    delete process.env.LANCHU_TERM_TITLE;
  }
});

test("terminalTitle: LANCHU_TERM_TITLE=role uses the role, falling back to the agent name when there is none", () => {
  process.env.LANCHU_TERM_TITLE = "role";
  try {
    assert.equal(terminalTitle("lanchu", "builder-core-2", "builder"), "builder");
    assert.equal(terminalTitle("lanchu", "builder-core-2", null), "builder-core-2");
    assert.equal(terminalTitle("lanchu", "builder-core-2", undefined), "builder-core-2");
  } finally {
    delete process.env.LANCHU_TERM_TITLE;
  }
});

test("terminalTitle: an unrecognized value keeps the default", () => {
  process.env.LANCHU_TERM_TITLE = "something-typo'd";
  try {
    assert.equal(terminalTitle("lanchu", "builder-core-2", "builder"), "lanchu·builder-core-2");
  } finally {
    delete process.env.LANCHU_TERM_TITLE;
  }
});

const macNoTmux = { hasTmux: () => false, isMac: () => true };

test("spawnTerminal on macOS: the AppleScript sets BOTH custom title and title-displays-custom-title", () => {
  let seenScript = "";
  const r = spawnTerminal({
    title: "lanchu·builder-core-2",
    agentName: "builder-core-2",
    cwd: dir,
    token: "tok",
    prompt: "hi",
    effects: { ...macNoTmux, run: (osa) => { seenScript = osa; return "42"; } },
  });
  assert.equal(r.method, "terminal.app");
  assert.match(seenScript, /set custom title of t to "lanchu·builder-core-2"/);
  assert.match(seenScript, /set title displays custom title of t to true/, "without this, Terminal's profile still composes shell path/dimensions around the custom title");
  assert.equal(r.ref?.id, "42");
});

test("spawnTerminal dry run on macOS never touches osascript", () => {
  let ran = false;
  const r = spawnTerminal({
    title: "lanchu·builder-core-2",
    agentName: "builder-core-2",
    cwd: dir,
    token: "tok",
    prompt: "hi",
    dry: true,
    effects: { ...macNoTmux, run: () => { ran = true; return "1"; } },
  });
  assert.equal(r.method, "terminal.app");
  assert.equal(ran, false);
});
