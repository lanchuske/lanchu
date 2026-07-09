#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { baseUrl, dbPath, DEFAULT_PORT, mcpUrl, port, stateDir } from "../config.js";
import { startServer } from "../server/server.js";

const args = process.argv.slice(2);

// ── tiny arg parser ──────────────────────────────────────────
function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}
function positional(): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      i++; // skip its value
      continue;
    }
    out.push(a);
  }
  return out;
}

// ── config file (.lanchu/config.json), git-style upward search ──
interface ProjectConfig {
  org: string;
  project: string;
}
function findConfig(from = process.cwd()): { file: string; config: ProjectConfig } | null {
  let dir = from;
  for (;;) {
    const file = path.join(dir, ".lanchu", "config.json");
    if (fs.existsSync(file)) {
      return { file, config: JSON.parse(fs.readFileSync(file, "utf8")) as ProjectConfig };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
function writeConfig(config: ProjectConfig): string {
  const file = path.join(process.cwd(), ".lanchu", "config.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  return file;
}

// ── server helpers ───────────────────────────────────────────
async function serverUp(): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl()}/health`, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}
async function ensureServer(): Promise<void> {
  if (await serverUp()) return;
  const script = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [script, "serve"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (await serverUp()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("could not start the local Lanchu server");
}

// ── commands ─────────────────────────────────────────────────
async function cmdServe(): Promise<void> {
  await startServer();
  console.log(`Lanchu server listening on ${baseUrl()}`);
  console.log(`  panel: ${baseUrl()}`);
  console.log(`  mcp:   ${mcpUrl()}`);
  console.log(`  db:    ${dbPath()}`);
}

async function cmdDoctor(): Promise<void> {
  const node = process.versions.node;
  const [major, minor] = node.split(".").map(Number) as [number, number];
  const nodeOk = major > 22 || (major === 22 && minor >= 5);
  console.log(`node        ${node}   ${nodeOk ? "OK" : "needs >= 22.5.0"}`);
  console.log(`state dir   ${stateDir()}`);
  console.log(`db          ${dbPath()}`);
  console.log(`port        ${port()}${port() === DEFAULT_PORT ? " (default)" : ""}`);
  console.log(`server      ${(await serverUp()) ? "running" : "stopped"}`);
}

async function cmdBoard(kind: "agents" | "tasks"): Promise<void> {
  const found = findConfig();
  if (!found) return console.log("no .lanchu/config.json here — run `lanchu init` first");
  await ensureServer();
  const res = await fetch(`${baseUrl()}/api/board?org=${encodeURIComponent(found.config.org)}`);
  const board = (await res.json()) as { agents: unknown[]; tasks: unknown[] };
  console.log(JSON.stringify(kind === "agents" ? board.agents : board.tasks, null, 2));
}

function cmdInit(): void {
  const org = flag("org") ?? "acme";
  const project = flag("project") ?? path.basename(process.cwd());
  const file = writeConfig({ org, project });
  console.log(`Wrote ${file}  (org: ${org}, project: ${project})`);
}

async function cmdOnboard(objective: string): Promise<void> {
  let found = findConfig();
  if (!found) {
    cmdInit();
    found = findConfig();
  }
  const { org, project } = found!.config;
  await ensureServer();

  // reuse-or-create
  if (!hasFlag("new") && !flag("reuse")) {
    const res = await fetch(
      `${baseUrl()}/api/reuse?org=${encodeURIComponent(org)}&objective=${encodeURIComponent(objective)}`,
    );
    const candidates = (await res.json()) as { agent: { id: string; name: string }; score: number }[];
    if (candidates.length > 0) {
      console.log("An existing agent may already fit this objective:");
      for (const c of candidates.slice(0, 5)) {
        console.log(`  • ${c.agent.name}  (id: ${c.agent.id}, overlap: ${c.score})`);
      }
      console.log("\nRe-run with `--reuse <id>` to reuse one, or `--new` to create a fresh agent.");
      return;
    }
  }

  const sessionReq: Record<string, unknown> = { org, project, objective, client: flag("client") };
  if (flag("reuse")) sessionReq.reuseAgentId = flag("reuse");
  if (flag("role")) sessionReq.role = flag("role");
  if (flag("tags")) sessionReq.roleTags = flag("tags")!.split(",").map((t) => t.trim());
  if (flag("as")) sessionReq.agentName = flag("as");

  const res = await fetch(`${baseUrl()}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sessionReq),
  });
  if (!res.ok) {
    console.error("session failed:", await res.text());
    process.exit(1);
  }
  const s = (await res.json()) as { token: string; agentName: string; mcpUrl: string };

  console.log(`● Org: ${org} · Project: ${project}`);
  console.log(`▸ Agent: ${s.agentName}`);
  console.log(`▸ Session started · token issued\n`);
  console.log("Wire your MCP client to Lanchu (Claude Code example):");
  console.log(
    `  claude mcp add lanchu --transport http ${s.mcpUrl} \\\n    --header "Authorization: Bearer ${s.token}"\n`,
  );
  console.log("Then start your agent; it will read its objective/role/tasks from lanchu://me.");
  console.log(`Panel: ${baseUrl()}`);
}

