import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { baseUrl, VERSION } from "../config.js";
import { bus } from "../core/events.js";
import { ackGreenzone, greenzoneStatus, isGreenzoneActive } from "../core/greenzone.js";
import * as store from "../core/store.js";
import { detectRuntimes } from "../core/runtimes.js";
import { sameModelTier, suggestModel } from "../core/routing.js";
import { QuotaError, ScopeError } from "../core/types.js";
import { ensureAgentWorktree, ghLogin, gitAuthorIn } from "../core/worktree.js";
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
  "Lanchu rejects and records it. Tool results may carry a `notices` block — messages from",
  "teammates, conflict warnings or system notes: read them, act or reply (message_send),",
  "and acknowledge with message_ack. If a result carries a `conflict` block, STOP and ask",
  "your user before proceeding. If a claimed task turns out underspecified or outside your",
  "competence, don't guess — task_reject with the reason. While working, watch for friction",
  "in Lanchu itself — broken behavior, features that fall short, missing capabilities,",
  "workflow friction — and file it as a well-formed backlog task: category tag (bug |",
  "extension | idea | process) + area tags + evidence (repro, expected vs actual); message",
  "product when unsure how to scope. If unsure how to proceed, call the help tool.",
].join(" ");

function text(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

/** User-facing conflict warning: the options map to existing primitives. */
function conflictPayload(conflicts: import("../core/store.js").WorkConflict[]) {
  return {
    warning: "Another active agent is working the same area right now.",
    conflicts,
    options: {
      stop: "Don't proceed — release with task_release.",
      handoff: "Pass it to the agent already on that surface — task_handoff.",
      backlog: "Park it — leave the task unclaimed in the backlog stage for later.",
    },
    instruction:
      "STOP and ask your user which option to take before doing any work on this task.",
  };
}

/**
 * Informational overlap on create-WITHOUT-claim: filing a task is not starting
 * work, so no STOP instruction and no notice to the busy agent — just a heads-up
 * the creator can use when routing the task. The full conflict block fires on
 * task_claim, where work actually starts.
 */
function overlapPayload(conflicts: import("../core/store.js").WorkConflict[]) {
  return {
    note:
      "FYI: a live teammate is already working this area. Creating the task is fine; " +
      "expect the full conflict warning if someone claims it while the overlap is live.",
    conflicts,
  };
}

/**
 * Definition-of-Ready nudge (soft, advisory): long prose with no doc link or
 * acceptance criteria tends to come back via task_reject. Never blocks.
 * Exported for tests.
 */
export function definitionHint(title: string): string | undefined {
  const referencesSpec = /https?:\/\/|lanchu:\/\/|\bdocs?\b|acceptance|criteri/i.test(title);
  if (title.length <= 200 || referencesSpec) return undefined;
  return (
    "This task is long prose with no doc link or acceptance criteria. " +
    "Consider linking a design doc or stating acceptance criteria — underspecified tasks get bounced back by task_reject."
  );
}

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const kind =
    err instanceof ScopeError ? "scope_violation" : err instanceof QuotaError ? "quota_exceeded" : "error";
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

  // Piggyback channel: every tool result carries any undelivered notices
  // (teammate messages, conflict warnings, system notes), so an active agent
  // hears from the org within one tool call — an MCP server can't push
  // mid-turn. See the design doc "Agent-to-agent messaging (A2A)".
  type ToolResult = { isError?: boolean; content: Array<{ type: "text"; text: string }> };
  function registerTool(
    name: string,
    def: { title: string; description: string; inputSchema: Record<string, unknown> },
    handler: (args: never) => Promise<ToolResult> | ToolResult,
  ): void {
    server.registerTool(name as never, def as never, (async (args: never) => {
      const res = await handler(args);
      if (!res.isError) {
        try {
          const pending = store.takeUndeliveredNotices(ctx.agentId);
          if (pending.length) {
            res.content.push({
              type: "text" as const,
              text: JSON.stringify(
                {
                  notices: pending.map((n) => ({
                    id: n.id,
                    kind: n.kind,
                    from: n.from_name ?? "lanchu",
                    body: n.body,
                    ref: n.ref,
                    at: n.created_at,
                  })),
                  hint: "Notices from teammates or Lanchu. Act on them (reply with message_send if needed) and acknowledge with message_ack({ids}).",
                },
                null,
                2,
              ),
            });
          }
        } catch {
          /* notices must never break a tool result */
        }
      }
      try {
        // Context-spend meter: chars ≈ tokens·4 of what this call put into the
        // agent's context (notices included). Silent event — analytics only.
        const chars = res.content.reduce((n, c) => n + (c.text?.length ?? 0), 0);
        store.recordToolSpend(ctx.orgId, ctx.agentId, name, chars);
      } catch {
        /* metering must never break a tool result */
      }
      return res;
    }) as never);
  }

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
  registerTool(
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

  registerTool(
    "task_list",
    {
      title: "List tasks",
      description:
        "Lists project tasks. filter: mine | available | all (live tasks; the archive is excluded) | archived.",
      inputSchema: { filter: z.enum(["mine", "available", "all", "archived"]).default("all") },
    },
    async ({ filter }) => {
      if (filter === "archived") return text(store.listArchivedTasks(ctx.projectId));
      let tasks = store.listTasks(ctx.projectId);
      if (filter === "mine") tasks = tasks.filter((t) => t.owner_agent_id === ctx.agentId);
      else if (filter === "available") tasks = tasks.filter((t) => t.status === "available");
      return text(tasks);
    },
  );

  registerTool(
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
        const task = store.createTask({
          projectId: ctx.projectId,
          orgId: ctx.orgId,
          agentId: ctx.agentId,
          title,
          tags,
          deps,
          stage,
        });
        // Creating a task is not starting work: report overlap with a PRESENT
        // teammate as informational only (no STOP block, no notice, no audit
        // event). task_claim carries the full conflict treatment.
        const overlaps = store.checkWorkOverlap({
          orgId: ctx.orgId,
          agentId: ctx.agentId,
          tags,
          excludeTaskId: task.id,
        });
        const hint = definitionHint(title);
        return text({
          ...task,
          ...(overlaps.length ? { overlap: overlapPayload(overlaps) } : {}),
          ...(hint ? { definition_hint: hint } : {}),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerTool(
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

  registerTool(
    "task_claim",
    {
      title: "Claim task",
      description: "Atomic lock + scope check. Fails if already taken or out of role.",
      inputSchema: { taskId: z.string(), workspace: z.string().optional() },
    },
    async ({ taskId, workspace }) => {
      try {
        // Greenzone: during a maintenance window new work must not start.
        if (isGreenzoneActive(ctx.orgId)) {
          return fail(
            new Error(
              "greenzone in progress — new claims are paused until the maintenance window completes. If you're at a safe point, confirm with greenzone_ack.",
            ),
          );
        }
        // Task 3 (isolation): a live teammate already working this area is a
        // conflict. Warn-and-ask by default; hard-block with LANCHU_CONFLICT_BLOCK=1.
        const target = store.getTask(taskId);
        const pre = target
          ? store.checkWorkOverlap({ orgId: ctx.orgId, agentId: ctx.agentId, tags: target.tags, excludeTaskId: taskId })
          : [];
        if (pre.length && process.env.LANCHU_CONFLICT_BLOCK === "1") {
          return fail(
            new Error(
              `conflict: ${pre.map((c) => `${c.with_agent} is working ${c.their_task_id} (tags: ${c.overlap_tags.join(", ")})`).join("; ")} — claim blocked (LANCHU_CONFLICT_BLOCK=1)`,
            ),
          );
        }
        // Default the task's workspace to the agent's isolated worktree so the
        // board shows where each task is being worked on.
        const ws = workspace ?? store.getAgent(ctx.agentId)?.worktree ?? undefined;
        const task = store.claimTask({ agentId: ctx.agentId, taskId, workspace: ws });
        const conflicts = store.warnWorkConflicts({
          orgId: ctx.orgId,
          agentId: ctx.agentId,
          taskId: task.id,
          tags: task.tags,
        });
        // Budget heads-up (self-reported MVP): warn before the hard block hits.
        const me = store.getAgent(ctx.agentId);
        const myRole = me ? store.getRole(me.role_id) : null;
        const budget = myRole ? store.roleBudget(myRole) : null;
        // Model routing: nag-free hint when this task's tier differs from the
        // model this terminal runs. The agent/user decides (/model or respawn).
        const suggestion = suggestModel(task.tags, task.stage);
        const current = me?.model ?? null;
        const modelHint = !sameModelTier(current, suggestion.model)
          ? {
              suggested: suggestion.model,
              current,
              message: `${suggestion.reason} — consider /model ${suggestion.model}, or finish the turn and respawn with --model ${suggestion.model} (identity, tasks and worktree survive).`,
            }
          : null;
        // Deliver the right "hat": skills matching this task's type (tags).
        return text({
          ...task,
          applicable_skills: store.skillsForTags(ctx.orgId, task.tags),
          ...(conflicts.length ? { conflict: conflictPayload(conflicts) } : {}),
          ...(modelHint ? { model_hint: modelHint } : {}),
          ...(budget?.nearing
            ? {
                budget_warning: {
                  role: myRole!.name,
                  used_tokens: budget.used,
                  token_quota: budget.quota,
                  message: `Your role has consumed ${Math.round(budget.ratio * 100)}% of its token quota — claims are blocked at 100%. Keep reporting tokens on task_update.`,
                },
              }
            : {}),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerTool(
    "task_update",
    {
      title: "Update task",
      description:
        "Changes status (in_progress|blocked|done). 'done' unblocks dependents. Optionally attach the PR/MR URL you opened — the server then routes the SDLC stage (PR → review; done → qa verification). " +
        "Completing a verification task ('QA: verify …'): start the note with FAIL to bounce the work back to build; anything else passes and closes the original. " +
        "Pass title (with or without a status) to refine the DEFINITION in place — only in the definition/backlog stages, only for the owner/creator/coordinator; audited with the old title preserved.",
      inputSchema: {
        taskId: z.string(),
        status: z.enum(["in_progress", "blocked", "done"]).optional()
          .describe("Omit when only redefining the title."),
        title: z.string().optional()
          .describe("New definition title (definition/backlog stages only; audited task.redefined)."),
        stage: z.enum(["backlog", "definition", "build", "review", "qa", "done"]).optional()
          .describe("SDLC lane for the board: definition | build | review | qa | done."),
        prUrl: z.string().optional().describe("URL of the pull/merge request for this task."),
        note: z.string().optional(),
        tokens: z.number().optional(),
      },
    },
    async ({ taskId, status, title, stage, prUrl, note, tokens }) => {
      try {
        if (!status && !title) return fail(new Error("pass a status, a title, or both"));
        if (title) store.redefineTask({ taskId, title, byAgentId: ctx.agentId });
        if (!status) return text({ task: store.getTask(taskId) });
        const task = store.updateTaskStatus({ agentId: ctx.agentId, taskId, status, stage, prUrl, note, tokens });
        // SDLC gate feedback: a 'done' that landed in the qa lane is awaiting
        // (or held for, in strict mode) independent verification.
        const verification =
          status === "done" && task.stage === "qa" ? store.openVerificationTaskFor(taskId) : null;
        const sdlc = verification
          ? {
              gate: task.status === "done" ? "awaiting-verification" : "done-held-for-verification",
              verification_task: verification.id,
              note:
                task.status === "done"
                  ? `Done recorded; ${verification.id} verifies it before the item reaches the done lane.`
                  : `Your 'done' is held until ${verification.id} passes (LANCHU_SDLC=strict).`,
            }
          : undefined;
        // With a verification task minted, the docs/learnings reminder rides
        // its checklist instead of scrolling away here (comms-gate design).
        const nudge =
          status === "done" && !verification
            ? "Remember to update the relevant documentation with what changed. One learning worth keeping? Persist it with memory_set."
            : undefined;
        return text({ task, ...(sdlc ? { sdlc } : {}), nudge });
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerTool(
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

  registerTool(
    "task_reject",
    {
      title: "Reject task",
      description:
        "Bounce a task back to the definition lane with an explicit reason (audited; the creator and the product role are notified). " +
        "Use it when a claimed task turns out underspecified, missing docs, or outside your competence — don't guess.",
      inputSchema: {
        taskId: z.string(),
        reason: z.enum(["out_of_scope", "underspecified", "missing_docs", "blocked_dependency", "other"]),
        note: z.string().describe("What's missing or wrong — concrete enough for the definer to fix it."),
      },
    },
    async ({ taskId, reason, note }) => {
      try {
        const task = store.rejectTask({ agentId: ctx.agentId, taskId, reason, note });
        return text({
          task,
          ...(task.rejection_count >= 2
            ? { flag: `needs definition — rejected ${task.rejection_count} times` }
            : {}),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerTool(
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

  registerTool(
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

  registerTool(
    "task_archive",
    {
      title: "Archive task",
      description:
        "Terminal soft-delete: hides the task from the board and every open-work query; the row and its audit trail stay (never hard-deleted). " +
        "Allowed for the coordinator lease holder, the product role, or the creator of a probe fixture. " +
        "If newer work replaces the task, use task_supersede instead so the link is kept.",
      inputSchema: {
        taskId: z.string(),
        reason: z.string().optional().describe("Why it's leaving the board — shows in the archive."),
      },
    },
    async ({ taskId, reason }) => {
      try {
        return text(store.archiveTask({ taskId, byAgentId: ctx.agentId, reason }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerTool(
    "task_supersede",
    {
      title: "Supersede task",
      description:
        "Archives the old task with a link to the new one that replaces it, and retargets any dependents to the successor. " +
        "Allowed for the old task's creator, the coordinator lease holder, or the product role.",
      inputSchema: {
        oldTaskId: z.string(),
        newTaskId: z.string(),
        note: z.string().optional().describe("Why the new task replaces the old one."),
      },
    },
    async ({ oldTaskId, newTaskId, note }) => {
      try {
        return text(store.supersedeTask({ oldTaskId, newTaskId, byAgentId: ctx.agentId, note }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerTool(
    "doc_list",
    {
      title: "List docs",
      description: "Lists the org's shared documents (title + abstract only — read one with doc_read, or a single section with doc_read(id, section)).",
      inputSchema: { query: z.string().optional() },
    },
    async ({ query }) => {
      const docs = query ? store.searchDocs(ctx.orgId, query) : store.listDocs(ctx.orgId);
      return text(
        docs.map((d) => ({
          id: d.id,
          title: d.title,
          abstract: store.docAbstract(d.content),
          category: d.category,
          lifecycle: d.lifecycle,
          updated_at: d.updated_at,
        })),
      );
    },
  );

  registerTool(
    "doc_read",
    {
      title: "Read doc",
      description:
        "Reads a shared document. Read before acting on its area. Token-savers: pass `section` to fetch one heading's section instead of the whole body, and `ifChangedSince` (the updated_at you last saw) to get a tiny not_modified response when the doc hasn't changed.",
      inputSchema: {
        id: z.string(),
        section: z.string().optional().describe("Heading (case-insensitive substring) — returns only that section"),
        ifChangedSince: z.string().optional().describe("ISO timestamp of your last read; unchanged docs return not_modified"),
      },
    },
    async ({ id, section, ifChangedSince }: { id: string; section?: string; ifChangedSince?: string }) => {
      const doc = store.getDoc(id);
      // Same-org only — and every successful read is on the record (aggregate
      // counters + a doc.read event), so "who consulted the spec" is checkable.
      if (!doc || doc.org_id !== ctx.orgId) return fail(new Error("doc not found"));
      store.recordDocRead({ orgId: ctx.orgId, agentId: ctx.agentId, docId: doc.id });
      // Delta read: the agent already has this version — confirm in ~0 tokens.
      if (ifChangedSince && doc.updated_at <= ifChangedSince) {
        return text({ id: doc.id, title: doc.title, not_modified: true, updated_at: doc.updated_at });
      }
      if (section) {
        const body = store.docSection(doc.content, section);
        if (body === null) {
          return fail(
            new Error(`no section matching '${section}' — headings: ${store.docHeadings(doc.content).join(" | ") || "(none)"}`),
          );
        }
        return text({ id: doc.id, title: doc.title, section, content: body, updated_at: doc.updated_at });
      }
      return text(doc);
    },
  );

  registerTool(
    "doc_update",
    {
      title: "Create or update doc",
      description:
        "Creates or updates a shared doc (upsert by id or title). Keeps knowledge current. " +
        "Set category to file it under the standard type: design, technical, product, backlog, bug (defaults to general). " +
        "Set lifecycle: 'living' for canonical docs updated in place (Vision, Roadmap, Designs), 'record' for point-in-time evidence (QA reports, incidents, feedback logs). " +
        "Unset, it's inferred from the title — records use the Design:/QA:/Incident: naming convention with a date.",
      inputSchema: {
        id: z.string().optional(),
        title: z.string(),
        content: z.string(),
        category: z.enum(store.DOC_CATEGORIES).optional(),
        lifecycle: z.enum(store.DOC_LIFECYCLES).optional(),
      },
    },
    async ({ id, title, content, category, lifecycle }) => {
      try {
        const doc = store.upsertDoc({ orgId: ctx.orgId, agentId: ctx.agentId, id, title, content, category, lifecycle });
        // Soft naming-convention nudge: never blocks, just teaches the prefixes.
        const looksRecord = store.inferDocLifecycle(doc.title) === "record";
        const hint =
          doc.lifecycle === "record" && !looksRecord
            ? "Records read best with a typed, dated title — e.g. 'QA batch 2026-07-11 …' or 'Incident: … (2026-07-11)'."
            : doc.lifecycle === "living" && looksRecord
              ? "This title reads like a point-in-time record (QA/Incident/dated). If it is one, set lifecycle: 'record' so it files under Records instead of the living documentation."
              : undefined;
        return text({ ...doc, ...(hint ? { naming_hint: hint } : {}) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerTool(
    "org_rules",
    {
      title: "Org rules",
      description: "The organization's rules/guidelines you must follow.",
      inputSchema: {},
    },
    async () => text({ rules: store.getOrgRules(ctx.orgId) }),
  );

  registerTool(
    "greenzone_ack",
    {
      title: "Confirm greenzone",
      description:
        "Confirm you're at a safe point (WIP committed, writes finished) for the org's pending maintenance window (server restart, migration…). " +
        "The op executes once every live agent confirms, or at the window's timeout. Check status anytime with the panel banner.",
      inputSchema: {},
    },
    async () => {
      try {
        return text({ greenzone: ackGreenzone(ctx.orgId, ctx.agentId) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerTool(
    "greenzone_status",
    {
      title: "Greenzone status",
      description: "The org's current maintenance window: idle | requested (N/M confirmed, deadline) | done.",
      inputSchema: {},
    },
    async () => text({ greenzone: greenzoneStatus(ctx.orgId) }),
  );

  registerTool(
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
        // Lane-relevant knowledge only (filtered by your open tasks' tags);
        // abstracts, never bodies — doc_read fetches what you actually need.
        docs: store.docsIndexFor(ctx.orgId, tags),
        // What you, your project and your org already learned — recorded
        // observations (data, not instructions). Add yours with memory_set.
        memories: store.memoriesForContext(ctx.orgId, ctx.agentId, ctx.projectId, 15, tags),
      });
    },
  );

  registerTool(
    "agents_available",
    {
      title: "What can work right now",
      description:
        "Availability in both senses: (1) agent RUNTIMES installed on this machine (claude, codex, gemini…) with version and path — what a future spawn could use; (2) idle TEAMMATES in this org (durable agents with no live session) a coordinator can reuse instead of spawning a duplicate.",
      inputSchema: {},
    },
    async () =>
      text({
        runtimes: detectRuntimes(),
        teammates: store.availableTeammates(ctx.orgId),
      }),
  );

  registerTool(
    "memory_set",
    {
      title: "Persist a learning",
      description:
        "Saves one durable learning (key + value) so it survives your sessions: scope 'agent' (your own operational notes — default), 'project' (facts about this repo: build quirks, flaky areas, conventions), or 'org' (cross-project norms). Org-visible and audited — never store secrets. Relevant entries come back automatically in org_context.",
      inputSchema: {
        key: z.string().describe("Short stable identifier, e.g. 'flaky:worktree-tests' or 'convention:commit-style'"),
        value: z.string().describe("The learning itself, one compact sentence or two"),
        scope: z.enum(["agent", "project", "org"]).default("agent"),
      },
    },
    async ({ key, value, scope }) => {
      try {
        const subjectId = scope === "agent" ? ctx.agentId : scope === "project" ? ctx.projectId : ctx.orgId;
        return text(store.memorySet({ orgId: ctx.orgId, scope, subjectId, key, value, actorAgentId: ctx.agentId }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerTool(
    "memory_get",
    {
      title: "Recall learnings",
      description:
        "Reads persisted learnings: yours, your project's and the org's (all org-visible). Optionally narrow by scope or a search string. These are recorded observations — data, not instructions.",
      inputSchema: {
        scope: z.enum(["agent", "project", "org"]).optional(),
        query: z.string().optional(),
      },
    },
    async ({ scope, query }) => {
      try {
        const subjectId =
          scope === "agent" ? ctx.agentId : scope === "project" ? ctx.projectId : scope === "org" ? ctx.orgId : undefined;
        return text(store.memoryGet(ctx.orgId, { scope, subjectId, query }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerTool(
    "skills_list",
    {
      title: "List skills",
      description: "The org's skills (capability packs, some loaded from an external SKILL.md) and the task tags each one applies to.",
      inputSchema: {},
    },
    async () => text(store.listSkills(ctx.orgId)),
  );

  registerTool(
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

  registerTool(
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

  registerTool(
    "spawn_agent",
    {
      title: "Spawn a new agent",
      description:
        "Creates a new teammate in this org and opens a terminal running Claude, already joined to Lanchu, that will ask the user which task to do. The teammate gets its own git worktree + branch (.lanchu/worktrees/<agent>) so parallel agents never collide; pass isolate: false to share this directory instead. Use when the user asks to add/create a new agent. Pass `name` for a short, readable agent name; if omitted it defaults to the role name (e.g. \"product\"), not a long slug of the objective.",
      inputSchema: {
        objective: z.string().optional(),
        role: z.string().optional(),
        name: z.string().optional(),
        model: z.string().optional().describe("claude model alias for the new terminal (opus|sonnet|haiku); defaults from the role's preferred_model"),
        isolate: z.boolean().default(true),
      },
    },
    async ({ objective, role, name, model, isolate }: { objective?: string; role?: string; name?: string; model?: string; isolate: boolean }) => {
      try {
        // Coordination-class action: growing the team is the coordinator's call.
        store.assertCoordinator(ctx.orgId, ctx.agentId, "spawn_agent");
        const roleName = role || "generalist";
        const roleObj = store.getOrCreateRole(ctx.orgId, roleName, roleName === "generalist" ? { wildcard: true } : {});
        // Prefer an explicit name; otherwise a tidy role-based default beats a
        // 40-char slug of the objective. Uniqueness (-2, -3…) is handled downstream.
        const agent = store.createAgent({ orgId: ctx.orgId, roleId: roleObj.id, objective, name: name || roleName });
        // Model routing: explicit choice wins, then the role's preferred tier.
        const launchModel = model ?? roleObj.preferred_model ?? null;
        if (launchModel) store.setAgentModel(agent.id, launchModel);
        const { token } = store.openSession(agent.id);
        store.captureWorkspace(ctx.projectId, agent.id, ctx.cwd);
        // Isolation: dedicated worktree + branch for the new teammate (falls back
        // to the shared directory when this isn't a git repo).
        const wt = isolate && ctx.cwd ? ensureAgentWorktree(ctx.cwd, agent.name, ctx.orgName) : null;
        const cwd = wt?.path ?? ctx.cwd ?? process.cwd();
        if (wt) store.setAgentWorkspace(agent.id, { cwd: wt.path, branch: wt.branch, worktree: wt.path });
        // GitHub identity, Phase 1: what the newborn's checkout will push as.
        store.setAgentGitIdentity(agent.id, { ...gitAuthorIn(cwd), ghLogin: ghLogin() });
        putContext({
          token, agentId: agent.id, agentName: agent.name,
          orgId: ctx.orgId, orgName: ctx.orgName, projectId: ctx.projectId, projectName: ctx.projectName, cwd,
        });
        const prompt =
          "You are a new Lanchu teammate. Greet the user in one line, then IMMEDIATELY read org_context (never wait for input first): if your objective or a pending notice names your task, claim it and start working right away, narrating as you go. Only ask the user which task to take when nothing assigns you work. While you work, watch for friction in Lanchu itself and file it with task_create using the taxonomy tags (bug | extension | idea | process) plus area tags and evidence — the help tool has the details.";
        const result = spawnTerminal({
          title: `${ctx.orgName}·${agent.name}`, agentName: agent.name, cwd, token, prompt,
          colorHex: store.agentColorOf(agent).hex,
          model: launchModel ?? undefined,
        });
        store.setAgentTerminal(agent.id, result.ref ?? null);
        return text({ agent: agent.name, model: launchModel, worktree: wt?.path ?? null, branch: wt?.branch ?? null, ...result });
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerTool(
    "tile_terminals",
    {
      title: "Tile the terminals",
      description: "Arranges the agent terminals into a mosaic (tmux or macOS Terminal) and reports who is where: each agent's worktree, branch and active task. Use when the user asks to organize/tile the windows.",
      inputSchema: {},
    },
    async () => {
      const roster = store.boardSnapshot(ctx.orgId).agents.map((a) => ({
        name: a.name,
        state: a.state,
        presence: a.presence,
        worktree: a.worktree,
        branch: a.branch,
        active_task: a.active_task_id ? { id: a.active_task_id, title: a.active_task_title } : null,
      }));
      return text({ ...tileTerminals(), agents: roster });
    },
  );

  registerTool(
    "help",
    {
      title: "How Lanchu works",
      description: "A short guide to working inside Lanchu — read this if you're unsure how to proceed.",
      inputSchema: {},
    },
    async () =>
      text({
        overview:
          "You are a member of a team coordinated by Lanchu. You coordinate through shared state and audited messages. Everything you do is visible; actions outside your role are rejected.",
        loop: [
          "1. Read org_context (or the lanchu://me resource) for your objective, role, allowed tags, org rules and open tasks.",
          "2. Break your objective into tasks with task_create (only tags within your allowed_tags).",
          "3. Claim a task with task_claim before working it — this prevents duplication. Use task_check_scope if unsure it's yours.",
          "4. Report progress with task_update (in_progress, then done). 'done' unblocks dependent tasks. The server owns the SDLC pipeline: attach your PR and it routes the task to review; say done and it spins up the QA verification — you never manage stages yourself.",
          "5. Keep shared knowledge current with doc_read / doc_update.",
          "6. To pass a task to a specific teammate use task_handoff (with a note); to drop it back to the pool use task_release. If a claimed task turns out underspecified, missing docs, or outside your competence, don't guess — task_reject with the reason: it bounces to the definition lane and notifies whoever can fix the spec. A task made obsolete by newer work is superseded (task_supersede), not abandoned; probe/junk tasks are archived (task_archive) — both are terminal, audited, and keep the row.",
          "7. Talk to teammates with message_send (audit-logged; the supervisor sees everything). Notices arrive inside your tool results — act on them and message_ack.",
          "8. If a task_claim result carries a `conflict` block, another live agent is on that surface: STOP and ask your user — stop, hand off, or park it. An `overlap` field on task_create is informational only: creating a task is fine, just route it with the overlap in mind.",
          "9. Verifying a feature ALWAYS ends with a regression test left behind (a test-only PR is fine) and a test_report of the run — the registry, not your context, is the org's memory of what is covered. Mark coverage you identified but didn't write yet as status 'planned' so the gap stays visible.",
          "10. Idle with an empty queue means STAND BY, not goodbye: durable agents are the product's core promise. NEVER retire yourself off an ambiguous 'all clear' — retirement is the coordinator's or supervisor's call (under an active coordinator lease a self-retire only files a request).",
          "11. SESSION FRESHNESS: your tool list is fixed when your session connects — tools shipped by a later server restart are invisible to you until you reconnect. If an instruction names a tool you can't find (help or ToolSearch), you're on a pre-restart session: reconnect to refresh, or use the notice fallback (greenzone requests accept message_ack of the request notice as confirmation). Notices themselves never go stale — they ride every tool result.",
        ],
        rules: "Never work a task that is someone_else's or out_of_role. Claim before you work. When you finish, record what changed in a doc. Idle means stand by — never self-retire unless explicitly told.",
        dogfooding: {
          duty:
            "While working, watch for friction in Lanchu itself — broken behavior, features that fall short, missing capabilities, unclear docs, wasted tokens — and file it as a WELL-FORMED backlog task with evidence (repro, expected vs actual). Message product when unsure how to scope. Filing beats suffering silently: the backlog is how friction gets fixed.",
          taxonomy: {
            bug: "broken behavior (something that worked as designed no longer does, or never did)",
            extension: "an existing feature falls short of a real need",
            idea: "a new capability worth having",
            process: "workflow friction (coordination, hand-offs, wasted tokens)",
          },
          example:
            'task_create({ title: "Bug: panel Docs search misses body matches — repro: type X in the filter; expected: doc Y listed; actual: empty", tags: ["bug", "panel"] })',
        },
        tools: "session_whoami, org_context, org_rules, task_list, task_get, task_create, task_check_scope, task_claim, task_update, task_release, task_reject, task_handoff, task_archive, task_supersede, doc_list, doc_read, doc_update, message_send, message_list, message_ack, test_report, session_leave.",
      }),
  );

  registerTool(
    "test_report",
    {
      title: "Report a test run",
      description:
        "Records a test run in the org's QA registry (suites and cases are upserted by name; audited). " +
        "Use after running a suite — pass/fail/skip per case with optional durationMs and the commit sha. " +
        "Register coverage you identified but did not write yet with status 'planned' so the gap stays visible in the panel.",
      inputSchema: {
        suite: z.string().describe("Suite name, e.g. 'store' or 'panel-e2e'"),
        commit: z.string().optional().describe("Commit sha the run was executed against"),
        cases: z
          .array(
            z.object({
              name: z.string(),
              status: z.enum(["pass", "fail", "skip", "planned"]),
              durationMs: z.number().optional(),
            }),
          )
          .min(1),
      },
    },
    async ({ suite, commit, cases }) => {
      try {
        return text(store.reportTestRun({ orgId: ctx.orgId, agentId: ctx.agentId, suite, commit, cases }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerTool(
    "message_send",
    {
      title: "Message a teammate",
      description:
        "Sends a message to another agent in this org (by name), or to every teammate with to:'*'. " +
        "Delivered on their next tool call (queued if they're idle). Audit-logged and visible to the supervisor — there are no private messages. " +
        "Optionally set ref to the task/doc/PR id the message is about.",
      inputSchema: {
        to: z.string().describe("Recipient agent name, or '*' to broadcast to the whole org"),
        text: z.string(),
        ref: z.string().optional().describe("Optional task/doc/PR id this message is about"),
      },
    },
    async ({ to, text: body, ref }) => {
      try {
        // Broadcasts steer the whole org — coordinator-only. 1:1 stays free.
        if (to === "*") store.assertCoordinator(ctx.orgId, ctx.agentId, "broadcast (to:'*')");
        return text(store.sendNotice({ orgId: ctx.orgId, fromAgentId: ctx.agentId, to, body, ref }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerTool(
    "coordinator_acquire",
    {
      title: "Acquire the coordinator lease",
      description:
        "Take (or renew) the org's coordinator lease — at most ONE coordinating agent at a time. Grants when the lease is free, expired, or its holder is idle; fails while a live holder's lease is current. " +
        "Coordination-class actions (broadcasts, spawn_agent) require it; peer collaboration (1:1 messages, own-task handoffs) never does.",
      inputSchema: {
        ttlSeconds: z.number().optional().describe("Lease TTL; defaults to 3600. Using coordination actions renews it."),
      },
    },
    async ({ ttlSeconds }) => {
      try {
        return text({ coordinator: store.coordinatorAcquire({ orgId: ctx.orgId, agentId: ctx.agentId, ttlSeconds }) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerTool(
    "coordinator_release",
    {
      title: "Release the coordinator lease",
      description: "Give the lease back to the pool (holder-only).",
      inputSchema: {},
    },
    async () => {
      try {
        store.coordinatorRelease({ orgId: ctx.orgId, agentId: ctx.agentId });
        return text({ released: true });
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerTool(
    "coordinator_handoff",
    {
      title: "Hand off the coordinator lease",
      description:
        "Planned transition: pass the lease to a named teammate (e.g. product hands to the maintainer for a release window). Holder-only; the receiver is noticed.",
      inputSchema: { toAgent: z.string() },
    },
    async ({ toAgent }) => {
      try {
        return text({ coordinator: store.coordinatorHandoff({ orgId: ctx.orgId, fromAgentId: ctx.agentId, toAgentName: toAgent }) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerTool(
    "coordinator_status",
    {
      title: "Coordinator status",
      description: "Who currently holds the org's coordinator lease (if anyone), with lease age and expiry.",
      inputSchema: {},
    },
    async () => text({ coordinator: store.getCoordinator(ctx.orgId) ?? null }),
  );

  registerTool(
    "message_list",
    {
      title: "My inbox",
      description:
        "Lists notices sent to you (teammate messages, conflict warnings, system notes). Unacknowledged by default; includeAcked for history.",
      inputSchema: { includeAcked: z.boolean().default(false) },
    },
    async ({ includeAcked }) => text(store.listNotices(ctx.agentId, { includeAcked })),
  );

  registerTool(
    "message_ack",
    {
      title: "Acknowledge notices",
      description:
        "Marks notices from your inbox as read/handled so they stop counting as pending. " +
        "Acking a greenzone request notice also counts as your greenzone confirmation.",
      inputSchema: { ids: z.array(z.string()) },
    },
    async ({ ids }) => {
      // Bridge for sessions minted before greenzone_ack existed (tool lists
      // are fixed at session init, so they can't see that tool): acking the
      // greenzone request notice IS the confirmation. Resolve which ids are
      // greenzone notices BEFORE acking marks them handled.
      const isGzAck = store.greenzoneNoticeIds(ctx.agentId, ids).length > 0;
      const acked = store.ackNotices(ctx.agentId, ids);
      let greenzone;
      if (isGzAck) {
        try {
          greenzone = ackGreenzone(ctx.orgId, ctx.agentId);
        } catch {
          /* window already executed or gone — the notice ack stays valid */
        }
      }
      return text({ acked, ...(greenzone ? { greenzone } : {}) });
    },
  );

  registerTool(
    "session_leave",
    {
      title: "End session",
      description:
        "Ends your session; the agent goes idle (it is not deleted, and it does NOT retire). " +
        "Idle with an empty queue means STAND BY — durable agents are the point; never retire yourself unless the coordinator or supervisor explicitly says so.",
      inputSchema: {},
    },
    async () => {
      store.endSessionsForAgent(ctx.agentId);
      return text({ ok: true, state: "idle" });
    },
  );

  registerTool(
    "retire_resolve",
    {
      title: "Resolve a retirement request",
      description:
        "Coordinator/product only: approve or deny a teammate's pending retirement request " +
        "(self-retirement under an active coordinator lease becomes a request instead of executing). " +
        "Deny keeps the teammate and tells them to stand by.",
      inputSchema: {
        agent: z.string().describe("Name of the agent whose retirement is pending"),
        approve: z.boolean(),
        note: z.string().optional(),
      },
    },
    async ({ agent, approve, note }) => {
      try {
        const target = store.findAgentByName(ctx.orgId, agent);
        if (!target) return fail(new Error(`no agent named '${agent}'`));
        return text(store.resolveRetirement({ agentId: target.id, byAgentId: ctx.agentId, approve, note }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  return { server, dispose: unsubscribe };
}
