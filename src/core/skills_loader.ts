import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

// A skill loaded from an external source. Mirrors the shape of a Claude "SKILL.md":
// an optional `---` frontmatter block (name / description / tags) followed by the
// instructions body. Everything is optional except the body.
export interface SkillDefinition {
  name?: string;
  description?: string;
  tags?: string[];
  instructions: string;
}

/** True for sources we fetch over the network rather than read from disk. */
function isHttp(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

/**
 * Read a skill source from an http(s) URL, a file:// URL, or a local file path.
 * Returns the raw text. Throws a friendly error if it can't be reached.
 */
export async function fetchSkillSource(source: string): Promise<string> {
  if (isHttp(source)) {
    let res: Response;
    try {
      res = await fetch(source, { headers: { accept: "text/markdown, text/plain, */*" } });
    } catch (err) {
      throw new Error(`Couldn't reach skill source ${source}: ${(err as Error).message}`);
    }
    if (!res.ok) throw new Error(`Skill source ${source} returned HTTP ${res.status}`);
    return await res.text();
  }
  const path = source.startsWith("file://") ? fileURLToPath(source) : source;
  try {
    return await fs.readFile(path, "utf8");
  } catch (err) {
    throw new Error(`Couldn't read skill file ${path}: ${(err as Error).message}`);
  }
}

/** Strip surrounding quotes and whitespace from a frontmatter scalar. */
function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/** Parse a `tags:` value written as `a, b` or `[a, b]` into a clean list. */
function parseTagList(value: string): string[] {
  return value
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map((t) => unquote(t))
    .filter(Boolean);
}

/**
 * Parse a skill source into name/description/tags/instructions. Supports an optional
 * YAML-ish frontmatter block delimited by `---` lines at the very top of the file;
 * without one, the whole text becomes the instructions. Kept dependency-free on
 * purpose — we only read simple `key: value` scalars and a tag list.
 */
export function parseSkillSource(text: string): SkillDefinition {
  const normalized = text.replace(/^﻿/, ""); // drop a leading BOM if present
  const fm = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(normalized);
  if (!fm) return { instructions: normalized.trim() };

  const def: SkillDefinition = { instructions: normalized.slice(fm[0].length).trim() };
  for (const line of fm[1]!.split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2] ?? "";
    if (key === "name") def.name = unquote(value);
    else if (key === "description") def.description = unquote(value);
    else if (key === "tags") def.tags = parseTagList(value);
  }
  return def;
}

/** Fetch and parse a skill source in one step. */
export async function loadSkillDefinition(source: string): Promise<SkillDefinition> {
  return parseSkillSource(await fetchSkillSource(source));
}
