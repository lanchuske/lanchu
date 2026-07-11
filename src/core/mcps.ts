import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Project-configured MCP discovery for the panel's MCPs section. Read-only:
 * parses the checkout's `.mcp.json` and the user's `~/.claude.json` project
 * entry, and NEVER surfaces credentials — env blocks and headers are dropped
 * entirely, URLs lose userinfo + query strings, and token-shaped args are
 * masked. See the "Panel philosophy" doc: observe & guide, provision in the
 * terminal.
 */
export interface McpServerInfo {
  name: string;
  transport: "http" | "sse" | "stdio";
  /** Sanitized URL (http/sse) or sanitized command line (stdio). */
  target: string;
  /** Where it was declared: project .mcp.json or ~/.claude.json. */
  source: string;
  status: "reachable" | "unreachable" | "unknown";
}

/** Anything that smells like a credential is masked, not trimmed. */
const SECRETish = /(token|secret|bearer|authorization|passw|api[-_]?key|lsk_|sk-)/i;

function sanitizeArg(arg: string): string {
  if (SECRETish.test(arg) || /[A-Za-z0-9_-]{28,}/.test(arg)) return "‹redacted›";
  return arg;
}

/** Strip userinfo and query/fragment — tokens ride there. */
export function sanitizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = ""; u.password = ""; u.search = ""; u.hash = "";
    return u.toString();
  } catch {
    return "‹unparseable url›";
  }
}

type RawServer = {
  type?: string; transport?: string; url?: string;
  command?: string; args?: unknown;
};

function toInfo(name: string, raw: RawServer, source: string): McpServerInfo {
  const url = typeof raw.url === "string" ? raw.url : null;
  const declared = (raw.type ?? raw.transport ?? "").toLowerCase();
  const transport: McpServerInfo["transport"] = url
    ? (declared === "sse" ? "sse" : "http")
    : "stdio";
  let target: string;
  if (url) {
    target = sanitizeUrl(url);
  } else {
    const args = Array.isArray(raw.args) ? raw.args.map((a) => sanitizeArg(String(a))) : [];
    target = [typeof raw.command === "string" ? raw.command : "?", ...args].join(" ").slice(0, 160);
  }
  return { name, transport, target, source, status: "unknown" };
}

function readJsonQuiet(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null; // missing or malformed — the panel shows what it can
  }
}

/** MCP servers a checkout declares: `<path>/.mcp.json` + the `~/.claude.json` project entry. */
export function readProjectMcpServers(localPath: string): McpServerInfo[] {
  const out: McpServerInfo[] = [];
  const seen = new Set<string>();
  const add = (bag: unknown, source: string) => {
    if (!bag || typeof bag !== "object") return;
    for (const [name, raw] of Object.entries(bag as Record<string, RawServer>)) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(toInfo(name, raw ?? {}, source));
    }
  };

  const projectFile = readJsonQuiet(path.join(localPath, ".mcp.json"));
  add(projectFile?.mcpServers, ".mcp.json");

  const claudeCfg = readJsonQuiet(path.join(os.homedir(), ".claude.json"));
  const projects = claudeCfg?.projects;
  if (projects && typeof projects === "object") {
    const entry = (projects as Record<string, { mcpServers?: unknown }>)[localPath];
    add(entry?.mcpServers, "~/.claude.json");
  }
  return out;
}

/** Best-effort liveness for HTTP/SSE servers: any HTTP answer (even 401/404)
 * means something is listening. stdio servers stay "unknown" — there is
 * nothing to ping without launching them. */
export async function probeServers(servers: McpServerInfo[]): Promise<McpServerInfo[]> {
  return Promise.all(
    servers.map(async (s) => {
      if (s.transport === "stdio" || s.target.startsWith("‹")) return s;
      try {
        await fetch(s.target, { method: "HEAD", signal: AbortSignal.timeout(1500) });
        return { ...s, status: "reachable" as const };
      } catch (err) {
        // An HTTP-level rejection still proves a listener; only network
        // failures (refused, DNS, timeout) count as unreachable.
        const msg = err instanceof Error ? String(err.cause ?? err.message) : String(err);
        return { ...s, status: /fetch failed|ECONN|ENOTFOUND|abort|timeout/i.test(msg) ? ("unreachable" as const) : ("reachable" as const) };
      }
    }),
  );
}
