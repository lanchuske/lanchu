# Lanchu — CLI and startup flow

> Command surface for v0 and exactly what happens when you run `npx lanchu`.
> Resolves **C2** (commands + org/project/role selection) and **C3** (how the agent's
> client connects to the MCP server). Delivers pillar #1: *frictionless onboarding*.
> Complements [`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`SCHEMA.md`](./SCHEMA.md).

---

## 1. Invocation

```bash
npx lanchu <objective> [options]     # main command (onboard/resume)
npx lanchu <subcommand> [options]    # management
```

No global install required. The first `npx lanchu` on a machine also **starts the
local server** if it isn't already running (see §7).

---

## 2. The main command: `lanchu <objective>`

Puts an agent into the org with a job and leaves it ready to start.

```bash
npx lanchu 'fix the login'
```

**Options:**

| Option | Effect |
|--------|--------|
| `--org <name>` | Forces the organization (otherwise resolved from the directory; see §4). |
| `--project <name>` | Forces the project. |
| `--role <name>` | Role of the **new** agent (otherwise chosen interactively). |
| `--as <name>` | Name of the new agent (otherwise derived from the objective: `fix-login`). |
| `--reuse <agent>` | Reuses that agent without asking. |
| `--new` | Forces creating a new one (skips the reuse prompt). |
| `--client <claude\|cursor\|print>` | How to connect the agent (see §5). `print` = just prints the config. |
| `--run "<cmd>"` | Additionally **launches** that agent command for you (convenience; opt-in). |

**Example session:**
```text
$ npx lanchu 'fix the login'
● Lanchu server active (http://127.0.0.1:4319)
● Org: acme · Project: web   (from ./.lanchu/config.json)

? An agent already worked on 'login':
  › fix-login   (idle · frontend role · 2 open tasks · 3 h ago)
    ─ create a new agent ─
  [Enter] reuse   ·   [n] new

▸ Reusing 'fix-login'  (role: frontend)
▸ Session started · token issued
▸ MCP client 'claude' connected to lanchu (session-scoped)

Done. Start your agent; it will read its objective, role, and tasks from Lanchu.
  claude "continue with your work in Lanchu"
Panel: http://127.0.0.1:4319
```

---

## 3. Startup flow (step by step)

```
npx lanchu 'fix the login'
   │
   1. Local server alive?  ── no ─▶ start it in the background (§7)
   │
   2. Resolve ORG + PROJECT  (from ./.lanchu/config.json; if missing → `lanchu init`)
   │
   3. Reuse-or-create:
   │     · look for idle agents whose footprint overlaps the objective
   │     · candidates found → ask the human (CLI)
   │     · create → choose ROLE (--role or interactive) + name
   │
   4. The server issues a session TOKEN bound to the agent  →  agent ACTIVE
   │
   5. Connect the agent's client to the MCP server with that token (§5)
   │
   6. (new) register the objective; the agent will break it down into tasks on startup
   │
   ▼
   On startup, the agent reads `lanchu://me` (objective + role + tasks + rules) and works.
```

Steps 1–5 happen in the **CLI/launcher**. Step 6 onward is the agent via
MCP tools. The CLI **does not manage the agent's process** (except `--run`, opt-in).

---

## 4. Org / project / role

### Org and project (C2)
Resolved from the **current directory**, git-style:
- The CLI looks for `./.lanchu/config.json` (walking up the parents):
  ```json
  { "org": "acme", "project": "web" }
  ```
- If it doesn't exist → it runs `lanchu init` (interactive): asks for the org (named explicitly —
  there is no invented default) and derives the project name from the real checkout (repo root
  folder, then the origin remote's name, then the folder). Name↔folder drift warns and asks
  before writing, so a record can't silently bind to a folder it doesn't describe. That way,
  next time is zero friction.
- `--org` / `--project` always take precedence over the config.

### Role (when creating a new agent)
- `--role <name>` if you know it.
- Otherwise, the CLI shows the **org's roles** to choose from.
- If the org **has no roles**, it offers: create one (`name` + `--tags ui,css`) or use the
  **wildcard role `*`** (touches everything) to get started quickly.
- A **reused agent keeps its role**; you're not asked again.

---

## 5. Connecting the agent's client (C3)

The agent (Claude Code, Cursor, …) needs to know **which MCP server to talk to and with which
token**. The CLI wires it up for you:

- **Known clients** (`--client claude|cursor`): the CLI registers an MCP server
  *scoped* to this session. For Claude Code this is equivalent to:
  ```bash
  claude mcp add lanchu --transport http \
    http://127.0.0.1:4319/mcp \
    --header "Authorization: Bearer <session-token>"
  ```
- **Anything else** (`--client print`): prints the config snippet for you to paste.
- The **token goes in the `Authorization` header** (not in the URL). The server validates it and
  knows **which agent** each connection is (prevents local impersonation).
- When the session ends (`lanchu retire`, or closing), the *scoped* entry can be removed.

**How the agent knows what to do on connecting:** the MCP server exposes server-level
*instructions* —"you are a Lanchu agent: start by reading
`lanchu://me` (your objective, role, tasks, and rules); work only within your scope;
coordinate by creating/claiming tasks"— which the client passes to the model. The objective and
tasks live in `lanchu://me`, not in the prompt.

---

## 6. Management commands

| Command | What it does |
|---------|----------|
| `lanchu init --org <name> [--project <name>] [--force]` | Binds this directory to an org/project (writes `.lanchu/config.json`). `--org` is required (no silent default); the project name defaults from the checkout (repo root / remote / folder) and drift warns; rebinding an already-bound directory needs `--force`. |
| `lanchu agents` (alias `ls`) | Lists agents: status, role, task count, last activity. |
| `lanchu agents --available` | Availability in both senses: agent **runtimes** installed on this machine (claude, codex, gemini… with version+path) and idle **teammates** in the org a coordinator can reuse instead of spawning duplicates. |
| `lanchu tasks` | Lists tasks: status, owner, tags, workspace. Flags the **stale** ones (idle owner with no changes ≥ threshold). |
| `lanchu task release <id>` | **Supervisor override**: releases a task back to the pool even if it has an owner. Audited. Escape hatch for *stale* tasks without retiring the agent. |
| `lanchu task reassign <id> <agent>` | **Supervisor override**: reassigns a task to another agent. Audited. |
| `lanchu retire <agent>` | **Safe retirement**: if it has open tasks, requires reassigning or releasing each one; then archives. |
| `lanchu roles` | Lists roles and their tags. |
| `lanchu roles add <name> --tags ui,css` \| `--wildcard` | Creates a role. |
| `lanchu roles edit <name> --add-tags a,b --rm-tags c` \| `--tags x,y` \| `--wildcard`/`--no-wildcard` | Edits an existing role's scope: adds/removes tags, `--tags` replaces the whole set, toggles wildcard. Audited as `role.updated`. |
| `lanchu roles edit <name> --model <opus\|sonnet\|haiku>` \| `--no-model` | Sets/clears the role's **preferred model tier** — agents spawned with the role launch on it by default (`lanchu spawn --model` overrides per spawn). Audited in `role.updated`. |
| `lanchu roles edit <name> --quota <tokens>` \| `--no-quota` | Sets/clears the role's **self-reported token budget**: agents report tokens on `task_update`; the panel shows consumption vs quota, claims warn at 80% and are blocked at 100% (audited as `quota.exceeded`). |
| `lanchu rotate-tokens` | **Security**: ends every open session in the org so their tokens stop authenticating. Run after a token exposure; agents get fresh tokens when they re-register (spawn / panel reveal). Audited as `session.rotated`. |
| `lanchu stats` | **Local** view for you (agents, tasks, orgs). Never leaves your machine. |
| `lanchu panel` (alias `open`) | Opens the web panel in the browser. |
| `lanchu serve` | Runs the server in the foreground (normally it auto-starts). |
| `lanchu stop` | Stops the background server. |
| `lanchu doctor` | Checks the environment: Node version, free port, config, DB — plus the agent-runtime inventory found on PATH. |

---

## 7. The local server

- **Auto-start:** the main command starts the server in the background if it isn't running.
  `lanchu serve` runs it in the foreground; `lanchu stop` stops it.
- **Port:** `4319` by default (configurable with `LANCHU_PORT` or in the config).
- **Endpoints:** panel at `http://127.0.0.1:4319/` · MCP at `http://127.0.0.1:4319/mcp`.
- **State on disk:** via `env-paths('lanchu')` (OS-agnostic):
  - macOS: `~/Library/Application Support/lanchu/`
  - Linux: `~/.local/share/lanchu/`
  - Windows: `%APPDATA%\lanchu\`
  - DB: `<stateDir>/lanchu.db` (SQLite/WAL).
- **Security:** loopback (`127.0.0.1`) and open by default — single-user, nothing
  leaves the machine. The **MCP requires a per-session token** so no process can
  impersonate an agent. Spawned terminals receive that token via a **mode-600
  config file** under `<stateDir>/run/` (removed when the agent exits), never on
  the command line — window titles and `ps` args must stay token-free. If a token
  does leak, `lanchu rotate-tokens` invalidates every open session in the org.
- **`LANCHU_STALE_HOURS`** (default `24`): after how many hours a task belonging to an
  idle agent is marked **stale**.

### Remote backend + authentication

Run one Lanchu server for a team and point every CLI/agent at it.

- **Serve it (on the host):**
  - `LANCHU_HOST=0.0.0.0` — bind beyond loopback so others can reach it.
  - `LANCHU_ACCESS_KEY=<secret>` — **required once you expose the host.** It gates the
    whole admin/API surface and `/session` (minting agents). `serve`/`doctor` warn if
    the host is exposed without a key.
  - `LANCHU_PUBLIC_URL=https://lanchu.example.com` — the reachable base URL advertised
    to agents as their MCP endpoint (otherwise derived from the request's `Host`).
- **Connect to it (on each machine):**
  - `LANCHU_SERVER=https://lanchu.example.com` — send all CLI/agent traffic here
    instead of spawning a local server.
  - `LANCHU_ACCESS_KEY=<secret>` — the same shared key; the CLI attaches it to every
    request.
- **What each credential protects:** the **access key** is the human/admin gate (CLI,
  panel, session minting). Each **agent** still authenticates its MCP connection with
  its own per-session token — the access key is *not* needed by the agent's MCP client.
- **Panel:** the page loads without the key and prompts for it; you can also open it
  with `?key=<secret>` once (it's stored locally). `/health` stays open for liveness
  probes.

---

## 8. *Stale* tasks and documentation (C4, C5)

- **Stale (C4):** two derived signals — *reserved* (idle owner, any age)
  and *stale* (idle owner **and** no changes ≥ `LANCHU_STALE_HOURS`). Both show up in
  `lanchu tasks` and in the panel. **There is no auto-release**; the supervisor decides with
  `lanchu task release/reassign` (override, audited).
- **Docs (C5):** *nudge + observability*, without forcing anything. When you close a task (`task.update`
  → `done`), the result **reminds you to update the relevant doc**; and the panel shows whether
  an objective closed tasks **without touching documentation**, so the supervisor can
  see it. The honest promise is *living, traceable documentation*, not guaranteed.

---

## 9. Minor pending detail

- Automatically retire/clean up the *scoped* MCP entry when the session ends.
