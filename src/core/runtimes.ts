import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Which coding-agent runtimes exist on THIS machine (the one that spawns
 * terminals)? Probed from PATH with a version call, cached in-process, and
 * refreshed on serve/doctor. v1 is detect-and-report only — groundwork for
 * multi-provider spawn; the spawn contract per runtime is a future task.
 */

export interface RuntimeInfo {
  /** Human name, e.g. "Claude Code". */
  name: string;
  /** The executable probed on PATH. */
  cmd: string;
  /** Absolute path it resolved to. */
  path: string;
  /** First line of `<cmd> --version` (null when the call fails). */
  version: string | null;
}

/** Known agent CLIs, most established first. All answer `--version`. */
const KNOWN_RUNTIMES: { name: string; cmd: string }[] = [
  { name: "Claude Code", cmd: "claude" },
  { name: "OpenAI Codex CLI", cmd: "codex" },
  { name: "Gemini CLI", cmd: "gemini" },
  { name: "GitHub Copilot CLI", cmd: "copilot" },
  { name: "Aider", cmd: "aider" },
  { name: "Amp", cmd: "amp" },
  { name: "OpenCode", cmd: "opencode" },
  { name: "Goose", cmd: "goose" },
  { name: "Cursor Agent", cmd: "cursor-agent" },
  { name: "Qwen Code", cmd: "qwen" },
];

/** Resolve a command on PATH (with Windows extensions). Null when absent. */
export function findOnPath(cmd: string): string | null {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const names = process.platform === "win32" ? [`${cmd}.cmd`, `${cmd}.exe`, `${cmd}.bat`, cmd] : [cmd];
  for (const d of dirs) {
    for (const n of names) {
      try {
        const full = path.join(d, n);
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
      } catch {
        /* unreadable PATH entry — skip */
      }
    }
  }
  return null;
}

function probeVersion(cmd: string): string | null {
  try {
    const r = spawnSync(cmd, ["--version"], { encoding: "utf8", timeout: 1500 });
    if (r.status !== 0) return null;
    const line = (r.stdout || r.stderr || "").trim().split("\n")[0] ?? "";
    return line || null;
  } catch {
    return null;
  }
}

let cache: { at: number; list: RuntimeInfo[] } | null = null;
const CACHE_TTL_MS = 5 * 60_000;

/**
 * Installed runtimes, probed at most every 5 minutes (each probe is a PATH
 * scan plus a --version call capped at 1.5s per CLI). Pass refresh=true to
 * force a re-probe (serve startup and doctor do), or `known` to override the
 * probe list (tests).
 */
export function detectRuntimes(opts: { refresh?: boolean; known?: { name: string; cmd: string }[] } = {}): RuntimeInfo[] {
  if (opts.known) return probe(opts.known);
  if (!opts.refresh && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.list;
  const list = probe(KNOWN_RUNTIMES);
  cache = { at: Date.now(), list };
  return list;
}

function probe(known: { name: string; cmd: string }[]): RuntimeInfo[] {
  const found: RuntimeInfo[] = [];
  for (const k of known) {
    const p = findOnPath(k.cmd);
    if (!p) continue;
    found.push({ name: k.name, cmd: k.cmd, path: p, version: probeVersion(k.cmd) });
  }
  return found;
}
