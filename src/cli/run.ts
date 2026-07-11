import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  accessKey,
  baseUrl,
  dbPath,
  DEFAULT_PORT,
  host,
  localBaseUrl,
  mcpUrl,
  port,
  publicUrl,
  readSettings,
  remoteServer,
  stateDir,
  VERSION,
  writeSettings,
} from "../config.js";
import { agentColor, ansiColorize } from "../core/colors.js";
import { gitInfo } from "../core/git.js";
import { detectRuntimes } from "../core/runtimes.js";
import { spawnTerminal, tileTerminals } from "../server/cockpit.js";
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
/** Flags that take no value; without this list positional() would swallow the token after them. */
const BOOL_FLAGS = new Set(["new", "wildcard", "dry", "uninstall", "purge", "no-isolate", "no-wildcard", "no-quota", "no-model", "force"]);
function positional(): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      if (!BOOL_FLAGS.has(a.slice(2))) i++; // skip its value
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
/** Attach the shared access key (when configured) to backend requests. */
function authHeaders(base?: Record<string, string>): Record<string, string> {
  const key = accessKey();
  const h: Record<string, string> = { ...(base ?? {}) };
  if (key) h.authorization = `Bearer ${key}`;
  return h;
}
/** fetch() against the backend (local or LANCHU_SERVER) with auth headers attached. */
async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: authHeaders(init.headers as Record<string, string> | undefined),
  });
  // Surface the shared-key gate plainly instead of letting callers mis-render a 401 body.
  if (res.status === 401) {
    throw new Error(
      accessKey()
        ? "access denied by the Lanchu server — the LANCHU_ACCESS_KEY does not match."
        : "this Lanchu server requires an access key — set LANCHU_ACCESS_KEY.",
    );
  }
  return res;
}

async function serverUp(): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl()}/health`, { signal: AbortSignal.timeout(remoteServer() ? 3000 : 500) });
    return res.ok;
  } catch {
    return false;
  }
}
async function ensureServer(): Promise<void> {
  if (await serverUp()) return;
  // A remote backend is not ours to start — point the user at it instead of
  // silently spawning a local server that would answer a different DB.
  if (remoteServer()) {
    throw new Error(`could not reach the Lanchu server at ${remoteServer()} (LANCHU_SERVER). Is it running and reachable?`);
  }
  // Spawn the bin (index.js), not this module: run.js only exports run() and does
  // nothing when executed directly, so we launch its sibling bootstrap entrypoint.
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
  const child = spawn(process.execPath, [bin, "serve"], {
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
  const local = localBaseUrl();
  const exposed = host() !== "127.0.0.1";
  console.log(`Lanchu server listening on http://${host()}:${port()}`);
  console.log(`  panel: ${local}`);
  console.log(`  mcp:   ${publicUrl() ? publicUrl() + "/mcp" : local + "/mcp"}`);
  console.log(`  db:    ${dbPath()}`);
  console.log(`  auth:  ${accessKey() ? "access key required (LANCHU_ACCESS_KEY)" : "open (loopback)"}`);
  if (exposed && !accessKey()) {
    console.log(`  ⚠ exposed on ${host()} without LANCHU_ACCESS_KEY — anyone who can reach this port has full access.`);
  }
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
  const remote = remoteServer();
  console.log(`backend     ${remote ? remote + "  (remote, LANCHU_SERVER)" : "local (" + localBaseUrl() + ")"}`);
  if (!remote) console.log(`bind host   ${host()}${host() === "127.0.0.1" ? " (loopback)" : " (exposed)"}`);
  console.log(`auth        ${accessKey() ? "access key set (LANCHU_ACCESS_KEY)" : "none"}`);
  console.log(`on PATH     ${lanchuOnPath() ? "yes" : "no — run: lanchu install-commands  (or npm i -g lanchu)"}`);
  console.log(`server      ${(await serverUp()) ? "running" : "stopped"}`);
  // Wake v5.1: wakes are push-based (asyncRewake hook + park & refire) — no
  // typing transports exist. tmux remains the preferred substrate for tiling,
  // focus-free spawning and lock-screen resilience.
  const tmuxOk = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
  console.log(`tmux        ${tmuxOk ? "found (preferred terminal substrate)" : "not found — install it (brew install tmux) for tiled, focus-free agent terminals"}`);
  // Runtime inventory: which agent CLIs this machine could spawn (fresh probe).
  const runtimes = detectRuntimes({ refresh: true });
  console.log(`runtimes    ${runtimes.length ? "" : "none of the known agent CLIs found on PATH"}`);
  for (const r of runtimes) {
    console.log(`  ${r.cmd.padEnd(14)} ${(r.version ?? "version unknown").padEnd(28)} ${r.path}`);
  }
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
  // Availability view: installed runtimes + idle teammates a coordinator can reuse.
  if (kind === "agents" && hasFlag("available")) {
    const res = await api(`/api/available?org=${encodeURIComponent(found.config.org)}`);
    console.log(JSON.stringify(await res.json(), null, 2));
    return;
  }
  const res = await api(`/api/board?org=${encodeURIComponent(found.config.org)}`);
  const board = (await res.json()) as { agents: unknown[]; tasks: unknown[] };
  console.log(JSON.stringify(kind === "agents" ? board.agents : board.tasks, null, 2));
}

/**
 * The project name this checkout implies: the repo root's folder name, then
 * the origin remote's repo name, then the bare folder name. A project IS a
 * repo + folder — deriving the default here is what keeps records bound to
 * something real (see the panel-philosophy design doc).
 */
