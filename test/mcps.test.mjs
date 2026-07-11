import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const { readProjectMcpServers, sanitizeUrl } = await import("../dist/core/mcps.js");

test("project MCP discovery reads .mcp.json and redacts every credential shape", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lanchu-mcps-"));
  fs.writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({
    mcpServers: {
      "lanchu": { type: "http", url: "http://127.0.0.1:4319/mcp?token=lsk_supersecret123#f" },
      "basic-auth": { url: "https://user:hunter2@example.com/mcp" },
      "local-tool": { command: "npx", args: ["-y", "some-mcp", "--api-key", "sk-abcdef1234567890abcdef1234567890"] },
      "clean-stdio": { command: "node", args: ["server.js"] },
    },
  }));

  const servers = readProjectMcpServers(dir);
  const by = Object.fromEntries(servers.map((s) => [s.name, s]));
  const all = JSON.stringify(servers);

  assert.equal(servers.length, 4);
  // secrets must not survive in any field
  assert.ok(!all.includes("lsk_supersecret123"), "query token leaked");
  assert.ok(!all.includes("hunter2"), "basic-auth password leaked");
  assert.ok(!all.includes("sk-abcdef"), "api key arg leaked");
  // shape survives
  assert.equal(by["lanchu"].transport, "http");
  assert.equal(by["lanchu"].target, "http://127.0.0.1:4319/mcp");
  assert.equal(by["local-tool"].transport, "stdio");
  assert.ok(by["local-tool"].target.includes("‹redacted›"));
  assert.ok(by["clean-stdio"].target.includes("node server.js"));
  assert.ok(servers.every((s) => s.status === "unknown"), "no probe ran at read time");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sanitizeUrl strips userinfo, query and fragment", () => {
  assert.equal(sanitizeUrl("https://u:p@h.example/mcp?key=x#y"), "https://h.example/mcp");
  assert.equal(sanitizeUrl("not a url"), "‹unparseable url›");
});

test("missing or malformed config files yield an empty list, not a crash", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lanchu-mcps2-"));
  assert.deepEqual(readProjectMcpServers(dir).filter((s) => s.source === ".mcp.json"), []);
  fs.writeFileSync(path.join(dir, ".mcp.json"), "{ nope");
  assert.deepEqual(readProjectMcpServers(dir).filter((s) => s.source === ".mcp.json"), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
