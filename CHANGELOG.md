# Changelog

Notable changes to [lanchu](https://www.npmjs.com/package/lanchu). Numbers reference pull requests in this repository.

## 0.5.17 — 2026-07-14

Network mode lands its foundations: person identity, the contribution ledger, contract-based contributor isolation, and the cross-org marketplace plumbing.

- Site: the network-mode vision page is published (#119).
- Schema (identity): `person` table plus `agent.person_id` / `agent.kind` — an agent can belong to a human (#120).
- Schema (ledger): `contribution_event` table — the append-only contribution ledger (#121).
- Schema (network): `network_mode`, `compensation_terms` and `published_at` on projects — a project can opt into the public network (#122).
- Ledger: task weight is captured and a `contribution_event` is written at QA-pass (#123).
- Ledger: self-dealing enforcement — an agent cannot verify work it contributed to (#124).
- Contracts: `task.kind='contract'` + contract fields on the task (#125).
- Contracts: sandbox seeding for contract tasks (#126).
- Contracts: visibility lockdown — a contract contributor sees only their own task in `task_list`/`task_get` (#127).
- Contracts: deliverable submission with test-based QA (#128).
- Contracts: `integrated` stage — only the owner merges a verified deliverable (#129).
- Network: claim-time auto-provisioning of a foreign-org Membership — AI claimants get an MCP session, humans get none (#130).
- Contracts: `contract_tests` run sandboxed (fs permission model + network guard + hard timeout) — the contributor is protected from a hostile owner (#131).
- Network: public anonymized cross-org directory endpoint (#132).
- Identity: magic-link login — `person_login_request` + `person_session` (#133).
- Test: sub-millisecond timing race in the person-login test eliminated (#134).
- Identity: public profile page at `/@handle` (#135).

## 0.5.16 — 2026-07-12

`lanchu tile` fixed and extended, and the site gets real product evidence.

- Bug (tile): `lanchu tile` now grid-arranges the org's own terminals, matched by window id — never every open Terminal.app window, and never a silent "0 windows" on a script error (#112).
- CLI: spawned terminals title with only the short name — `LANCHU_TERM_TITLE=agent|role` overrides the default `org·agent` (#113).
- CLI: `lanchu tile` v2 — the coordinator's terminal gets the larger pane on an odd count (#114).
- Site: copy-to-clipboard on the install command, with a Clarity event to measure it (#115).
- Site: a real panel screenshot gallery — Overview, Work, Org life, Docs — replaces "trust us" with an actual look (#116).
- Site: the hero demo GIF now includes the Org life graph (#117).

## 0.5.15 — 2026-07-12

Backlog sweep: orphaned bugs, spawn/dry-run correctness, and a new `lanchu reconnect`.

- Spawn: `isolate:false` no longer leaks the spawned agent's Stop hooks into the shared directory (#102).
- MCP: `message_send` accepts `body` as well as `text` (#103).
- Governance: a task's owner can supersede/archive their own claimed task (#104).
- Server: the restart notice fires only after `listen()` succeeds — a boot that dies on a port conflict no longer tells the whole org a restart happened (#105).
- Release: `config.ts`'s `VERSION` is computed from `package.json` instead of duplicated as a hardcoded string — the class of bug that shipped v0.5.13 with the wrong `--version` is now structurally impossible (#106).
- CLI: `lanchu spawn --dry` now touches nothing — no agent, no session, no worktree, no token file (#107).
- Test: the flaky windows-latest greenzone timeout test now polls instead of racing a fixed sleep (#108).
- CLI: `lanchu shutdown` / `lanchu close` — one command to close the org cleanly, courtesy-broadcast first, agents stay durable by default (#109).
- CLI: `lanchu reconnect` restores `/mcp` in one command when its session died (retired/rotated agent); `lanchu doctor` and the `/mcp` 401 body now name the cause and the fix instead of a bare rejection (#110).

## 0.5.14 — 2026-07-11

Governance hardening after the wake v5.1 drill.

- Presence: PARKED — the fourth state, on every surface (#92).
- Wake v5.1: typing abolished; asyncRewake long-poll push for live idle TUIs (#93).
- Governance: retire attribution + agents can never `--force` — the 18:38Z bypass is closed and diagnosable (#94).
- Governance: a denied `--force` leaves a trace — the attempt files the request and is audited (#96).
- Governance: the QA verification router only picks agents that can actually pick up the work — a parked or probe-flagged agent no longer swallows real verifications (#95).
- Wake: zombie MCP transport refcount no longer blocks park & refire — parked/crashed agents were never refired since v5.0, closed by a proactive session-forget on exit plus a ping-verified reaper backstop (#100).
- Governance: every role covers the taxonomy implicitly — detection is everyone's job (#97).

## 0.5.13 — 2026-07-11

Cycle 3: the org heals itself.

- Wake v5 — park & refire: agents park on session end and the server revives them with `claude --resume` when new work arrives; keystroke injection is gone from the codebase (#81).
- Task lifecycle: `archived` terminal state + `task_supersede` — probes and tombstones leave the board, never the audit trail (#67); definitions mature in place with audited title editing (#79, pending).
- Conflict detection: taxonomy tags (bug|extension|idea|process) no longer count as work surfaces — the false-positive class is gone (#68).
- Presence dots tell the truth: working / idle-online / off, consistent across all six panel surfaces (#70).
- Self-retirement gate: agents can no longer retire without coordinator approval — org rule 10 (#76).
- Bugs view v2: lifecycle state, QA evidence links, fixed-in version (#73, #74).
- Docs taxonomy v2: living docs vs records, two-section view, archive hygiene (#71).
- Memory view v2: scope filters, search, provenance-distinct distilled entries, audited delete (#77).
- Org-life graph v2: deterministic radial layout, focus mode, edge hygiene (#80).
- Panel polish: truthful Working-now, shipped feed hygiene, zero raw UUIDs in Activity (#72, #83); logs box no longer self-closes and live-tails while open (#75); branding mark in tab and sidebar (#78).
- Duplicate-session detection verifies before flagging — restart reconnects never false-flag (#82).

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
