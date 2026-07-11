/**
 * Model routing v1: a static tier map from task shape (tags + stage) to the
 * claude CLI model alias that maximizes capability per dollar. Aliases stay
 * evergreen (opus/sonnet/haiku resolve to the latest model of each tier —
 * never pin dated IDs here). Refined later by per-task-type token history
 * from the budgets MVP; this module provides the lever, budgets the data.
 */

export type ModelTier = "opus" | "sonnet" | "haiku";

/** Tags whose work is mechanical: verification, docs formatting, submissions, smoke tests. */
const HAIKU_TAGS = new Set(["docs", "qa", "smoke", "verify", "verification", "distribution", "formatting"]);

/** Tags that signal definition/architecture/incident-analysis work. */
const OPUS_TAGS = new Set(["design", "architecture", "incident", "definition"]);

export interface ModelSuggestion {
  model: ModelTier;
  reason: string;
}

/**
 * Suggested tier for a task. Heuristic (v1, static):
 * definition/architecture/review/incident-analysis → opus;
 * mechanical verification, docs formatting, submissions, smoke tests → haiku;
 * well-specified build tasks (and everything else) → sonnet.
 */
export function suggestModel(tags: string[], stage: string | null): ModelSuggestion {
  const t = tags.map((x) => x.toLowerCase());
  if (stage === "definition" || stage === "review" || t.some((x) => OPUS_TAGS.has(x))) {
    return { model: "opus", reason: "definition/architecture/review work benefits from the deepest tier" };
  }
  if (t.length > 0 && t.every((x) => HAIKU_TAGS.has(x))) {
    return { model: "haiku", reason: "mechanical verification/docs work — the cheap tier is enough" };
  }
  return { model: "sonnet", reason: "well-specified build work — the balanced tier" };
}

/**
 * Do two model names name the same tier? Compares by alias family so
 * "sonnet" matches "claude-sonnet-5" and any dated variant.
 */
export function sameModelTier(a: string | null, b: string | null): boolean {
  if (!a || !b) return true; // unknown on either side — never nag
  const tier = (m: string): string => {
    const l = m.toLowerCase();
    for (const t of ["opus", "sonnet", "haiku", "fable", "mythos"]) if (l.includes(t)) return t;
    return l;
  };
  return tier(a) === tier(b);
}
