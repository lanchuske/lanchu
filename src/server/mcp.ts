import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { baseUrl, VERSION } from "../config.js";
import { bus } from "../core/events.js";
import * as store from "../core/store.js";
import { ScopeError } from "../core/types.js";
import { spawnTerminal, tileTerminals } from "./cockpit.js";
import { putContext, type SessionContext } from "./context.js";

const INSTRUCTIONS = [
  "You are an agent connected to Lanchu, the team's control and coordination layer.",
  "ALWAYS start by reading the lanchu://me resource: it holds your objective, your role,",
  "your allowed tags and your tasks. Then, as your FIRST message to the user, say in one",
  "line that you're connected to Lanchu (your agent name, your role, and how many open",
  "tasks you have) so they know Lanchu is running. Break your objective into tasks with",
  "task_create, claim only the ones that fall within your role (task_claim), and report",
  "progress with task_update. Do not work on other agents' tasks or outside your scope:",
  "Lanchu rejects and records it. If unsure how to proceed, call the help tool.",
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

export interface BuiltServer {
  server: McpServer;
  dispose: () => void;
}

/** Builds an MCP server bound to a session (a specific agent). */
export function buildMcpServer(ctx: SessionContext): BuiltServer {
  const server = new McpServer(
    { name: "lanchu", version: VERSION },
    {
      instructions: INSTRUCTIONS,
      capabilities: { resources: { subscribe: true, listChanged: true } },
    },
  );

  // Live MCP notifications: turn org events into resources/updated pushes.
  const unsubscribe = bus.onEvent((ev) => {
    if (ev.org_id !== ctx.orgId) return;
    const uris = ["lanchu://board"];
    if (ev.actor_agent_id === ctx.agentId) uris.push("lanchu://me");
    if (ev.type.startsWith("task.")) uris.push("lanchu://tasks/mine", "lanchu://tasks/available");
    for (const uri of uris) {
      server.server.sendResourceUpdated({ uri }).catch(() => {
        /* transport may be closing */
      });
    }
  });

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

  server.registerResource(
    "tasks-mine",
    "lanchu://tasks/mine",
    { title: "My tasks", mimeType: "application/json" },
    async () => ({
      contents: [
        {
          uri: "lanchu://tasks/mine",
          mimeType: "application/json",
          text: JSON.stringify(
            store.listTasks(ctx.projectId).filter((t) => t.owner_agent_id === ctx.agentId),
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerResource(
    "tasks-available",
    "lanchu://tasks/available",
    { title: "Available tasks", mimeType: "application/json" },
    async () => ({
      contents: [
        {
          uri: "lanchu://tasks/available",
          mimeType: "application/json",
          text: JSON.stringify(
            store.listTasks(ctx.projectId, "available"),
            null,
            2,
          ),
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
        stage: z.enum(["backlog", "definition", "build", "review", "qa", "done"]).optional()
          .describe("SDLC lane for the board: definition | build | review | qa | done."),
      },
    },
    async ({ title, tags, deps, stage }) => {
      try {
        return text(
          store.createTask({
            projectId: ctx.projectId,
            orgId: ctx.orgId,
            agentId: ctx.agentId,
            title,
            tags,
            deps,
            stage,
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
        const task = store.claimTask({ agentId: ctx.agentId, taskId, workspace });
        // Deliver the right "hat": skills matching this task's type (tags).
        return text({ ...task, applicable_skills: store.skillsForTags(ctx.orgId, task.tags) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "task_update",
    {
      title: "Update task",
      description:
        "Changes status (in_progress|blocked|done). 'done' unblocks dependents. Optionally advance the SDLC stage or attach the PR/MR URL you opened.",
      inputSchema: {
        taskId: z.string(),
        status: z.enum(["in_progress", "blocked", "done"]),
        stage: z.enum(["backlog", "definition", "build", "review", "qa", "done"]).optional()
          .describe("SDLC lane for the board: definition | build | review | qa | done."),
        prUrl: z.string().optional().describe("URL of the pull/merge request for this task."),
        note: z.string().optional(),
        tokens: z.number().optional(),
      },
    },
    async ({ taskId, status, stage, prUrl, note, tokens }) => {
      try {
        const task = store.updateTaskStatus({ agentId: ctx.agentId, taskId, status, stage, prUrl, note, tokens });
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
    "task_get",
    {
      title: "Get task",
      description: "Returns one task's detail (status, tags, owner, workspace).",
      inputSchema: { taskId: z.string() },
    },
    async ({ taskId }) => {
      const task = store.getTask(taskId);
      return task
        ? text({ ...task, applicable_skills: store.skillsForTags(ctx.orgId, task.tags) })
        : fail(new Error("task not found"));
    },
  );

  server.registerTool(
    "task_handoff",
    {
      title: "Hand off task",
      description: "Hand a task you own to another agent (by name), with a note. Role-checked and logged.",
      inputSchema: { taskId: z.string(), toAgent: z.string(), note: z.string().optional() },
    },
    async ({ taskId, toAgent, note }) => {
      try {
        const task = store.getTask(taskId);
        if (!task) return fail(new Error("task not found"));
        if (task.owner_agent_id !== ctx.agentId) return fail(new Error("you don't own this task"));
        const target = store.findAgentByName(ctx.orgId, toAgent);
        if (!target) return fail(new Error(`no agent named '${toAgent}'`));
        return text(
          store.reassignTask({ taskId, toAgentId: target.id, byAgentId: ctx.agentId, note }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "doc_list",
    {
      title: "List docs",
      description: "Lists the org's shared documents (title + metadata).",
      inputSchema: { query: z.string().optional() },
    },
    async ({ query }) => {
      const docs = query ? store.searchDocs(ctx.orgId, query) : store.listDocs(ctx.orgId);
      return text(docs.map((d) => ({ id: d.id, title: d.title, updated_at: d.updated_at })));
    },
  );

  server.registerTool(
    "doc_read",
    {
      title: "Read doc",
      description: "Reads a shared document. Read before acting on its area.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const doc = store.getDoc(id);
      return doc ? text(doc) : fail(new Error("doc not found"));
    },
  );

  server.registerTool(
    "doc_update",
    {
      title: "Create or update doc",
      description: "Creates or updates a shared doc (upsert by id or title). Keeps knowledge current.",
      inputSchema: { id: z.string().optional(), title: z.string(), content: z.string() },
    },
    async ({ id, title, content }) => {
      try {
        return text(store.upsertDoc({ orgId: ctx.orgId, agentId: ctx.agentId, id, title, content }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "org_rules",
    {
      title: "Org rules",
      description: "The organization's rules/guidelines you must follow.",
      inputSchema: {},
    },
    async () => text({ rules: store.getOrgRules(ctx.orgId) }),
  );

  server.registerTool(
    "org_context",
    {
      title: "My minimal context",
      description: "A compact briefing: your objective, role, org rules, open tasks and doc index. Read this to focus and save tokens.",
      inputSchema: {},
    },
    async () => {
      const agent = store.getAgent(ctx.agentId);
      const role = agent ? store.getRole(agent.role_id) : null;
      const openTasks = store.openTasksForAgent(ctx.agentId);
      const tags = [...new Set(openTasks.flatMap((t) => t.tags))];
      return text({
        agent: agent ? { name: agent.name, objective: agent.objective } : null,
        role: role ? { name: role.name, allowed_tags: role.allowed_tags } : null,
        rules: store.getOrgRules(ctx.orgId),
        open_tasks: openTasks,
        skills: store.skillsForTags(ctx.orgId, tags),
        docs: store.listDocs(ctx.orgId).map((d) => ({ id: d.id, title: d.title })),
      });
    },
  );

  server.registerTool(
    "skills_list",
    {
      title: "List skills",
      description: "The org's skills (capability packs, some loaded from an external SKILL.md) and the task tags each one applies to.",
      inputSchema: {},
    },
    async () => text(store.listSkills(ctx.orgId)),
  );

  server.registerTool(
    "skills_for",
    {
      title: "Skill for a task",
      description: "Returns the skill(s) that apply to a task's type — the 'hat' to wear for it.",
      inputSchema: { taskId: z.string() },
    },
    async ({ taskId }) => {
      const task = store.getTask(taskId);
      if (!task) return fail(new Error("task not found"));
      return text(store.skillsForTags(ctx.orgId, task.tags));
    },
  );

  server.registerTool(
    "open_panel",
    {
      title: "Open the dashboard",
      description: "Opens the Lanchu supervisor panel in the user's browser (Lanchu runs on their machine). Use when the user asks to see the dashboard/panel.",
      inputSchema: {},
    },
    async () => {
      const url = baseUrl();
      try {
        const [cmd, cmdArgs] =
          process.platform === "darwin"
            ? ["open", [url]]
            : process.platform === "win32"
              ? ["cmd", ["/c", "start", "", url]]
              : ["xdg-open", [url]];
        spawn(cmd as string, cmdArgs as string[], { detached: true, stdio: "ignore" }).unref();
      } catch {
        /* headless — just return the URL */
      }
      return text({ opened: true, url });
    },
  );

  server.registerTool(
    "spawn_agent",
    {
      title: "Spawn a new agent",
      description:
        "Creates a new teammate in this org and opens a terminal running Claude, already joined to Lanchu, that will ask the user which task to do. Use when the user asks to add/create a new agent.",
      inputSchema: { objective: z.string().optional(), role: z.string().optional() },
    },
    async ({ objective, role }) => {
      try {
        const roleName = role || "generalist";
        const roleObj = store.getOrCreateRole(ctx.orgId, roleName, roleName === "generalist" ? { wildcard: true } : {});
        const agent = store.createAgent({ orgId: ctx.orgId, roleId: roleObj.id, objective });
        const { token } = store.openSession(agent.id);
        store.captureWorkspace(ctx.projectId, agent.id, ctx.cwd);
        putContext({
          token, agentId: agent.id, agentName: agent.name,
          orgId: ctx.orgId, orgName: ctx.orgName, projectId: ctx.projectId, projectName: ctx.projectName, cwd: ctx.cwd,
        });
        const prompt =
          "You are a new Lanchu teammate. Greet the user in one line, then ask which task you should do. When they answer, read org_context, then claim and work the matching task.";
        const result = spawnTerminal({ title: `${ctx.orgName}·${agent.name}`, agentName: agent.name, cwd: ctx.cwd || process.cwd(), token, prompt });
        store.setAgentTerminal(agent.id, result.ref ?? null);
        return text({ agent: agent.name, ...result });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "tile_terminals",
    {
      title: "Tile the terminals",
      description: "Arranges the agent terminals into a mosaic (tmux or macOS Terminal). Use when the user asks to organize/tile the windows.",
      inputSchema: {},
    },
    async () => text(tileTerminals()),
  );

  server.registerTool(
    "help",
    {
      title: "How Lanchu works",
      description: "A short guide to working inside Lanchu — read this if you're unsure how to proceed.",
      inputSchema: {},
    },
    async () =>
      text({
        overview:
          "You are a member of a team coordinated by Lanchu. You coordinate through shared state, not by talking to other agents directly. Everything you do is visible and audited; actions outside your role are rejected.",
        loop: [
          "1. Read org_context (or the lanchu://me resource) for your objective, role, allowed tags, org rules and open tasks.",
          "2. Break your objective into tasks with task_create (only tags within your allowed_tags).",
          "3. Claim a task with task_claim before working it — this prevents duplication. Use task_check_scope if unsure it's yours.",
          "4. Report progress with task_update (in_progress, then done). 'done' unblocks dependent tasks.",
          "5. Keep shared knowledge current with doc_read / doc_update.",
          "6. To pass a task to a specific teammate use task_handoff (with a note); to drop it back to the pool use task_release.",
        ],
        rules: "Never work a task that is someone_else's or out_of_role. Claim before you work. When you finish, record what changed in a doc.",
        tools: "session_whoami, org_context, org_rules, task_list, task_get, task_create, task_check_scope, task_claim, task_update, task_release, task_handoff, doc_list, doc_read, doc_update, session_leave.",
      }),
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

  return { server, dispose: unsubscribe };
}
