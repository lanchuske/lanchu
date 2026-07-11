import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Per-agent git worktree isolation. Each spawned agent gets its own working
 * tree under `<repo>/.lanchu/worktrees/<agent>` on branch `agent/<agent>`, so
 * parallel agents never share a HEAD, an index or uncommitted files. See the
 * design doc "Design: agent isolation — per-agent worktree + branch".
 */

export interface AgentWorktree {
  /** Absolute path of the agent's dedicated working tree. */
  path: string;
  /** Branch checked out in that worktree (agent/<name>). */
  branch: string;
  /** false when an existing worktree was reused (durable-agent reattach). */
  created: boolean;
}

const WORKTREES_SUBDIR = path.join(".lanchu", "worktrees");

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  try {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 15_000 });
    return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

/** Agent name → filesystem/branch-safe slug ("QA rev.2" → "qa-rev-2"). */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "agent"
  );
}

/**
 * The commit new agent branches start from: the repo's default branch when it
 * can be resolved (origin/HEAD), otherwise the current HEAD.
 */
function baseRef(repoRoot: string): string {
  const head = git(repoRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  return head.ok && head.out ? head.out : "HEAD";
}

/** Keep the worktrees dir out of `git status` without touching the repo's .gitignore. */
function excludeWorktreesDir(repoRoot: string): void {
  const commonDir = git(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!commonDir.ok || !commonDir.out) return;
  const exclude = path.join(commonDir.out, "info", "exclude");
  const line = ".lanchu/worktrees/";
  try {
    const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
    if (current.split("\n").includes(line)) return;
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, (current && !current.endsWith("\n") ? "\n" : "") + line + "\n");
  } catch {
    /* best-effort — an unignored dir is cosmetic */
  }
}

/**
 * Create (or reuse) the agent's dedicated worktree + branch. Reuse happens when
 * reattaching to a durable agent whose worktree still exists; the branch is
 * likewise reused when it survived a previous prune. Returns null when `dir`
 * is not inside a git repository or git itself fails — callers fall back to
 * the shared directory, which is the pre-isolation behavior.
 */
export function ensureAgentWorktree(dir: string, agentName: string): AgentWorktree | null {
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || !top.out) return null;
  // Nested isolation guard: spawning from inside an agent worktree must anchor
  // new worktrees at the main repo, not grow .lanchu/worktrees/a/.lanchu/… chains.
  let repoRoot = top.out;
  const marker = path.sep + WORKTREES_SUBDIR + path.sep;
  const idx = repoRoot.indexOf(marker);
  if (idx >= 0) repoRoot = repoRoot.slice(0, idx);

  const slug = slugify(agentName);
  const wtPath = path.join(repoRoot, WORKTREES_SUBDIR, slug);
  const branch = `agent/${slug}`;

  // Reattach: the worktree is already there and still a valid checkout.
  if (fs.existsSync(wtPath) && git(wtPath, ["rev-parse", "--is-inside-work-tree"]).ok) {
    const cur = git(wtPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return { path: wtPath, branch: cur.ok && cur.out ? cur.out : branch, created: false };
  }

  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  excludeWorktreesDir(repoRoot);
  // A stale registration (dir deleted manually) blocks `worktree add` — clear it.
  git(repoRoot, ["worktree", "prune"]);

  const branchExists = git(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
  const add = branchExists
    ? git(repoRoot, ["worktree", "add", wtPath, branch])
    : git(repoRoot, ["worktree", "add", wtPath, "-b", branch, baseRef(repoRoot)]);
  if (!add.ok) return null;
  return { path: wtPath, branch, created: true };
}

/**
 * Remove a retired agent's worktree, keeping its branch for PR/merge. Only
 * touches paths Lanchu created (under .lanchu/worktrees) and refuses to drop
 * uncommitted work: a dirty worktree is left in place and reported.
 */
export function removeAgentWorktree(worktreePath: string | null | undefined): {
  removed: boolean;
  reason?: string;
} {
  if (!worktreePath) return { removed: false, reason: "no worktree recorded" };
  const marker = path.sep + WORKTREES_SUBDIR + path.sep;
  if (!worktreePath.includes(marker)) {
    return { removed: false, reason: "not a Lanchu-managed worktree" };
  }
  if (!fs.existsSync(worktreePath)) return { removed: false, reason: "already gone" };
  const repoRoot = worktreePath.slice(0, worktreePath.indexOf(marker));
  const r = git(repoRoot, ["worktree", "remove", worktreePath]);
  if (!r.ok) return { removed: false, reason: "worktree has uncommitted changes — left in place" };
  return { removed: true };
}
