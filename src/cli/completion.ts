/**
 * Shell completion for `lanchu` (design doc "CLI completion & inline
 * suggestions", Layer 1): bash/zsh/fish scripts generated from one
 * declarative command tree, plus DYNAMIC values completed from the running
 * server (agents, tasks, orgs, roles, ids). The grey ghost-text narrowing
 * comes from the shell's own autosuggestion engine consuming these specs
 * (fish natively; zsh via zsh-autosuggestions); Tab menus work everywhere.
 *
 * Keep COMMANDS in sync with the dispatch switch in run.ts — it is the
 * completion's single source of truth for commands, subcommands and flags.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accessKey, baseUrl } from "../config.js";

/** What a positional argument completes to (drives the dynamic lookups). */
export type ValueKind =
  | "agents" // agent names
  | "agent-ids"
  | "tasks" // task ids
  | "orgs" // org names
  | "roles" // role names
  | "skills" // skill ids
  | "webhooks" // webhook ids
  | "recurring" // recurring ids
  | "models"; // model tiers (static; used by spawn/roles --model)

interface CommandSpec {
  name: string;
  desc: string;
  /** Subcommand words (first positional after the command). */
  sub?: { name: string; desc: string; arg?: ValueKind }[];
  /** Positional argument of the command itself. */
  arg?: ValueKind;
  flags?: { name: string; desc: string; arg?: ValueKind | "value" }[];
}

export const COMMANDS: CommandSpec[] = [
  { name: "work", desc: "guided onboarding wizard (org, agent, role) + launch Claude" },
  { name: "init", desc: "bind this directory to an org/project", flags: [
    { name: "org", desc: "org name", arg: "orgs" },
    { name: "project", desc: "project name", arg: "value" },
    { name: "force", desc: "rebind an already-bound directory" },
  ] },
  { name: "agents", desc: "list agents (status, role, tasks, activity)" },
  { name: "ls", desc: "alias of agents" },
  { name: "tasks", desc: "list tasks (status, owner, tags, workspace)" },
  { name: "orgs", desc: "list orgs / delete one", sub: [{ name: "rm", desc: "delete an org", arg: "orgs" }] },
  { name: "projects", desc: "list this org's projects" },
  { name: "roles", desc: "list roles and their tags", sub: [
    { name: "add", desc: "create a role" },
    { name: "edit", desc: "edit a role's tags/quota", arg: "roles" },
  ], flags: [
    { name: "tags", desc: "comma-separated tags", arg: "value" },
    { name: "wildcard", desc: "role covers any tag" },
    { name: "add-tags", desc: "tags to add", arg: "value" },
    { name: "rm-tags", desc: "tags to remove", arg: "value" },
    { name: "quota", desc: "token budget", arg: "value" },
    { name: "no-quota", desc: "clear the token budget" },
    { name: "model", desc: "preferred model tier for the role", arg: "models" },
    { name: "no-model", desc: "clear the role's preferred model" },
  ] },
  { name: "rules", desc: "view / set the org's rules", sub: [{ name: "set", desc: "replace the org rules" }] },
  { name: "rotate-tokens", desc: "end every open session token (after an exposure)" },
  { name: "coordinator", desc: "show the coordinator lease / supervisor override", sub: [
    { name: "set", desc: "grant the lease to an agent", arg: "agents" },
    { name: "clear", desc: "revoke the lease" },
  ] },
  { name: "skills", desc: "skills per task type", sub: [
    { name: "add", desc: "create a skill" },
    { name: "load", desc: "load a reusable SKILL.md from a url/file" },
    { name: "reload", desc: "re-fetch a loaded skill", arg: "skills" },
    { name: "rm", desc: "remove a skill", arg: "skills" },
  ], flags: [
    { name: "tags", desc: "comma-separated tags", arg: "value" },
    { name: "instructions", desc: "inline skill instructions", arg: "value" },
    { name: "url", desc: "SKILL.md source url", arg: "value" },
    { name: "name", desc: "skill name", arg: "value" },
  ] },
  { name: "webhooks", desc: "outbound webhooks (HMAC-signed)", sub: [
    { name: "add", desc: "register a webhook url" },
    { name: "rm", desc: "remove a webhook", arg: "webhooks" },
  ], flags: [
    { name: "events", desc: "comma-separated event types", arg: "value" },
    { name: "secret", desc: "HMAC secret", arg: "value" },
  ] },
  { name: "recurring", desc: "scheduled task creation", sub: [
    { name: "add", desc: "schedule a recurring task" },
    { name: "rm", desc: "remove a recurring", arg: "recurring" },
  ], flags: [{ name: "every", desc: "interval in minutes", arg: "value" }] },
  { name: "stats", desc: "local stats (agents, tasks, orgs)" },
  { name: "status", desc: "alias of stats" },
  { name: "spawn", desc: "new agent in a new terminal, in its own worktree + branch", flags: [
    { name: "role", desc: "role for the new agent", arg: "roles" },
    { name: "model", desc: "model tier for the new agent", arg: "models" },
    { name: "no-isolate", desc: "share this directory instead of a worktree" },
    { name: "dry", desc: "print the plan without executing" },
  ] },
  { name: "tile", desc: "arrange agent terminals into a mosaic", flags: [{ name: "dry", desc: "print the plan" }] },
  { name: "retire", desc: "safe agent retirement (handoff enforced)", arg: "agent-ids" },
  { name: "task", desc: "supervisor overrides on tasks", sub: [
    { name: "release", desc: "release a task back to the pool", arg: "tasks" },
    { name: "reassign", desc: "reassign a task to an agent", arg: "tasks" },
  ] },
  { name: "panel", desc: "open the web panel in the browser" },
  { name: "open", desc: "alias of panel" },
  { name: "serve", desc: "run the local server (foreground)" },
  { name: "stop", desc: "stop the background server" },
  { name: "restart", desc: "restart the server (--greenzone coordinates it)", flags: [
    { name: "greenzone", desc: "agents confirm a safe point first" },
    { name: "timeout", desc: "greenzone timeout in seconds", arg: "value" },
  ] },
  { name: "greenzone", desc: "show the org's maintenance window / abort it", sub: [
    { name: "cancel", desc: "abort the requested window (supervisor override)" },
  ] },
  { name: "doctor", desc: "check the environment (node, port, config, DB)" },
  { name: "statusline", desc: "status line for Claude Code" },
  { name: "install-commands", desc: "install lanchu slash-commands for Claude Code" },
  { name: "upgrade", desc: "upgrade the lanchu CLI" },
  { name: "uninstall", desc: "remove lanchu from this machine" },
  { name: "completion", desc: "shell completion (bash|zsh|fish) / install", sub: [
    { name: "bash", desc: "print the bash completion script" },
    { name: "zsh", desc: "print the zsh completion script" },
    { name: "fish", desc: "print the fish completion script" },
    { name: "install", desc: "wire completion into your shell rc" },
  ] },
  { name: "help", desc: "show help (optionally for one topic)" },
  { name: "version", desc: "print the version" },
];

