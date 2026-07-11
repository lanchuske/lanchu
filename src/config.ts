import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Single source of truth for the version (keep in sync with package.json). */
export const VERSION = "0.5.10";

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

/** Loopback by default. Set LANCHU_HOST=0.0.0.0 to serve a remote/shared backend. */
export const DEFAULT_HOST = "127.0.0.1";
export function host(): string {
  const h = process.env.LANCHU_HOST?.trim();
  return h ? h : DEFAULT_HOST;
}
/** Back-compat alias for the loopback default (some call sites still import HOST). */
export const HOST = DEFAULT_HOST;

/**
 * When the CLI/agents should talk to a Lanchu server running elsewhere, set
 * LANCHU_SERVER to its base URL (e.g. https://lanchu.example.com). Returns the
 * normalized base (no trailing slash) or undefined for the local default.
 */
export function remoteServer(): string | undefined {
  const s = process.env.LANCHU_SERVER?.trim();
  return s ? s.replace(/\/+$/, "") : undefined;
}

/**
 * Shared secret that gates the admin/API surface (and /session) when set. Local
 * loopback deployments can leave it unset; expose the host and you should set it.
 */
export function accessKey(): string | undefined {
  const k = process.env.LANCHU_ACCESS_KEY?.trim();
  return k ? k : undefined;
}

/**
 * The base URL a remote client can reach this server at, used to advertise the
 * MCP endpoint to agents. Prefer LANCHU_PUBLIC_URL; callers fall back to the
 * request's Host header, then loopback.
 */
export function publicUrl(): string | undefined {
  const u = process.env.LANCHU_PUBLIC_URL?.trim();
  return u ? u.replace(/\/+$/, "") : undefined;
}

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

/**
 * Reconnect grace after server start: while it lasts, a second MCP session for
 * an already-live agent is treated as the SAME terminal re-establishing its
 * transport (restart blip / retry race), not as a duplicate identity.
 */
export function reconnectGraceMs(): number {
  const s = process.env.LANCHU_RECONNECT_GRACE_MS;
  const n = s ? Number.parseInt(s, 10) : 120_000;
  return Number.isFinite(n) && n >= 0 ? n : 120_000;
}

/**
 * SDLC state-machine rollout (design doc "SDLC state machine"):
 * off    — no pipeline involvement (solo use);
 * assist — the server routes stages, auto-creates QA verification and notices
 *          specialists, but never blocks an agent's status change (default);
 * strict — gates enforced: 'done' on unverified work is held until the
 *          verification task passes.
 */
export type SdlcMode = "off" | "assist" | "strict";
export function sdlcMode(): SdlcMode {
  const m = (process.env.LANCHU_SDLC ?? "assist").trim().toLowerCase();
  return m === "off" || m === "strict" ? m : "assist";
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

/** Where the local server binds (and its own self-reference when serving). */
export function localBaseUrl(): string {
  const h = host() === "0.0.0.0" ? "127.0.0.1" : host();
  return `http://${h}:${port()}`;
}

/** Where the CLI/agents should send requests: the remote server if configured, else local. */
export function baseUrl(): string {
  return remoteServer() ?? localBaseUrl();
}

export function mcpUrl(): string {
  return `${baseUrl()}/mcp`;
}
