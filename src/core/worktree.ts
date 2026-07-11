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
/**
 * Marker for "this path is inside a Lanchu-managed worktree". Compared on
 * forward slashes: git prints `/`-separated paths even on Windows, where
 * path.sep is `\`, so a path.sep-built marker would never match there.
 */
const WORKTREES_MARKER = "/.lanchu/worktrees/";
const toSlashes = (p: string) => p.replace(/\\/g, "/");

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
export function ensureAgentWorktree(dir: string, agentName: string, orgName?: string): AgentWorktree | null {
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || !top.out) return null;
  // Nested isolation guard: spawning from inside an agent worktree must anchor
  // new worktrees at the main repo, not grow .lanchu/worktrees/a/.lanchu/… chains.
  let repoRoot = top.out;
  const idx = toSlashes(repoRoot).indexOf(WORKTREES_MARKER);
  if (idx >= 0) repoRoot = repoRoot.slice(0, idx);

  const slug = slugify(agentName);
  const wtPath = path.join(repoRoot, WORKTREES_SUBDIR, slug);
  const branch = `agent/${slug}`;

  // Reattach: the worktree is already there and still a valid checkout.
  if (fs.existsSync(wtPath) && git(wtPath, ["rev-parse", "--is-inside-work-tree"]).ok) {
    const cur = git(wtPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    setWorktreeAuthor(repoRoot, wtPath, agentName, orgName); // idempotent — upgrades pre-identity worktrees
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
  setWorktreeAuthor(repoRoot, wtPath, agentName, orgName);
  return { path: wtPath, branch, created: true };
}

/**
 * GitHub-identity Phase 2: per-worktree git author, so commits name WHICH
 * agent wrote them even when every agent pushes from one shared account.
 * Uses git's per-worktree config (extensions.worktreeConfig) so agents never
 * clobber each other's author or the human's global identity.
 */
function setWorktreeAuthor(repoRoot: string, wtPath: string, agentName: string, orgName?: string): void {
  git(repoRoot, ["config", "extensions.worktreeConfig", "true"]);
  git(wtPath, ["config", "--worktree", "user.name", `${agentName} (lanchu)`]);
  git(wtPath, ["config", "--worktree", "user.email", `${slugify(agentName)}@agents.${slugify(orgName ?? "org")}.lanchu`]);
}

/** Effective git author in a directory (worktree-local config included). Read-only. */
export function gitAuthorIn(dir: string): { name: string | null; email: string | null } {
  const name = git(dir, ["config", "user.name"]);
  const email = git(dir, ["config", "user.email"]);
  return {
    name: name.ok && name.out ? name.out : null,
    email: email.ok && email.out ? email.out : null,
  };
}

/**
 * GitHub-identity Phase 1: best-effort active GitHub account via the gh CLI,
 * cached for the server's lifetime (the machine holds one auth). Read-only —
 * only the public login ever leaves this function, never a credential.
 */
let ghLoginCache: { value: string | null } | null = null;
export function ghLogin(): string | null {
  if (ghLoginCache) return ghLoginCache.value;
  try {
    const r = spawnSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8", timeout: 4000 });
    ghLoginCache = { value: r.status === 0 ? (r.stdout ?? "").trim() || null : null };
  } catch {
    ghLoginCache = { value: null };
  }
  return ghLoginCache.value;
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
  const idx = toSlashes(worktreePath).indexOf(WORKTREES_MARKER);
  if (idx < 0) {
    return { removed: false, reason: "not a Lanchu-managed worktree" };
  }
  if (!fs.existsSync(worktreePath)) return { removed: false, reason: "already gone" };
  const repoRoot = worktreePath.slice(0, idx);
  const r = git(repoRoot, ["worktree", "remove", worktreePath]);
  if (!r.ok) return { removed: false, reason: "worktree has uncommitted changes — left in place" };
  return { removed: true };
}
