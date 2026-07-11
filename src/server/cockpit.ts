import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { baseUrl, mcpUrl, stateDir } from "../config.js";
import { agentColor, contrastRatio16, tintedBg16, type Rgb16 } from "../core/colors.js";

/**
 * Multi-agent "cockpit": open a terminal running a new Claude agent already
 * wired to Lanchu, and tile the terminals into a mosaic. tmux is preferred
 * (reliable, cross-platform); on macOS we fall back to Terminal.app via
 * AppleScript; otherwise we return the command for the user to run.
 */

const TMUX_SESSION = "lanchu";

function has(cmd: string): boolean {
  try {
    return spawnSync(cmd, ["-V"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}
const hasTmux = () => has("tmux");
const isMac = () => process.platform === "darwin";

/** POSIX single-quote a string (safe even if it contains apostrophes). */
const sq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";

/**
 * Persist the per-agent MCP config to a private file (user-only state dir,
 * mode 600) and return its path. SECURITY: the config carries the agent's
 * Bearer token — passed inline it lands in the spawned command line, where
 * macOS Terminal window titles and `ps` args expose it for the process
 * lifetime (screen shares, window switchers, any local process). The launched
 * shell removes the file on exit (trap EXIT); a leftover from a hard kill is
 * still unreadable to other users.
 */
function writeMcpConfigFile(token: string, agentName?: string): string {
  const dir = path.join(stateDir(), "run");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const slug = (agentName ?? "agent").replace(/[^a-zA-Z0-9._-]/g, "_");
  const file = path.join(dir, `${slug}-${randomBytes(4).toString("hex")}.mcp.json`);
  const config = JSON.stringify({
    mcpServers: { lanchu: { type: "http", url: mcpUrl(), headers: { Authorization: `Bearer ${token}` } } },
  });
  fs.writeFileSync(file, config, { mode: 0o600 });
  return file;
}

/** Shell command that wires Claude to Lanchu and launches it with a first prompt. */
export function bootstrapCommand(cwd: string, token: string, prompt: string, agentName?: string, title?: string, model?: string, resumeSessionId?: string): string {
  // Carry this agent's identity as a per-process MCP config FILE. We
  // deliberately avoid `claude mcp add lanchu`, which writes a shared,
  // project-scoped server: a second agent in the same repo would then either
  // inherit the first agent's token (add is a no-op when the server already
  // exists) or clobber it — both cause the agent's lanchu://me to report the
  // wrong identity/role. --strict-mcp-config makes the identity deterministic.
  // The file (not inline JSON) keeps the token out of window titles and ps.
  const mcpConfigFile = writeMcpConfigFile(token, agentName);
  // Name the window before anything else runs, so the terminal never titles
  // itself after the raw command.
  const setTitle = title ? `printf '\\033]0;%s\\007' ${sq(title)}; ` : "";
  // Export the agent name so `lanchu statusline` can show which teammate owns this terminal.
  const ident = agentName ? `export LANCHU_AGENT=${sq(agentName)}; ` : "";
  // Model routing: launch the terminal on the tier the role/spawn chose.
  const modelFlag = model ? `--model ${sq(model)} ` : "";
  // Wake v5 refire: reopen an existing Claude session in this worktree. The
  // prompt MUST ride as a CLI arg — a bare interactive resume revives the
  // context but never triggers a turn (field finding, 2026-07-11).
  const resumeFlag = resumeSessionId ? `--resume ${sq(resumeSessionId)} ` : "";
  // `--mcp-config` is variadic, so the prompt MUST be separated by `--` — otherwise
  // Claude slurps it as another config path ("MCP config file not found: <prompt>").
  return `cd ${sq(cwd)}; ${setTitle}${ident}trap 'rm -f ${sq(mcpConfigFile)}' EXIT; claude ${modelFlag}${resumeFlag}--strict-mcp-config --mcp-config ${sq(mcpConfigFile)} -- ${sq(prompt)}`;
}

const asAppleStr = (s: string) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

/**
 * Wake v4, the 90% case: a Claude Code Stop hook in the agent's worktree.
 * When the agent's turn ends, the hook asks the server for its pending-notice
 * count and BLOCKS the stop (exit 2) while work is queued — the agent never
 * reaches the idle prompt with unread notices, and nothing ever has to type
 * into its terminal. Standard Claude Code mechanism, zero injection.
 *
 * The session token lives in a user-only file in the state dir (mode 600,
 * same exposure class as the MCP config file, but persistent: the hook
 * outlives the launching shell). Stable path per agent name, so a respawn
 * refreshes the token in place and the hook entry stays idempotent.
 */
export function installStopHook(cwd: string, token: string, agentName?: string): boolean {
  try {
    const dir = path.join(stateDir(), "run");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const slug = (agentName ?? "agent").replace(/[^a-zA-Z0-9._-]/g, "_");
    const tokenFile = path.join(dir, `${slug}.stop-hook-token`);
    fs.writeFileSync(tokenFile, token, { mode: 0o600 });

    // POSIX, jq-free: the endpoint answers a bare number. Fail-open on any
    // curl error (server down, token rotated) — a hook must never trap an
    // agent at the end of its turn.
    const stopCommand =
      `N=$(curl -sf --max-time 3 -H "Authorization: Bearer $(cat ${sq(tokenFile)} 2>/dev/null)" ` +
      `${sq(`${baseUrl()}/api/agent/pending`)} 2>/dev/null); ` +
      `case "$N" in ''|0|*[!0-9]*) exit 0;; ` +
      `*) echo "You have $N Lanchu notices — run message_list now and follow the instructions." >&2; exit 2;; esac`;
    // Wake v5 (park & refire): the session lifecycle reports itself. The hook
    // input JSON (session_id, reason…) is relayed verbatim from stdin; always
    // exit 0 — lifecycle reporting must never block the session.
    const lifecycleCommand = (endpoint: string) =>
      `curl -sf --max-time 3 -X POST -H "Authorization: Bearer $(cat ${sq(tokenFile)} 2>/dev/null)" ` +
      `-H 'content-type: application/json' --data-binary @- ` +
      `${sq(`${baseUrl()}${endpoint}`)} >/dev/null 2>&1; exit 0`;

    const file = path.join(cwd, ".claude", "settings.local.json");
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(file)) {
      try {
        settings = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      } catch {
        return false; // unparseable user file — never clobber it
      }
    }
    const hooks = (settings.hooks ??= {}) as Record<string, unknown>;
    // Idempotency: the token-file path identifies this agent's hook entries.
    // Compare against the RAW command strings — serializing the array first
    // (JSON.stringify) escapes Windows path backslashes, so the path never
    // matched and every respawn appended a duplicate hook (Windows CI red).
    const ensure = (event: string, command: string) => {
      const list = (hooks[event] ??= []) as unknown[];
      const installed = list.some((entry) => {
        const entryHooks = (entry as { hooks?: unknown })?.hooks;
        return (
          Array.isArray(entryHooks) &&
          entryHooks.some((h) => {
            const cmd = (h as { command?: unknown })?.command;
            return typeof cmd === "string" && cmd.includes(tokenFile);
          })
        );
      });
      if (!installed) list.push({ hooks: [{ type: "command", command }] });
    };
    ensure("Stop", stopCommand);
    ensure("SessionStart", lifecycleCommand("/hooks/agent/session-start"));
    ensure("SessionEnd", lifecycleCommand("/hooks/agent/session-end"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
    return true;
  } catch {
    return false; // best-effort: spawn must not fail over a hook
  }
}

/**
 * Liveness gate for refire (wake v5): the session ids `claude agents --json`
 * reports as running. Returns null when the answer can't be trusted (CLI
 * missing, non-zero exit, unparseable) — callers must treat null as "do not
 * refire" (fail closed: resuming a session that is still open elsewhere
 * interleaves two processes into one transcript).
 */
export function claudeLiveSessionIds(): Set<string> | null {
  try {
    const res = spawnSync("claude", ["agents", "--json"], { encoding: "utf8", timeout: 5000 });
    if (res.status !== 0 || !res.stdout) return null;
    const parsed = JSON.parse(res.stdout) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { agents?: unknown[] })?.agents)
        ? (parsed as { agents: unknown[] }).agents
        : null;
    if (!list) return null;
    const ids = new Set<string>();
    for (const item of list) {
      const sid =
        (item as { sessionId?: unknown })?.sessionId ?? (item as { session_id?: unknown })?.session_id;
      if (typeof sid === "string") ids.add(sid);
    }
    return ids;
  } catch {
    return null;
  }
}

/**
 * Handle to an agent's live terminal, captured at spawn: a tmux pane id or a
 * Terminal.app window id. We focus by this id rather than by title, because
 * Claude Code rewrites the window title with its own status once it starts.
 * Persisted (via the store) so any process can re-focus, not just the spawner.
 */
export interface TerminalRef {
  method: "tmux" | "terminal.app";
  id: string;
}

export interface SpawnResult {
  method: "tmux" | "terminal.app" | "print";
  title: string;
  command: string;
  note: string;
  ref?: TerminalRef;
}

/** Open a terminal for a new agent. With dry=true, returns the plan without executing. */
export function spawnTerminal(input: {
  title: string;
  agentName?: string;
  cwd: string;
  token: string;
  prompt: string;
  /** De-collided per-org color (store.agentColorOf). Falls back to the name hash. */
  colorHex?: string;
  /** claude model alias for this terminal (opus|sonnet|haiku…); omitted = harness default. */
  model?: string;
  /** Wake v5 refire: reopen this Claude session instead of starting fresh. */
  resumeSessionId?: string;
  dry?: boolean;
}): SpawnResult {
  const command = bootstrapCommand(input.cwd, input.token, input.prompt, input.agentName, input.title, input.model, input.resumeSessionId);
  // Wake v4: the Stop hook keeps the agent from idling with queued notices —
  // preferred over any terminal wake. Installed for every launch method (the
  // print path's user runs the command in this same cwd).
  if (!input.dry) installStopHook(input.cwd, input.token, input.agentName);

  if (hasTmux()) {
    const plan: SpawnResult = {
      method: "tmux",
      title: input.title,
      command,
      note: `tmux pane in session '${TMUX_SESSION}'. Attach with: tmux attach -t ${TMUX_SESSION}`,
    };
    if (input.dry) return plan;
    // ensure session, add a tiled pane titled org·agent, and capture its pane id
    const has0 = spawnSync("tmux", ["has-session", "-t", TMUX_SESSION], { stdio: "ignore" }).status === 0;
    let paneId = "";
    if (!has0) {
      spawnSync("tmux", ["new-session", "-d", "-s", TMUX_SESSION, "-c", input.cwd, command]);
      paneId = (spawnSync("tmux", ["display-message", "-p", "-t", TMUX_SESSION, "#{pane_id}"], { encoding: "utf8" }).stdout ?? "").trim();
    } else {
      paneId = (spawnSync("tmux", ["split-window", "-P", "-F", "#{pane_id}", "-t", TMUX_SESSION, "-c", input.cwd, command], { encoding: "utf8" }).stdout ?? "").trim();
    }
    spawnSync("tmux", ["select-layout", "-t", TMUX_SESSION, "tiled"]);
    spawnSync("tmux", ["set-option", "-p", "-t", TMUX_SESSION, "pane-border-status", "top"]);
    if (paneId) spawnSync("tmux", ["select-pane", "-t", paneId, "-T", input.title]);
    if (paneId && input.agentName) {
      // Stable per-agent identity: tint this pane's border with the agent's
      // color (same hue as the panel chip). Best-effort — per-pane style
      // options need tmux >= 3.2; older tmux just ignores the call.
      const hex = input.colorHex ?? agentColor(input.agentName).hex;
      spawnSync("tmux", ["set-option", "-p", "-t", paneId, "pane-border-style", `fg=${hex}`]);
    }
    if (paneId) plan.ref = { method: "tmux", id: paneId };
    return plan;
  }

  if (isMac()) {
    const plan: SpawnResult = {
      method: "terminal.app",
      title: input.title,
      command,
      note: "Opened a new Terminal.app window.",
    };
    if (input.dry) return plan;
    // Return the new window's id so we can re-focus it later regardless of title.
    const osa = [
      'tell application "Terminal"',
      "  activate",
      `  set t to do script ${asAppleStr(command)}`,
      "  delay 0.4",
      `  set custom title of t to ${asAppleStr(input.title)}`,
      "  return id of front window",
      "end tell",
    ].join("\n");
    const out = spawnSync("osascript", ["-e", osa], { encoding: "utf8" });
    const winId = (out.stdout ?? "").trim();
    if (/^\d+$/.test(winId)) plan.ref = { method: "terminal.app", id: winId };
    if (/^\d+$/.test(winId) && input.agentName) {
      tintTerminalWindow(winId, input.colorHex ?? agentColor(input.agentName).hex);
    }
    return plan;
  }

  return {
    method: "print",
    title: input.title,
    command,
    note: "No tmux and not macOS — run this command in a new terminal yourself.",
  };
}

/**
 * Identity tint for a Terminal.app window, derived from the USER'S profile:
 * read the tab's own background and text colors, blend the agent hue into
 * that background (dark profile → very dark shade of the hue, light profile
 * → light pastel), and apply it only if the result still clears a WCAG-ish
 * contrast bar against the profile's text color. Anything unreadable or
 * unreadable-to-us leaves the profile untouched — the title, panel chip and
 * tile still carry the identity. (The old absolute blend-toward-white pastel
 * assumed dark text and made light-on-dark profiles illegible.)
 */
export const TINT_MIN_CONTRAST = 4.5;

export function tintTerminalWindow(
  winId: string,
  hex: string,
  effects: { run?: (osa: string) => string } = {},
): boolean {
  const run =
    effects.run ??
    ((osa: string) => (spawnSync("osascript", ["-e", osa], { encoding: "utf8" }).stdout ?? "").trim());
  try {
    const probe = run(
      [
        'tell application "Terminal"',
        `  set t to selected tab of (first window whose id is ${winId})`,
        "  return (background color of t) & (normal text color of t)",
        "end tell",
      ].join("\n"),
    );
    const nums = probe.split(",").map((s) => Number.parseInt(s.trim(), 10));
    if (nums.length !== 6 || nums.some((n) => !Number.isFinite(n))) return false;
    const bg = nums.slice(0, 3) as Rgb16;
    const fg = nums.slice(3, 6) as Rgb16;
    const tint = tintedBg16(bg, hex);
    if (contrastRatio16(tint, fg) < TINT_MIN_CONTRAST) return false;
    run(
      [
        'tell application "Terminal" to try',
        `  set background color of selected tab of (first window whose id is ${winId}) to {${tint.join(", ")}}`,
        "end try",
      ].join("\n"),
    );
    return true;
  } catch {
    return false; // best-effort: never break spawn over a cosmetic tint
  }
}

/**
 * Bring an agent's terminal to the front using the ref captured at spawn. Returns
 * false when the terminal is gone (e.g. the user closed it), so the caller can
 * open a fresh one instead.
 */
export function focusTerminal(ref: TerminalRef): boolean {
  if (ref.method === "tmux") {
    const panes = (spawnSync("tmux", ["list-panes", "-a", "-F", "#{pane_id}"], { encoding: "utf8" }).stdout ?? "")
      .trim().split("\n");
    if (panes.indexOf(ref.id) < 0) return false;
    spawnSync("tmux", ["select-window", "-t", ref.id]);
    spawnSync("tmux", ["select-pane", "-t", ref.id]);
    return true;
  }

  // terminal.app: raise the window by id if it still exists.
  const osa = [
    'tell application "Terminal"',
    "  try",
    `    set w to (first window whose id is ${ref.id})`,
    "    set index of w to 1",
    "    activate",
    "    return true",
    "  on error",
    "    return false",
    "  end try",
    "end tell",
  ].join("\n");
  const out = spawnSync("osascript", ["-e", osa], { encoding: "utf8" });
  return (out.stdout ?? "").trim() === "true";
}

/** Is the agent's terminal still open? */
export function terminalAlive(ref: TerminalRef): boolean {
  if (ref.method === "tmux") {
    const panes = (spawnSync("tmux", ["list-panes", "-a", "-F", "#{pane_id}"], { encoding: "utf8" }).stdout ?? "")
      .trim().split("\n");
    return panes.indexOf(ref.id) >= 0;
  }
  const osa = `tell application "Terminal" to try
  get (first window whose id is ${ref.id})
  return true
on error
  return false
end try`;
  return (spawnSync("osascript", ["-e", osa], { encoding: "utf8" }).stdout ?? "").trim() === "true";
}

/** Recent output from the agent's terminal (best-effort; empty when unavailable). */
export function terminalLogs(ref: TerminalRef, lines = 200): string {
  if (ref.method === "tmux") {
    const out = spawnSync("tmux", ["capture-pane", "-p", "-t", ref.id, "-S", `-${lines}`], { encoding: "utf8" });
    return out.status === 0 ? (out.stdout ?? "") : "";
  }
  // Terminal.app: the tab's scrollback (history), tail-trimmed.
  const osa = `tell application "Terminal" to try
  return history of selected tab of (first window whose id is ${ref.id})
on error
  return ""
end try`;
  const out = spawnSync("osascript", ["-e", osa], { encoding: "utf8" });
  const text = (out.stdout ?? "").replace(/\n+$/, "");
  const arr = text.split("\n");
  return arr.slice(Math.max(0, arr.length - lines)).join("\n");
}

/**
 * Stop the agent's terminal. tmux panes are killed directly; Terminal.app windows
 * are stopped by killing the tty's processes first (so no "processes running"
 * modal appears), then closing the window without a save prompt.
 */
export function closeTerminal(ref: TerminalRef): boolean {
  if (ref.method === "tmux") {
    return spawnSync("tmux", ["kill-pane", "-t", ref.id]).status === 0;
  }
  const tty = (spawnSync("osascript", ["-e",
    `tell application "Terminal" to try
  return tty of selected tab of (first window whose id is ${ref.id})
on error
  return ""
end try`], { encoding: "utf8" }).stdout ?? "").trim();
  if (tty) spawnSync("pkill", ["-t", tty.replace(/^\/dev\//, "")]);
  spawnSync("osascript", ["-e",
    `tell application "Terminal" to try
  close (first window whose id is ${ref.id}) saving no
end try`]);
  return true;
}

/** How a wake reached the terminal — audited so degraded paths are visible. */
export type WakeTransport = "tmux" | "terminal.app-keystroke-degraded";

/**
 * Wake an idle agent by putting ONE fixed line into its own terminal.
 * Wake v4 transport policy: tmux paste-buffer/send-keys is the standard path
 * (scriptable, no focus stealing, works with the screen locked). The
 * Terminal.app System-Events keystroke is a LAST-RESORT fallback only — it
 * steals focus and types into the user's machine — and callers must audit it
 * as degraded (the returned transport says which path ran). The Stop hook
 * installed at spawn should make most wakes unnecessary in the first place.
 * Best-effort: returns null when the terminal can't be nudged.
 */
export function nudgeTerminal(ref: TerminalRef, line: string): WakeTransport | null {
  if (ref.method === "tmux") {
    if (!terminalAlive(ref)) return null;
    // Paste via a named buffer (safe for any chars), then submit.
    const buf = spawnSync("tmux", ["set-buffer", "-b", "lanchu-nudge", "--", line]);
    if (buf.status !== 0) return null;
    const paste = spawnSync("tmux", ["paste-buffer", "-b", "lanchu-nudge", "-t", ref.id, "-d"]);
    if (paste.status !== 0) return null;
    return spawnSync("tmux", ["send-keys", "-t", ref.id, "Enter"]).status === 0 ? "tmux" : null;
  }

  // Terminal.app: raise the window BY ID, paste from the clipboard, restore it.
  const osa = [
    "set prevClip to \"\"",
    "try",
    "  set prevClip to the clipboard as text",
    "end try",
    `set the clipboard to ${asAppleStr(line)}`,
    'tell application "Terminal"',
    "  try",
    `    set w to (first window whose id is ${ref.id})`,
    "    set index of w to 1",
    "    activate",
    "  on error",
    "    return false",
    "  end try",
    "end tell",
    "delay 0.2",
    'tell application "System Events" to tell process "Terminal"',
    '  keystroke "v" using command down',
    "  delay 0.15",
    "  key code 36",
    "end tell",
    "delay 0.2",
    "set the clipboard to prevClip",
    "return true",
  ].join("\n");
  const out = spawnSync("osascript", ["-e", osa], { encoding: "utf8", timeout: 8000 });
  return (out.stdout ?? "").trim() === "true" ? "terminal.app-keystroke-degraded" : null;
}

export interface TileResult {
  method: "tmux" | "terminal.app" | "unsupported";
  count: number;
  note: string;
}

/** Arrange the agent terminals into a mosaic. */
export function tileTerminals(dry?: boolean): TileResult {
  if (hasTmux()) {
    if (!dry) spawnSync("tmux", ["select-layout", "-t", TMUX_SESSION, "tiled"]);
    const out = spawnSync("tmux", ["list-panes", "-t", TMUX_SESSION], { encoding: "utf8" });
    const count = (out.stdout ?? "").split("\n").filter(Boolean).length;
    return { method: "tmux", count, note: `Tiled ${count} panes in tmux session '${TMUX_SESSION}'.` };
  }
  if (isMac()) {
    // Grid-arrange Terminal.app windows by setting their bounds. No Accessibility needed.
    const osa = [
      'tell application "Finder" to set sb to bounds of window of desktop',
      'tell application "Terminal"',
      "  set ws to windows",
      "  set n to count of ws",
      "  if n is 0 then return 0",
      "  set cols to (round (n ^ 0.5) rounding up)",
      "  set rows to (round (n / cols) rounding up)",
      "  set sw to (item 3 of sb) - (item 1 of sb)",
      "  set sh to (item 4 of sb) - (item 2 of sb)",
      "  set cw to sw div cols",
      "  set ch to sh div rows",
      "  repeat with i from 1 to n",
      "    set c to (i - 1) mod cols",
      "    set r to (i - 1) div cols",
      "    set x1 to (item 1 of sb) + c * cw",
      "    set y1 to (item 2 of sb) + r * ch",
      "    set bounds of (item i of ws) to {x1, y1, x1 + cw, y1 + ch}",
      "  end repeat",
      "  return n",
      "end tell",
    ].join("\n");
    if (dry) return { method: "terminal.app", count: 0, note: "Would grid-arrange Terminal.app windows." };
    const out = spawnSync("osascript", ["-e", osa], { encoding: "utf8" });
    const count = Number.parseInt((out.stdout ?? "0").trim(), 10) || 0;
    return { method: "terminal.app", count, note: `Arranged ${count} Terminal.app windows into a mosaic.` };
  }
  return { method: "unsupported", count: 0, note: "Terminal tiling needs tmux or macOS." };
}
