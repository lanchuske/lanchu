import fs from "node:fs";
import path from "node:path";
import { stateDir } from "../config.js";

/**
 * Network mode (Piece 5): a contract task's isolated sandbox. NOT a git
 * worktree of the real project — this directory has no `.git`, no remote,
 * and no relation whatsoever to the project's `local_path`. It's seeded
 * only from the task's own contract fields, so a network contributor never
 * sees anything of the surrounding codebase. See "Design: Contract-based
 * contributor isolation (network mode — Piece 5)".
 */

const CONTRACTS_SUBDIR = "contracts";

export interface ContractSandbox {
  /** Absolute path of the task's dedicated sandbox directory. */
  path: string;
  /** false when an existing sandbox was reused (re-claim / reattach). */
  created: boolean;
}

export interface ContractFields {
  contractSpec: string | null;
  contractTests: string | null;
  contractDeps: string | null;
}

/**
 * Create (or reuse) a contract task's sandbox directory, seeded from its
 * current contract fields. Re-seeds on every call so a sandbox never drifts
 * from the task's latest fields (e.g. after a definition edit) — cheap,
 * since this only ever writes 3 small files, never touches git.
 */
export function ensureContractSandbox(taskId: string, fields: ContractFields): ContractSandbox {
  const sandboxPath = path.join(stateDir(), CONTRACTS_SUBDIR, taskId);
  const created = !fs.existsSync(sandboxPath);
  fs.mkdirSync(sandboxPath, { recursive: true });

  writeOrRemove(sandboxPath, "CONTRACT.md", fields.contractSpec);
  writeOrRemove(sandboxPath, "CONTRACT_TESTS", fields.contractTests);
  writeOrRemove(sandboxPath, "CONTRACT_DEPS.json", fields.contractDeps);

  return { path: sandboxPath, created };
}

function writeOrRemove(dir: string, name: string, content: string | null): void {
  const target = path.join(dir, name);
  if (content === null) {
    if (fs.existsSync(target)) fs.rmSync(target);
    return;
  }
  fs.writeFileSync(target, content, "utf8");
}
