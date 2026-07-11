/**
 * Build provenance (task-mrg7nmg43): restart ≠ rebuild. On 2026-07-11 a
 * greenzone restart relaunched a dist/ compiled three hours earlier — two
 * merged PRs were "deployed" but not running, and only a builder-side DB diff
 * exposed it. The infrastructure now knows exactly which code is live: git
 * HEAD of the package checkout (when dogfooding from a repo), when dist/ was
 * compiled, and whether HEAD is newer than the build — surfaced on /health,
 * logged at serve, and consumed by the restart path to rebuild first.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface BuildProvenance {
  version: string;
  /** git HEAD sha of the package checkout; null for plain npm installs. */
  commit: string | null;
  /** When HEAD was committed (ISO); null without a repo. */
  committed_at: string | null;
  /** When dist/ was compiled (newest mtime across its entry modules). */
  built_at: string | null;
  /** HEAD is newer than the running build — the compiled code is stale. */
  stale: boolean;
}

/** dist/core/provenance.js → the package root two levels up. */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function gitHead(root: string): { sha: string; committedAt: string } | null {
  try {
    const res = spawnSync("git", ["-C", root, "log", "-1", "--format=%H %cI"], {
      encoding: "utf8",
      timeout: 3000,
    });
    if (res.status !== 0 || !res.stdout) return null;
    const [sha, committedAt] = res.stdout.trim().split(/\s+/);
    if (!sha || !committedAt) return null;
    return { sha, committedAt };
  } catch {
    return null;
  }
}

/** When the running build was compiled: the newest mtime across dist's entry modules. */
function builtAt(root: string): string | null {
  const probes = [
    path.join(root, "dist", "server", "server.js"),
    path.join(root, "dist", "core", "store.js"),
    path.join(root, "dist", "cli", "index.js"),
  ];
  let newest = 0;
  for (const p of probes) {
    try {
      newest = Math.max(newest, fs.statSync(p).mtimeMs);
    } catch {
      /* missing probe file — skip */
    }
  }
  return newest ? new Date(newest).toISOString() : null;
}

/** Pure comparator, exported for tests: a commit newer than the build = stale code. */
export function isStaleBuild(committedAt: string | null, built: string | null): boolean {
  if (!committedAt || !built) return false; // no repo or no dist — nothing to compare
  return new Date(committedAt).getTime() > new Date(built).getTime();
}

/** Provenance of the code on disk right now (the restart path re-reads it live). */
export function buildProvenance(version: string): BuildProvenance {
  const root = packageRoot();
  const head = gitHead(root);
  const built = builtAt(root);
  return {
    version,
    commit: head?.sha ?? null,
    committed_at: head?.committedAt ?? null,
    built_at: built,
    stale: isStaleBuild(head?.committedAt ?? null, built),
  };
}
