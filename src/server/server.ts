import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { accessKey, host, port, publicUrl, reconnectGraceMs, VERSION } from "../config.js";
import { bus } from "../core/events.js";
import { cancelGreenzone, greenzoneStatus, requestGreenzone } from "../core/greenzone.js";
import { uuid } from "../core/ids.js";
import * as store from "../core/store.js";
import { detectRuntimes } from "../core/runtimes.js";
import { ensureAgentWorktree, ghLogin, gitAuthorIn, removeAgentWorktree } from "../core/worktree.js";
import { ScopeError } from "../core/types.js";
import { closeTerminal, focusTerminal, nudgeTerminal, spawnTerminal, terminalAlive, terminalLogs } from "./cockpit.js";
import { clearContexts, getContext, putContext } from "./context.js";
import { addLiveSession, isAgentLive, removeLiveSession } from "../core/presence.js";
import { probeServers, readProjectMcpServers } from "../core/mcps.js";
import { buildMcpServer } from "./mcp.js";
import { PANEL_BUILD_ID, panelHtml } from "./panel.js";
import { startWebhookDelivery } from "./webhooks.js";

const transports = new Map<string, StreamableHTTPServerTransport>();
/** Maps an MCP session id to its agent, so we can refresh presence on each request. */
const sessionAgent = new Map<string, string>();

/**
 * Right after the server starts, clients whose transports died with the old
 * process re-establish sessions — sometimes twice (initialize retry race), and
 * the first attempt can linger half-open holding a live-presence entry. Within
 * this window a second session for the same agent is a RECONNECT, not a second
 * terminal: replace the old entry instead of counting it, and don't alarm the
 * agent. Steady-state duplicates still flag once the window has passed.
 */
const serverStartedAt = Date.now();
function inReconnectGrace(): boolean {
  return Date.now() - serverStartedAt < reconnectGraceMs();
}

/**
 * Forget a closed MCP session and drop its live-presence hold. Guarded by the
 * sessionAgent entry so it stays correct when both `onsessionclosed` and
 * `transport.onclose` fire for the same session: the first call clears the
 * mapping and releases the hold, the second is a no-op.
 */
function forgetSession(id: string): void {
  const agentId = sessionAgent.get(id);
  transports.delete(id);
  sessionAgent.delete(id);
  if (agentId !== undefined) removeLiveSession(agentId);
}

function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m?.[1] ?? null;
}

/** Constant-time string compare that tolerates unequal lengths. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * When LANCHU_ACCESS_KEY is set, the admin/API surface requires it. The key may
 * arrive as `Authorization: Bearer <key>`, an `x-lanchu-key` header, or a `?key=`
 * query param (the last is for the panel's SSE, which can't set headers). These
 * paths stay open: `/health`, the panel shell `/` (it prompts for the key
 * client-side), `/mcp` (per-agent session tokens), and `/hooks/intake` (its own
 * LANCHU_INTAKE_SECRET). Without a key configured, everything is open as before.
 */
function accessGate(req: http.IncomingMessage, url: URL): { ok: true } | { ok: false } {
  const key = accessKey();
  if (!key) return { ok: true };
  const p = url.pathname;
  if (p === "/health") return { ok: true };
  if (p === "/" && req.method === "GET") return { ok: true };
  if (p === "/mcp" || p === "/hooks/intake") return { ok: true };
  // Stop-hook probe: authenticated by the agent's own session token, not the
  // panel key (same class as /mcp).
  if (p === "/api/agent/pending") return { ok: true };
  const presented =
    bearer(req.headers.authorization ?? undefined) ??
    (typeof req.headers["x-lanchu-key"] === "string" ? (req.headers["x-lanchu-key"] as string) : null) ??
    url.searchParams.get("key");
  if (presented && safeEqual(presented, key)) return { ok: true };
  return { ok: false };
}

/**
 * The base URL a remote agent can reach this server at, for the `mcpUrl` we hand
 * back from `/session`. Prefer LANCHU_PUBLIC_URL, then the request's Host header
 * (so a laptop connecting to `lanchu-box:4319` gets that back, not `127.0.0.1`),
 * then loopback.
 */
