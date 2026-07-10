import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { HOST, mcpUrl, port } from "../config.js";
import { bus } from "../core/events.js";
import { uuid } from "../core/ids.js";
import * as store from "../core/store.js";
import { ScopeError } from "../core/types.js";
import { getContext, putContext } from "./context.js";
import { buildMcpServer } from "./mcp.js";
import { panelHtml } from "./panel.js";
import { startWebhookDelivery } from "./webhooks.js";

const transports = new Map<string, StreamableHTTPServerTransport>();
/** Maps an MCP session id to its agent, so we can refresh presence on each request. */
const sessionAgent = new Map<string, string>();

function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m?.[1] ?? null;
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
}

function handleSession(body: SessionRequest, res: http.ServerResponse): void {
  const org = store.getOrCreateOrg(body.org);
  const project = store.getOrCreateProject(org.id, body.project);

  let agentId: string;
  let agentName: string;

  if (body.reuseAgentId) {
    const agent = store.getAgent(body.reuseAgentId);
    if (!agent) return sendJson(res, 404, { error: "agent not found" });
    agentId = agent.id;
    agentName = agent.name;
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

  const { token } = store.openSession(agentId, body.client);
  putContext({ token, agentId, agentName, orgId: org.id, projectId: project.id });

  sendJson(res, 200, {
    token,
    agentId,
    agentName,
    org: org.name,
    project: project.name,
    mcpUrl: mcpUrl(),
  });
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
    },
    onsessionclosed: (id) => {
      transports.delete(id);
      sessionAgent.delete(id);
    },
  });
  const { server, dispose } = buildMcpServer(ctx);
  transport.onclose = () => {
    dispose();
    if (transport.sessionId) {
      transports.delete(transport.sessionId);
      sessionAgent.delete(transport.sessionId);
    }
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
      const url = new URL(req.url ?? "/", `http://${HOST}`);

      if (url.pathname === "/health") {
        return sendJson(res, 200, { ok: true, service: "lanchu" });
      }

      if (url.pathname === "/" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(panelHtml());
        return;
      }

      if (url.pathname === "/api/board" && req.method === "GET") {
        const orgName = url.searchParams.get("org");
        if (!orgName) return sendJson(res, 400, { error: "org required" });
        const org = store.getOrCreateOrg(orgName);
        return sendJson(res, 200, store.boardSnapshot(org.id));
      }

      if (url.pathname === "/api/reuse" && req.method === "GET") {
        const orgName = url.searchParams.get("org");
        const objective = url.searchParams.get("objective") ?? "";
        if (!orgName) return sendJson(res, 400, { error: "org required" });
        const org = store.getOrCreateOrg(orgName);
        return sendJson(res, 200, store.findReuseCandidates(org.id, objective));
      }

      if (url.pathname === "/session" && req.method === "POST") {
        const body = (await readJson(req)) as SessionRequest;
        if (!body?.org || !body?.project) {
          return sendJson(res, 400, { error: "org and project required" });
        }
        return handleSession(body, res);
      }

      if (url.pathname === "/api/roles" && req.method === "GET") {
        const orgName = url.searchParams.get("org");
        if (!orgName) return sendJson(res, 400, { error: "org required" });
        const org = store.getOrCreateOrg(orgName);
        return sendJson(res, 200, store.listRoles(org.id));
      }

      if (url.pathname === "/api/roles" && req.method === "POST") {
        const body = (await readJson(req)) as { org: string; name: string; tags?: string[]; wildcard?: boolean };
        if (!body?.org || !body?.name) return sendJson(res, 400, { error: "org and name required" });
        const org = store.getOrCreateOrg(body.org);
        return sendJson(res, 200, store.defineRole(org.id, body.name, { wildcard: body.wildcard, tags: body.tags }));
      }

      if (url.pathname === "/api/org/rules" && req.method === "GET") {
        const orgName = url.searchParams.get("org");
        if (!orgName) return sendJson(res, 400, { error: "org required" });
        const org = store.getOrCreateOrg(orgName);
        return sendJson(res, 200, { rules: store.getOrgRules(org.id) });
      }
      if (url.pathname === "/api/org/rules" && req.method === "POST") {
        const b = (await readJson(req)) as { org: string; rules: string };
        if (!b?.org) return sendJson(res, 400, { error: "org required" });
        const org = store.getOrCreateOrg(b.org);
        store.setOrgRules(org.id, b.rules ?? "");
        return sendJson(res, 200, { ok: true, rules: store.getOrgRules(org.id) });
      }

      if (url.pathname === "/api/audit" && req.method === "GET") {
        const orgName = url.searchParams.get("org");
        if (!orgName) return sendJson(res, 400, { error: "org required" });
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "60", 10) || 60;
        const org = store.getOrCreateOrg(orgName);
        return sendJson(res, 200, store.listAuditEvents(org.id, limit));
      }

      if (url.pathname === "/api/docs" && req.method === "GET") {
        const orgName = url.searchParams.get("org");
        if (!orgName) return sendJson(res, 400, { error: "org required" });
        const org = store.getOrCreateOrg(orgName);
        const docs = store.listDocs(org.id).map((d) => ({
          id: d.id,
          title: d.title,
          updated_at: d.updated_at,
          updated_by: d.updated_by_agent_id ? (store.getAgent(d.updated_by_agent_id)?.name ?? null) : null,
          chars: d.content.length,
        }));
        return sendJson(res, 200, docs);
      }

      if (url.pathname === "/events" && req.method === "GET") {
        const orgName = url.searchParams.get("org");
        if (!orgName) return sendJson(res, 400, { error: "org required" });
        const org = store.getOrCreateOrg(orgName);
        return handleEvents(org.id, res);
      }

      // ── supervisor actions ──
      if (url.pathname === "/agent/retire" && req.method === "POST") {
        const body = (await readJson(req)) as { agentId: string };
        return sendJson(res, 200, store.retireAgent(body.agentId));
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
      // ── skills (per task type) ──
      if (url.pathname === "/api/skills" && req.method === "GET") {
        const orgName = url.searchParams.get("org");
        if (!orgName) return sendJson(res, 400, { error: "org required" });
        const org = store.getOrCreateOrg(orgName);
        return sendJson(res, 200, store.listSkills(org.id));
      }
      if (url.pathname === "/api/skills" && req.method === "POST") {
        const b = (await readJson(req)) as { org: string; name: string; tags?: string[]; instructions?: string; skillUrl?: string };
        if (!b?.org || !b?.name) return sendJson(res, 400, { error: "org and name required" });
        const org = store.getOrCreateOrg(b.org);
        return sendJson(res, 200, store.createSkill(org.id, { name: b.name, tags: b.tags ?? [], instructions: b.instructions, skillUrl: b.skillUrl }));
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
        const org = store.getOrCreateOrg(orgName);
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
        const org = store.getOrCreateOrg(orgName);
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

export function startServer(): Promise<http.Server> {
  startWebhookDelivery();
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
  const server = createServer();
  return new Promise((resolve) => {
    server.listen(port(), HOST, () => resolve(server));
  });
}