function projectNameFromCheckout(cwd = process.cwd()): string {
  const g = gitInfo(cwd);
  if (g.worktree) return path.basename(g.worktree);
  const fromRemote = g.repoUrl?.split("/").pop();
  return fromRemote || path.basename(cwd);
}

/** Name↔folder drift checks shared by `lanchu init` and the wizard. */
function provisioningWarnings(org: string, project: string, cwd = process.cwd()): string[] {
  const warnings: string[] = [];
  const bound = findConfig(cwd);
  if (bound && bound.config.org !== org) {
    warnings.push(
      `this directory is already bound to org '${bound.config.org}' (${bound.file}) — you chose '${org}'.`,
    );
  }
  if (bound && bound.config.project !== project) {
    warnings.push(
      `this directory is already bound to project '${bound.config.project}' (${bound.file}) — you chose '${project}'.`,
    );
  }
  const expected = projectNameFromCheckout(cwd);
  if (project !== expected) {
    warnings.push(
      `project name '${project}' does not match this checkout ('${expected}'). ` +
        "A project is a repo + folder; a name that drifts from its folder is how phantom records happen.",
    );
  }
  return warnings;
}

function cmdInit(): void {
  const org = flag("org");
  // No silent default org: the phantom 'acme' org existed because init
  // invented one. Provisioning must name the org explicitly.
  if (!org) {
    const bound = findConfig();
    if (bound) {
      return console.log(
        `This directory is already bound to org '${bound.config.org}' · project '${bound.config.project}' (${bound.file}).\n` +
          "To rebind, run: lanchu init --org <name> [--project <name>] [--force]",
      );
    }
    return console.log(
      `usage: lanchu init --org <name> [--project <name>]   (project defaults to '${projectNameFromCheckout()}' from this checkout)`,
    );
  }
  const project = flag("project") ?? projectNameFromCheckout();
  const existingHere = fs.existsSync(path.join(process.cwd(), ".lanchu", "config.json"));
  const warnings = provisioningWarnings(org, project);
  for (const w of warnings) console.log(`⚠ ${w}`);
  // Overwriting THIS directory's binding with different names is a rebind —
  // make it deliberate. (Warnings about a parent binding or a name↔folder
  // mismatch inform but don't block.)
  const rebinding = warnings.some((w) => w.includes("already bound")) && existingHere;
  if (rebinding && !hasFlag("force")) {
    return console.log("Refusing to rebind this directory. Re-run with --force if you mean it.");
  }
  const file = writeConfig({ org, project });
  console.log(`Wrote ${file}  (org: ${org}, project: ${project})`);
}