async function orgOf(): Promise<string> {
  const found = findConfig();
  if (!found) {
    console.log("no .lanchu/config.json here — run `lanchu init` first");
    process.exit(1);
  }
  await ensureServer();
  return found.config.org;
}

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function cmdRoles(): Promise<void> {
  const org = await orgOf();
  const res = await fetch(`${baseUrl()}/api/roles?org=${encodeURIComponent(org)}`);
  console.log(JSON.stringify(await res.json(), null, 2));
}

async function cmdStats(): Promise<void> {
  const org = await orgOf();
  const res = await fetch(`${baseUrl()}/api/board?org=${encodeURIComponent(org)}`);
  const b = (await res.json()) as { agents: unknown[]; tasks: { status: string; stale?: boolean }[] };
  const byStatus: Record<string, number> = {};
  for (const t of b.tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  const stale = b.tasks.filter((t) => t.stale).length;
  console.log(`org: ${org}`);
  console.log(`agents: ${b.agents.length}`);
  console.log(`tasks:  ${b.tasks.length}  ${JSON.stringify(byStatus)}`);
  console.log(`stale:  ${stale}`);
}

async function cmdRetire(agentId: string): Promise<void> {
  if (!agentId) return console.log("usage: lanchu retire <agentId>");
  await orgOf();
  const r = (await post("/agent/retire", { agentId })) as {
    retired: boolean;
    blockedBy: { id: string; title: string }[];
  };
  if (r.retired) return console.log(`Retired ${agentId}.`);
  console.log("Blocked — open tasks must be handed off first:");
  for (const t of r.blockedBy) console.log(`  • ${t.id}  ${t.title}`);
  console.log("\nUse `lanchu task reassign <id> <agent>` or `lanchu task release <id>`.");
}

async function cmdTask(sub: string, id: string, toAgent?: string): Promise<void> {
  await orgOf();
  if (sub === "release") {
    if (!id) return console.log("usage: lanchu task release <id>");
    console.log(JSON.stringify(await post("/task/release", { taskId: id }), null, 2));
  } else if (sub === "reassign") {
    if (!id || !toAgent) return console.log("usage: lanchu task reassign <id> <agentId>");
    console.log(JSON.stringify(await post("/task/reassign", { taskId: id, toAgentId: toAgent }), null, 2));
  } else {
    console.log("usage: lanchu task <release|reassign> ...");
  }
}

async function cmdStop(): Promise<void> {
  if (!(await serverUp())) return console.log("server not running");
  await post("/shutdown", {});
  console.log("server stopped");
}

function cmdPanel(): void {
  console.log(`Open the panel in your browser: ${baseUrl()}`);
}

function cmdHelp(): void {
  console.log(`lanchu — control & trust layer for your AI agents

Usage:
  lanchu "<objective>"              onboard/resume an agent for an objective
  lanchu init                       set org/project for this directory
  lanchu serve                      run the local server (foreground)
  lanchu stop                       stop the background server
  lanchu doctor                     environment checks
  lanchu agents | tasks             list agents / tasks (JSON)
  lanchu roles | stats              list roles / local stats
  lanchu retire <agentId>           safe retirement (handoff enforced)
  lanchu task release <id>          supervisor override: release a task
  lanchu task reassign <id> <agent> supervisor override: reassign a task
  lanchu panel                      print the panel URL
  lanchu help | version

Onboard flags:
  --org --project --role --tags a,b --as <name> --reuse <id> --new --client <claude|print>
`);
}

async function main(): Promise<void> {
  const cmd = args[0];
  switch (cmd) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      return cmdHelp();
    case "version":
    case "-v":
    case "--version":
      return void console.log("0.0.1");
    case "serve":
      return cmdServe();
    case "doctor":
      return cmdDoctor();
    case "init":
      return cmdInit();
    case "agents":
    case "ls":
      return cmdBoard("agents");
    case "tasks":
      return cmdBoard("tasks");
    case "roles":
      return cmdRoles();
    case "stats":
      return cmdStats();
    case "stop":
      return cmdStop();
    case "panel":
    case "open":
      return cmdPanel();
    case "retire":
      return cmdRetire(positional()[1] ?? "");
    case "task": {
      const p = positional();
      return cmdTask(p[1] ?? "", p[2] ?? "", p[3]);
    }
    default:
      // Anything else is treated as an objective.
      return cmdOnboard(positional().join(" "));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
