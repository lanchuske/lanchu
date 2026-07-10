import { spawnSync } from "node:child_process";

export interface GitInfo {
  /** origin remote, normalized to a browsable https URL when recognizable. */
  repoUrl: string | null;
  /** current branch (or null in a detached HEAD / non-repo). */
  branch: string | null;
  /** absolute path of the working tree root (git worktree the agent is in). */
  worktree: string | null;
}

/** Read git facts for a directory. Never throws; missing git or non-repo → nulls. */
export function gitInfo(cwd: string | undefined | null): GitInfo {
  const empty: GitInfo = { repoUrl: null, branch: null, worktree: null };
  if (!cwd) return empty;
  const run = (args: string[]): string | null => {
    try {
      const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 1500 });
      const out = r.status === 0 ? r.stdout.trim() : "";
      return out || null;
    } catch {
      return null;
    }
  };
  return {
    repoUrl: normalizeRepoUrl(run(["remote", "get-url", "origin"])),
    branch: run(["rev-parse", "--abbrev-ref", "HEAD"]),
    worktree: run(["rev-parse", "--show-toplevel"]),
  };
}

/** Turn a git remote (ssh or https, with/without .git) into a browsable https URL. */
export function normalizeRepoUrl(raw: string | null): string | null {
  if (!raw) return null;
  let url = raw.trim().replace(/\.git$/, "");
  // scp-style: git@host:owner/repo  →  https://host/owner/repo
  const scp = url.match(/^[\w.-]+@([\w.-]+):(.+)$/);
  if (scp) url = `https://${scp[1]}/${scp[2]}`;
  // ssh://git@host/owner/repo  →  https://host/owner/repo
  url = url.replace(/^ssh:\/\/(?:[\w.-]+@)?/, "https://");
  return url;
}
