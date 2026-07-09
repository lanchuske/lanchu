# Lanchu — Pre-build review (open questions)

> Critical review of [`DEFINITION.md`](./DEFINITION.md) and
> [`ARCHITECTURE.md`](./ARCHITECTURE.md) **before writing any code**. Lists the gaps,
> inconsistencies, and pending decisions. None of this blocks the *vision*; it blocks the
> *implementation*. To be resolved and closed before v0.

Severity — **blocking**, **important**, **minor** (may be set by default).
Items labelled **Resolved** are integrated into DEFINITION/ARCHITECTURE.

---

## RESOLVED (integrated into the documents)

- **A1** — The agent breaks its objective down into tasks with `task.create` (Lanchu
  doesn't decompose; it stays unopinionated). The objective no longer has an empty `t=0`.
- **A2** — *Custom* roles with tags: `role = {name, allowed_tags}`; tasks with
  `tags`; scope rule `T.tags ⊆ R.allowed_tags`. Role `*` = wildcard.
- **A3** — Honest framing: **cooperative + auditable limits**. Hard block only
  on actions mediated by Lanchu; OS sandbox = **non-goal**.
- **A4** — Identity via the launcher's **session token**; presence = launcher alive;
  activity derived from **recent tool-calls** (not an agent heartbeat).
- **B1** — Lifecycle events renamed and aligned (`agent.created/reused/
  active/idle/retired`).
- **B2** — `branch` → `workspace` (generic; git is one case).
- **B3** — `tokens`/cost marked as **self-reported** (Lanchu doesn't measure it).
- **D1** — Explicit: a semi-technical *operator* sets things up; a non-technical
  *supervisor* observes.
- **D2** — Copy adjusted; "an entire company" stays on the roadmap (remote backend).
- **C1** — Full SQLite schema in [`SCHEMA.md`](./SCHEMA.md).
- **C2** — CLI commands + org/project selection (`.lanchu/config.json`, git-style)
  and role (flag/interactive/wildcard) in [`CLI.md`](./CLI.md).
- **C3** — The launcher wires up the MCP client (token in `Authorization`); the agent
  reads its objective/role/tasks from `lanchu://me`. In [`CLI.md`](./CLI.md).
- **C6** — Panel/server: port 4319, auto-start, `env-paths` paths, local security
  (token in MCP, local panel without auth). In [`CLI.md`](./CLI.md) §7.

- **C4** — *Stale* tasks: *reserved*/*stale* signals (threshold `LANCHU_STALE_HOURS`,
  default 24h), no auto-release; supervisor override `task release`/`task reassign`
  (audited). In [`CLI.md`](./CLI.md) §8 and [`SCHEMA.md`](./SCHEMA.md) §5.
- **C5** — Docs: a *nudge* when closing a task + observability in the panel (objectives
  with no docs touched). Honest promise of "living and traceable". In [`CLI.md`](./CLI.md) §8.

**Everything closed.** No blocking open questions remain. Ready for the v0 scaffold.

---

## A. Foundational gaps (RESOLVED — see above)

### A1. How do *objective*, *task*, and *role* relate to each other?
The flow is `npx lanchu 'fix the login'`. But:
- **Tasks** are the unit of coordination (claim, don't-duplicate) and of scope. When you
  write an objective, **there is no task yet**. Does the objective *become* a task? Does
  the agent create tasks with `task.create` as it works? The human?
- Lanchu is *unopinionated about the plan* (it doesn't decompose). So **who creates the
  tasks** that then get coordinated and scoped?
- Without resolving this, "coordination without duplication" and "hard block by scope"
  have nothing to operate on at `t=0`.

**To define:** the exact objective → task(s) → role relationship, and who creates them.

### A2. Where does an agent's *role* come from, and how is *scope* expressed?
The entire governance depends on the role, but:
- In `npx lanchu 'fix login'` **no role is given**. How does the agent get one? Is it
  inferred from the objective? Are there predefined roles? Does the user define them?
- The "hard block" says "fail if the task is out of role". But **how does Lanchu know
  that a task belongs to a role?** A concrete model is needed: tasks carry
  tags/areas and roles declare what they can claim. That pairing is **not
  defined**.

**To define:** the role model (predefined vs. custom), how it's assigned at launch,
and the concrete role ↔ task rule that makes the block real.

### A3. Honesty about the "hard block": Lanchu is **not** an OS sandbox
This is the most important thing in the whole review.
- Lanchu can only block what **goes through Lanchu** (claiming a task, writing a
  doc). It **cannot physically prevent** an agent from editing a file, running a command,
  or touching a resource on its own — the agent has its own tools outside
  Lanchu.
- In other words: governance is **over the mediated actions**, not over the operating
  system. The "lane" is a **cooperative agreement** that Lanchu makes visible and
  records, not a cage.

**To decide:** how we communicate this honestly ("cooperative + auditable limits"
instead of just "hard block"?) and how far the v0 promise goes.
This affects the README message and the principles.

### A4. Agent identity and who populates the "real-time" activity
- Over `localhost` HTTP/SSE, **how does the server know which agent each connection is?**
  A handshake is needed (a session token issued by the launcher). Without this, any
  local process can impersonate an agent.
- `session.heartbeat` as a tool the agent invokes is **unreliable**: an LLM doesn't call
  a heartbeat on a timer. "Real-time activity" should probably be
  derived from (a) the presence of the launcher process and (b) recent tool
  calls — not from the agent remembering to beat.

**To define:** the identity handshake (local token) and how the "what it's doing right
now" is actually populated (launcher-wrapper vs. the agent's tool-calls).

---

## B. Inconsistencies to fix (I can fix these myself)

### B1. Lifecycle events don't line up with the launcher
`§7` lists `agent.registered`, but `§5` says there is **no `session.register`** (the
launcher does it). And `agent.reused` appears in events but isn't emitted in any flow
described. → Rename/align: `agent.created`, `agent.reused`, `agent.active`,
`agent.idle`, `agent.retired`, `agent.heartbeat`.

### B2. `branch` is baked in, but the audience isn't only code
`task.claim(branch?)`, `heartbeat(branch?)`, and `data.branch` assume git. But
"automating a company" includes work that isn't code. → Generalize to
`workspace`/`context` (with `branch` as an optional special case), so we don't tie
ourselves to git.

### B3. `tokens`/`cost` in audit and events is **self-reported**
Lanchu doesn't measure tokens; the agent reports them (optionally). This has to be stated
explicitly so we don't promise a metric that may never arrive.

---

## C. Missing specs before building

### C1. Data model / schema (SQLite)
Doesn't exist yet. Entities: `org`, `project`, `role`, `agent`, `session`, `task`,
`doc`, `event`/`audit`. Fields, relationships, indexes, and the **task-state enum**
(`available → claimed → in_progress → blocked → done` + reserved by idle agent).

### C2. CLI command surface
We only have `npx lanchu 'objective'`. Missing: `lanchu ls` (agents/tasks),
`lanchu retire <agent>`, `lanchu stats` (local view), `lanchu serve`/panel, org/project
selection (via `cwd`? a flag? config?).

### C3. How the agent's client is configured to talk to the MCP server
The agent (Claude Code, Cursor…) needs to know the URL of the local MCP server. Does the
launcher inject it? The client's config? It's part of "frictionless onboarding".

### C4. Policy for idle "zombie" agents
An idle agent keeps its reserved tasks and **blocks everyone else**. If it never comes
back, those tasks stay stuck until a manual retire. → A timeout / "stale" mark that
releases them or raises an alert?

### C5. "Always up-to-date documentation": a mechanism, not a promise
Today there's only `doc.update`. "Always up to date" isn't achieved just by the tool
existing. → A *nudge* (when closing a task, remind to update the affected doc)? Or do we
lower the promise to "easy to update and traceable"?

### C6. Panel: port, startup, and access
Does the server start it? Fixed/configurable port? Being local and single-user, no auth;
worth writing it down.

---

## D. Scope / positioning tensions (honesty)

### D1. Who is the real "user" of v0?
The message says "for non-technical people". But someone **semi-technical** still has to:
run `npx`, configure the agent's MCP client, have agents installed. The **pure
non-technical** person only uses the **panel** (view and trust). → Worth being explicit:
in v0, a semi-technical *operator* sets things up; the non-technical *supervisor*
observes. Don't promise that a non-technical person sets it all up alone… yet.

### D2. "Automate an entire company" vs. local single-machine
The vision hints at company scale, but v0 is local on one machine. It's already on the
roadmap (remote backend), but the copy shouldn't overpromise.

---

## Suggested order to close

1. Resolve **A1–A4** (foundational blockers) — they change the design.
2. I apply **B1–B3** (inconsistencies) and **D1–D2** (copy nuances).
3. Write **C1** (data schema) and **C2–C3** (CLI + client config).
4. Set **C4–C6** by default.
5. Only then: the v0 scaffold.
