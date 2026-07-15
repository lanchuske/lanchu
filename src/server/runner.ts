/**
 * Hosted headless agent runner (network mode, Piece 2 Task 2): runs a
 * bounded agent objective server-side with no terminal, no worktree, no
 * human machine — the piece that lets a public web submission (the intake
 * form) end in real MCP tool calls. Uses `claude -p` (headless print mode),
 * NOT the Agent SDK: the SDK requires API-key billing while Lanchu's
 * positioning is "bring your own Claude Code" (see "Design: orchestrating
 * agents on Claude Code" and "Design: hosted headless agent runner").
 *
 * Deliberately a plain exported function — not an MCP tool, not an HTTP
 * endpoint. Task 3 wires it to intake; nothing remote may trigger paid
 * runs in v1.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { stateDir } from "../config.js";
import * as store from "../core/store.js";
import { putContext, dropContext } from "./context.js";
import { writeMcpConfigFile } from "./cockpit.js";

export interface HeadlessRunInput {
  orgId: string;
  orgName: string;
  projectId: string;
  projectName: string;
  /** Role the agent runs under (created if missing), e.g. "moderator". */
  roleName: string;
  /** Defaults to roleName; uniqueness (-2, -3…) handled by createAgent. */
  agentName?: string;
  objective: string;
  /** Semantic budget, enforced by claude itself. */
  maxTurns?: number;
  /** Wall-clock backstop: a turn cap does not bound a single stuck turn. */
  timeoutMs?: number;
  model?: string;
  /** Test seam: the claude binary to spawn. */
  claudeBin?: string;
}

export interface HeadlessRunResult {
  agentId: string;
  agentName: string;
  /** Process exited 0 and produced a parseable result. */
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  sessionId: string | null;
  numTurns: number | null;
  costUsd: number | null;
  /** claude's final result text (or raw stdout tail when parsing failed). */
  resultText: string | null;
  logFile: string;
}

const DEFAULT_MAX_TURNS = 15;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** One live run per agent name: an intake double-submit must not fan out into parallel moderators. */
const liveRuns = new Set<string>();

export async function runHeadlessAgent(input: HeadlessRunInput): Promise<HeadlessRunResult> {
  const roleName = input.roleName;
  const wantedName = input.agentName ?? roleName;
  const runKey = `${input.orgId}:${wantedName}`;
  if (liveRuns.has(runKey)) {
    throw new Error(`a headless run for '${wantedName}' in this org is already live`);
  }
  liveRuns.add(runKey);
  try {
    return await execute(input, roleName, wantedName);
  } finally {
    liveRuns.delete(runKey);
  }
}

async function execute(
  input: HeadlessRunInput,
  roleName: string,
  wantedName: string,
): Promise<HeadlessRunResult> {
  // Identity: the exact chain spawn_agent uses, minus the terminal.
  const role = store.getOrCreateRole(input.orgId, roleName);
  const agent = store.createAgent({
    orgId: input.orgId,
    roleId: role.id,
    objective: input.objective,
    name: wantedName,
  });
  const { token } = store.openSession(agent.id, "headless-runner");
  putContext({
    token,
    agentId: agent.id,
    agentName: agent.name,
    orgId: input.orgId,
    orgName: input.orgName,
    projectId: input.projectId,
    projectName: input.projectName,
  });
  const mcpConfigFile = writeMcpConfigFile(token, agent.name);

  // No worktree — the runner's job never touches code — but claude needs a
  // cwd to key its session storage; give each run a private scratch dir.
  const runDir = path.join(stateDir(), "run", "headless", `${agent.name}-${randomBytes(4).toString("hex")}`);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const logFile = path.join(runDir, "run.log");

  const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const args = [
    "-p",
    input.objective,
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfigFile,
    "--max-turns",
    String(maxTurns),
    "--output-format",
    "json",
  ];
  if (input.model) args.push("--model", input.model);

  store.touchActivity(agent.id, "headless run started");

  const outcome = await new Promise<{ exitCode: number | null; timedOut: boolean; stdout: string }>(
    (resolve) => {
      const child = spawn(input.claudeBin ?? "claude", args, {
        cwd: runDir,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const log = fs.createWriteStream(logFile, { mode: 0o600 });
      let stdout = "";
      let timedOut = false;
      const killer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.stdout.on("data", (c: Buffer) => {
        stdout += c.toString("utf8");
        log.write(c);
      });
      child.stderr.on("data", (c: Buffer) => log.write(c));
      const settle = (exitCode: number | null) => {
        clearTimeout(killer);
        log.end();
        resolve({ exitCode, timedOut, stdout });
      };
      child.on("error", () => settle(null)); // spawn failure (binary missing)
      child.on("close", (code) => settle(code));
    },
  );

  // claude -p --output-format json prints one result object on stdout.
  let sessionId: string | null = null;
  let numTurns: number | null = null;
  let costUsd: number | null = null;
  let resultText: string | null = null;
  try {
    const parsed = JSON.parse(outcome.stdout.trim()) as Record<string, unknown>;
    sessionId = typeof parsed.session_id === "string" ? parsed.session_id : null;
    numTurns = typeof parsed.num_turns === "number" ? parsed.num_turns : null;
    costUsd = typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : null;
    resultText = typeof parsed.result === "string" ? parsed.result : null;
  } catch {
    resultText = outcome.stdout.slice(-500) || null;
  }
  const ok = outcome.exitCode === 0 && !outcome.timedOut && resultText !== null;

  // The run is over: retire the credentials and record the audit trail.
  store.endSessionsForAgent(agent.id);
  dropContext(token);
  fs.rmSync(mcpConfigFile, { force: true });
  store.touchActivity(agent.id, ok ? "headless run finished" : "headless run failed");
  store.recordEvent({
    org_id: input.orgId,
    project_id: input.projectId || null,
    type: "agent.headless_run",
    actor_agent_id: agent.id,
    subject_kind: "agent",
    subject_id: agent.id,
    outcome: ok ? "applied" : "rejected",
    data: {
      exit_code: outcome.exitCode,
      timed_out: outcome.timedOut,
      max_turns: maxTurns,
      num_turns: numTurns,
      cost_usd: costUsd,
      claude_session_id: sessionId,
      log_file: logFile,
    },
  });

  return {
    agentId: agent.id,
    agentName: agent.name,
    ok,
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    sessionId,
    numTurns,
    costUsd,
    resultText,
    logFile,
  };
}
