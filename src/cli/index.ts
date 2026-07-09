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

function cmdHelp(): void {
  console.log(`lanchu — control & trust layer for your AI agents

Usage:
  lanchu "<objective>"          onboard/resume an agent for an objective
  lanchu init                   set org/project for this directory
  lanchu serve                  run the local server (foreground)
  lanchu doctor                 environment checks
  lanchu agents | tasks         list agents / tasks (JSON)
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
      return cmdBoard("agents");
    case "tasks":
      return cmdBoard("tasks");
    default:
      // Anything else is treated as an objective.
      return cmdOnboard(positional().join(" "));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
