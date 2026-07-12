import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// task-mrg6z88g13: `lanchu tile` used to grid-arrange EVERY Terminal.app
// window unconditionally (`set ws to windows`), which both swept up windows
// that don't belong to this org and read as "0 windows" the instant the
// whole AppleScript threw (e.g. `bounds of window of desktop` with no Finder
// window open) — there was no way to tell "nothing to arrange" apart from
// "the script broke". The fix scopes the mosaic to the org's own known
// terminal_ref ids, the same way focusTerminal/closeTerminal already do.
//
// Platform/tmux availability varies across CI runners, so tileTerminals now
// takes injectable `effects` (hasTmux/isMac/run) — same DI shape as
// tintTerminalWindow's `effects.run` — letting these tests exercise the
// macOS branch deterministically everywhere instead of skipping on
// non-macOS or tmux-equipped runners.

const { tileTerminals } = await import("../dist/server/cockpit.js");

const macNoTmux = { hasTmux: () => false, isMac: () => true };

test("dry run on macOS reports the known-refs count and never shells out", () => {
  let ran = false;
  const refs = [
    { method: "terminal.app", id: "111" },
    { method: "terminal.app", id: "222" },
    { method: "tmux", id: "%1" }, // a stray non-mac ref must not count
  ];
  const r = tileTerminals(refs, true, { ...macNoTmux, run: () => { ran = true; return "0"; } });
  assert.equal(r.method, "terminal.app");
  assert.equal(r.count, 2, "only terminal.app refs count toward the mosaic");
  assert.match(r.note, /Would grid-arrange 2 known agent Terminal\.app window/);
  assert.equal(ran, false, "a dry run must never invoke osascript");
});

test("no known agent terminals: reports a clear reason, still never shells out", () => {
  let ran = false;
  const r = tileTerminals([], false, { ...macNoTmux, run: () => { ran = true; return "0"; } });
  assert.equal(r.method, "terminal.app");
  assert.equal(r.count, 0);
  assert.match(r.note, /No known agent Terminal\.app windows to arrange/);
  assert.match(r.note, /lanchu spawn/);
  assert.equal(ran, false);
});

test("the AppleScript matches windows by id and never falls back to the blanket `windows` list", () => {
  let seenScript = "";
  const refs = [{ method: "terminal.app", id: "555" }, { method: "terminal.app", id: "777" }];
  tileTerminals(refs, false, { ...macNoTmux, run: (osa) => { seenScript = osa; return "2"; } });
  assert.match(seenScript, /first window whose id is wid/, "matches by id, like focusTerminal/closeTerminal");
  assert.match(seenScript, /\{555, 777\}/, "the id list is exactly the org's known refs");
  assert.doesNotMatch(seenScript, /set ws to windows\b/, "never grabs every Terminal.app window unconditionally");
});

test("a bad Finder bounds lookup is caught, not left to blow up the whole script", () => {
  let seenScript = "";
  tileTerminals([{ method: "terminal.app", id: "1" }], false, {
    ...macNoTmux,
    run: (osa) => { seenScript = osa; return "1"; },
  });
  assert.match(seenScript, /try\s+set sb to bounds of window of desktop\s+on error/, "the desktop-bounds lookup is wrapped in try/on error");
});

test("closed/unknown window ids are reported distinctly from a clean full match", () => {
  const refs = [{ method: "terminal.app", id: "1" }, { method: "terminal.app", id: "2" }, { method: "terminal.app", id: "3" }];
  const short = tileTerminals(refs, false, { ...macNoTmux, run: () => "1" }); // only 1 of 3 still open
  assert.equal(short.count, 1);
  assert.match(short.note, /1 of 3 known agent Terminal\.app windows.*2 no longer open/);

  const full = tileTerminals(refs, false, { ...macNoTmux, run: () => "3" });
  assert.equal(full.count, 3);
  assert.match(full.note, /^Arranged 3 Terminal\.app windows into a mosaic\.$/);
});

test("non-terminal.app refs (e.g. a tmux id string) are filtered out of the macOS id list", () => {
  let seenScript = "";
  const refs = [{ method: "tmux", id: "%3" }, { method: "terminal.app", id: "42" }];
  tileTerminals(refs, false, { ...macNoTmux, run: (osa) => { seenScript = osa; return "1"; } });
  assert.match(seenScript, /\{42\}/);
  assert.doesNotMatch(seenScript, /%3/);
});

test("unsupported platform (no tmux, not macOS): reports 0 without touching refs", () => {
  const r = tileTerminals([{ method: "terminal.app", id: "1" }], false, { hasTmux: () => false, isMac: () => false });
  assert.equal(r.method, "unsupported");
  assert.equal(r.count, 0);
  assert.match(r.note, /tmux or macOS/);
});

// ── /api/terminals: the server-side source of the org's known refs (CLI + panel) ──

test("/api/terminals returns the org's live terminal refs by name (real HTTP route)", async () => {
  const dir = path.join(os.tmpdir(), "lanchu-tile-test-" + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
  process.env.LANCHU_STATE_DIR = dir;
  delete process.env.LANCHU_ACCESS_KEY;

  const { createServer } = await import("../dist/server/server.js");
  const store = await import("../dist/core/store.js");

  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const org = store.getOrCreateOrg("tile-org");
    const role = store.getOrCreateRole(org.id, "generalist", { wildcard: true });
    const agent = store.createAgent({ orgId: org.id, roleId: role.id, name: "tile-agent" });
    store.setAgentTerminal(agent.id, { method: "terminal.app", id: "9001" });

    const missing = await fetch(`${base}/api/terminals?org=unknown-org`);
    assert.equal(missing.status, 200);
    assert.deepEqual((await missing.json()).terminals, []);

    const res = await fetch(`${base}/api/terminals?org=tile-org`);
    assert.equal(res.status, 200);
    const { terminals } = await res.json();
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].name, "tile-agent");
    assert.deepEqual(terminals[0].ref, { method: "terminal.app", id: "9001" });

    const noOrg = await fetch(`${base}/api/terminals`);
    assert.equal(noOrg.status, 400);
  } finally {
    server.close();
  }
});
