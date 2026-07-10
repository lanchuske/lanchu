# Security Policy

## Scope

By default Lanchu runs **100% locally** and has **no central server or telemetry** —
nothing leaves the user's machine. The server binds to `127.0.0.1` only, and the MCP
endpoint requires a per-session token so no other local process can impersonate an agent.

Lanchu can optionally back a team from a shared host (`LANCHU_HOST` to bind beyond
loopback, `LANCHU_SERVER` for clients to point at it). When exposed, set
`LANCHU_ACCESS_KEY`: it gates the admin/API surface and agent minting (`/session`), leaving
only `/health` and the panel shell open. Agents still authenticate their MCP connection
with a per-session token, not the access key. Exposing the host without an access key is
unsafe — the server warns when you do.

Please keep this threat model in mind when reporting: the main surfaces are the HTTP
server (and its access-key gate), the MCP transport/token handling, session-context
handling, and the SQLite data layer.

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

Instead, use GitHub's private vulnerability reporting:
**Security → Report a vulnerability** on the repository, or email the maintainer listed on
the GitHub profile.

Please include:
- A description of the issue and its impact.
- Steps to reproduce (a minimal proof of concept if possible).
- Affected version/commit.

We aim to acknowledge reports within a few days and will coordinate a fix and disclosure
timeline with you.

## Supported versions

Lanchu is pre-1.0 (`0.x`). Fixes land on `main`; please test against the latest commit
before reporting.
