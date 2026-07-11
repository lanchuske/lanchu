import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Docs version consistency (QA regression for the #51 bounce): the package
// version must appear wherever the docs claim a version, or a release leaves
// the public surface contradicting itself (index.html said 0.5.11 while the
// machine-readable server card still said 0.5.9 — an LLM reading both got two
// different answers). One place to bump is package.json; everything else must
// follow in the same PR.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const version = JSON.parse(read("package.json")).version;

test("docs/index.html JSON-LD softwareVersion matches package.json", () => {
  const m = /"softwareVersion":\s*"([^"]+)"/.exec(read("docs/index.html"));
  assert.ok(m, "index.html must declare softwareVersion in its JSON-LD");
  assert.equal(m[1], version);
});

test("MCP server card version matches package.json", () => {
  const card = JSON.parse(read("docs/.well-known/mcp/server-card.json"));
  assert.equal(card.serverInfo.version, version);
});

test("CHANGELOG has an entry for the current version", () => {
  assert.ok(
    read("CHANGELOG.md").includes(`## ${version} `),
    `CHANGELOG.md must have a "## ${version}" entry before releasing`,
  );
});
