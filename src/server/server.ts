import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { HOST, mcpUrl, port } from "../config.js";
import { uuid } from "../core/ids.js";
import * as store from "../core/store.js";
import { ScopeError } from "../core/types.js";
import { dropContext, getContext, putContext } from "./context.js";
import { buildMcpServer } from "./mcp.js";
import { panelHtml } from "./panel.js";

const transports = new Map<string, StreamableHTTPServerTransport>();

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

  // Existing session: route to its transport.
  if (sid && transports.has(sid)) {
    const transport = transports.get(sid)!;
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
    },
    onsessionclosed: (id) => {
      transports.delete(id);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) transports.delete(transport.sessionId);
  };

  const server = buildMcpServer(ctx);
  await server.connect(transport);

  const body = await readJson(req);
  await transport.handleRequest(req, res, body);
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
  const server = createServer();
  return new Promise((resolve) => {
    server.listen(port(), HOST, () => resolve(server));
  });
}
