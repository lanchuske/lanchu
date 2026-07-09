#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { baseUrl, dbPath, DEFAULT_PORT, mcpUrl, port, readSettings, stateDir, VERSION, writeSettings } from "../config.js";
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
  await maybeNotify();
}

/** Explicit, user-initiated check against the public npm registry (no user data sent). */
async function latestVersion(): Promise<string | null> {
  try {
    const r = await fetch("https://registry.npmjs.org/lanchu/latest", { signal: AbortSignal.timeout(3000) });
    const j = (await r.json()) as { version?: string };
    return j.version ?? null;
  } catch {
    return null;
  }
}

async function cmdDoctor(): Promise<void> {
  const node = process.versions.node;
  const [major, minor] = node.split(".").map(Number) as [number, number];
  const nodeOk = major > 22 || (major === 22 && minor >= 5);
  const latest = await latestVersion();
  console.log(`version     ${VERSION}${latest ? (latest === VERSION ? "  (latest)" : "  (latest: " + latest + ")") : ""}`);
  console.log(`node        ${node}   ${nodeOk ? "OK" : "needs >= 22.5.0"}`);
  console.log(`state dir   ${stateDir()}`);
  console.log(`db          ${dbPath()}`);
  console.log(`port        ${port()}${port() === DEFAULT_PORT ? " (default)" : ""}`);
  console.log(`server      ${(await serverUp()) ? "running" : "stopped"}`);
}

async function cmdUpgrade(): Promise<void> {
  const latest = await latestVersion();
  if (!latest) return console.log("Could not reach the npm registry. Try: npm i -g lanchu@latest");
  if (latest === VERSION) return console.log(`You're on the latest version (${VERSION}).`);
  console.log(`A new version is available: ${latest} (you have ${VERSION}).`);
  console.log("Update:  npm i -g lanchu@latest   ·   or just run  npx lanchu@latest");
}

function cmdNotify(): void {
  const sub = positional()[1];
  const s = readSettings();
  if (sub === "on" || sub === "off") {
    s.notifyUpdates = sub === "on";
    writeSettings(s);
    console.log(`Update notifications: ${sub}`);
  } else {
    console.log(`Update notifications: ${s.notifyUpdates ? "on" : "off (default)"}`);
    console.log("Toggle with: lanchu notify on | off  (opt-in; only checks the public npm registry)");
  }
}

