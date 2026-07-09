// Self-contained Lanchu demo: boots an isolated local server, connects a real
// MCP client as an agent, and walks the core flow (create tasks, hit a hard
// scope block, claim, complete, write a doc). Run with `npm run demo`.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = Number(process.env.DEMO_PORT || 4399);
const BASE = `http://127.0.0.1:${PORT}`;
const stateDir = path.join(os.tmpdir(), `lanchu-demo-${process.pid}`);
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli", "index.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const body = (r) => JSON.parse(r.content[0].text);

fs.rmSync(stateDir, { recursive: true, force: true });
const server = spawn(process.execPath, [cli, "serve"], {
  env: { ...process.env, LANCHU_PORT: String(PORT), LANCHU_STATE_DIR: stateDir },
  stdio: "ignore",
});
const up = async () => { try { return (await fetch(`${BASE}/health`)).ok; } catch { return false; } };

async function main() {
  for (let i = 0; i < 60 && !(await up()); i++) await sleep(100);

  const sess = await (await fetch(`${BASE}/session`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ org: "demo", project: "web", objective: "build the landing page", role: "frontend", roleTags: ["ui", "copy"] }),
  })).json();
  console.log(`\n[launcher]  agent "${sess.agentName}" (role frontend: [ui, copy])`);

  const client = new Client({ name: "demo-agent", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${sess.token}` } },
  }));
  const tools = await client.listTools();
  console.log(`[mcp]       connected · ${tools.tools.length} tools`);

  const me = JSON.parse((await client.readResource({ uri: "lanchu://me" })).contents[0].text);
  console.log(`[me]        role "${me.role.name}", allowed tags [${me.role.allowed_tags}]`);

  const t1 = body(await client.callTool({ name: "task_create", arguments: { title: "Hero section", tags: ["ui"] } }));
  console.log(`[create]    ${t1.id} "${t1.title}" (${t1.status})`);

  const bad = await client.callTool({ name: "task_create", arguments: { title: "DB migration", tags: ["backend"] } });
  console.log(`[governance] out-of-scope create -> ${bad.isError ? "BLOCKED: " + JSON.parse(bad.content[0].text).message : "allowed (!)"}`);

  const claimed = body(await client.callTool({ name: "task_claim", arguments: { taskId: t1.id } }));
  console.log(`[claim]     ${claimed.id} -> ${claimed.status}`);
  const done = body(await client.callTool({ name: "task_update", arguments: { taskId: t1.id, status: "done", tokens: 12000 } }));
  console.log(`[done]      ${t1.id} · nudge: "${done.nudge}"`);
  await client.callTool({ name: "doc_update", arguments: { title: "Landing notes", content: "Hero shipped." } });
  console.log(`[doc]       "Landing notes" saved`);

  const board = await (await fetch(`${BASE}/api/board?org=demo`)).json();
  console.log(`\n[board]     agents: ${board.agents.map((a) => a.name + "(" + a.state + ")").join(", ")}`);
  console.log(`[board]     tasks: ${board.tasks.map((t) => t.title + " [" + t.status + "]").join(", ")}`);
  console.log(`\nPanel would be at ${BASE} (this demo runs on an isolated port + temp state).`);
  await client.close();
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    await fetch(`${BASE}/shutdown`, { method: "POST" }).catch(() => {});
    server.kill();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
