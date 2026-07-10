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
export function bootstrapCommand(cwd: string, token: string, prompt: string): string {
  const add = `claude mcp add lanchu --transport http ${mcpUrl()} --header 'Authorization: Bearer ${token}'`;
  return `cd ${sq(cwd)}; ${add} >/dev/null 2>&1; claude ${sq(prompt)}`;
}

const asAppleStr = (s: string) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

export interface SpawnResult {
  method: "tmux" | "terminal.app" | "print";
  title: string;
  command: string;
  note: string;
}

/** Open a terminal for a new agent. With dry=true, returns the plan without executing. */
export function spawnTerminal(input: {
  title: string;
  cwd: string;
  token: string;
  prompt: string;
  dry?: boolean;
}): SpawnResult {
  const command = bootstrapCommand(input.cwd, input.token, input.prompt);

  if (hasTmux()) {
    const plan: SpawnResult = {
      method: "tmux",
      title: input.title,
      command,
      note: `tmux pane in session '${TMUX_SESSION}'. Attach with: tmux attach -t ${TMUX_SESSION}`,
    };
    if (input.dry) return plan;
    // ensure session, add a tiled pane titled org·agent
    const has0 = spawnSync("tmux", ["has-session", "-t", TMUX_SESSION], { stdio: "ignore" }).status === 0;
    if (!has0) {
      spawnSync("tmux", ["new-session", "-d", "-s", TMUX_SESSION, "-c", input.cwd, command]);
    } else {
      spawnSync("tmux", ["split-window", "-t", TMUX_SESSION, "-c", input.cwd, command]);
    }
    spawnSync("tmux", ["select-layout", "-t", TMUX_SESSION, "tiled"]);
    spawnSync("tmux", ["set-option", "-p", "-t", TMUX_SESSION, "pane-border-status", "top"]);
    spawnSync("tmux", ["select-pane", "-t", TMUX_SESSION, "-T", input.title]);
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
    const osa = [
      'tell application "Terminal"',
      "  activate",
      `  set t to do script ${asAppleStr(command)}`,
      "  delay 0.4",
      `  set custom title of t to ${asAppleStr(input.title)}`,
      "end tell",
    ].join("\n");
    spawnSync("osascript", ["-e", osa]);
    return plan;
  }

  return {
    method: "print",
    title: input.title,
    command,
    note: "No tmux and not macOS — run this command in a new terminal yourself.",
  };
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