/** Opt-in, best-effort update check (off by default). Only reads the public registry. */
async function maybeNotify(): Promise<void> {
  if (!readSettings().notifyUpdates) return;
  const latest = await latestVersion();
  if (latest && latest !== VERSION) console.log(`(update available: ${latest} — run 'lanchu upgrade')`);
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

async function cmdRolesAdd(): Promise<void> {
  const name = positional()[2];
  if (!name) return console.log("usage: lanchu roles add <name> --tags a,b | --wildcard");
  const org = await orgOf();
  const t = flag("tags");
  const tags = t ? t.split(",").map((x) => x.trim()).filter(Boolean) : [];
  const r = await post("/api/roles", { org, name, wildcard: hasFlag("wildcard"), tags });
  console.log("role:", JSON.stringify(r));
}

async function cmdWebhooks(): Promise<void> {
  const org = await orgOf();
  const sub = positional()[1];
  if (sub === "add") {
    const target = positional()[2];
    if (!target) return console.log("usage: lanchu webhooks add <url> --events a,b [--secret s]");
    const evs = flag("events");
    const events = evs ? evs.split(",").map((x) => x.trim()).filter(Boolean) : ["*"];
    console.log(JSON.stringify(await post("/api/webhooks", { org, url: target, events, secret: flag("secret") })));
  } else if (sub === "rm" || sub === "remove") {
    const id = positional()[2];
    if (!id) return console.log("usage: lanchu webhooks rm <id>");
    await post("/api/webhooks/delete", { id });
    console.log("removed", id);
  } else {
    const res = await fetch(`${baseUrl()}/api/webhooks?org=${encodeURIComponent(org)}`);
    console.log(JSON.stringify(await res.json(), null, 2));
  }
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

function openBrowser(url: string): boolean {
  const [cmd, cmdArgs] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd as string, cmdArgs as string[], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function cmdPanel(): Promise<void> {
  await ensureServer();
  const url = baseUrl();
  if (openBrowser(url)) console.log(`Opening the panel: ${url}`);
  else console.log(`Open the panel in your browser: ${url}`);
}

// ── interactive onboarding wizard ────────────────────────────
const claudeCmd = process.platform === "win32" ? "claude.cmd" : "claude";
function hasClaude(): boolean {
  try {
    return spawnSync(claudeCmd, ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

async function pick(
  rl: readline.Interface,
  label: string,
  choices: string[],
  defaultIndex = 0,
): Promise<number> {
  console.log(`\n${label}`);
  choices.forEach((c, i) => console.log(`  ${i + 1}) ${c}${i === defaultIndex ? "  (default)" : ""}`));
  const ans = (await rl.question(`Choose [1-${choices.length}]: `)).trim();
  if (!ans) return defaultIndex;
  const n = Number.parseInt(ans, 10);
  return Number.isInteger(n) && n >= 1 && n <= choices.length ? n - 1 : defaultIndex;
}

async function cmdWork(prefillObjective: string): Promise<void> {
  if (!process.stdin.isTTY) return cmdOnboard(prefillObjective); // non-interactive fallback
  await ensureServer();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("Lanchu — let's get you set up.");
    await maybeNotify();

    // 1) org / project
    let found = findConfig();
    let org: string;
    let project: string;
    if (found) {
      org = found.config.org;
      project = found.config.project;
      console.log(`\nOrg: ${org} · Project: ${project}  (from .lanchu/config.json)`);
    } else {
      org = (await rl.question(`\nOrganization [acme]: `)).trim() || "acme";
      project = (await rl.question(`Project [${path.basename(process.cwd())}]: `)).trim() || path.basename(process.cwd());
      writeConfig({ org, project });
      console.log(`Wrote .lanchu/config.json`);
    }

    // 2) objective
    let objective = prefillObjective.trim();
    while (!objective) objective = (await rl.question(`\nWhat do you want to work on? `)).trim();

    // 3) reuse-or-create
    const cands = (await (
      await fetch(`${baseUrl()}/api/reuse?org=${encodeURIComponent(org)}&objective=${encodeURIComponent(objective)}`)
    ).json()) as { agent: { id: string; name: string }; score: number }[];

    const sessionReq: Record<string, unknown> = { org, project, objective, client: "claude" };
    if (cands.length > 0) {
      const choices = [...cands.map((c) => `reuse "${c.agent.name}" (idle, overlap ${c.score})`), "create a new agent"];
      const idx = await pick(rl, "An existing agent may fit this:", choices, choices.length - 1);
      if (idx < cands.length) sessionReq.reuseAgentId = cands[idx]!.agent.id;
    }

    // 4) role (only when creating)
    if (!sessionReq.reuseAgentId) {
      const roles = (await (await fetch(`${baseUrl()}/api/roles?org=${encodeURIComponent(org)}`)).json()) as {
        name: string;
        is_wildcard: boolean;
        allowed_tags: string[];
      }[];
      const choices = [
        ...roles.map((r) => `${r.name}  [${r.is_wildcard ? "*" : r.allowed_tags.join(", ")}]`),
        "create a new role",
      ];
      const idx = await pick(rl, "Role for this agent:", choices, 0);
      if (idx < roles.length) {
        sessionReq.role = roles[idx]!.name;
      } else {
        const name = (await rl.question(`New role name: `)).trim() || "general";
        const tags = (await rl.question(`Allowed tags (comma-separated, empty = wildcard): `)).trim();
        sessionReq.role = name;
        if (tags) sessionReq.roleTags = tags.split(",").map((t) => t.trim()).filter(Boolean);
        else sessionReq.wildcard = true;
      }
    }

    // 5) register
    const s = (await (
      await fetch(`${baseUrl()}/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sessionReq),
      })
    ).json()) as { token: string; agentName: string; mcpUrl: string };
    console.log(`\n✓ Agent "${s.agentName}" ready · session token issued`);

    // 6) wire the MCP client
    let launchHint = `claude mcp add lanchu --transport http ${s.mcpUrl} --header "Authorization: Bearer ${s.token}"`;
    if (hasClaude()) {
      spawnSync(claudeCmd, ["mcp", "remove", "lanchu"], { encoding: "utf8" }); // ignore if absent
      const add = spawnSync(
        claudeCmd,
        ["mcp", "add", "lanchu", "--transport", "http", s.mcpUrl, "--header", `Authorization: Bearer ${s.token}`],
        { encoding: "utf8" },
      );
      console.log(add.status === 0 ? `✓ Wired Claude Code to Lanchu` : `! Could not auto-wire; run:\n  ${launchHint}`);
    } else {
      console.log(`! 'claude' not found. Wire your MCP client manually:\n  ${launchHint}`);
    }

    // 7) final confirmation
    const go = (await rl.question(`\nLaunch Claude now? [Y/n] `)).trim().toLowerCase();
    if (go === "" || go === "y" || go === "yes") {
      rl.close();
      const instruction =
        "You are connected to Lanchu. Read the lanchu://me resource for your objective, role and tasks, " +
        "then claim (task_claim) and work the tasks in your scope, reporting progress with task_update.";
      spawn(claudeCmd, [instruction], { stdio: "inherit" });
    } else {
      const op = (await rl.question(`Open the supervisor panel instead? [Y/n] `)).trim().toLowerCase();
      rl.close();
      if (op === "" || op === "y" || op === "yes") {
        openBrowser(baseUrl());
        console.log(`Opening the panel: ${baseUrl()}`);
      } else {
        console.log(`\nWhen ready:  claude\nPanel:       ${baseUrl()}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/readline was closed|abort/i.test(msg)) {
      console.log("\nOnboarding cancelled.");
      return;
    }
    throw err;
  } finally {
    rl.close(); // idempotent
  }
}

function cmdHelp(): void {
  console.log(`lanchu — control & trust layer for your AI agents

Usage:
  lanchu                            guided onboarding wizard (org, agent, role) + launch Claude
  lanchu work ["<objective>"]       same wizard, optionally pre-filling the objective
  lanchu "<objective>" --role r     non-interactive onboard (for scripting)
  lanchu init                       set org/project for this directory
  lanchu serve                      run the local server (foreground)
  lanchu stop                       stop the background server
  lanchu doctor                     environment checks
  lanchu agents | tasks             list agents / tasks (JSON)
  lanchu roles | stats              list roles / local stats
  lanchu roles add <name> --tags a,b   create a role (or --wildcard)
  lanchu retire <agentId>           safe retirement (handoff enforced)
  lanchu task release <id>          supervisor override: release a task
  lanchu task reassign <id> <agent> supervisor override: reassign a task
  lanchu webhooks [add <url> --events a,b | rm <id>]   outbound webhooks (HMAC-signed)
  lanchu panel                      open the panel in your browser
  lanchu upgrade                    check npm for a newer version
  lanchu notify on|off              opt-in update notifications (off by default)
  lanchu help | version

Onboard flags:
  --org --project --role --tags a,b --as <name> --reuse <id> --new --client <claude|print>
`);
}

function hasOnboardFlags(): boolean {
  return !!(flag("role") || flag("reuse") || hasFlag("new") || flag("tags") || flag("as"));
}

async function main(): Promise<void> {
  const cmd = args[0];
  switch (cmd) {
    case undefined:
      return process.stdin.isTTY ? cmdWork("") : cmdHelp();
    case "work":
      return cmdWork(positional().slice(1).join(" "));
    case "help":
    case "-h":
    case "--help":
      return cmdHelp();
    case "version":
    case "-v":
    case "--version":
      return void console.log(VERSION);
    case "upgrade":
      return cmdUpgrade();
    case "notify":
      return cmdNotify();
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
      return positional()[1] === "add" ? cmdRolesAdd() : cmdRoles();
    case "webhooks":
      return cmdWebhooks();
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
    default: {
      // Anything else is treated as an objective. Guided wizard unless flags/non-TTY.
      const obj = positional().join(" ");
      return hasOnboardFlags() || !process.stdin.isTTY ? cmdOnboard(obj) : cmdWork(obj);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
