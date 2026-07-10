import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Single source of truth for the version (keep in sync with package.json). */
export const VERSION = "0.5.5";

/**
 * Local server paths and configuration, OS-agnostic.
 * See DEFINITION.md §7 (non-negotiable constraints) and CLI.md §7.
 */

/** Per-OS state directory (equivalent to env-paths, without an external dependency). */
export function stateDir(): string {
  const override = process.env.LANCHU_STATE_DIR;
  if (override) return override;

  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "lanchu");
    case "win32":
      return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "lanchu");
    default: // linux y otros unix
      return path.join(process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "lanchu");
  }
}

export function dbPath(): string {
  return path.join(stateDir(), "lanchu.db");
}

export const DEFAULT_PORT = 4319;

export function port(): number {
  const p = process.env.LANCHU_PORT;
  const n = p ? Number.parseInt(p, 10) : DEFAULT_PORT;
  return Number.isFinite(n) ? n : DEFAULT_PORT;
}

export const HOST = "127.0.0.1";

/** After how many hours a task of an idle agent is marked "stale" (C4). */
export function staleHours(): number {
  const h = process.env.LANCHU_STALE_HOURS;
  const n = h ? Number.parseInt(h, 10) : 24;
  return Number.isFinite(n) && n > 0 ? n : 24;
}

/** An agent counts as "active" if it was seen within this window (presence). */
export function activeWindowMs(): number {
  const s = process.env.LANCHU_ACTIVE_SECONDS;
  const n = s ? Number.parseInt(s, 10) : 45;
  return (Number.isFinite(n) && n > 0 ? n : 45) * 1000;
}

// ── local settings (opt-in preferences; never leaves the machine) ──
export interface Settings {
  notifyUpdates?: boolean;
}
function settingsPath(): string {
  return path.join(stateDir(), "settings.json");
}
export function readSettings(): Settings {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), "utf8")) as Settings;
  } catch {
    return {};
  }
}
export function writeSettings(s: Settings): void {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2) + "\n");
}

export function baseUrl(): string {
  return `http://${HOST}:${port()}`;
}

export function mcpUrl(): string {
  return `${baseUrl()}/mcp`;
}