function advertisedMcpUrl(req: http.IncomingMessage): string {
  const configured = publicUrl();
  if (configured) return `${configured}/mcp`;
  const hostHeader = req.headers.host;
  if (hostHeader) return `http://${hostHeader}/mcp`;
  return `http://127.0.0.1:${port()}/mcp`;
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

/**
 * Launcher entry point: register (or reuse) a durable agent, open a session, and return
 * the session token the agent's MCP client will use. See CLI.md §3.
 */
interface SessionRequest {
  org: string;
  project: string;
  objective?: string;
  role?: string;
  roleTags?: string[];
  wildcard?: boolean;
  reuseAgentId?: string;
  agentName?: string;
  client?: string;
  cwd?: string;
  /** Give the agent its own git worktree + branch under .lanchu/worktrees (see the agent-isolation design doc). */
  isolate?: boolean;
  /** claude model alias for the terminal (opus|sonnet|haiku…); defaults from role.preferred_model. */
  model?: string;
  /**
   * Force a fresh agent even when agentName matches an existing teammate
   * (dedupe-on-collision: name-2, name-3…). Spawn passes this — a new teammate
   * wants a fresh identity. Plain joins leave it unset and reuse by name.
   */
  create?: boolean;
}

function handleSession(req: http.IncomingMessage, body: SessionRequest, res: http.ServerResponse): void {
  const org = store.getOrCreateOrg(body.org);
  const project = store.getOrCreateProject(org.id, body.project);

  let agentId: string;
  let agentName: string;

  // A plain join with a known agentName reuses that durable agent instead of
  // minting a dedupe (product-2…): the raw endpoint can't ask reuse-or-create
  // like the wizard does, so reuse is the default and create:true opts out.
  const byName =
    !body.reuseAgentId && body.agentName && !body.create
      ? store.findAgentByName(org.id, body.agentName)
      : null;

  if (body.reuseAgentId) {
    const agent = store.getAgent(body.reuseAgentId);
    if (!agent) return sendJson(res, 404, { error: "agent not found" });
    agentId = agent.id;
    agentName = agent.name;
  } else if (byName && byName.state !== "retired") {
    agentId = byName.id;
    agentName = byName.name;
    store.recordEvent({
      org_id: org.id,
      type: "agent.reused",
      actor_agent_id: byName.id,
      subject_kind: "agent",
      subject_id: byName.id,
      data: { name: byName.name, via: "session" },
    });
  } else {
    const roleName = body.role ?? "general";
    const wildcard = body.wildcard ?? (body.roleTags?.length ? false : true);
    const role = store.getOrCreateRole(org.id, roleName, {
      wildcard,
      tags: body.roleTags ?? [],
    });
    const agent = store.createAgent({
      orgId: org.id,
      roleId: role.id,
      objective: body.objective,
      name: body.agentName,
    });
    agentId = agent.id;
    agentName = agent.name;
  }

  // Model routing: explicit spawn choice wins, then the role's preferred tier,
  // then whatever the agent already ran with (respawn keeps its model).
  {
    const agent = store.getAgent(agentId)!;
    const role = store.getRole(agent.role_id);
    const model = body.model ?? agent.model ?? role?.preferred_model ?? null;
    if (model !== agent.model) store.setAgentModel(agentId, model);
  }

  // Isolation: give the agent its own worktree + branch so parallel agents in
  // the same repo never share a HEAD/index. Falls back to the shared cwd when
  // the directory isn't a local git repo (e.g. a remote LANCHU_SERVER).
  let cwd = body.cwd;
  let worktree: string | null = null;
  let branch: string | null = null;
  if (body.isolate && body.cwd && fs.existsSync(body.cwd)) {
    const wt = ensureAgentWorktree(body.cwd, agentName, org.name);
    if (wt) {
      cwd = wt.path;
      worktree = wt.path;
      branch = wt.branch;
    }
  }

  const { token } = store.openSession(agentId, body.client);
  // Project repo/path from the launch dir (the main checkout); the agent's own
  // workspace then points at its isolated worktree when one was created.
  store.captureWorkspace(project.id, agentId, body.cwd);
  if (worktree) store.setAgentWorkspace(agentId, { cwd, branch, worktree });
  // GitHub identity, Phase 1: what this checkout will push as (read-only).
  if (cwd && fs.existsSync(cwd)) {
    store.setAgentGitIdentity(agentId, { ...gitAuthorIn(cwd), ghLogin: ghLogin() });
  }
  putContext({
    token,
    agentId,
    agentName,
    orgId: org.id,
    orgName: org.name,
    projectId: project.id,
    projectName: project.name,
    cwd,
  });

  sendJson(res, 200, {
    token,
    agentId,
    agentName,
    org: org.name,
    project: project.name,
    mcpUrl: advertisedMcpUrl(req),
    worktree,
    branch,
    // De-collided per-org color so CLI-side spawns tint with the same hue
    // the panel shows (falling back to the name hash would re-collide).
    color: store.agentColorOf(store.getAgent(agentId)!),
    // The resolved model so CLI-side spawns launch the same tier the record says.
    model: store.getAgent(agentId)!.model,
  });
}

/**
 * Panel action: reveal an agent's terminal. If its window is still open, bring
 * it to the front; otherwise open a fresh terminal, resuming the same agent
 * (new session, its stored directory) so the supervisor can jump back in.
 */
function revealAgent(agentId: string): {
  action: "focused" | "opened" | "unavailable";
  method?: string;
  reason?: string;
} {
  const agent = store.getAgent(agentId);
  if (!agent) return { action: "unavailable", reason: "agent not found" };
  const org = store.getOrg(agent.org_id);
  const title = `${org?.name ?? "lanchu"}·${agent.name}`;

  const ref = store.getAgentTerminal(agent.id);
  if (ref && focusTerminal(ref)) return { action: "focused" };

  // No live terminal — open one for this agent where it was last working.
  const project = store.listProjects(agent.org_id)[0];
  let cwd = agent.cwd || agent.worktree || process.cwd();
  if (!fs.existsSync(cwd)) {
    // Its worktree was pruned (or the dir moved) — recreate the isolated
    // worktree from the project's main checkout instead of failing the spawn.
    const base = project?.local_path && fs.existsSync(project.local_path) ? project.local_path : process.cwd();
    const wt = ensureAgentWorktree(base, agent.name, org?.name);
    cwd = wt?.path ?? base;
    if (wt) store.setAgentWorkspace(agent.id, { cwd: wt.path, branch: wt.branch, worktree: wt.path });
  }
  const { token } = store.openSession(agent.id);
  if (project) store.captureWorkspace(project.id, agent.id, cwd);
  if (fs.existsSync(cwd)) store.setAgentGitIdentity(agent.id, { ...gitAuthorIn(cwd), ghLogin: ghLogin() });
  putContext({
    token,
    agentId: agent.id,
    agentName: agent.name,
    orgId: agent.org_id,
    orgName: org?.name ?? "",
    projectId: project?.id ?? "",
    projectName: project?.name ?? "",
    cwd,
  });
  const prompt =
    "You are resuming as a Lanchu teammate. Read the lanchu://me resource for your objective, " +
    "role and open tasks, then continue working them, reporting progress with task_update. " +
    "While you work, watch for friction in Lanchu itself and file it with task_create using the " +
    "taxonomy tags (bug | extension | idea | process) plus evidence — the help tool has the details.";
  const result = spawnTerminal({
    title, agentName: agent.name, cwd, token, prompt,
    colorHex: store.agentColorOf(agent).hex,
    model: agent.model ?? undefined,
  });
  store.setAgentTerminal(agent.id, result.ref ?? null);
  return { action: "opened", method: result.method };
}

async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const sid = req.headers["mcp-session-id"] as string | undefined;

  // Existing session: route to its transport and refresh presence.
  if (sid && transports.has(sid)) {
    const transport = transports.get(sid)!;
    const agentId = sessionAgent.get(sid);
    if (agentId) store.touchSeen(agentId);
    const body = req.method === "POST" ? await readJson(req) : undefined;
    await transport.handleRequest(req, res, body);
    return;
  }

  // New session: only valid on POST (initialize). Authenticate via the launcher token.
  if (req.method !== "POST") {
    return sendJson(res, 400, { error: "missing or unknown mcp-session-id" });
  }

  const ctx = getContext(bearer(req.headers.authorization ?? undefined) ?? "");
  if (!ctx) {
    return sendJson(res, 401, { error: "invalid or missing session token" });
  }

  const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => uuid(),
    onsessioninitialized: (id) => {
      transports.set(id, transport);
      sessionAgent.set(id, ctx.agentId);
      // Two live sessions resolving to one agent id means two terminals share
      // an identity — misattribution waiting to happen (isolation root cause #2).
      // Warn the agent (it'll see it on its next tool call) and audit it.
      // Exception: during the post-start grace window it's the same terminal
      // reconnecting — replace its previous session instead of counting it.
      if (isAgentLive(ctx.agentId)) {
        if (inReconnectGrace()) {
          const stale = [...sessionAgent.entries()]
            .filter(([sid, agentId]) => agentId === ctx.agentId && sid !== id)
            .map(([sid]) => sid);
          for (const sid of stale) {
            const old = transports.get(sid);
            forgetSession(sid); // idempotent — a later onclose for the same sid is a no-op
            void old?.close().catch(() => {
              /* already half-closed */
            });
          }
        } else {
          store.recordEvent({
            org_id: ctx.orgId,
            type: "agent.duplicate_session",
            actor_agent_id: ctx.agentId,
            subject_kind: "agent",
            subject_id: ctx.agentId,
            data: { note: "a second live session connected as this agent" },
          });
          store.systemNotice(
            ctx.orgId,
            ctx.agentId,
            "Another live session is connected as this same agent. Two terminals sharing one identity causes misattribution — close one, or spawn a separate agent (lanchu spawn).",
          );
        }
      }
      addLiveSession(ctx.agentId);
    },
    onsessionclosed: (id) => forgetSession(id),
  });
  const { server, dispose } = buildMcpServer(ctx);
  transport.onclose = () => {
    dispose();
    if (transport.sessionId) forgetSession(transport.sessionId);
  };

  await server.connect(transport);
  store.touchSeen(ctx.agentId); // presence heartbeat on connect

  const body = await readJson(req);
  await transport.handleRequest(req, res, body);
}

