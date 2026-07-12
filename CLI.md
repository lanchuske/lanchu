# Lanchu — CLI and startup flow

> Command surface and exactly what happens when you run `npx lanchu`.
> Covers commands + org/project/role selection and how the agent's
> client connects to the MCP server. Delivers pillar #1: *frictionless onboarding*.
> Complements [`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`SCHEMA.md`](./SCHEMA.md).
> `lanchu help` prints the same surface from the CLI; `lanchu help <topic>` narrows
> to one section (topics: start, orgs, agents, governance, automation, server,
> maintenance, flags).

---

## 1. Invocation

```bash
npx lanchu                           # guided onboarding wizard (org, agent, role) + launch Claude
npx lanchu work ["<objective>"]      # same wizard, optionally pre-filling the objective
npx lanchu "<objective>" [options]   # non-interactive onboard (for scripting)
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
| `--tags a,b` | Tags for a role created on the fly. |
| `--as <name>` | Name of the new agent (otherwise derived from the objective: `fix-login`). |
| `--reuse <agent>` | Reuses that agent without asking. |
| `--new` | Forces creating a new one (skips the reuse prompt). |
| `--client <claude\|print>` | How to connect the agent (see §5). `print` = just prints the config. |

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

- **Known clients** (`--client claude`): the CLI registers an MCP server
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

Grouped as in `lanchu help`.

### Orgs & projects

| Command | What it does |
|---------|----------|
| `lanchu init --org <name> [--project <name>] [--force]` | Binds this directory to an org/project (writes `.lanchu/config.json`). `--org` is required (no silent default); the project name defaults from the checkout (repo root / remote / folder) and drift warns; rebinding an already-bound directory needs `--force`. |
| `lanchu orgs [rm <name>]` | Lists every org (with counts) / deletes one. |
| `lanchu projects` | Lists this org's projects (each = a repo + local folder). |

### Agents & tasks

| Command | What it does |
|---------|----------|
| `lanchu agents` (alias `ls`) | Lists agents: status, role, task count, last activity. |
| `lanchu agents --available` | Availability in both senses: agent **runtimes** installed on this machine (claude, codex, gemini… with version+path) and idle **teammates** in the org a coordinator can reuse instead of spawning duplicates. |
| `lanchu tasks` | Lists tasks: status, owner, tags, workspace. Flags the **stale** ones (idle owner with no changes ≥ threshold). |
| `lanchu spawn ["<objective>"] [--role r] [--model m] [--no-isolate] [--dry]` | Launches a **new agent in a new terminal**, in its own git worktree + branch (skip isolation with `--no-isolate`; preview with `--dry`). `--model` overrides the role's preferred tier for this spawn. |
| `lanchu tile [--dry]` | Arranges the agent terminals into a mosaic. |
| `lanchu retire <agent>` | **Safe retirement**: if it has open tasks, requires reassigning or releasing each one; then archives. |
| `lanchu shutdown [--stop-server] [--retire] [--force]` | Closes the org cleanly: courtesy broadcast, closes every agent terminal (agents stay **durable** by default — `--retire` retires them instead, handoff-enforced per agent), optionally stops the server. Refuses if any task is claimed/in_progress or a greenzone is active; `--force` overrides (human-only — denied from a non-TTY). |
| `lanchu close <agent>` | Closes **one** agent's terminal: notifies it first, then closes, leaving it durable-idle (not retired). |
| `lanchu task release <id>` | **Supervisor override**: releases a task back to the pool even if it has an owner. Audited. Escape hatch for *stale* tasks without retiring the agent. |
| `lanchu task reassign <id> <agent>` | **Supervisor override**: reassigns a task to another agent. Audited. |

### Governance

| Command | What it does |
|---------|----------|
| `lanchu roles` | Lists roles and their tags. |
| `lanchu roles add <name> --tags ui,css` \| `--wildcard` | Creates a role. |
| `lanchu roles edit <name> --add-tags a,b --rm-tags c` \| `--tags x,y` \| `--wildcard`/`--no-wildcard` | Edits an existing role's scope: adds/removes tags, `--tags` replaces the whole set, toggles wildcard. Audited as `role.updated`. |
| `lanchu roles edit <name> --model <opus\|sonnet\|haiku>` \| `--no-model` | Sets/clears the role's **preferred model tier** — agents spawned with the role launch on it by default (`lanchu spawn --model` overrides per spawn). Audited in `role.updated`. |
| `lanchu roles edit <name> --quota <tokens>` \| `--no-quota` | Sets/clears the role's **self-reported token budget**: agents report tokens on `task_update`; the panel shows consumption vs quota, claims warn at 80% and are blocked at 100% (audited as `quota.exceeded`). |
| `lanchu rules [set "<text>"]` | Views / sets the org's rules — the guidelines every agent receives. |
| `lanchu coordinator [set <agent> \| clear]` | Shows the org's **coordinator lease** — one coordinating agent per org, enforced — or grants/revokes it (supervisor). |
| `lanchu rotate-tokens` | **Security**: ends every open session in the org so their tokens stop authenticating. Run after a token exposure; agents get fresh tokens when they re-register (spawn / panel reveal). Audited as `session.rotated`. |
| `lanchu skills [add <name> --tags a,b --instructions "…"]` | Lists skills / creates one — per-task-type instructions agents receive when claiming matching work. |
| `lanchu skills load <url\|file> [--name n] [--tags a,b]` | Loads a reusable `SKILL.md` from a URL or file. |
| `lanchu skills reload <id>` \| `rm <id>` | Re-fetches a loaded skill / removes one. |
| `lanchu stats` (alias `status`) | **Local** view for you (agents, tasks, orgs). Never leaves your machine. |

### Automation

| Command | What it does |
|---------|----------|
| `lanchu webhooks [add <url> --events a,b \| rm <id>]` | Outbound webhooks (HMAC-signed) on org events. |
| `lanchu recurring [add "<title>" --every <min> \| rm <id>]` | Scheduled task creation. |

### Server & panel

| Command | What it does |
|---------|----------|
| `lanchu serve` | Runs the server in the foreground (normally it auto-starts). |
| `lanchu stop` | Stops the background server. |
| `lanchu restart [--greenzone] [--timeout <s>]` | Restarts the server. `--greenzone` coordinates it: every connected agent confirms a safe point before the server goes down. |
| `lanchu completion [bash\|zsh\|fish]` \| `install` | Shell Tab-completion for commands, flags and live board values (agent/task/org names); `install` wires it into your shell rc. |
| `lanchu panel` (alias `open`) | Opens the web panel in the browser. |
| `lanchu statusline` | Status line for Claude Code (setup shown when run). |
| `lanchu doctor` | Checks the environment: Node version, free port, config, DB — plus the agent-runtime inventory found on PATH. Also reads this directory's `lanchu` MCP entry (if any) and names why its token is dead (unknown / retired / rotated) instead of a bare all-green. |
| `lanchu reconnect` | Restores `/mcp` in this directory when its session died: reads the local Claude MCP entry, mints a fresh session reusing that identity (confirms first if the agent was retired), rewrites the entry via `claude mcp remove` + `add`. Then run `/mcp` → reconnect inside Claude Code. |

### Maintenance

| Command | What it does |
|---------|----------|
| `lanchu upgrade` | Checks npm for a newer version. |
| `lanchu notify on\|off` | Opt-in update notifications (off by default; only reads the public npm registry). |
| `lanchu install-commands [--uninstall]` | Adds the `/lanchu` slash command to Claude Code. |
| `lanchu uninstall [--purge]` | Stops the server; `--purge` deletes local data. |
| `lanchu help [<topic>]` \| `version` | Shows help (optionally one topic) / prints the version. |

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
- **`LANCHU_TERM_TITLE`**: spawned-terminal title format — default `org·agent` (e.g.
  `lanchu·builder-core-2`); `agent` for just the agent name; `role` for just the role
  (falls back to the agent name when the agent has none). Purely cosmetic — `lanchu tile`
  matches terminals by window/pane id, never by title.

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
