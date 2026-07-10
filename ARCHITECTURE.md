# Lanchu — Architecture

> Concrete design: **surfaces**, **lifecycle**, **identity**, **MCP tools**,
> **resources**, **roles/governance**, **events**. Complements
> [`DEFINITION.md`](./DEFINITION.md) (the why) and
> [`OPEN-QUESTIONS.md`](./OPEN-QUESTIONS.md) (what's still open). It answers: *how does it
> work, exactly?*

---

## 1. The three surfaces

| Surface | What it is | Responsibility |
|-----------|--------|-----------------|
| **CLI / launcher** (`npx lanchu`) | What you run in the terminal. | Onboarding: matches the objective, asks the human the **reuse-or-create** question, picks a role, issues the **identity token**, and keeps the connection alive (= presence). |
| **MCP server** | The shared service the agent connects to (`localhost` HTTP/SSE). | Tools, state (SQLite), roles/governance, event bus, audit. |
| **Web panel** | Supervisor dashboard (open on loopback; access-key–gated when the server sets one). | View agents/activity/audit in real time; retire agents with handoff. |

> **Key:** the *"reuse?"* question happens in the **CLI** (interaction with the
> human), it is **not** an MCP tool. The launcher queries candidates and connects the
> session to the chosen durable identity.

---

## 2. Identity, session, and activity (decision A4)

- On startup, the launcher **issues a session token** bound to an `agent_id`. Every MCP
  call travels with that token → the server knows **which agent** each connection is (and
  nobody can impersonate it locally).
- **Presence (active/idle):** while the launcher is alive and connected (SSE open),
  the agent is **ACTIVE**. When the launcher ends (you close the window) → **IDLE**.
- **Activity ("what it's doing now"):** it is **derived from recent tool-calls** (the last
  task claimed/updated, the last doc touched). It does **not** depend on the agent calling
  a heartbeat. Optionally the agent can annotate with `session.note`, but presence and
  activity don't depend on it.

---

## 3. Lifecycle and durable agents

### Session ≠ Agent
- **Agent** = durable identity (role, scope, tasks, *footprint*, history).
- **Session** = a live connection tied to an agent via a token. Ephemeral.

### States

```mermaid
stateDiagram-v2
    [*] --> ACTIVE: create / reuse
    ACTIVE --> IDLE: launcher ends
    IDLE --> ACTIVE: reopen / reuse
    ACTIVE --> RETIRED: retire (no open tasks)
    IDLE --> RETIRED: retire (no open tasks)
    ACTIVE --> ACTIVE: retire blocked → handoff per task
    RETIRED --> [*]
```

Events: `agent.created` · `agent.reused` · `agent.active` · `agent.idle` ·
`agent.retired`.

### From the objective to the tasks (decision A1)
The launcher registers the objective and **the agent breaks it down into tasks** with `task.create`
(Lanchu doesn't break it down for it). From there on there are concrete tasks to
coordinate around and apply limits to.

### The footprint (reuse by objective)
Each agent accumulates a **footprint**: tasks done, tags/areas touched, context.
On startup with an objective, Lanchu compares against the footprints of the `idle` agents and
returns **candidates** ranked by overlap. *(v0 matching mechanism: tag/keyword
overlap; see [`OPEN-QUESTIONS.md`](./OPEN-QUESTIONS.md).)*

### Safe retirement
Retiring with open tasks **is blocked** until each one is resolved: `task.reassign` to
another agent or `task.release` back to the pool. At the end, `agent.retired`. Nothing orphaned.

---

## 4. Roles and governance (decisions A2, A3)

### Role model
- **Role** = `{ name, allowed_tags: [...] }`, defined by the org (custom). A `*` role
  can touch everything (coordinator).
- **Task** carries `tags: [...]`.
- **Scope rule:** an agent with role *R* can **claim or create** a task *T*
  if `T.tags ⊆ R.allowed_tags`. Otherwise, the action is **rejected** (error) + a
  `scope.violation` event.

### What Lanchu can and can't do (honesty)
Every tool that **mutates** state goes through two steps:
1. **Scope check** against the role and the org's rules → if it violates them, **error**.
2. **Audit logging** of the action (applied *or* rejected), with actor, subject,
   workspace, and cost/tokens **if the agent reports them** (self-reported; Lanchu doesn't measure).

**Real enforcement scope:** the block is hard **only on actions mediated by
Lanchu** (claiming/creating tasks, writing docs). Lanchu **is not an OS sandbox**: it
can't prevent an agent from editing files or running commands on its own. The lane is
**cooperative + auditable**; the trust comes from the fact that **everything stays visible and logged**.
OS-level enforcement is a **non-goal**.

---

## 5. MCP resources (subscribable, read-only)

| URI | Content | Updates when… |
|-----|---------|---------------|
| `lanchu://me` | The agent's identity, role, `allowed_tags`, and open tasks. | any `agent.*` in the org. |
| `lanchu://board` | Agents (state, role, objective, open count, workspace) and tasks, with derived **stale**/**reserved** signals (C4). | any `agent.*` / `task.*`. |
| `lanchu://tasks/mine` | The agent's tasks. | any `task.*`. |
| `lanchu://tasks/available` | The project's available tasks. | any `task.*`. |

The server advertises `resources.subscribe`; it pushes `notifications/resources/updated`
when a relevant org event fires. Broader reads (audit, docs, roles) are available over
HTTP (`/api/*`) and shown in the panel.

---

## 6. Agent tools (MCP)

Fifteen tools, each bound to the calling agent's session (names are the MCP tool ids).

| Tool | Inputs | Notes |
|------|--------|-------|
| `session_whoami` | — | Identity + role + `allowed_tags` + open tasks. |
| `session_leave` | — | Ends the session; the agent goes to **IDLE**. |
| `task_list` | `filter` (`mine`/`available`/`all`) | *Pull* view of the project's tasks. |
| `task_get` | `taskId` | One task's detail (status, tags, owner, workspace, deps). |
| `task_create` | `title`, `tags?`, `deps?` | The agent structures its plan. Rejected if `tags ⊄ allowed_tags`. Emits `task.created`. |
| `task_check_scope` | `taskId` | `yours` / `someone_else` / `out_of_role` / `available`. |
| `task_claim` | `taskId`, `workspace?` | **Atomic lock** + role check. Fails if taken or out of role. Emits `task.claimed`. |
| `task_update` | `taskId`, `status`, `note?`, `tokens?` | `done` unblocks dependents; the response includes a doc *nudge* (C5). Emits `task.started/blocked/completed`. |
| `task_release` | `taskId` | Returns the task to the pool. Emits `task.released`. |
| `task_handoff` | `taskId`, `toAgent`, `note?` | Hand a task **you own** to another agent by name (role-checked, logged). Emits `task.reassigned`. |
| `doc_list` | `query?` | List/search shared docs. |
| `doc_read` | `id` | Read a doc (agents are pushed to read before acting). |
| `doc_update` | `id?`, `title`, `content` | Create or update a doc (upsert). Emits `doc.created/updated`. |
| `org_rules` | — | The org's rules/guidelines the agent must follow. |
| `org_context` | — | Compact briefing (objective, role, rules, open tasks, doc index) to focus and save tokens. |

Org rules are set by the supervisor via `lanchu rules set "…"` or `POST /api/org/rules`.

> There is no `session_register`/`heartbeat`: identity is issued by the **launcher** (§2)
> and presence is derived from recency of activity. `workspace` is generic (a git branch
> is one case). `tokens` is **self-reported** — an MCP server cannot measure model usage.

### Supervisor & pull surfaces (HTTP, not agent tools)
Used by the panel and CLI, not by the agent:
- **Actions:** `POST /agent/retire` (safe — blocks on open tasks), `POST /task/release`,
  `POST /task/reassign` (override; role-checked).
- **Reads:** `/api/board`, `/api/audit`, `/api/docs`, `/api/roles` (+ `POST` to add roles),
  `/api/webhooks`, `/api/recurring`; live event stream at `/events` (SSE).
- **Inbound:** `POST /hooks/intake` creates an unassigned task from an external source.

---

## 7. Events

```
agent.created   agent.active   agent.idle   agent.retired
task.created    task.claimed   task.released  task.started
task.completed  task.blocked   task.reassigned
doc.created     doc.updated
scope.violation
```

**Shape of an event:**
```json
{
  "type": "task.completed",
  "org": "acme", "project": "landing",
  "actor": { "agent": "arregla-login", "role": "frontend" },
  "subject": { "kind": "task", "id": "task-42" },
  "data": { "workspace": "feat/login", "note": "Login done", "tokens": 18240 },
  "timestamp": "2026-07-09T14:30:00Z"
}
```
`tokens` is optional/self-reported. Events feed the panel, MCP notifications, and the
audit log.

---

## 8. Webhooks (shipped)

- **Outbound** — `POST /api/webhooks` registers a URL + event filter (or `*`) + optional
  secret. Every matching event is `POST`ed to the URL, signed with **HMAC-SHA256** in
  `x-lanchu-signature`, at-least-once with backoff. Manage via `lanchu webhooks`.
- **Inbound** — `POST /hooks/intake` creates an unassigned task from a trusted external
  source (optional `x-lanchu-intake-token` when `LANCHU_INTAKE_SECRET` is set).

## 8b. Recurring functions (shipped)

A local scheduler (steady tick) fires **recurring** schedules: each creates an unassigned
task in its project every N minutes, then reschedules. Manage via `lanchu recurring` or
`POST /api/recurring`. Connected agents pick the tasks up like any other — Lanchu
schedules the work, it doesn't run the agents.

## 8c. Remote backend + authentication (shipped)

Lanchu is loopback-first, but one server can back a whole team.

- **Expose it** — `LANCHU_HOST=0.0.0.0` binds beyond loopback. Optionally
  `LANCHU_PUBLIC_URL` sets the base URL advertised to agents as their MCP endpoint
  (otherwise derived from the request's `Host`, falling back to loopback).
- **Authenticate it** — `LANCHU_ACCESS_KEY` gates the admin/API surface and `/session`
  (agent minting). The key may arrive as `Authorization: Bearer <key>`, an
  `x-lanchu-key` header, or a `?key=` query param (for the panel's SSE). Constant-time
  compared. Left open on loopback when unset. Always open: `/health` (liveness) and the
  panel shell `/` (it prompts for the key client-side). `/mcp` is exempt from the
  access-key gate because it carries **per-agent session tokens** — so an agent's MCP
  client needs only its session token, never the admin key. `/hooks/intake` keeps its
  own `LANCHU_INTAKE_SECRET`.
- **Point clients at it** — `LANCHU_SERVER=<base-url>` makes the CLI and agents send all
  traffic to the remote server instead of spawning a local one; the CLI attaches the
  access key to every request and reports a clear error if the key is missing/wrong or
  the server is unreachable.

### Still roadmap
- **Advanced limits / token budgets** (need a local LLM proxy to measure cost).
  Documented so as not to close the door.

---

## 9. How each pillar is resolved (map to the definition)

| Pillar (DEFINITION.md §3) | Mechanism here |
|--------------------------|----------------|
| **1. Frictionless onboarding** | CLI/launcher (§1) + token-based identity (§2). |
| **2. Durable agents** | Lifecycle + footprint (§3); reuse-or-create; safe retirement with `task.reassign`/`task.release`. |
| **3. Lane + visibility** | Roles with tags + scope check (§4); `task.claim` (lock); `lanchu://audit` + panel; minimal `doc.*`. |