/** Server-Sent Events: push a tick to the panel whenever an org event fires. */
function handleEvents(orgId: string, res: http.ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(": connected\n\n");
  // Sent on every (re)connect: a tab whose stamped build id differs from this
  // one is running stale client code (loaded before a restart) and reloads.
  res.write(`data: ${JSON.stringify({ type: "hello", build: PANEL_BUILD_ID })}\n\n`);
  const unsub = bus.onEvent((ev) => {
    if (ev.org_id !== orgId) return;
    res.write(`data: ${JSON.stringify({ type: ev.type, at: ev.created_at })}\n\n`);
  });
  const keepalive = setInterval(() => res.write(": ping\n\n"), 25_000);
  const close = () => {
    clearInterval(keepalive);
    unsub();
  };
  res.on("close", close);
  res.on("error", close);
}

export function createServer(): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (url.pathname === "/health") {
        return sendJson(res, 200, { ok: true, service: "lanchu" });
      }

      // Shared-secret gate for the admin/API surface (no-op unless a key is set).
      if (!accessGate(req, url).ok) {
        return sendJson(res, 401, { error: "invalid or missing access key" });
      }

      if (url.pathname === "/" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(panelHtml());
        return;
      }

      if (url.pathname === "/api/orgs" && req.method === "GET") {
        return sendJson(res, 200, store.listOrgs());
      }
      if (url.pathname === "/org/delete" && req.method === "POST") {
        const body = (await readJson(req)) as { name: string };
        if (!body?.name) return sendJson(res, 400, { error: "name required" });
        return sendJson(res, 200, store.deleteOrg(body.name));
      }
      // Explicit create path for the CLI/automation only (besides /session).
      // No panel UI calls this: the panel observes and guides, provisioning
      // happens in the terminal — see the "Panel philosophy" design doc.
      if (url.pathname === "/org/create" && req.method === "POST") {
        const body = (await readJson(req)) as { name: string };
        const name = (body?.name ?? "").trim();
        if (!name) return sendJson(res, 400, { error: "name required" });
        const org = store.getOrCreateOrg(name);
        return sendJson(res, 200, { id: org.id, name: org.name });
      }
      if (url.pathname === "/api/board" && req.method === "GET") {
        const orgName = url.searchParams.get("org");
        if (!orgName) return sendJson(res, 400, { error: "org required" });
        const org = store.getOrgByName(orgName);
        if (!org) return sendJson(res, 200, { agents: [], tasks: [], projects: [] });
        return sendJson(res, 200, store.boardSnapshot(org.id));
      }

      if (url.pathname === "/api/landing" && req.method === "GET") {
        const orgName = url.searchParams.get("org");
        if (!orgName) return sendJson(res, 400, { error: "org required" });
        const org = store.getOrgByName(orgName);
        if (!org) return sendJson(res, 200, { landing: [] });
        return sendJson(res, 200, {
          landing: store.listProjects(org.id).flatMap((p) => store.landingQueue(p.id)),
        });
      }
      if (url.pathname === "/api/graph" && req.method === "GET") {
        const orgName = url.searchParams.get("org");
        if (!orgName) return sendJson(res, 400, { error: "org required" });
        const windows: Record<string, number> = { "1h": 1, "24h": 24, "7d": 168 };
        const wh = windows[url.searchParams.get("window") ?? "24h"] ?? 24;
        const org = store.getOrgByName(orgName);
        if (!org) return sendJson(res, 200, { window_hours: wh, nodes: [], edges: [] });
        return sendJson(res, 200, store.orgGraph(org.id, wh));
      }

      if (url.pathname === "/api/mcps" && req.method === "GET") {
        const orgName = url.searchParams.get("org");
        if (!orgName) return sendJson(res, 400, { error: "org required" });
        const org = store.getOrgByName(orgName);
        if (!org) return sendJson(res, 200, { agents: [], projects: [] });
        const projects = [];
        for (const p of store.listProjects(org.id)) {
          const servers = p.local_path ? await probeServers(readProjectMcpServers(p.local_path)) : [];
          projects.push({ id: p.id, name: p.name, local_path: p.local_path, servers });
        }
        return sendJson(res, 200, { agents: store.mcpAgentStatus(org.id), projects });
      }

      if (url.pathname === "/api/tests" && req.method === "GET") {
        const orgName = url.searchParams.get("org");
        if (!orgName) return sendJson(res, 400, { error: "org required" });
        const org = store.getOrgByName(orgName);
        if (!org) return sendJson(res, 200, []);
        return sendJson(res, 200, store.testRegistry(org.id));
      }

      if (url.pathname === "/api/reuse" && req.method === "GET") {
        const orgName = url.searchParams.get("org");
        const objective = url.searchParams.get("objective") ?? "";
        if (!orgName) return sendJson(res, 400, { error: "org required" });
        const org = store.getOrgByName(orgName);
        if (!org) return sendJson(res, 200, []);
        return sendJson(res, 200, store.findReuseCandidates(org.id, objective));
      }

      if (url.pathname === "/session" && req.method === "POST") {
        const body = (await readJson(req)) as SessionRequest;
        if (!body?.org || !body?.project) {
          return sendJson(res, 400, { error: "org and project required" });
        }
        return handleSession(req, body, res);
      }

      if (url.pathname === "/api/roles" && req.method === "GET") {
        const orgName = url.searchParams.get("org");
        if (!orgName) return sendJson(res, 400, { error: "org required" });
        const org = store.getOrgByName(orgName);
        if (!org) return sendJson(res, 200, []);
        // Budgets MVP: ship consumption with each role so the panel can show
        // used vs quota without a second round-trip.
        const roles = store.listRoles(org.id).map((r) => ({ ...r, used_tokens: store.roleTokenUsage(r.id) }));
        return sendJson(res, 200, roles);
      }

      if (url.pathname === "/api/roles" && req.method === "POST") {
        const body = (await readJson(req)) as {
          org: string; name: string; tags?: string[]; wildcard?: boolean; preferredModel?: string | null;
        };
        if (!body?.org || !body?.name) return sendJson(res, 400, { error: "org and name required" });
        const org = store.getOrCreateOrg(body.org);
        let role = store.defineRole(org.id, body.name, { wildcard: body.wildcard, tags: body.tags });
        if (body.preferredModel !== undefined && body.preferredModel !== null) {
          role = store.updateRole(org.id, role.name, { preferredModel: body.preferredModel }) ?? role;
        }
        return sendJson(res, 200, role);
      }

      if (url.pathname === "/api/roles" && req.method === "PATCH") {
        const body = (await readJson(req)) as {
          org: string;
          name: string;
          addTags?: string[];
          rmTags?: string[];
          tags?: string[];
          wildcard?: boolean;
          quota?: number | null;
          preferredModel?: string | null;
        };
        if (!body?.org || !body?.name) return sendJson(res, 400, { error: "org and name required" });
        const org = store.getOrgByName(body.org);
        if (!org) return sendJson(res, 404, { error: `no org named '${body.org}'` });
        if (body.quota !== undefined && body.quota !== null && (!Number.isFinite(body.quota) || body.quota < 0)) {
          return sendJson(res, 400, { error: "quota must be a non-negative number or null" });
        }
        const role = store.updateRole(org.id, body.name, {
          addTags: body.addTags,
          rmTags: body.rmTags,
          tags: body.tags,
          wildcard: body.wildcard,
          quota: body.quota,
          preferredModel: body.preferredModel,
        });
        if (!role) return sendJson(res, 404, { error: `no role named '${body.name}' in org '${body.org}'` });
        return sendJson(res, 200, role);
      }

      if (url.pathname === "/api/org/rules" && req.method === "GET") {
        const orgName = url.searchParams.get("org");
        if (!orgName) return sendJson(res, 400, { error: "org required" });
        const org = store.getOrgByName(orgName);
        if (!org) return sendJson(res, 200, { rules: "" });
        return sendJson(res, 200, { rules: store.getOrgRules(org.id) });
      }
      if (url.pathname === "/api/org/rules" && req.method === "POST") {
        const b = (await readJson(req)) as { org: string; rules: string };
        if (!b?.org) return sendJson(res, 400, { error: "org required" });
        const org = store.getOrCreateOrg(b.org);
        store.setOrgRules(org.id, b.rules ?? "");
        return sendJson(res, 200, { ok: true, rules: store.getOrgRules(org.id) });
      }

      if (url.pathname === "/api/available" && req.method === "GET") {
        const orgName = url.searchParams.get("org");
        const org = orgName ? store.getOrgByName(orgName) : null;
        return sendJson(res, 200, {
          runtimes: detectRuntimes(),
          teammates: org ? store.availableTeammates(org.id) : [],
        });
      }

      if (url.pathname === "/api/context-spend" && req.method === "GET") {
        const orgName = url.searchParams.get("org");
        if (!orgName) return sendJson(res, 400, { error: "org required" });
        const org = store.getOrgByName(orgName);
        if (!org) return sendJson(res, 200, { by_tool: [], by_agent: [] });
        const hours = Number.parseInt(url.searchParams.get("hours") ?? "24", 10) || 24;
        return sendJson(res, 200, store.contextSpend(org.id, hours));
      }

      if (url.pathname === "/api/memory" && req.method === "GET") {
        const orgName = url.searchParams.get("org");
        if (!orgName) return sendJson(res, 400, { error: "org required" });
        const org = store.getOrgByName(orgName);
        if (!org) return sendJson(res, 200, []);
        const entries = store.memoryGet(org.id).map((m) => ({
          ...m,
          subject_name:
            m.scope === "agent"
              ? (store.getAgent(m.subject_id)?.name ?? m.subject_id)
              : m.scope === "project"
                ? (store.listProjects(org.id).find((p) => p.id === m.subject_id)?.name ?? m.subject_id)
                : org.name,
          writer_name: m.source === "agent" && m.source_ref ? (store.getAgent(m.source_ref)?.name ?? null) : null,
        }));
        return sendJson(res, 200, entries);
      }

      if (url.pathname === "/api/audit" && req.method === "GET") {
        const orgName = url.searchParams.get("org");
        if (!orgName) return sendJson(res, 400, { error: "org required" });
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "60", 10) || 60;
        const org = store.getOrgByName(orgName);
        if (!org) return sendJson(res, 200, []);
        // ?reads=1 opts the high-volume doc.read events back into the feed.
        return sendJson(res, 200, store.listAuditEvents(org.id, limit, { includeReads: url.searchParams.get("reads") === "1" }));
      }

      if (url.pathname === "/api/docs" && req.method === "GET") {
        const orgName = url.searchParams.get("org");
        if (!orgName) return sendJson(res, 400, { error: "org required" });
        const org = store.getOrgByName(orgName);
        if (!org) return sendJson(res, 200, []);
        const docs = store.listDocs(org.id).map((d) => ({
          id: d.id,
          title: d.title,
          category: d.category,
          content: d.content,
          created_at: d.created_at,
          updated_at: d.updated_at,
          updated_by: d.updated_by_agent_id ? (store.getAgent(d.updated_by_agent_id)?.name ?? null) : null,
          chars: d.content.length,
          read_count: d.read_count,
          last_read_at: d.last_read_at,
          last_read_by: d.last_read_by_agent_id ? (store.getAgent(d.last_read_by_agent_id)?.name ?? null) : null,
          readers: store.docReaders(d.id),
        }));
        return sendJson(res, 200, docs);
      }

      if (url.pathname === "/events" && req.method === "GET") {
        const orgName = url.searchParams.get("org");
        if (!orgName) return sendJson(res, 400, { error: "org required" });
        const org = store.getOrgByName(orgName);
        return handleEvents(org?.id ?? "", res);
      }

      // ── supervisor actions ──
      if (url.pathname === "/agent/retire" && req.method === "POST") {
        const body = (await readJson(req)) as { agentId: string };
        const agent = store.getAgent(body.agentId);
        const result = store.retireAgent(body.agentId);
        // Prune the retired agent's isolated worktree; its branch stays for PR/merge.
        const worktree = result.retired ? removeAgentWorktree(agent?.worktree) : undefined;
        return sendJson(res, 200, { ...result, worktree });
      }
      if (url.pathname === "/agent/reveal" && req.method === "POST") {
        const body = (await readJson(req)) as { agentId: string };
        return sendJson(res, 200, revealAgent(body.agentId));
      }
      if (url.pathname === "/agent/terminal" && req.method === "POST") {
        const body = (await readJson(req)) as { agentId: string; ref: store.TerminalRef | null };
        store.setAgentTerminal(body.agentId, body.ref ?? null);
        return sendJson(res, 200, { ok: true });
      }

      // ── processes (server + agent terminals) ──
      if (url.pathname === "/api/processes" && req.method === "GET") {
        const orgName = url.searchParams.get("org");
        if (!orgName) return sendJson(res, 400, { error: "org required" });
        const org = store.getOrgByName(orgName);
        const terminals = (org ? store.listTerminals(org.id) : []).map((t) => ({
          agentId: t.agentId,
          name: t.name,
          method: t.ref.method,
          id: t.ref.id,
          alive: terminalAlive(t.ref),
        }));
        return sendJson(res, 200, {
          server: {
            pid: process.pid,
            uptimeSec: Math.round(process.uptime()),
            port: port(),
            version: VERSION,
            memMB: Math.round(process.memoryUsage().rss / 1e6),
            platform: process.platform,
            node: process.version,
          },
          terminals,
        });
      }
      if (url.pathname === "/api/agent/logs" && req.method === "GET") {
        const agentId = url.searchParams.get("agentId") ?? "";
        const ref = store.getAgentTerminal(agentId);
        if (!ref) return sendJson(res, 200, { logs: "", alive: false });
        return sendJson(res, 200, { logs: terminalLogs(ref), alive: terminalAlive(ref) });
      }
      if (url.pathname === "/agent/terminal/close" && req.method === "POST") {
        const body = (await readJson(req)) as { agentId: string };
        const ref = store.getAgentTerminal(body.agentId);
        const ok = ref ? closeTerminal(ref) : false;
        store.setAgentTerminal(body.agentId, null);
        return sendJson(res, 200, { closed: ok });
      }
      if (url.pathname === "/server/stop" && req.method === "POST") {
        sendJson(res, 200, { ok: true });
        setTimeout(() => process.exit(0), 50);
        return;
      }
      if (url.pathname === "/server/restart" && req.method === "POST") {
        sendJson(res, 200, { ok: true });
        restartServer();
        return;
      }
      // Greenzone: coordinated maintenance window (design: task-mrg0aeba6).
      // Agents are noticed to reach a safe point and confirm via greenzone_ack;
      // the op runs when all live agents confirm or the timeout expires.
      if (url.pathname === "/greenzone/request" && req.method === "POST") {
        const body = (await readJson(req)) as { org: string; action?: string; timeoutSeconds?: number };
        if (!body?.org) return sendJson(res, 400, { error: "org required" });
        const org = store.getOrgByName(body.org);
        if (!org) return sendJson(res, 404, { error: `no org named '${body.org}'` });
        const action = body.action ?? "restart";
        if (action !== "restart") {
          return sendJson(res, 400, { error: `unsupported greenzone action '${action}' (v1 supports: restart)` });
        }
        try {
          const status = requestGreenzone({
            orgId: org.id,
            action,
            timeoutMs: body.timeoutSeconds ? Math.max(1, body.timeoutSeconds) * 1000 : undefined,
            execute: () => restartServer(),
          });
          return sendJson(res, 200, status);
        } catch (err) {
          return sendJson(res, 409, { error: (err as Error).message });
        }
      }
      // Stop-hook probe (wake v4): how many notices has this agent not heard
      // yet? Bare number, agent-token auth — the hook is a jq-free curl. On a
      // bad token the hook's -f fails and it fails OPEN (never trap an agent).
      if (url.pathname === "/api/agent/pending" && req.method === "GET") {
        const ctx = getContext(bearer(req.headers.authorization ?? undefined) ?? "");
        if (!ctx) {
          res.writeHead(401, { "content-type": "text/plain" });
          return res.end("unauthorized");
        }
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end(String(store.undeliveredNoticeCount(ctx.agentId)));
      }
      // Supervisor override: abort a requested window before it executes (the
      // armed op never runs). Also the recovery path for a stuck window.
      if (url.pathname === "/greenzone/cancel" && req.method === "POST") {
        const body = (await readJson(req)) as { org: string };
        if (!body?.org) return sendJson(res, 400, { error: "org required" });
        const org = store.getOrgByName(body.org);
        if (!org) return sendJson(res, 404, { error: `no org named '${body.org}'` });
        try {
          return sendJson(res, 200, cancelGreenzone(org.id));
        } catch (err) {
          return sendJson(res, 409, { error: (err as Error).message });
        }
      }
      if (url.pathname === "/api/greenzone" && req.method === "GET") {
        const orgName = url.searchParams.get("org");
        if (!orgName) return sendJson(res, 400, { error: "org required" });
        const org = store.getOrgByName(orgName);
        return sendJson(res, 200, org ? greenzoneStatus(org.id) : { state: "idle", required: [] });
      }
      // Kill every open session token in an org (after an exposure): agents
      // re-register through the launcher and get fresh tokens.
      if (url.pathname === "/tokens/rotate" && req.method === "POST") {
        const body = (await readJson(req)) as { org: string };
        if (!body?.org) return sendJson(res, 400, { error: "org required" });
        const org = store.getOrgByName(body.org);
        if (!org) return sendJson(res, 404, { error: `no org named '${body.org}'` });
        const result = store.rotateOrgSessions(org.id);
        clearContexts();
        return sendJson(res, 200, result);
      }
      // Coordinator lease: read state for the panel; supervisor grant/revoke.
      if (url.pathname === "/api/coordinator" && req.method === "GET") {
        const orgName = url.searchParams.get("org");
        if (!orgName) return sendJson(res, 400, { error: "org required" });
        const org = store.getOrgByName(orgName);
        return sendJson(res, 200, (org && store.getCoordinator(org.id)) ?? { state: "none" });
      }
      if (url.pathname === "/coordinator" && req.method === "POST") {
        const body = (await readJson(req)) as { org: string; set?: string; clear?: boolean };
        if (!body?.org) return sendJson(res, 400, { error: "org required" });
        const org = store.getOrgByName(body.org);
        if (!org) return sendJson(res, 404, { error: `no org named '${body.org}'` });
        try {
          if (body.clear) return sendJson(res, 200, { coordinator: store.coordinatorOverride(org.id, null) });
          if (!body.set) return sendJson(res, 400, { error: "set (agent name) or clear required" });
          return sendJson(res, 200, { coordinator: store.coordinatorOverride(org.id, body.set) });
        } catch (err) {
          return sendJson(res, 400, { error: (err as Error).message });
        }
      }
      if (url.pathname === "/task/release" && req.method === "POST") {
        const body = (await readJson(req)) as { taskId: string };
        return sendJson(res, 200, store.releaseTask({ agentId: null, taskId: body.taskId, override: true }));
      }
      if (url.pathname === "/task/reassign" && req.method === "POST") {
        const body = (await readJson(req)) as { taskId: string; toAgentId: string };
        return sendJson(
          res,
          200,
          store.reassignTask({ taskId: body.taskId, toAgentId: body.toAgentId, override: true }),
        );
      }
      if (url.pathname === "/task/archive" && req.method === "POST") {
        const body = (await readJson(req)) as { taskId: string; reason?: string };
        if (!body?.taskId) return sendJson(res, 400, { error: "taskId required" });
        try {
          return sendJson(res, 200, store.archiveTask({ taskId: body.taskId, reason: body.reason, override: true }));
        } catch (err) {
          return sendJson(res, 400, { error: (err as Error).message });
        }
      }
      if (url.pathname === "/task/supersede" && req.method === "POST") {
        const body = (await readJson(req)) as { oldTaskId: string; newTaskId: string; note?: string };
        if (!body?.oldTaskId || !body?.newTaskId)
          return sendJson(res, 400, { error: "oldTaskId and newTaskId required" });
        try {
          return sendJson(
            res,
            200,
            store.supersedeTask({ oldTaskId: body.oldTaskId, newTaskId: body.newTaskId, note: body.note, override: true }),
          );
        } catch (err) {
          return sendJson(res, 400, { error: (err as Error).message });
        }
      }
      // ── skills (per task type) ──
      if (url.pathname === "/api/skills" && req.method === "GET") {
        const orgName = url.searchParams.get("org");
        if (!orgName) return sendJson(res, 400, { error: "org required" });
        const org = store.getOrgByName(orgName);
        if (!org) return sendJson(res, 200, []);
        return sendJson(res, 200, store.listSkills(org.id));
      }
      if (url.pathname === "/api/skills" && req.method === "POST") {
        const b = (await readJson(req)) as { org: string; name?: string; tags?: string[]; instructions?: string; skillUrl?: string };
        if (!b?.org) return sendJson(res, 400, { error: "org required" });
        const org = store.getOrCreateOrg(b.org);
        // With a source URL and no inline instructions, load the skill from it
        // (its frontmatter can supply the name/tags); otherwise upsert inline.
        if (b.skillUrl && !b.instructions) {
          try {
            const skill = await store.loadSkillFromUrl(org.id, b.skillUrl, { name: b.name, tags: b.tags });
            return sendJson(res, 200, skill);
          } catch (err) {
            return sendJson(res, 400, { error: (err as Error).message });
          }
        }
        if (!b.name) return sendJson(res, 400, { error: "name required (or pass a skillUrl to load)" });
        return sendJson(res, 200, store.createSkill(org.id, { name: b.name, tags: b.tags ?? [], instructions: b.instructions, skillUrl: b.skillUrl }));
      }
      if (url.pathname === "/api/skills/reload" && req.method === "POST") {
        const b = (await readJson(req)) as { id: string };
        if (!b?.id) return sendJson(res, 400, { error: "id required" });
        try {
          return sendJson(res, 200, await store.reloadSkill(b.id));
        } catch (err) {
          return sendJson(res, 400, { error: (err as Error).message });
        }
      }
      if (url.pathname === "/api/skills/delete" && req.method === "POST") {
        const b = (await readJson(req)) as { id: string };
        store.deleteSkill(b.id);
        return sendJson(res, 200, { ok: true });
      }

      // ── webhooks (outbound) ──
      if (url.pathname === "/api/webhooks" && req.method === "GET") {
        const orgName = url.searchParams.get("org");
        if (!orgName) return sendJson(res, 400, { error: "org required" });
        const org = store.getOrgByName(orgName);
        if (!org) return sendJson(res, 200, []);
        const hooks = store.listWebhooks(org.id).map((w) => ({ ...w, secret: w.secret ? "set" : null }));
        return sendJson(res, 200, hooks);
      }
      if (url.pathname === "/api/webhooks" && req.method === "POST") {
        const b = (await readJson(req)) as { org: string; url: string; events?: string[]; secret?: string };
        if (!b?.org || !b?.url) return sendJson(res, 400, { error: "org and url required" });
        const org = store.getOrCreateOrg(b.org);
        const hook = store.createWebhook(org.id, b.url, b.events ?? ["*"], b.secret);
        return sendJson(res, 200, { ...hook, secret: hook.secret ? "set" : null });
      }
      if (url.pathname === "/api/webhooks/delete" && req.method === "POST") {
        const b = (await readJson(req)) as { id: string };
        store.deleteWebhook(b.id);
        return sendJson(res, 200, { ok: true });
      }

      // ── recurring functions ──
      if (url.pathname === "/api/recurring" && req.method === "GET") {
        const orgName = url.searchParams.get("org");
        if (!orgName) return sendJson(res, 400, { error: "org required" });
        const org = store.getOrgByName(orgName);
        if (!org) return sendJson(res, 200, []);
        return sendJson(res, 200, store.listRecurring(org.id));
      }
      if (url.pathname === "/api/recurring" && req.method === "POST") {
        const b = (await readJson(req)) as { org: string; project: string; title: string; tags?: string[]; everyMinutes?: number };
        if (!b?.org || !b?.project || !b?.title || !b?.everyMinutes) {
          return sendJson(res, 400, { error: "org, project, title and everyMinutes required" });
        }
        const org = store.getOrCreateOrg(b.org);
        const project = store.getOrCreateProject(org.id, b.project);
        const r = store.createRecurring({
          orgId: org.id,
          projectId: project.id,
          title: b.title,
          tags: b.tags,
          intervalSeconds: Math.max(60, Math.round(b.everyMinutes * 60)),
        });
        return sendJson(res, 200, r);
      }
      if (url.pathname === "/api/recurring/delete" && req.method === "POST") {
        const b = (await readJson(req)) as { id: string };
        store.deleteRecurring(b.id);
        return sendJson(res, 200, { ok: true });
      }

      // ── inbound intake: create a task from an external source ──
      if (url.pathname === "/hooks/intake" && req.method === "POST") {
        const secret = process.env.LANCHU_INTAKE_SECRET;
        if (secret && req.headers["x-lanchu-intake-token"] !== secret) {
          return sendJson(res, 401, { error: "invalid intake token" });
        }
        const b = (await readJson(req)) as { org: string; project: string; title: string; tags?: string[] };
        if (!b?.org || !b?.project || !b?.title) {
          return sendJson(res, 400, { error: "org, project and title required" });
        }
        const org = store.getOrCreateOrg(b.org);
        const project = store.getOrCreateProject(org.id, b.project);
        return sendJson(res, 200, store.createTaskSystem({ orgId: org.id, projectId: project.id, title: b.title, tags: b.tags }));
      }

      if (url.pathname === "/shutdown" && req.method === "POST") {
        sendJson(res, 200, { ok: true });
        setTimeout(() => process.exit(0), 50);
        return;
      }

      if (url.pathname === "/mcp") {
        return await handleMcp(req, res);
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof ScopeError ? 403 : 500;
      if (!res.headersSent) sendJson(res, status, { error: message });
      else res.end();
    }
  });
}