async function cmdOnboard(objective: string): Promise<void> {
  let found = findConfig();
  if (!found) {
    cmdInit();
    found = findConfig();
    // init refuses to invent an org — its message already says what to run.
    if (!found) return;
  }
  const { org, project } = found.config;
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

  const sessionReq: Record<string, unknown> = { org, project, objective, client: flag("client"), cwd: process.cwd() };
  if (flag("reuse")) sessionReq.reuseAgentId = flag("reuse");
  if (flag("role")) sessionReq.role = flag("role");
  if (flag("tags")) sessionReq.roleTags = flag("tags")!.split(",").map((t) => t.trim());
  if (flag("as")) sessionReq.agentName = flag("as");

  const res = await api(`/session`, {
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
  const res = await api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function cmdOrgs(): Promise<void> {
  const sub = positional()[1];
  if (sub === "rm" || sub === "delete") {
    const name = positional()[2];
    if (!name) return console.log("usage: lanchu orgs rm <name>");
    await ensureServer();
    const r = (await post("/org/delete", { name })) as { deleted: boolean };
    return console.log(
      r.deleted
        ? `Deleted org '${name}' and all its projects, agents and tasks.`
        : `No org named '${name}'.`,
    );
  }
  await ensureServer();
  const orgs = (await (await api(`/api/orgs`)).json()) as {
    name: string; agents: number; projects: number; tasks: number;
  }[];
  if (!orgs.length) return console.log("No orgs yet. Create one with: lanchu init --org <name> --project <name>");
  const cur = findConfig()?.config.org;
  console.log("Orgs (● = this directory):");
  for (const o of orgs) {
    console.log(`  ${o.name === cur ? "●" : " "} ${o.name.padEnd(20)} ${o.agents} agents · ${o.projects} projects · ${o.tasks} tasks`);
  }
}

async function cmdProjects(): Promise<void> {
  const org = await orgOf();
  const b = (await (await api(`/api/board?org=${encodeURIComponent(org)}`)).json()) as {
    projects: { name: string; repo_url: string | null; local_path: string | null }[];
  };
  if (!b.projects.length) return console.log(`Org '${org}' has no projects yet.`);
  console.log(`Org '${org}' — ${b.projects.length} project(s) (each is a repo + local folder):`);
  for (const p of b.projects) {
    console.log(`  ${p.name}`);
    if (p.repo_url) console.log(`      repo  ${p.repo_url}`);
    if (p.local_path) console.log(`      path  ${p.local_path}`);
  }
}

async function cmdRoles(): Promise<void> {
  const org = await orgOf();
  const res = await api(`/api/roles?org=${encodeURIComponent(org)}`);
  console.log(JSON.stringify(await res.json(), null, 2));
}

async function cmdRolesAdd(): Promise<void> {
  const name = positional()[2];
  if (!name) return console.log("usage: lanchu roles add <name> --tags a,b | --wildcard");
  const org = await orgOf();
  const t = flag("tags");
  const tags = t ? t.split(",").map((x) => x.trim()).filter(Boolean) : [];
  const r = await post("/api/roles", { org, name, wildcard: hasFlag("wildcard"), tags, preferredModel: flag("model") });
  console.log("role:", JSON.stringify(r));
}

async function cmdRolesEdit(): Promise<void> {
  const name = positional()[2];
  const csv = (v: string | undefined): string[] | undefined =>
    v === undefined ? undefined : v.split(",").map((x) => x.trim()).filter(Boolean);
  const body: Record<string, unknown> = {
    org: await orgOf(),
    name,
    addTags: csv(flag("add-tags")),
    rmTags: csv(flag("rm-tags")),
    tags: csv(flag("tags")),
  };
  if (hasFlag("wildcard")) body.wildcard = true;
  if (hasFlag("no-wildcard")) body.wildcard = false;
  const quotaFlag = flag("quota");
  if (quotaFlag !== undefined) {
    const q = Number(quotaFlag);
    if (!Number.isFinite(q) || q < 0) return console.log("error: --quota must be a non-negative number");
    body.quota = q;
  }
  if (hasFlag("no-quota")) body.quota = null;
  const modelFlag = flag("model");
  if (modelFlag !== undefined) body.preferredModel = modelFlag;
  if (hasFlag("no-model")) body.preferredModel = null;
  const hasChange =
    body.addTags || body.rmTags || body.tags || body.wildcard !== undefined ||
    body.quota !== undefined || body.preferredModel !== undefined;
  if (!name || !hasChange) {
    return console.log(
      "usage: lanchu roles edit <name> --add-tags a,b --rm-tags c | --tags x,y | --wildcard | --no-wildcard | --quota <tokens> | --no-quota | --model <opus|sonnet|haiku> | --no-model",
    );
  }
  const res = await api("/api/roles", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const r = (await res.json()) as { error?: string };
  if (!res.ok) return console.log(`error: ${r.error ?? res.statusText}`);
  console.log("role:", JSON.stringify(r));
}

async function cmdRules(): Promise<void> {
  const org = await orgOf();
  if (positional()[1] === "set") {
    const text = positional()[2] ?? "";
    await post("/api/org/rules", { org, rules: text });
    console.log("org rules updated");
  } else {
    const r = (await (await api(`/api/org/rules?org=${encodeURIComponent(org)}`)).json()) as { rules: string };
    console.log(r.rules || "(no rules set — add with: lanchu rules set \"<text>\")");
  }
}

/** Kill every open session token in the org (after an exposure); agents re-register for fresh ones. */
async function cmdRotateTokens(): Promise<void> {
  const org = await orgOf();
  const r = (await post("/tokens/rotate", { org })) as { agents: number; sessions: number };
  console.log(`rotated: ended ${r.sessions} open session(s) across ${r.agents} agent(s) in '${org}'`);
  console.log("agents re-register through the launcher on their next connect (lanchu spawn / panel reveal).");
}

/** Coordinator lease: show the holder, or supervisor-override it (set/clear). */
async function cmdCoordinator(): Promise<void> {
  const org = await orgOf();
  const sub = positional()[1];
  if (sub === "set") {
    const name = positional()[2];
    if (!name) return console.log("usage: lanchu coordinator set <agent>");
    const r = (await post("/coordinator", { org, set: name })) as { error?: string; coordinator?: { agent_name: string } };
    return console.log(r.error ?? `coordinator lease granted to '${r.coordinator?.agent_name}' (supervisor override)`);
  }
  if (sub === "clear") {
    const r = (await post("/coordinator", { org, clear: true })) as { error?: string };
    return console.log(r.error ?? "coordinator lease cleared");
  }
  const c = (await (await api(`/api/coordinator?org=${encodeURIComponent(org)}`)).json()) as {
    agent_name?: string; acquired_at?: string; expired?: boolean; live?: boolean;
  };
  if (!c?.agent_name) return console.log("no coordinator — the lease is free (agents take it with coordinator_acquire)");
  console.log(
    `coordinator: ${c.agent_name}${c.expired ? " (lease EXPIRED)" : c.live ? "" : " (idle)"} · since ${c.acquired_at}`,
  );
}

async function cmdSkills(): Promise<void> {
  const org = await orgOf();
  const sub = positional()[1];
  const tagsFlag = (): string[] => {
    const t = flag("tags");
    return t ? t.split(",").map((x) => x.trim()).filter(Boolean) : [];
  };
  if (sub === "add") {
    const name = positional()[2];
    if (!name) return console.log('usage: lanchu skills add <name> --tags a,b --instructions "..."');
    console.log(JSON.stringify(await post("/api/skills", { org, name, tags: tagsFlag(), instructions: flag("instructions"), skillUrl: flag("url") })));
  } else if (sub === "load") {
    // Load a reusable skill from a SKILL.md URL or local file; frontmatter supplies
    // the name/tags unless overridden with --name / --tags.
    const source = positional()[2];
    if (!source) return console.log("usage: lanchu skills load <url|file> [--name n] [--tags a,b]");
    const tags = tagsFlag();
    console.log(JSON.stringify(await post("/api/skills", { org, name: flag("name"), tags: tags.length ? tags : undefined, skillUrl: source })));
  } else if (sub === "reload") {
    const id = positional()[2];
    if (!id) return console.log("usage: lanchu skills reload <id>");
    console.log(JSON.stringify(await post("/api/skills/reload", { id })));
  } else if (sub === "rm" || sub === "remove") {
    const id = positional()[2];
    if (!id) return console.log("usage: lanchu skills rm <id>");
    await post("/api/skills/delete", { id });
    console.log("removed", id);
  } else {
    const res = await api(`/api/skills?org=${encodeURIComponent(org)}`);
    console.log(JSON.stringify(await res.json(), null, 2));
  }
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
    const res = await api(`/api/webhooks?org=${encodeURIComponent(org)}`);
    console.log(JSON.stringify(await res.json(), null, 2));
  }
}

async function cmdRecurring(): Promise<void> {
  const found = findConfig();
  if (!found) return console.log("no .lanchu/config.json here — run `lanchu init` first");
  await ensureServer();
  const { org, project } = found.config;
  const sub = positional()[1];
  if (sub === "add") {
    const title = positional()[2];
    const every = Number(flag("every"));
    if (!title || !every) {
      return console.log('usage: lanchu recurring add "<title>" --every <minutes> [--tags a,b] [--project p]');
    }
    const t = flag("tags");
    const tags = t ? t.split(",").map((x) => x.trim()).filter(Boolean) : [];
    console.log(JSON.stringify(await post("/api/recurring", { org, project: flag("project") ?? project, title, everyMinutes: every, tags })));
  } else if (sub === "rm" || sub === "remove") {
    const id = positional()[2];
    if (!id) return console.log("usage: lanchu recurring rm <id>");
    await post("/api/recurring/delete", { id });
    console.log("removed", id);
  } else {
    const res = await api(`/api/recurring?org=${encodeURIComponent(org)}`);
    console.log(JSON.stringify(await res.json(), null, 2));
  }
}

async function cmdStats(): Promise<void> {
  const org = await orgOf();
  const res = await api(`/api/board?org=${encodeURIComponent(org)}`);
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
  if (!agentId) return console.log("usage: lanchu retire <agentId> [--force]");
  await orgOf();
  const r = (await post("/agent/retire", { agentId, force: hasFlag("force") })) as {
    retired: boolean;
    requested?: boolean;
    coordinator?: string;
    blockedBy: { id: string; title: string }[];
  };
  if (r.retired) return console.log(`Retired ${agentId}.`);
  if (r.requested) {
    console.log(
      `A coordinator lease is active — retirement filed as a REQUEST for '${r.coordinator}' to resolve.`,
    );
    console.log("If you are the human supervisor and mean it, re-run with --force.");
    return;
  }
  console.log("Blocked — open tasks must be handed off first:");
  for (const t of r.blockedBy) console.log(`  • ${t.id}  ${t.title}`);
  console.log("\nUse `lanchu task reassign <id> <agent>` or `lanchu task release <id>`.");
}

async function cmdTask(sub: string, id: string, extra?: string[]): Promise<void> {
  await orgOf();
  if (sub === "release") {
    if (!id) return console.log("usage: lanchu task release <id>");
    console.log(JSON.stringify(await post("/task/release", { taskId: id }), null, 2));
  } else if (sub === "reassign") {
    const toAgent = extra?.[0];
    if (!id || !toAgent) return console.log("usage: lanchu task reassign <id> <agentId>");
    console.log(JSON.stringify(await post("/task/reassign", { taskId: id, toAgentId: toAgent }), null, 2));
  } else if (sub === "archive") {
    if (!id) return console.log("usage: lanchu task archive <id> [reason…]");
    const reason = extra?.length ? extra.join(" ") : undefined;
    console.log(JSON.stringify(await post("/task/archive", { taskId: id, reason }), null, 2));
  } else if (sub === "supersede") {
    const newId = extra?.[0];
    if (!id || !newId) return console.log("usage: lanchu task supersede <oldId> <newId> [note…]");
    const note = extra && extra.length > 1 ? extra.slice(1).join(" ") : undefined;
    console.log(JSON.stringify(await post("/task/supersede", { oldTaskId: id, newTaskId: newId, note }), null, 2));
  } else {
    console.log("usage: lanchu task <release|reassign|archive|supersede> ...");
  }
}

async function cmdStop(): Promise<void> {
  if (!(await serverUp())) return console.log("server not running");
  await post("/shutdown", {});
  console.log("server stopped");
}

/** Shell completion: print a script, list dynamic values (hidden), or install. */
async function cmdCompletion(): Promise<void> {
  const { completionValues, detectShell, installCompletion, scriptFor } = await import("./completion.js");
  const sub = positional()[1];
  if (sub === "values") {
    // Hidden hook the generated scripts call; silent and fast by design.
    const values = await completionValues(positional()[2] as never);
    if (values.length) console.log(values.join("\n"));
    return;
  }
  if (sub === "install") {
    const forced = flag("shell") as "bash" | "zsh" | "fish" | undefined;
    const r = installCompletion(forced);
    console.log(r.installed ? `✓ completion wired for ${r.shell} → ${r.file}` : `already installed for ${r.shell} (${r.file})`);
    console.log(r.shell === "fish" ? r.ghostHint : `restart your shell (or: source ${r.file}) to activate Tab completion.`);
    if (r.shell !== "fish") console.log(r.ghostHint);
    return;
  }
  const shell = sub ?? detectShell();
  const script = shell ? scriptFor(shell) : null;
  if (!script) {
    return console.log("usage: lanchu completion [bash|zsh|fish]   ·   lanchu completion install [--shell bash|zsh|fish]");
  }
  process.stdout.write(script);
}

/**
 * Restart the server. --greenzone opens a coordinated maintenance window first:
 * live agents are noticed to reach a safe point and confirm (greenzone_ack);
 * the restart runs when everyone confirms or at the timeout (default 120s).
 */
async function cmdRestart(): Promise<void> {
  if (!(await serverUp())) return console.log("server not running — start it with: lanchu serve");
  if (!hasFlag("greenzone")) {
    await post("/server/restart", {});
    console.log("server restarting…");
    return;
  }
  const org = await orgOf();
  const timeoutSeconds = flag("timeout") ? Number.parseInt(flag("timeout")!, 10) : undefined;
  const status = (await post("/greenzone/request", { org, action: "restart", timeoutSeconds })) as {
    error?: string; state: string; required: { name: string; confirmed_at: string | null }[]; confirmed?: number;
  };
  if (status.error) return console.log(status.error);
  if (status.state === "done") return console.log("no live agents — restarting now");
  console.log(`greenzone requested: waiting for ${status.required.length} live agent(s) to confirm (greenzone_ack)…`);
  // Poll until it executes; the poll erroring means the restart happened.
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const gz = (await (await api(`/api/greenzone?org=${encodeURIComponent(org)}`)).json()) as typeof status;
      if (gz.state === "done") {
        console.log(`greenzone complete (${gz.confirmed}/${gz.required.length} confirmed) — restarting`);
        return;
      }
      console.log(`  ${gz.confirmed}/${gz.required.length} confirmed`);
    } catch {
      console.log("server restarting…");
      return;
    }
  }
}

/**
 * Inspect or abort the org's maintenance window. `lanchu greenzone` prints the
 * current status; `lanchu greenzone cancel` is the supervisor override — the
 * armed op never runs and the recovery path for a stuck window (audited).
 */
async function cmdGreenzone(): Promise<void> {
  if (!(await serverUp())) return console.log("server not running — start it with: lanchu serve");
  const org = await orgOf();
  const sub = positional()[1];
  if (sub === "cancel") {
    const r = (await post("/greenzone/cancel", { org })) as { error?: string; action?: string };
    if (r.error) return console.log(r.error);
    console.log(`greenzone cancelled (${r.action ?? "?"}) — the pending op will not run; agents were noticed.`);
    return;
  }
  const gz = (await (await api(`/api/greenzone?org=${encodeURIComponent(org)}`)).json()) as {
    state: string; action?: string; requested_at?: string; deadline?: string;
    confirmed?: number; required: { name: string; confirmed_at: string | null }[];
  };
  if (gz.state === "idle") return console.log("no greenzone — the org is running normally");
  const age = gz.requested_at ? Math.round((Date.now() - new Date(gz.requested_at).getTime()) / 1000) : 0;
  console.log(`greenzone ${gz.state}: ${gz.action ?? ""} · requested ${age}s ago · ${gz.confirmed ?? 0}/${gz.required.length} confirmed`);
  for (const r of gz.required) console.log(`  ${r.confirmed_at ? "✓" : "…"} ${r.name}`);
  if (gz.state === "requested") console.log("abort with: lanchu greenzone cancel");
}

const SPAWN_PROMPT =
  "You are a new Lanchu teammate. Greet the user in one line, then IMMEDIATELY read org_context (never wait for input first): if your objective or a pending notice names your task, claim it and start working right away, narrating as you go. Only ask the user which task to take when nothing assigns you work. While you work, watch for friction in Lanchu itself and file it with task_create using the taxonomy tags (bug | extension | idea | process) plus area tags and evidence — the help tool has the details.";

async function cmdSpawn(): Promise<void> {
  const found = findConfig();
  if (!found) return console.log("no .lanchu/config.json here — run `lanchu init` first");
  await ensureServer();
  const { org, project } = found.config;
  const role = flag("role");
  const roleName = role ?? "generalist";
  const objective = positional().slice(1).join(" ") || undefined;
  // Honor --as; otherwise default to a tidy role-based name (matches spawn_agent)
  // rather than a long slug of the objective.
  const s = (await post("/session", {
    org, project, objective, cwd: process.cwd(), role: roleName, wildcard: role ? false : true,
    agentName: flag("as") || roleName,
    model: flag("model"),
    isolate: !hasFlag("no-isolate"),
    // Spawn always mints a fresh teammate: keep dedupe-on-collision instead of
    // the /session default of reusing an existing agent by name.
    create: true,
  })) as {
    token: string; agentName: string; agentId: string; worktree: string | null; branch: string | null;
    color?: { hex: string; ansi256: number };
    model?: string | null;
  };
  // Launch inside the agent's isolated worktree (falls back to this dir with --no-isolate
  // or when the directory isn't a git repo).
  const cwd = s.worktree ?? process.cwd();
  const result = spawnTerminal({
    title: `${org}·${s.agentName}`, agentName: s.agentName, cwd, token: s.token, prompt: SPAWN_PROMPT,
    colorHex: s.color?.hex, model: s.model ?? undefined, dry: hasFlag("dry"),
  });
  // Persist the terminal handle so the panel can re-focus this agent later.
  if (!hasFlag("dry") && result.ref) await post("/agent/terminal", { agentId: s.agentId, ref: result.ref });
  console.log(`Agent '${s.agentName}' · [${result.method}] ${result.note}`);
  if (s.worktree) console.log(`  worktree: ${s.worktree}  (branch: ${s.branch})`);
  if (result.method === "print" || hasFlag("dry")) console.log("\nCommand:\n  " + result.command);
}

async function cmdTile(): Promise<void> {
  await ensureServer();
  const r = tileTerminals(hasFlag("dry"));
  console.log(`[${r.method}] ${r.note}`);
  // The "who is where" half of tiling: each agent's worktree, branch and
  // active task. Best-effort — skipped outside a lanchu project.
  const found = findConfig();
  if (!found) return;
  const res = await api(`/api/board?org=${encodeURIComponent(found.config.org)}`);
  const b = (await res.json()) as {
    agents: {
      name: string; state: string; presence?: string; branch: string | null; worktree: string | null;
      active_task_id: string | null; active_task_title: string | null;
      color?: { hex: string; ansi256: number };
    }[];
  };
  if (!b.agents.length) return;
  const home = os.homedir();
  const tilde = (p: string) => (p.startsWith(home) ? "~" + p.slice(home.length) : p);
  const pad = Math.max(...b.agents.map((a) => a.name.length));
  console.log("");
  for (const a of b.agents) {
    // Same hue as the terminal border and panel chip — one identity everywhere.
    // The board carries the de-collided slot; the hash is only the offline fallback.
    // Glyph = the panel's presence tri-state: ● working · ◐ idle · ○ off.
    const glyph = a.presence === "working" ? "●"
      : a.presence === "idle" ? "◐"
      : a.presence === "off" ? "○"
      : a.state === "active" ? "●" : "○"; // pre-v2 server fallback
    const dot = ansiColorize(glyph, a.color ?? agentColor(a.name));
    const where = a.worktree
      ? `${tilde(a.worktree)}  (${a.branch ?? "no branch"})`
      : a.branch
        ? `(${a.branch})`
        : "shared directory";
    console.log(`  ${dot} ${a.name.padEnd(pad)}  ${where}`);
    if (a.active_task_id) {
      const title = a.active_task_title ?? "";
      console.log(`  ${" ".repeat(pad + 2)}  task ${a.active_task_id}: ${title.length > 70 ? title.slice(0, 70) + "…" : title}`);
    }
  }
}

const LANCHU_SLASH_COMMAND = `---
description: Lanchu control — supervisor commands (panel, status, spawn, tile, orgs, projects, agents, tasks…)
argument-hint: [panel | status | spawn "<objective>" | tile | orgs | projects | agents | tasks | doctor | retire <id> | rules | skills]
allowed-tools: Bash(npx lanchu:*), Bash(lanchu:*)
---
The user ran a Lanchu control command. Below is its output — report the result to
the user concisely (these are supervisor actions, not agent work).

!\`npx lanchu $ARGUMENTS\`
`;

/** Is a real `lanchu` executable resolvable on PATH? (npx runs never leave one.) */
function lanchuOnPath(): boolean {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const names = process.platform === "win32" ? ["lanchu.cmd", "lanchu.exe", "lanchu"] : ["lanchu"];
  for (const d of dirs) {
    for (const n of names) {
      try {
        if (fs.existsSync(path.join(d, n))) return true;
      } catch {
        /* unreadable PATH entry — skip */
      }
    }
  }
  return false;
}

/**
 * Make sure `lanchu` is on PATH so the user can run it directly (not only via
 * `npx` or the slash command). Installs it globally when missing. Best-effort:
 * a failed install (e.g. needs sudo) just prints the manual command.
 */
function ensureOnPath(): void {
  if (lanchuOnPath()) return;
  console.log("`lanchu` isn't on your PATH yet — installing it globally so you can run it directly…");
  const r = spawnSync("npm", ["i", "-g", "lanchu"], { stdio: "inherit" });
  if (r.status === 0 && lanchuOnPath()) {
    console.log("✓ `lanchu` is on your PATH. If this shell still can't find it, run `hash -r` or open a new tab.");
  } else {
    console.log("Couldn't auto-install. Add it yourself:  npm i -g lanchu");
  }
}

function cmdInstallCommands(): void {
  const dir = path.join(os.homedir(), ".claude", "commands");
  const file = path.join(dir, "lanchu.md");
  if (hasFlag("uninstall")) {
    fs.rmSync(file, { force: true });
    return console.log(`Removed ${file}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, LANCHU_SLASH_COMMAND);
  console.log(`Installed the /lanchu slash command → ${file}`);
  console.log('In Claude Code:  /lanchu panel  ·  /lanchu status  ·  /lanchu spawn "write the docs"  ·  /lanchu tile');
  ensureOnPath(); // so `lanchu …` works in a plain terminal too, not just `npx`/slash
}

async function cmdUninstall(): Promise<void> {
  if (await serverUp()) {
    await api(`/shutdown`, { method: "POST" }).catch(() => {});
    console.log("Stopped the local server.");
  }
  const dir = stateDir();
  if (hasFlag("purge")) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`Removed all local Lanchu data at ${dir}`);
  } else {
    console.log(`Local Lanchu data lives at:\n  ${dir}`);
    console.log("Delete all orgs/agents/tasks with:  lanchu uninstall --purge");
  }
  console.log("\nAlso, to fully clean up:");
  console.log("  claude mcp remove lanchu     # if you wired an MCP client");
  console.log("  rm -rf .lanchu               # per-project config, in each project");
  console.log("  npm rm -g lanchu             # if you installed it globally (npx needs no removal)");
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

/** One compact line for a Claude Code statusLine. Fast, never auto-starts the server. */
async function statusLine(): Promise<string> {
  const found = findConfig();
  if (!found) return "";
  const { org, project } = found.config;
  // Set at launch (spawn/wizard) so the line can name which teammate owns this
  // terminal — shown in the agent's color (de-collided slot from the board
  // when reachable; name-hash fallback offline).
  const myName = process.env.LANCHU_AGENT;
  const meWith = (color: { ansi256: number }) => (myName ? ` · you: ${ansiColorize(myName, color)}` : "");
  const me = myName ? meWith(agentColor(myName)) : "";
  if (!(await serverUp())) return "lanchu ○ not running";
  try {
    const b = (await (await api(`/api/board?org=${encodeURIComponent(org)}`, {
      signal: AbortSignal.timeout(400),
    })).json()) as {
      agents: { name: string; state: string; presence?: string; color?: { ansi256: number } }[];
      tasks: { status: string }[];
    };
    // "working" is the presence tri-state's truthful count — agents with fresh
    // MCP calls, not everyone merely connected (pre-v2 servers fall back to state).
    const working = b.agents.filter((a) => (a.presence ? a.presence === "working" : a.state === "active")).length;
    const open = b.tasks.filter((t) => ["claimed", "in_progress", "blocked"].includes(t.status)).length;
    const mine = myName ? b.agents.find((a) => a.name === myName)?.color : undefined;
    return `lanchu ● ${org}/${project}${mine ? meWith(mine) : me} · ${working} working · ${open} open`;
  } catch {
    return `lanchu ● running${me}`;
  }
}

async function cmdStatusline(): Promise<void> {
  const line = await statusLine();
  if (process.stdin.isTTY) {
    // A person ran it: preview + how to wire it into Claude Code.
    console.log(`Preview:  ${line || "(no .lanchu/config.json in this directory)"}\n`);
    console.log("Add this to your Claude Code settings (~/.claude/settings.json):");
    console.log('  "statusLine": { "type": "command", "command": "npx lanchu statusline" }');
    console.log("\nThen Claude Code shows Lanchu's status at the bottom of every session.");
  } else {
    process.stdout.write(line); // Claude Code renders this
  }
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
    ensureOnPath(); // one-time: put `lanchu` on PATH (no-op if already there)
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
      // Org must be named explicitly (no invented default); the project name
      // defaults from the real checkout so records stay bound to the folder.
      org = "";
      while (!org) org = (await rl.question(`\nOrganization: `)).trim();
      const defProject = projectNameFromCheckout();
      project = (await rl.question(`Project [${defProject}]: `)).trim() || defProject;
      const warnings = provisioningWarnings(org, project);
      if (warnings.length) {
        for (const w of warnings) console.log(`⚠ ${w}`);
        const go = (await rl.question(`Continue anyway? [y/N] `)).trim().toLowerCase();
        if (go !== "y" && go !== "yes") {
          console.log("Cancelled — nothing written.");
          return;
        }
      }
      writeConfig({ org, project });
      console.log(`Wrote .lanchu/config.json`);
    }

    // 2) objective
    let objective = prefillObjective.trim();
    while (!objective) objective = (await rl.question(`\nWhat do you want to work on? `)).trim();

    // 3) reuse-or-create
    const cands = (await (
      await api(`/api/reuse?org=${encodeURIComponent(org)}&objective=${encodeURIComponent(objective)}`)
    ).json()) as { agent: { id: string; name: string }; score: number }[];

    const sessionReq: Record<string, unknown> = { org, project, objective, client: "claude", cwd: process.cwd() };
    if (cands.length > 0) {
      const choices = [...cands.map((c) => `reuse "${c.agent.name}" (idle, overlap ${c.score})`), "create a new agent"];
      const idx = await pick(rl, "An existing agent may fit this:", choices, choices.length - 1);
      if (idx < cands.length) sessionReq.reuseAgentId = cands[idx]!.agent.id;
    }

    // 4) role (only when creating)
    if (!sessionReq.reuseAgentId) {
      const roles = (await (await api(`/api/roles?org=${encodeURIComponent(org)}`)).json()) as {
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
      await api(`/session`, {
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
      // Tag this terminal with the agent so `lanchu statusline` can name it.
      spawn(claudeCmd, [instruction], { stdio: "inherit", env: { ...process.env, LANCHU_AGENT: s.agentName } });
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

type HelpSection = { topic: string; title: string; rows: Array<[string, string]> };

// One entry per help topic. `topic` is what the user types after `lanchu help <topic>`.
const HELP_SECTIONS: HelpSection[] = [
  {
    topic: "start",
    title: "Getting started",
    rows: [
      ["lanchu", "guided onboarding wizard (org, agent, role) + launch Claude"],
      ['lanchu work ["<objective>"]', "same wizard, optionally pre-filling the objective"],
      ['lanchu "<objective>" --role r', "non-interactive onboard (for scripting)"],
      ["lanchu init", "set org/project for this directory"],
    ],
  },
  {
    topic: "orgs",
    title: "Orgs & projects",
    rows: [
      ["lanchu orgs [rm <name>]", "list every org (with counts) / delete one"],
      ["lanchu projects", "list this org's projects (each = a repo + local folder)"],
    ],
  },
  {
    topic: "agents",
    title: "Agents & tasks",
    rows: [
      ["lanchu agents | tasks", "list agents / tasks (JSON)"],
      ["lanchu agents --available", "installed agent runtimes + idle teammates to reuse"],
      ['lanchu spawn ["<objective>"] [--role r] [--model m] [--no-isolate] [--dry]', "new agent in a new terminal, in its own git worktree + branch"],
      ["lanchu tile [--dry]", "arrange agent terminals into a mosaic"],
      ["lanchu retire <agentId> [--force]", "safe retirement (handoff enforced; --force = supervisor override of the coordinator gate)"],
      ["lanchu task release <id>", "supervisor override: release a task"],
      ["lanchu task reassign <id> <agent>", "supervisor override: reassign a task"],
      ["lanchu task archive <id> [reason…]", "supervisor override: archive a task (terminal, soft — audit stays)"],
      ["lanchu task supersede <old> <new> [note…]", "supervisor override: archive old with a link to its successor"],
    ],
  },
  {
    topic: "governance",
    title: "Governance",
    rows: [
      ["lanchu roles | stats", "list roles / local stats"],
      ["lanchu roles add <name> --tags a,b", "create a role (or --wildcard)"],
      ["lanchu roles edit <name> --add-tags a,b --rm-tags c", "edit a role's tags (--tags replaces; --wildcard/--no-wildcard)"],
      ["lanchu roles edit <name> --quota <tokens> | --no-quota", "set/clear the role's self-reported token budget"],
      ["lanchu roles edit <name> --model <opus|sonnet|haiku>", "default model tier for agents spawned with this role"],
      ['lanchu rules [set "<text>"]', "view / set the org's rules"],
      ["lanchu rotate-tokens", "end every open session token (run after a token exposure)"],
      ["lanchu coordinator [set <agent> | clear]", "show the org's coordinator lease / supervisor grant or revoke"],
      ['lanchu skills [add <name> --tags a,b --instructions "…"]', "skills per task type"],
      ["lanchu skills load <url|file> [--name n] [--tags a,b]", "load a reusable SKILL.md"],
      ["lanchu skills reload <id> | rm <id>", "re-fetch a loaded skill / remove one"],
    ],
  },
  {
    topic: "automation",
    title: "Automation",
    rows: [
      ["lanchu webhooks [add <url> --events a,b | rm <id>]", "outbound webhooks (HMAC-signed)"],
      ['lanchu recurring [add "<title>" --every <min> | rm <id>]', "scheduled task creation"],
    ],
  },
  {
    topic: "server",
    title: "Server & panel",
    rows: [
      ["lanchu serve", "run the local server (foreground)"],
      ["lanchu stop", "stop the background server"],
      ["lanchu restart [--greenzone] [--timeout <s>]", "restart the server; --greenzone coordinates it (agents confirm a safe point first)"],
      ["lanchu greenzone [cancel]", "show the org's maintenance window; cancel aborts a requested one (supervisor override)"],
      ["lanchu completion [bash|zsh|fish] | install", "shell Tab-completion (commands, flags, live agent/task/org names); install wires your shell rc"],
      ["lanchu panel", "open the panel in your browser"],
      ["lanchu statusline", "status line for Claude Code (setup shown when run)"],
      ["lanchu doctor", "environment checks"],
    ],
  },
  {
    topic: "maintenance",
    title: "Maintenance",
    rows: [
      ["lanchu upgrade", "check npm for a newer version"],
      ["lanchu notify on|off", "opt-in update notifications (off by default)"],
      ["lanchu install-commands [--uninstall]", "add the /lanchu slash command to Claude Code"],
      ["lanchu uninstall [--purge]", "stop the server; --purge deletes local data"],
      ["lanchu help [<topic>] | version", "show help (optionally for one topic) / print the version"],
    ],
  },
  {
    topic: "flags",
    title: "Onboard flags",
    rows: [["--org --project --role --tags a,b", "--as <name> --reuse <id> --new --client <claude|print>"]],
  },
];

const HELP_PAD = 34;

function renderSection(s: HelpSection): string {
  const row = (usage: string, desc: string): string =>
    usage.length + 2 <= HELP_PAD
      ? `  ${usage.padEnd(HELP_PAD - 2)}${desc}`
      : `  ${usage}\n  ${" ".repeat(HELP_PAD - 2)}${desc}`;
  return `${s.title}\n${s.rows.map(([u, d]) => row(u, d)).join("\n")}`;
}

function cmdHelp(topic?: string): void {
  const header = "lanchu — control & trust layer for your AI agents";

  if (topic) {
    const key = topic.toLowerCase();
    const match = HELP_SECTIONS.find((s) => s.topic === key || s.title.toLowerCase().startsWith(key));
    if (!match) {
      const topics = HELP_SECTIONS.map((s) => s.topic).join(", ");
      console.error(`Unknown help topic "${topic}". Try one of: ${topics}`);
      process.exitCode = 1;
      return;
    }
    console.log(`${header}\n\n${renderSection(match)}\n`);
    return;
  }

  const usage = 'Usage: lanchu <command> [args]   ·   "lanchu help <topic>" narrows to one section';
  const body = HELP_SECTIONS.map(renderSection).join("\n\n");
  const footer = `Topics: ${HELP_SECTIONS.map((s) => s.topic).join(", ")}`;
  console.log(`${header}\n${usage}\n\n${body}\n\n${footer}\n`);
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
      return cmdHelp(positional()[1]);
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
    case "orgs":
      return cmdOrgs();
    case "projects":
      return cmdProjects();
    case "roles":
      return positional()[1] === "add"
        ? cmdRolesAdd()
        : positional()[1] === "edit"
          ? cmdRolesEdit()
          : cmdRoles();
    case "rules":
      return cmdRules();
    case "rotate-tokens":
      return cmdRotateTokens();
    case "coordinator":
      return cmdCoordinator();
    case "skills":
      return cmdSkills();
    case "webhooks":
      return cmdWebhooks();
    case "recurring":
      return cmdRecurring();
    case "stats":
    case "status":
      return cmdStats();
    case "install-commands":
      return cmdInstallCommands();
    case "stop":
      return cmdStop();
    case "restart":
      return cmdRestart();
    case "greenzone":
      return cmdGreenzone();
    case "completion":
      return cmdCompletion();
    case "spawn":
      return cmdSpawn();
    case "tile":
      return cmdTile();
    case "uninstall":
      return cmdUninstall();
    case "panel":
    case "open":
      return cmdPanel();
    case "statusline":
      return cmdStatusline();
    case "retire":
      return cmdRetire(positional()[1] ?? "");
    case "task": {
      const p = positional();
      return cmdTask(p[1] ?? "", p[2] ?? "", p.slice(3));
    }
    default: {
      // Anything else is treated as an objective. Guided wizard unless flags/non-TTY.
      const obj = positional().join(" ");
      return hasOnboardFlags() || !process.stdin.isTTY ? cmdOnboard(obj) : cmdWork(obj);
    }
  }
}

export async function run(): Promise<void> {
  try {
    await main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
