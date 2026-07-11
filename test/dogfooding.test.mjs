import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The detect-and-file mindset lives in the product's own prompts (not just
// org-editable rules) so every org gets it out of the box. These pins keep a
// prompt rewrite from silently dropping the duty or its taxonomy.
const dist = (p) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", p), "utf8");

test("MCP INSTRUCTIONS carry the detect-and-file duty with the taxonomy", () => {
  const mcp = dist("server/mcp.js");
  assert.match(mcp, /watch for friction/i);
  assert.match(mcp, /bug \|\s*extension \|\s*idea \|\s*process/);
  assert.match(mcp, /expected vs actual/);
});

test("help tool documents the taxonomy with definitions and an example", () => {
  const mcp = dist("server/mcp.js");
  assert.match(mcp, /dogfooding:/);
  assert.match(mcp, /broken behavior/);
  assert.match(mcp, /falls short/);
  assert.match(mcp, /workflow friction/);
  assert.match(mcp, /task_create\(\{ title: "Bug:/);
});

test("every spawn/resume prompt carries the one-liner", () => {
  for (const file of ["cli/run.js", "server/mcp.js", "server/server.js"]) {
    assert.match(dist(file), /watch for friction in Lanchu itself/, file + " must carry the dogfooding one-liner");
  }
});