/**
 * Restart the server for the panel's "Restart" action. We can't rebind the port
 * while still listening, so a detached helper waits for us to exit, then starts a
 * fresh `serve`. The panel's SSE drops and reconnects once it's back (~1s).
 */
function restartServer(): void {
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli", "index.js");
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", `ping -n 2 127.0.0.1 >NUL & "${process.execPath}" "${bin}" serve`]]
      : ["sh", ["-c", `sleep 1; exec "${process.execPath}" "${bin}" serve`]];
  spawn(cmd, args as string[], { detached: true, stdio: "ignore" }).unref();
  setTimeout(() => process.exit(0), 150);
}

/**
 * The one fixed line auto-wake may ever type into an agent's terminal.
 * Deliberately constant: no interpolation of message bodies or names — the
 * nudge points at the inbox, the inbox carries the content (audited).
 */
export const NUDGE_LINE =
  "You have Lanchu notices: run message_list now and follow the instructions.";

/**
 * Auto-wake sweep: nudge agents whose queued notices sat undelivered past the
 * grace window and whose Lanchu-spawned terminal is still open. Store-side
 * guard rails (queued-only, cooldown) are in agentsNeedingNudge; injectable
 * effects keep this testable without a real terminal.
 */
export function runNudgeSweep(
  effects: { alive?: typeof terminalAlive; nudge?: typeof nudgeTerminal } = {},
): { nudged: string[]; expired_broadcasts: number } {
  const alive = effects.alive ?? terminalAlive;
  const nudge = effects.nudge ?? nudgeTerminal;
  // Notice hygiene first: stale broadcasts self-expire so they never count as
  // pending inbox anywhere (sleeping agents, fixtures) — see store for why.
  const expired = store.expireBroadcastNotices();
  const nudged: string[] = [];
  for (const org of store.listOrgs()) {
    for (const c of store.agentsNeedingNudge(org.id)) {
      try {
        if (!alive(c.terminal_ref)) continue;
        // The alive probe can take seconds — cancel if delivery or a tool
        // call happened since this candidate was computed.
        if (!store.nudgeStillNeeded(c.agent_id)) continue;
        const transport = nudge(c.terminal_ref, NUDGE_LINE);
        if (!transport) continue;
        // Wake v4: the transport is audited — a degraded keystroke wake means
        // "install tmux / check the Stop hook" and must be visible, not silent.
        store.recordNudge(org.id, c.agent_id, c.queued_notices, transport);
        nudged.push(c.agent_name);
      } catch {
        /* a broken terminal must not stop the sweep */
      }
    }
  }
  return { nudged, expired_broadcasts: expired };
}

