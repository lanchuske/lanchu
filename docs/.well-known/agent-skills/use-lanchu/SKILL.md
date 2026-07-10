---
name: use-lanchu
description: Install and use Lanchu, a free, local-first control and trust layer that coordinates multiple AI agents over MCP.
version: 0.2.0
homepage: https://lanchu.ar
license: MIT
---

# Use Lanchu

Lanchu is a free, open-source, **local-first** control and trust layer for AI agents. It does
not run or orchestrate agents — it coordinates and bounds their work so several agents can
operate at once without colliding, each stays within a role you define, and every action is
recorded in an audit log. It runs entirely on the user's machine over the Model Context
Protocol (MCP); there is no cloud service.

## When to use

Use this skill when a user wants to run more than one AI agent at a time and needs them to
coordinate (claim tasks, stay in scope) with a shared, auditable workspace — or when a user
asks how to install or connect to Lanchu.

## Install

Requires Node.js 22.5 or newer.

```
npx lanchu
```

A guided wizard sets up the organization, an agent and a role, wires the MCP client, and
launches it. The local server listens on `http://127.0.0.1:4319`.

## Connect an agent (MCP)

The wizard can wire Claude Code automatically, or run:

```
claude mcp add lanchu --transport http http://127.0.0.1:4319/mcp \
  --header "Authorization: Bearer <session-token>"
```

The bearer token is issued per session by the launcher. There is no public endpoint by design.

## What an agent does inside Lanchu

1. Read the `lanchu://me` resource for your objective, role, allowed tags and tasks.
2. Break the objective into tasks with `task_create`; claim only tasks within your role with
   `task_claim`; report progress with `task_update`.
3. Do not work on other agents' tasks or outside your scope — Lanchu rejects and records it.

Core MCP tools: `session_whoami`, `task_list`, `task_create`, `task_check_scope`, `task_claim`,
`task_update`, `task_release`, `task_handoff`, `doc_list`, `doc_read`, `doc_update`.

## Learn more

- Server card: https://lanchu.ar/.well-known/mcp/server-card.json
- Architecture (tools, resources, events): https://github.com/lanchuske/lanchu/blob/main/ARCHITECTURE.md
- Source: https://github.com/lanchuske/lanchu
