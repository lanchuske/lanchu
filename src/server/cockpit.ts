import { spawnSync } from "node:child_process";
import { mcpUrl } from "../config.js";

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

/** Shell command that wires Claude to Lanchu and launches it with a first prompt. */
export function bootstrapCommand(cwd: string, token: string, prompt: string, agentName?: string): string {
  // Carry this agent's identity as an inline MCP config scoped to THIS process
  // only. We deliberately avoid `claude mcp add lanchu`, which writes a shared,
  // project-scoped server: a second agent in the same repo would then either
  // inherit the first agent's token (add is a no-op when the server already
  // exists) or clobber it — both cause the agent's lanchu://me to report the
  // wrong identity/role. --strict-mcp-config makes the identity deterministic.
  const mcpConfig = JSON.stringify({
    mcpServers: { lanchu: { type: "http", url: mcpUrl(), headers: { Authorization: `Bearer ${token}` } } },
  });
  // Export the agent name so `lanchu statusline` can show which teammate owns this terminal.
  const ident = agentName ? `export LANCHU_AGENT=${sq(agentName)}; ` : "";
  return `cd ${sq(cwd)}; ${ident}claude --strict-mcp-config --mcp-config ${sq(mcpConfig)} ${sq(prompt)}`;
}

const asAppleStr = (s: string) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

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
  dry?: boolean;
}): SpawnResult {
  const command = bootstrapCommand(input.cwd, input.token, input.prompt, input.agentName);

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