export function startServer(): Promise<http.Server> {
  startWebhookDelivery();
  // Heal done/review inconsistencies left by pre-batch-flip history (audited,
  // idempotent — see reconcileSdlcStages). Must never stop the server.
  try {
    store.reconcileSdlcStages();
  } catch {
    /* reconciliation is best-effort */
  }
  // Warm the runtime inventory off the startup path (each probe is capped at
  // 1.5s; deferring keeps `lanchu serve` responsive on machines with many CLIs).
  setTimeout(() => detectRuntimes({ refresh: true }), 0).unref();
  // Recurring-function scheduler: fire due recurrings on a steady tick.
  const tick = () => {
    try {
      store.runDueRecurring();
    } catch {
      /* keep the server alive */
    }
  };
  tick();
  setInterval(tick, 30_000).unref();
  // Auto-wake: queued A2A messages must not wait for a tool call that never
  // comes. Same cadence as the recurring tick.
  setInterval(() => {
    try {
      runNudgeSweep();
    } catch {
      /* keep the server alive */
    }
  }, 30_000).unref();
  // Landing queue + release pressure: detect queued PRs that hit origin/main
  // and notice whose turn it is; measure merged-but-unreleased debt and queue
  // the release checklist when it crosses the threshold (fetches are
  // throttled inside the sweeps — one per project per minute, shared).
  setInterval(() => {
    try {
      store.runLandingSweep();
    } catch {
      /* keep the server alive */
    }
    try {
      store.runReleaseSweep();
    } catch {
      /* keep the server alive */
    }
  }, 30_000).unref();
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(`Port ${port()} is already in use — another Lanchu server may be running.`);
        console.error(`Stop it with 'lanchu stop', or use a different port: LANCHU_PORT=4320 lanchu ...`);
        process.exit(1);
      }
      reject(err);
    });
    server.listen(port(), host(), () => resolve(server));
  });
}
