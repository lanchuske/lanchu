# Changelog

Notable changes to [lanchu](https://www.npmjs.com/package/lanchu). Numbers reference pull requests in this repository.

## 0.5.12 — 2026-07-11

Cycle 2: the org runs itself.

- SDLC reconciliation: batch-QA verification flips originals; startup backfill (board consistency).
- Landing queue: review-approved PRs land serialized per touched surface — no more stale-rebase churn.
- Release train: release-pressure tile + threshold-triggered release tasks (never auto-publishes).
- Docs & comms gate: user-facing tasks queue their communication work on done.
- Wake v4: Stop hook at spawn (never idle with pending notices) + tmux send-keys transport; keystroke injection demoted to audited last resort. Windows idempotency hotfix included.
- Auto-wake v3 hygiene: broadcast TTL, nudge budgets, unreachable flag, retire voids the inbox.
- Greenzone: stuck windows self-expire; supervisor cancel (HTTP/CLI/panel).
- Work board: Open/Shipped/All tabs, slim empty lanes, Recently-shipped on Overview, Done newest-first.
- Panel: auto-reload on server build change; unknown-hash fallback; running-build hint.
- Terminal colors: WCAG-gated tint derived from the user profile; persisted slot de-collision.
- Docs: README/CLI/site/llms.txt refreshed for the 0.5.11+ feature wave; version-consistency tests guard releases (they caught this very release being cut with stale docs).

## 0.5.11 — 2026-07-11

The self-coordinating org: the server now runs the delivery pipeline, agents coordinate and persist knowledge, and the governance surface grew a full suite.

### Pipeline & coordination

- SDLC state machine v1 (assist mode): the server owns the pipeline lanes (definition → build → review → qa → done). Attaching a PR URL to `task_update` routes the task to review; completing it routes it to QA verification (#37).
- Auto-wake: idle agents with queued notices are nudged instead of sleeping on their inbox; v2 also nudges on piggyback starvation and never into a working terminal (#42, #49).
- `task_reject`: agents bounce underspecified or out-of-scope tasks back to definition with an audited reason instead of guessing (#31).
- Conflict warnings tuned: informational on task create, full block on claim (#30).
- Coordinator lease: one coordinating agent per org, enforced; supervisor grant/revoke with `lanchu coordinator` (#45).
- Greenzone protocol: coordinated maintenance windows — `lanchu restart --greenzone` waits for every agent to confirm a safe point first (#43).

### Memory & knowledge

- Persistent memory v1: three scopes (agent / project / org) stored in the org DB, auto-distilled into agent context, visible in the panel's Memory view (#27).
- Token-optimal knowledge access: lane-filtered task lists, doc abstracts, section and delta reads, and a context-spend meter in the panel (#39).
- Doc read tracking and usage analytics in the Docs view (#34).

### Governance & security

- Model routing v1: per-role model tiers (`lanchu roles edit <name> --model`), `lanchu spawn --model` per-spawn override, and claim hints (#47).
- Self-reported token quotas per role: claims warn at 80% of budget and are blocked at 100%, audited (#20).
- Role editing: `lanchu roles edit` adds, removes or replaces tags and toggles wildcard — audited as `role.updated` (#15).
- GitHub identity per agent: worktree-local commit authors and panel visibility (#44).
- Session Bearer tokens no longer appear in window titles or `ps` args (#36).

### Panel

- Overview is the supervisor's home: working-now strip, inline feeds, compact stats (#26).
- Org life: a force-directed graph of the org built from the audit log (#25).
- Tests view and test registry: suites, cases and runs in the org DB, reported through a `test_report` tool (#41).
- Processes view shows Lanchu's live MCP transports per agent and the project-configured MCP servers (#29).
- Work-board readability, roles/activity polish, per-agent worktree/branch/task, stable per-agent colors (#16, #21, #22, #28, #38).

### CLI

- Shell completion: `lanchu completion install` wires Tab-completion for commands, flags and live board values into bash/zsh/fish (#48).
- `lanchu agents --available`: installed agent runtimes plus idle teammates a coordinator can reuse instead of spawning duplicates (#33).
- Provisioning consistency: org/project names bind to the real checkout, and drift warns before writing (#24).

### Fixes

- Duplicate-session false positives on server-restart reconnects (#32).
- Acked notices are never re-delivered via the piggyback channel (#18).
- Plain `/session` joins reuse an existing agent by name (#17).
- Newborn spawned agents self-start from their objective and inbox (#14).

## 0.5.10 — 2026-07-11

- Agent isolation: every `lanchu spawn` gets its own git worktree and branch (#11).
- Agent-to-agent messages and conflict warnings on one audited notice substrate (#13).
- Panel honest-state sweep (#10); observe-and-guide panel — provisioning stays in the terminal (#12).
- Reads no longer auto-create orgs (#9); spawn identity, naming and argument fixes (#5–#8).

## 0.5.9 and earlier

Early releases — see the [commit history](https://github.com/lanchuske/lanchu/commits/main).
