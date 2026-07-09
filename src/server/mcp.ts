import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as store from "../core/store.js";
import { ScopeError } from "../core/types.js";
import type { SessionContext } from "./context.js";

const INSTRUCTIONS = [
  "You are an agent connected to Lanchu, the team's control and coordination layer.",
  "ALWAYS start by reading the lanchu://me resource: it holds your objective, your role,",
  "your allowed tags and your tasks. Break your objective into tasks with task_create,",
  "claim only the ones that fall within your role (task_claim), and report progress with",
  "task_update. Do not work on other agents' tasks or outside your scope: Lanchu rejects",
  "and records it.",
].join(" ");

function text(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const kind = err instanceof ScopeError ? "scope_violation" : "error";
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ kind, message }) }],
  };
}

/** Builds an MCP server bound to a session (a specific agent). */
export function buildMcpServer(ctx: SessionContext): McpServer {
  const server = new McpServer(
    { name: "lanchu", version: "0.0.1" },
    { instructions: INSTRUCTIONS },
  );

  // ── Resources ───────────────────────────────────────────────
  server.registerResource(
    "me",
    "lanchu://me",
    { title: "My identity, role and tasks", mimeType: "application/json" },
    async () => {
      const agent = store.getAgent(ctx.agentId);
      const role = agent ? store.getRole(agent.role_id) : null;
      const tasks = store.openTasksForAgent(ctx.agentId);
      return {
        contents: [
          {
            uri: "lanchu://me",
            mimeType: "application/json",
            text: JSON.stringify({ agent, role, open_tasks: tasks }, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "board",
    "lanchu://board",
    { title: "Organization board", mimeType: "application/json" },
    async () => ({
      contents: [
        {
          uri: "lanchu://board",
          mimeType: "application/json",
          text: JSON.stringify(store.boardSnapshot(ctx.orgId), null, 2),
        },
      ],
    }),
  );

  // ── Tools ───────────────────────────────────────────────────
  server.registerTool(
    "session_whoami",
    {
      title: "Who am I",
      description: "Returns your identity, role, allowed tags and open tasks.",
      inputSchema: {},
    },
    async () => {
      const agent = store.getAgent(ctx.agentId);
      const role = agent ? store.getRole(agent.role_id) : null;
      return text({ agent, role, open_tasks: store.openTasksForAgent(ctx.agentId) });
    },
  );

  server.registerTool(
    "task_list",
    {
      title: "List tasks",
      description: "Lists project tasks. filter: mine | available | all.",
      inputSchema: { filter: z.enum(["mine", "available", "all"]).default("all") },
    },
    async ({ filter }) => {
      let tasks = store.listTasks(ctx.projectId);
      if (filter === "mine") tasks = tasks.filter((t) => t.owner_agent_id === ctx.agentId);
      else if (filter === "available") tasks = tasks.filter((t) => t.status === "available");
      return text(tasks);
    },
  );

  server.registerTool(
    "task_create",
    {
      title: "Create task",
      description: "Creates a task. Rejected if its tags fall outside your role.",
      inputSchema: {
        title: z.string(),
        tags: z.array(z.string()).default([]),
        deps: z.array(z.string()).default([]),
      },
    },
    async ({ title, tags, deps }) => {
      try {
        return text(
          store.createTask({
            projectId: ctx.projectId,
            orgId: ctx.orgId,
            agentId: ctx.agentId,
            title,
            tags,
            deps,
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "task_check_scope",
    {
      title: "Can I take this task?",
      description: "Returns yours | someone_else | out_of_role | available.",
      inputSchema: { taskId: z.string() },
    },
    async ({ taskId }) => {
      try {
        return text({ scope: store.checkScope(ctx.agentId, taskId) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "task_claim",
    {
      title: "Claim task",
      description: "Atomic lock + scope check. Fails if already taken or out of role.",
      inputSchema: { taskId: z.string(), workspace: z.string().optional() },
    },
    async ({ taskId, workspace }) => {
      try {
        return text(store.claimTask({ agentId: ctx.agentId, taskId, workspace }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "task_update",
    {
      title: "Update task",
      description: "Changes status (in_progress|blocked|done). 'done' unblocks dependents.",
      inputSchema: {
        taskId: z.string(),
        status: z.enum(["in_progress", "blocked", "done"]),
        note: z.string().optional(),
        tokens: z.number().optional(),
      },
    },
    async ({ taskId, status, note, tokens }) => {
      try {
        const task = store.updateTaskStatus({ agentId: ctx.agentId, taskId, status, note, tokens });
        const nudge =
          status === "done"
            ? "Remember to update the relevant documentation with what changed."
            : undefined;
        return text({ task, nudge });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "task_release",
    {
      title: "Release task",
      description: "Returns the task to the pool so another agent can take it.",
      inputSchema: { taskId: z.string() },
    },
    async ({ taskId }) => {
      try {
        return text(store.releaseTask({ agentId: ctx.agentId, taskId }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "session_leave",
    {
      title: "End session",
      description: "Ends your session; the agent goes idle (it is not deleted).",
      inputSchema: {},
    },
    async () => {
      store.endSessionsForAgent(ctx.agentId);
      return text({ ok: true, state: "idle" });
    },
  );

  return server;
}