// ── dynamic values from the live server ──────────────────────
// Completion must be fast and silent: short timeout, never auto-start the
// server, empty output when anything is off.

function orgFromConfig(): string | null {
  let dir = process.cwd();
  for (;;) {
    const file = path.join(dir, ".lanchu", "config.json");
    if (fs.existsSync(file)) {
      try {
        return (JSON.parse(fs.readFileSync(file, "utf8")) as { org?: string }).org ?? null;
      } catch {
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function quietGet(pathname: string): Promise<unknown | null> {
  try {
    const key = accessKey();
    const res = await fetch(`${baseUrl()}${pathname}`, {
      signal: AbortSignal.timeout(800),
      headers: key ? { authorization: `Bearer ${key}` } : {},
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Newline-ready values for a kind; [] when the server is down or org unknown. */
export async function completionValues(kind: ValueKind): Promise<string[]> {
  if (kind === "models") return ["opus", "sonnet", "haiku"]; // evergreen aliases (model routing)
  if (kind === "orgs") {
    const orgs = (await quietGet("/api/orgs")) as { name: string }[] | null;
    return (orgs ?? []).map((o) => o.name);
  }
  const org = orgFromConfig();
  if (!org) return [];
  const q = `?org=${encodeURIComponent(org)}`;
  switch (kind) {
    case "agents":
    case "agent-ids": {
      const board = (await quietGet(`/api/board${q}`)) as { agents?: { id: string; name: string }[] } | null;
      return (board?.agents ?? []).map((a) => (kind === "agents" ? a.name : a.id));
    }
    case "tasks": {
      const board = (await quietGet(`/api/board${q}`)) as { tasks?: { id: string; status: string }[] } | null;
      return (board?.tasks ?? []).filter((t) => t.status !== "done").map((t) => t.id);
    }
    case "roles": {
      const roles = (await quietGet(`/api/roles${q}`)) as { name: string }[] | null;
      return (roles ?? []).map((r) => r.name);
    }
    case "skills": {
      const skills = (await quietGet(`/api/skills${q}`)) as { id: string }[] | null;
      return (skills ?? []).map((s) => s.id);
    }
    case "webhooks": {
      const hooks = (await quietGet(`/api/webhooks${q}`)) as { id: string }[] | null;
      return (hooks ?? []).map((w) => w.id);
    }
    case "recurring": {
      const recs = (await quietGet(`/api/recurring${q}`)) as { id: string }[] | null;
      return (recs ?? []).map((r) => r.id);
    }
    default:
      return [];
  }
}

// ── script generators ────────────────────────────────────────
// All three scripts shell out to `lanchu completion values <kind>` for
// dynamic args, so they never go stale as the org changes.

const sq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";

export function bashCompletionScript(): string {
  const names = COMMANDS.map((c) => c.name).join(" ");
  const subCases = COMMANDS.filter((c) => c.sub?.length)
    .map((c) => `    ${c.name}) words="${c.sub!.map((s) => s.name).join(" ")}" ;;`)
    .join("\n");
  const argCases = [
    ...COMMANDS.filter((c) => c.arg).map((c) => `    "${c.name} *") kind=${c.arg} ;;`),
    ...COMMANDS.flatMap((c) => (c.sub ?? []).filter((s) => s.arg).map((s) => `    "${c.name} ${s.name} *") kind=${s.arg} ;;`)),
  ].join("\n");
  return `# lanchu bash completion — generated by \`lanchu completion bash\`
_lanchu() {
  local cur prev words kind
  cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${names}" -- "$cur") )
    return
  fi
  # flags for the current command
  if [[ "$cur" == --* ]]; then
    case "\${COMP_WORDS[1]}" in
${COMMANDS.filter((c) => c.flags?.length).map((c) => `      ${c.name}) COMPREPLY=( $(compgen -W "${c.flags!.map((f) => `--${f.name}`).join(" ")}" -- "$cur") ); return ;;`).join("\n")}
    esac
  fi
  # subcommands (second word)
  if [ "$COMP_CWORD" -eq 2 ]; then
    words=""
    case "\${COMP_WORDS[1]}" in
${subCases}
    esac
    if [ -n "$words" ]; then COMPREPLY=( $(compgen -W "$words" -- "$cur") ); fi
  fi
  # dynamic values from the live server (silent when it's down)
  kind=""
  case "\${COMP_WORDS[1]} \${COMP_WORDS[2]} " in
${argCases}
  esac
  if [ -n "$kind" ]; then
    COMPREPLY=( $(compgen -W "$(lanchu completion values $kind 2>/dev/null)" -- "$cur") )
  fi
}
complete -F _lanchu lanchu
`;
}

export function zshCompletionScript(): string {
  const cmdLines = COMMANDS.map((c) => `    ${sq(`${c.name}:${c.desc}`)}`).join(" \\\n");
  const subBlocks = COMMANDS.filter((c) => c.sub?.length)
    .map(
      (c) =>
        `      ${c.name}) _describe 'subcommand' ${c.name.replace(/-/g, "_")}_subs ;;`,
    )
    .join("\n");
  const subArrays = COMMANDS.filter((c) => c.sub?.length)
    .map(
      (c) =>
        `  local -a ${c.name.replace(/-/g, "_")}_subs=(${c.sub!.map((s) => sq(`${s.name}:${s.desc}`)).join(" ")})`,
    )
    .join("\n");
  const dyn = (kind: ValueKind) => `_values 'value' \${(f)"$(lanchu completion values ${kind} 2>/dev/null)"} ;;`;
  const dynCases = [
    // command-level positional: matches "cmd " + whatever partial is typed
    ...COMMANDS.filter((c) => c.arg).map((c) => `      "${c.name} "*) ${dyn(c.arg!)}`),
    // subcommand positional: matches once the subcommand word is in place
    ...COMMANDS.flatMap((c) =>
      (c.sub ?? []).filter((s) => s.arg).map((s) => `      "${c.name} ${s.name}") ${dyn(s.arg!)}`),
    ),
  ].join("\n");
  const flagCases = COMMANDS.filter((c) => c.flags?.length)
    .map((c) => `      ${c.name}) _values 'flag' ${c.flags!.map((f) => sq(`--${f.name}[${f.desc}]`)).join(" ")} ;;`)
    .join("\n");
  return `#compdef lanchu
# lanchu zsh completion — generated by \`lanchu completion zsh\`
# Ghost-text narrowing: install zsh-autosuggestions to see grey suggestions as you type.
_lanchu() {
  local -a commands=( \\
${cmdLines} )
${subArrays}
  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi
  if [[ $words[CURRENT] == --* ]]; then
    case $words[2] in
${flagCases}
    esac
    return
  fi
  if (( CURRENT == 3 )); then
    case $words[2] in
${subBlocks}
    esac
  fi
  case "$words[2] $words[3]" in
${dynCases}
  esac
}
_lanchu "$@"
`;
}

export function fishCompletionScript(): string {
  const lines: string[] = [
    "# lanchu fish completion — generated by `lanchu completion fish`",
    "# fish shows the grey autosuggestion natively as you type.",
    "complete -c lanchu -f",
  ];
  for (const c of COMMANDS) {
    lines.push(`complete -c lanchu -n __fish_use_subcommand -a ${c.name} -d ${sq(c.desc)}`);
    for (const s of c.sub ?? []) {
      lines.push(`complete -c lanchu -n ${sq(`__fish_seen_subcommand_from ${c.name}`)} -a ${s.name} -d ${sq(s.desc)}`);
      if (s.arg) {
        lines.push(
          `complete -c lanchu -n ${sq(`__fish_seen_subcommand_from ${c.name}; and __fish_seen_subcommand_from ${s.name}`)} -a ${sq(`(lanchu completion values ${s.arg} 2>/dev/null)`)}`,
        );
      }
    }
    if (c.arg) {
      lines.push(
        `complete -c lanchu -n ${sq(`__fish_seen_subcommand_from ${c.name}`)} -a ${sq(`(lanchu completion values ${c.arg} 2>/dev/null)`)}`,
      );
    }
    for (const f of c.flags ?? []) {
      lines.push(`complete -c lanchu -n ${sq(`__fish_seen_subcommand_from ${c.name}`)} -l ${f.name} -d ${sq(f.desc)}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function scriptFor(shell: string): string | null {
  if (shell === "bash") return bashCompletionScript();
  if (shell === "zsh") return zshCompletionScript();
  if (shell === "fish") return fishCompletionScript();
  return null;
}

// ── one-step install ─────────────────────────────────────────

const INSTALL_MARK = "# lanchu shell completion";

/** Which shell the user runs, from $SHELL. */
export function detectShell(): "bash" | "zsh" | "fish" | null {
  const sh = path.basename(process.env.SHELL ?? "");
  return sh === "bash" || sh === "zsh" || sh === "fish" ? sh : null;
}

export interface InstallResult {
  shell: string;
  file: string;
  installed: boolean; // false = already present
  ghostHint: string;
}

/** Wire completion into the user's shell rc (idempotent), return what to print. */
export function installCompletion(shell?: "bash" | "zsh" | "fish", home = os.homedir()): InstallResult {
  const sh = shell ?? detectShell();
  if (!sh) throw new Error("could not detect your shell from $SHELL — run: lanchu completion install --shell bash|zsh|fish");
  let file: string;
  let line: string;
  if (sh === "fish") {
    // fish sources ~/.config/fish/completions/<cmd>.fish automatically.
    file = path.join(home, ".config", "fish", "completions", "lanchu.fish");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const already = fs.existsSync(file);
    fs.writeFileSync(file, fishCompletionScript());
    return {
      shell: sh,
      file,
      installed: !already,
      ghostHint: "fish shows grey autosuggestions natively — start typing `lanchu ` and press → to accept.",
    };
  }
  if (sh === "zsh") {
    file = path.join(home, ".zshrc");
    line = `${INSTALL_MARK}\nsource <(lanchu completion zsh)`;
  } else {
    file = path.join(home, ".bashrc");
    line = `${INSTALL_MARK}\nsource <(lanchu completion bash)`;
  }
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const installed = !current.includes(INSTALL_MARK);
  if (installed) fs.appendFileSync(file, `\n${line}\n`);
  return {
    shell: sh,
    file,
    installed,
    ghostHint:
      sh === "zsh"
        ? "For grey ghost-text as you type (not just Tab), install zsh-autosuggestions: https://github.com/zsh-users/zsh-autosuggestions"
        : "bash shows Tab menus; for inline ghost-text look at ble.sh (https://github.com/akinomyoga/ble.sh).",
  };
}
