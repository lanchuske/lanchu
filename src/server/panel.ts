import { baseUrl } from "../config.js";

/**
 * Supervisor panel. Open on loopback; when the server sets LANCHU_ACCESS_KEY the
 * page prompts for it and sends it on every request (Bearer header, or ?key= for
 * SSE). Live via SSE (/events) with a polling fallback. A sidebar switches
 * between views (Overview, Team, Work, Bugs, Docs, Activity); supervisor actions
 * (retire / release / reassign) and revealing an agent's terminal happen without
 * browser dialogs.
 */
export function panelHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Lanchu — panel</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f7f9fb; --surface: #ffffff; --surface-2: #fbfcfe;
    --fg: #0f172a; --muted: #64748b; --faint: #94a3b8;
    --line: #e6eaf0; --accent: #0b7285; --accent-weak: rgba(11,114,133,.10);
    --ok: #16a34a; --ok-bg: rgba(22,163,74,.12);
    --info: #2563eb; --info-bg: rgba(37,99,235,.12);
    --warn: #b45309; --warn-bg: rgba(217,119,6,.14);
    --bad: #dc2626; --bad-bg: rgba(220,38,38,.12);
    --radius: 12px; --shadow: 0 1px 2px rgba(16,24,40,.05), 0 1px 3px rgba(16,24,40,.05);
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    --side: 232px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0a0e13; --surface: #111822; --surface-2: #0e141d;
      --fg: #e6edf3; --muted: #8b98a6; --faint: #5b6773;
      --line: #1e2732; --accent: #4dd0c1; --accent-weak: rgba(77,208,193,.12);
      --ok: #4ade80; --ok-bg: rgba(74,222,128,.12);
      --info: #60a5fa; --info-bg: rgba(96,165,250,.12);
      --warn: #fbbf24; --warn-bg: rgba(251,191,36,.12);
      --bad: #f87171; --bad-bg: rgba(248,113,113,.12);
      --shadow: none;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
         font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         -webkit-font-smoothing: antialiased; }

  /* ── layout ── */
  .app { display: grid; grid-template-columns: var(--side) 1fr; min-height: 100vh; }
  .sidebar { position: sticky; top: 0; align-self: start; height: 100vh; overflow-y: auto;
             border-right: 1px solid var(--line); background: var(--surface);
             display: flex; flex-direction: column; gap: 4px; padding: 18px 14px; }
  .content { padding: 26px 30px 64px; max-width: 1180px; }

  .brand { font-weight: 700; font-size: 17px; letter-spacing: -.01em; padding: 2px 8px 12px; }
  .brand small { display: block; font-weight: 500; color: var(--muted); font-size: 12px; margin-top: 2px; }
  .orgfield { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; padding: 0 8px 8px; }
  .orgfield input { min-width: 0; }
  input { padding: 6px 10px; border-radius: 9px; border: 1px solid var(--line); background: var(--bg);
          color: inherit; font: inherit; outline: none; transition: border-color .15s; width: 100%; }
  input:focus { border-color: var(--accent); }
  .live { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted);
          padding: 5px 10px; margin: 0 8px 8px; border: 1px solid var(--line); border-radius: 999px; background: var(--bg); }
  .live .pip { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); }
  .live.on .pip { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-bg); }
  .orgwarn { margin: 0 8px 8px; padding: 8px 10px; border: 1px solid var(--warn); border-radius: 9px;
             background: var(--warn-bg); color: var(--warn); font-size: 12px; line-height: 1.45; }
  .orgwarn code { font-family: var(--mono); font-size: 11.5px; background: var(--surface-2);
             border: 1px solid var(--line); border-radius: 5px; padding: 0 5px; color: var(--fg); }

  .nav { list-style: none; margin: 6px 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .nav li { display: flex; align-items: center; justify-content: space-between; gap: 8px; cursor: pointer;
            padding: 8px 12px; border-radius: 9px; color: var(--muted); font-weight: 500; user-select: none;
            transition: background .12s, color .12s; }
  .nav li:hover { background: var(--accent-weak); color: var(--fg); }
  .nav li.active { background: var(--accent-weak); color: var(--accent); font-weight: 600; }
  .nav .badge { font-size: 11px; font-variant-numeric: tabular-nums; color: var(--faint);
                background: var(--surface-2); border: 1px solid var(--line); border-radius: 999px; padding: 0 7px; min-width: 20px; text-align: center; }
  .nav li.active .badge { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 30%, var(--line)); }
  .nav .warnstat { color: var(--bad); border-color: var(--bad-bg); }

  .sidefoot { margin-top: auto; padding: 12px 10px 2px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }
  .sidefoot b { color: var(--fg); font-variant-numeric: tabular-nums; }

  /* ── views ── */
  .view { display: none; }
  .view.on { display: block; }
  .vhead { font-size: 20px; font-weight: 700; letter-spacing: -.02em; margin: 0 0 4px; }
  .vsub { color: var(--muted); font-size: 13px; margin: 0 0 20px; }
  .vsub code { font-family: var(--mono); font-size: 12px; background: var(--surface-2); border: 1px solid var(--line);
               border-radius: 6px; padding: 1px 6px; color: var(--fg); }
  .proj-card .repo a { color: var(--accent); text-decoration: none; }
  .proj-card .repo a:hover { text-decoration: underline; }
  .sub-h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .07em; color: var(--faint);
            margin: 26px 0 12px; }

  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; align-items: start; }
  @media (max-width: 860px) { .cols { grid-template-columns: 1fr; } }

  /* ── cards ── */
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius);
          padding: 13px 15px; margin-bottom: 10px; box-shadow: var(--shadow); transition: border-color .15s, transform .05s; }
  .card:hover { border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); }
  .card.clickable { cursor: pointer; }
  .card.clickable:active { transform: translateY(1px); }
  .card .top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .name { font-weight: 600; letter-spacing: -.01em; }
  .meta { color: var(--muted); font-size: 12.5px; margin-top: 3px; }
  /* ── docs: category sections + expandable detail ── */
  .cat-title { display: flex; align-items: center; gap: 8px; font-size: 11.5px; font-weight: 600;
               text-transform: uppercase; letter-spacing: .06em; color: var(--muted);
               margin: 22px 0 10px; }
  .cat-title:first-child { margin-top: 4px; }
  .card.doc .doc-body { display: none; word-break: break-word; margin-top: 11px;
               padding-top: 11px; border-top: 1px solid var(--line); color: var(--muted);
               font-size: 13px; line-height: 1.6; }
  .card.doc.open .doc-body { display: block; }
  .card.doc.open { border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); }
  /* rendered markdown inside a doc body */
  .doc-body h1, .doc-body h2, .doc-body h3, .doc-body h4, .doc-body h5, .doc-body h6 {
               color: var(--fg); font-weight: 600; line-height: 1.3; margin: 16px 0 6px; }
  .doc-body h1 { font-size: 16px; } .doc-body h2 { font-size: 14.5px; } .doc-body h3 { font-size: 13.5px; }
  .doc-body h4, .doc-body h5, .doc-body h6 { font-size: 13px; color: var(--muted); }
  .doc-body > :first-child { margin-top: 0; }
  .doc-body p { margin: 7px 0; }
  .doc-body ul, .doc-body ol { margin: 7px 0; padding-left: 20px; }
  .doc-body li { margin: 2px 0; }
  .doc-body hr { border: 0; border-top: 1px solid var(--line); margin: 14px 0; }
  .doc-body code { font-family: var(--mono); font-size: 12px; background: var(--surface-2);
               border: 1px solid var(--line); border-radius: 5px; padding: 1px 5px; }
  .doc-body pre { background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px;
               padding: 10px 12px; overflow-x: auto; margin: 9px 0; }
  .doc-body pre code { background: none; border: 0; padding: 0; font-size: 12px; line-height: 1.5; white-space: pre; }
  .doc-body strong { color: var(--fg); font-weight: 600; }
  .doc-body a { color: var(--accent); text-decoration: none; }
  .doc-body a:hover { text-decoration: underline; }
  .doc-search { width: 100%; max-width: 420px; margin: 4px 0 16px; padding: 7px 12px; border-radius: 9px;
               border: 1px solid var(--line); background: var(--surface); color: var(--fg); font: inherit; font-size: 13px; }
  .doc-search:focus { outline: none; border-color: var(--accent); }
  .doc-search::placeholder { color: var(--faint); }
  .empty-inline { color: var(--faint); font-style: italic; }
  .meta .k { color: var(--faint); }
  .id { font-family: var(--mono); font-size: 11.5px; color: var(--faint); }
  .hint { color: var(--faint); font-size: 11.5px; margin-top: 6px; }

  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; }
  .dot.active { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-bg); }
  .dot.idle { background: var(--warn); box-shadow: 0 0 0 3px var(--warn-bg); }

  .pill { display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 9px; border-radius: 999px; letter-spacing: .01em; }
  .p-available { background: var(--surface-2); color: var(--muted); border: 1px solid var(--line); }
  .p-claimed { background: var(--info-bg); color: var(--info); }
  .p-in_progress { background: var(--warn-bg); color: var(--warn); }
  .p-blocked { background: var(--bad-bg); color: var(--bad); }
  .p-done { background: var(--ok-bg); color: var(--ok); }
  .stale-pill { background: var(--bad-bg); color: var(--bad); }
  .tag { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 7px; margin: 4px 4px 0 0;
         background: var(--accent-weak); color: var(--accent); font-weight: 500; }
  .branch { font-family: var(--mono); font-size: 11px; color: var(--accent); background: var(--accent-weak);
            padding: 1px 7px; border-radius: 6px; }
  .stage-chip { display: inline-block; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em;
                padding: 2px 7px; border-radius: 6px; background: var(--surface-2); color: var(--muted); border: 1px solid var(--line); }
  .pr-link { font-size: 11.5px; color: var(--accent); text-decoration: none; font-weight: 500; }
  .pr-link:hover { text-decoration: underline; }

  /* ── SDLC board ── */
  .board { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(266px, 1fr); gap: 16px; overflow-x: auto; padding-bottom: 8px; align-items: start; }
  .lane { min-width: 266px; }
  .lane-h { font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: var(--faint); font-weight: 600;
            margin: 0 0 10px; padding: 0 2px; display: flex; justify-content: space-between; align-items: center; }
  .lane-h .c { color: var(--muted); background: var(--surface-2); border: 1px solid var(--line); border-radius: 999px; padding: 0 7px; }
  .lane .empty { text-align: center; font-size: 12px; opacity: .6; }

  .actions { margin-top: 10px; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  button, select { font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 8px; border: 1px solid var(--line);
                   background: var(--surface); color: var(--fg); cursor: pointer; transition: background .12s, border-color .12s; }
  button:hover { border-color: var(--accent); background: var(--accent-weak); }
  button.danger:hover { border-color: var(--bad); color: var(--bad); background: var(--bad-bg); }

  .empty { color: var(--faint); font-size: 13px; padding: 8px 2px; }

  /* ── copy-paste command snippet (the panel guides; the terminal provisions) ── */
  .cmd { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; vertical-align: middle; }
  .cmd code { font-family: var(--mono); font-size: 12px; background: var(--surface-2); border: 1px solid var(--line);
              border-radius: 6px; padding: 3px 8px; color: var(--fg); white-space: nowrap; overflow-x: auto; }
  button.copy { font-size: 11px; padding: 3px 8px; flex: none; }

  /* ── sidebar help: how to add an org/project (always points at the terminal) ── */
  .help { margin: 4px 8px 8px; margin-top: auto; font-size: 12px; color: var(--muted); }
  .help summary { cursor: pointer; color: var(--accent); font-weight: 500; user-select: none; }
  .help .body { display: flex; flex-direction: column; gap: 8px; padding: 8px 0 0; line-height: 1.5; }
  /* the sidebar is narrow — let commands wrap there instead of overflowing */
  .help .cmd, .orgwarn .cmd { display: inline-flex; flex-wrap: wrap; }
  .help .cmd code, .orgwarn .cmd code { white-space: normal; word-break: break-all; }

  /* ── overview ── */
  .projects { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 22px; }
  .repo-chip { display: flex; align-items: center; gap: 8px; background: var(--surface); border: 1px solid var(--line);
               border-radius: 999px; padding: 6px 14px; box-shadow: var(--shadow); font-size: 12.5px; }
  .repo-chip .pname { font-weight: 600; }
  .repo-chip a { color: var(--accent); text-decoration: none; }
  .repo-chip a:hover { text-decoration: underline; }
  .repo-chip .path { color: var(--faint); font-family: var(--mono); font-size: 11.5px; }
  .repo-chip .sep { color: var(--line); }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 14px; }
  .tile { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 18px; box-shadow: var(--shadow); }
  .tile .n { font-size: 26px; font-weight: 700; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
  .tile .l { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .tile.bad .n { color: var(--bad); }

  /* ── processes ── */
  .proc-grid { display: flex; flex-wrap: wrap; gap: 18px; }
  .proc-grid .kv { font-size: 12.5px; }
  .proc-grid .kv .k { color: var(--faint); display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
  .proc-grid .kv .v { font-family: var(--mono); font-size: 13px; }
  .logbox { margin-top: 10px; background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px;
            padding: 10px 12px; max-height: 320px; overflow: auto; }
  .logbox pre { margin: 0; font-family: var(--mono); font-size: 11.5px; line-height: 1.5; white-space: pre-wrap;
                word-break: break-word; color: var(--muted); }

  /* ── audit ── */
  .ev { display: grid; grid-template-columns: 74px 1fr auto; gap: 10px; padding: 7px 10px; border-radius: 8px;
        align-items: baseline; font-size: 13px; }
  .ev:nth-child(odd) { background: var(--surface-2); }
  .ev.rej { background: var(--bad-bg); box-shadow: inset 2px 0 0 var(--bad); }
  .ev .time { font-family: var(--mono); font-size: 12px; color: var(--faint); }
  .ev .who { font-weight: 600; }
  .ev .type { font-family: var(--mono); font-size: 12px; color: var(--accent); }
  .ev.rej .type { color: var(--bad); }
  .ev .right { font-size: 12px; color: var(--muted); text-align: right; white-space: nowrap; }

  ::-webkit-scrollbar { width: 9px; height: 9px; }
  ::-webkit-scrollbar-thumb { background: var(--line); border-radius: 9px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--faint); }
  ::-webkit-scrollbar-track { background: transparent; }

  /* ── toast ── */
  #toast { position: fixed; bottom: 22px; right: 22px; display: flex; flex-direction: column; gap: 8px; z-index: 50; }
  .toast { background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--accent);
           border-radius: 9px; padding: 10px 14px; box-shadow: 0 6px 20px rgba(16,24,40,.14); font-size: 13px;
           animation: pop .18s ease-out; }
  .toast.bad { border-left-color: var(--bad); }
  @keyframes pop { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

  @media (max-width: 680px) {
    .app { grid-template-columns: 1fr; }
    .sidebar { position: static; height: auto; flex-direction: row; flex-wrap: wrap; align-items: center; }
    .nav { flex-direction: row; flex-wrap: wrap; }
    .sidefoot { margin: 0; border: 0; }
  }
</style>
</head>
<body>
  <div class="app">
    <nav class="sidebar">
      <div class="brand">Lanchu <small>control &amp; trust</small></div>
      <div class="orgfield"><span>org</span><input id="org" value="lanchu" list="orglist" autocomplete="off" placeholder="pick an existing org…" title="Picks an existing org — orgs are created from the terminal (run lanchu in your repo)" /><datalist id="orglist"></datalist></div>
      <span id="live" class="live"><span class="pip"></span><span id="live-t">connecting</span></span>
      <div id="orgwarn" class="orgwarn" style="display:none"></div>
      <ul class="nav" id="nav">
        <li data-view="overview">Overview</li>
        <li data-view="projects">Projects <span class="badge" id="c-projects">0</span></li>
        <li data-view="team">Team <span class="badge" id="c-agents">0</span></li>
        <li data-view="work">Work <span class="badge" id="c-tasks">0</span></li>
        <li data-view="bugs">Bugs <span class="badge" id="c-bugs">0</span></li>
        <li data-view="docs">Docs <span class="badge" id="c-docs">0</span></li>
        <li data-view="activity">Activity</li>
        <li data-view="processes">Processes <span class="badge" id="c-proc">0</span></li>
      </ul>
      <details class="help">
        <summary>How do I add an org or project?</summary>
        <div class="body" id="help-body"></div>
      </details>
      <div class="sidefoot" id="sidestat"></div>
    </nav>

    <main class="content">
      <section class="view" id="v-overview">
        <h1 class="vhead">Overview</h1>
        <p class="vsub">An <b>org</b> groups everything below it: <b>projects</b> (each a repo + local folder), the <b>agents</b> working across them, and their <b>tasks</b>.</p>
        <div class="projects" id="projects"></div>
        <div class="tiles" id="tiles"></div>
        <div id="attention"></div>
      </section>

      <section class="view" id="v-projects">
        <h1 class="vhead">Projects</h1>
        <p class="vsub">One org can span many repos and folders — each is a <b>project</b>: a repo + its local folder, so it's created from <b>inside that folder</b>, in the terminal. There, run
          <span class="cmd"><code id="proj-cmd">lanchu init --org YOUR-ORG --project NAME</code><button class="copy" id="proj-cmd-copy" data-copy="lanchu init --org YOUR-ORG --project NAME">copy</button></span>;
          its repo and path appear here once an agent joins.</p>
        <div id="projects-full"></div>
      </section>

      <section class="view" id="v-team">
        <h1 class="vhead">Team</h1>
        <p class="vsub">Agents in this org. Click a card to focus its terminal — or open a fresh one if it's closed.</p>
        <div id="agents"></div>
        <h2 class="sub-h2">Roles</h2>
        <div id="roles"></div>
      </section>

      <section class="view" id="v-work">
        <h1 class="vhead">Work</h1>
        <p class="vsub">Tasks across the SDLC — definition, build, review, QA, done — with owner, PR and governance signals.</p>
        <div class="board" id="tasks"></div>
      </section>

      <section class="view" id="v-bugs">
        <h1 class="vhead">Bugs</h1>
        <p class="vsub">Tasks tagged <span class="tag">bug</span>.</p>
        <div id="bugs"></div>
      </section>

      <section class="view" id="v-docs">
        <h1 class="vhead">Documentation</h1>
        <p class="vsub">Shared definitions and knowledge kept current by the team.</p>
        <input id="doc-q" class="doc-search" type="search" placeholder="Filter docs by title or content…" autocomplete="off" spellcheck="false">
        <div id="docs"></div>
      </section>

      <section class="view" id="v-activity">
        <h1 class="vhead">Activity</h1>
        <p class="vsub">Audit log — every action, applied or rejected.</p>
        <div id="audit"></div>
      </section>

      <section class="view" id="v-processes">
        <h1 class="vhead">Processes</h1>
        <p class="vsub">The local server and every agent terminal — inspect logs, stop, or restart.</p>
        <h2 class="sub-h2">Server</h2>
        <div id="server-proc"><div class="empty">loading…</div></div>
        <h2 class="sub-h2">Agent terminals</h2>
        <div id="terminals"><div class="empty">loading…</div></div>
      </section>
    </main>
  </div>
  <div id="toast"></div>

<script>
var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
  return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); };
var org = function () { return document.getElementById("org").value.trim(); };

// ── access key (only needed when the server sets LANCHU_ACCESS_KEY) ──
// A shared secret can arrive as ?key=… (stored, then stripped from the URL) and
// otherwise lives in localStorage. It rides on every request as a Bearer header,
// and on the SSE URL as ?key= (EventSource can't set headers).
var KEY = (function () {
  try {
    var u = new URL(location.href);
    var q = u.searchParams.get("key");
    if (q) { localStorage.setItem("lanchu_key", q); u.searchParams.delete("key"); history.replaceState(null, "", u.toString()); return q; }
    return localStorage.getItem("lanchu_key") || "";
  } catch (e) { return ""; }
})();
function authInit(init) {
  init = init || {};
  if (KEY) { init.headers = Object.assign({}, init.headers, { "authorization": "Bearer " + KEY }); }
  return init;
}
function keyParam() { return KEY ? "&key=" + encodeURIComponent(KEY) : ""; }
var authError = false;
function authFetch(url, init) {
  return fetch(url, authInit(init)).then(function (r) {
    if (r.status === 401 && !authError) { authError = true; promptKey(); }
    return r;
  });
}
function promptKey() {
  var k = window.prompt("This Lanchu server requires an access key (LANCHU_ACCESS_KEY):", "");
  if (k) { localStorage.setItem("lanchu_key", k); location.reload(); }
}

var get = function (p) { return authFetch(p + (p.indexOf("?") < 0 ? "?" : "&") + "org=" + encodeURIComponent(org())).then(function (r) { return r.json(); }); };
// owner/repo from a github-ish url, else the tail segment.
var repoLabel = function (url) { var m = String(url).match(/[:/]([^/]+\\/[^/]+?)(?:\\.git)?$/); return m ? m[1] : url; };
// collapse $HOME to ~ for readability.
var shortPath = function (p) { return p ? String(p).replace(/^\\/Users\\/[^/]+/, "~").replace(/^\\/home\\/[^/]+/, "~") : ""; };

function post(path, body) {
  return authFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(function (r) { return r.json(); }).then(function (r) { refresh(); return r; });
}
function toast(msg, bad) {
  var t = document.createElement("div"); t.className = "toast" + (bad ? " bad" : ""); t.textContent = msg;
  document.getElementById("toast").appendChild(t);
  setTimeout(function () { t.remove(); }, 2600);
}

// ── copy-paste guidance: the panel never provisions, it hands you the command ──
function cmdSnippet(cmd) {
  return '<span class="cmd"><code>' + esc(cmd) + '</code><button class="copy" data-copy="' + esc(cmd) + '">copy</button></span>';
}
function initCmd() { return "lanchu init --org " + (org() || "YOUR-ORG") + " --project NAME"; }
function copyCmd(btn) {
  var txt = btn.getAttribute("data-copy") || "";
  var done = function () { toast("Copied — paste it in your terminal"); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(txt).then(done, function () { fallbackCopy(txt); done(); });
  } else { fallbackCopy(txt); done(); }
}
function fallbackCopy(txt) {
  var ta = document.createElement("textarea"); ta.value = txt;
  document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); } catch (e) { /* best effort */ }
  ta.remove();
}
// Keep the static hints (Projects header, sidebar help) pointing at the CURRENT org.
var lastCmdOrg = null;
function updateContextCmds() {
  if (org() === lastCmdOrg) return;
  lastCmdOrg = org();
  var cmd = initCmd();
  var el = document.getElementById("proj-cmd"); if (el) el.textContent = cmd;
  var cp = document.getElementById("proj-cmd-copy"); if (cp) cp.setAttribute("data-copy", cmd);
  document.getElementById("help-body").innerHTML =
    'In the terminal — the panel supervises existing agents; it never creates orgs or projects.' +
    '<span>A <b>project</b> is a repo + its local folder, so it\\'s created from inside that folder:</span>' +
    cmdSnippet(cmd) +
    '<span>Then start a teammate from that folder with ' + cmdSnippet('lanchu spawn "your objective"') + ' — the org and project appear here once it joins.</span>';
}

function retire(id) {
  post("/agent/retire", { agentId: id }).then(function (r) {
    var el = document.getElementById("retire-msg-" + id);
    if (el && r && r.retired === false) el.textContent = "blocked — " + r.blockedBy.length + " open task(s) to hand off first";
  });
}
function reveal(id, name) {
  post("/agent/reveal", { agentId: id }).then(function (r) {
    if (!r) return;
    if (r.action === "focused") toast("Focused " + name + "'s terminal");
    else if (r.action === "opened") toast("Opened a terminal for " + name + " (" + (r.method || "") + ")");
    else toast("Couldn't reveal " + name + (r.reason ? " — " + r.reason : ""), true);
  });
}
function reassign(id) {
  var sel = document.querySelector('select[data-task="' + id + '"]');
  if (sel && sel.value) post("/task/reassign", { taskId: id, toAgentId: sel.value });
}
// Removing an org cascades to its (empty) projects, so arm the button instead of
// a browser confirm dialog: first click asks, second click within 4s executes.
function removeOrg(btn, name) {
  if (!btn.getAttribute("data-armed")) {
    btn.setAttribute("data-armed", "1");
    btn.textContent = "Click again to remove";
    setTimeout(function () { btn.removeAttribute("data-armed"); btn.textContent = "Remove org"; }, 4000);
    return;
  }
  post("/org/delete", { name: name }).then(function (r) {
    toast(r && r.deleted ? "Removed org “" + name + "”" : "Couldn't remove “" + name + "”", !(r && r.deleted));
  });
}
function closeTerm(id, name) {
  post("/agent/terminal/close", { agentId: id }).then(function (r) {
    toast((r && r.closed ? "Closed " : "Cleared ") + name + "'s terminal"); refreshProcesses();
  });
}
function toggleLogs(id) {
  var box = document.getElementById("log-" + id); if (!box) return;
  if (box.style.display !== "none") { box.style.display = "none"; return; }
  box.style.display = "block"; box.querySelector("pre").textContent = "loading…";
  authFetch("/api/agent/logs?agentId=" + encodeURIComponent(id)).then(function (r) { return r.json(); }).then(function (r) {
    box.querySelector("pre").textContent = (r.logs || "").trim() || "(no output captured)";
    box.scrollTop = box.scrollHeight;
  }).catch(function () { box.querySelector("pre").textContent = "(couldn't read logs)"; });
}
function stopServer() {
  authFetch("/server/stop", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(function () {});
  toast("Stopping the server — the panel will go offline.", true);
}

document.addEventListener("click", function (e) {
  var cp = e.target.closest ? e.target.closest("button[data-copy]") : null;
  if (cp) { copyCmd(cp); return; }
  var b = e.target.closest ? e.target.closest("button[data-act]") : null;
  if (b) {
    var act = b.getAttribute("data-act"), id = b.getAttribute("data-id"), nm = b.getAttribute("data-name") || "agent";
    if (act === "retire") retire(id);
    else if (act === "release") post("/task/release", { taskId: id });
    else if (act === "reassign") reassign(id);
    else if (act === "focus-term") reveal(id, nm);
    else if (act === "logs") toggleLogs(id);
    else if (act === "close-term") closeTerm(id, nm);
    else if (act === "restart-server") { post("/server/restart", {}); toast("Restarting the server…"); }
    else if (act === "stop-server") stopServer();
    else if (act === "remove-org") removeOrg(b, id);
    return;
  }
  // Click anywhere on an agent card (but not on its controls) → reveal its terminal.
  if (e.target.closest && !e.target.closest("button, select, a")) {
    var card = e.target.closest(".card[data-agent]");
    if (card) { reveal(card.getAttribute("data-agent"), card.getAttribute("data-name")); return; }
    // Click a doc card → expand/collapse its content (remembered across refreshes).
    var doc = e.target.closest(".card.doc[data-doc]");
    if (doc) { openDocs[doc.getAttribute("data-doc")] = doc.classList.toggle("open"); }
  }
});

// ── views / router ──
var curView = "overview";
function showView(name) {
  curView = name;
  var items = document.querySelectorAll("#nav li");
  for (var i = 0; i < items.length; i++) items[i].classList.toggle("active", items[i].getAttribute("data-view") === name);
  var views = document.querySelectorAll(".view");
  for (var j = 0; j < views.length; j++) views[j].classList.toggle("on", views[j].id === "v-" + name);
  if (name === "processes") refreshProcesses();
}
document.getElementById("nav").addEventListener("click", function (e) {
  var li = e.target.closest("li[data-view]"); if (!li) return;
  location.hash = li.getAttribute("data-view");
});
function routeFromHash() { showView((location.hash || "#overview").slice(1)); }
window.addEventListener("hashchange", routeFromHash);

// ── renders ──
function renderOrgOptions(orgs) {
  var cur = org();
  document.getElementById("orglist").innerHTML = (orgs || []).map(function (o) {
    return '<option value="' + esc(o.name) + '">' + o.agents + ' agents · ' + o.projects + ' projects · ' + o.tasks + ' tasks</option>';
  }).join("");
  // keep the current selection; the datalist just offers the known names
  void cur;
}

function renderProjects(list) {
  var withInfo = (list || []).filter(function (p) { return p.repo_url || p.local_path; });
  document.getElementById("projects").innerHTML = withInfo.map(function (p) {
    var repo = p.repo_url ? '<a href="' + esc(p.repo_url) + '" target="_blank" rel="noopener">' + esc(repoLabel(p.repo_url)) + '</a>' : "";
    var path = p.local_path ? '<span class="path">' + esc(shortPath(p.local_path)) + '</span>' : "";
    var sep = repo && path ? '<span class="sep">·</span>' : "";
    return '<div class="repo-chip"><span class="pname">' + esc(p.name) + '</span><span class="sep">·</span>' + repo + sep + path + '</div>';
  }).join("") || '<div class="empty">No projects yet. A project is a repo + its local folder, so it\\'s created from inside that folder — in your terminal, run ' + cmdSnippet(initCmd()) + '</div>';
}

// Full Projects view: one card per project, with its repo/folder, task count and the branches agents are on.
function renderProjectsView(projects, tasks, agents) {
  document.getElementById("c-projects").textContent = (projects || []).length;
  var agentById = {}; (agents || []).forEach(function (a) { agentById[a.id] = a; });
  document.getElementById("projects-full").innerHTML = (projects || []).map(function (p) {
    var pts = (tasks || []).filter(function (t) { return t.project_id === p.id; });
    var owners = {}; pts.forEach(function (t) { if (t.owner_agent_id) owners[t.owner_agent_id] = true; });
    var branches = {};
    Object.keys(owners).forEach(function (id) { var a = agentById[id]; if (a && a.branch) branches[a.branch] = true; });
    var done = pts.filter(function (t) { return t.status === "done"; }).length;
    var repo = p.repo_url
      ? '<div class="meta repo"><span class="k">repo</span> <a href="' + esc(p.repo_url) + '" target="_blank" rel="noopener">' + esc(repoLabel(p.repo_url)) + '</a></div>'
      : '<div class="meta"><span class="k">repo</span> <span class="hint">not captured yet</span></div>';
    var path = p.local_path ? '<div class="meta"><span class="k">path</span> <span class="path" style="font-family:var(--mono);font-size:11.5px">' + esc(shortPath(p.local_path)) + '</span></div>' : "";
    var br = Object.keys(branches).map(function (b) { return '<span class="branch">⌥ ' + esc(b) + '</span>'; }).join(" ");
    return '<div class="card proj-card"><div class="top"><span class="name">' + esc(p.name) + '</span>' +
      '<span class="meta"><b>' + pts.length + '</b> tasks · <b>' + done + '</b> done · <b>' + Object.keys(owners).length + '</b> contributors</span></div>' +
      repo + path + (br ? '<div class="meta"><span class="k">branches</span> ' + br + '</div>' : "") + '</div>';
  }).join("") || '<div class="empty">No projects yet. A project is a repo + its local folder, so it\\'s created from inside that folder — in your terminal, run ' + cmdSnippet(initCmd()) + ' then have an agent join (it appears here with its repo and path).</div>';
}

function renderAgents(list) {
  document.getElementById("c-agents").textContent = list.length;
  document.getElementById("agents").innerHTML = list.map(function (a) {
    var branch = a.branch ? ' · <span class="branch">⌥ ' + esc(a.branch) + '</span>' : "";
    var wt = a.worktree ? '<div class="meta"><span class="k">wt</span> <span class="path" style="font-family:var(--mono);font-size:11.5px">' + esc(shortPath(a.worktree)) + '</span></div>' : "";
    var taskTitle = a.active_task_title ? (a.active_task_title.length > 90 ? a.active_task_title.slice(0, 90) + "…" : a.active_task_title) : "";
    var task = a.active_task_id ? '<div class="meta"><span class="k">task</span> <span title="' + esc(a.active_task_title || "") + '">' + esc(taskTitle) + '</span></div>' : "";
    var reveal = a.state === "active" ? "focus terminal" : "open terminal";
    return '<div class="card clickable" data-agent="' + a.id + '" data-name="' + esc(a.name) + '" title="Click to ' + reveal + '">' +
      '<div class="top"><span class="name"><span class="dot ' + (a.state === "active" ? "active" : "idle") + '"></span>' +
      esc(a.name) + '</span><button class="danger" data-act="retire" data-id="' + a.id + '">Retire</button></div>' +
      '<div class="meta"><span class="k">role</span> ' + esc(a.role_name || "—") + ' · <b>' + a.open_tasks + '</b> open' + branch +
      (a.workspace ? ' · <span class="k">ws</span> ' + esc(a.workspace) : "") + '</div>' + wt + task +
      (a.objective ? '<div class="meta"><span class="k">obj</span> ' + esc(a.objective) + '</div>' : "") +
      '<div class="meta"><span class="k">last</span> ' + esc(a.last_activity || "no activity yet") + '</div>' +
      '<div class="hint">' + (a.state === "active" ? "● click to focus its terminal" : "○ click to open a terminal") + '</div>' +
      '<div class="meta" style="color:var(--bad)" id="retire-msg-' + a.id + '"></div></div>';
  }).join("") || '<div class="empty">No agents yet. Agents are started from the terminal — inside a project folder, run ' + cmdSnippet('lanchu spawn "your objective"') + ' and supervise it from here.</div>';
}

function taskCard(t, opts) {
  var badge = t.stale ? '<span class="pill stale-pill">stale</span>' : (t.reserved ? '<span class="pill p-available">reserved</span>' : "");
  var owned = !!t.owner_agent_id;
  var pr = t.pr_url ? ' · <a class="pr-link" href="' + esc(t.pr_url) + '" target="_blank" rel="noopener">PR ↗</a>' : "";
  // Supervisor overrides only make sense on open work — a done task has nothing
  // to release or reassign.
  var actions = owned && t.status !== "done"
    ? '<div class="actions"><button data-act="release" data-id="' + t.id + '">Release</button>' +
      '<select data-task="' + t.id + '">' + opts + '</select>' +
      '<button data-act="reassign" data-id="' + t.id + '">Reassign</button></div>'
    : "";
  return '<div class="card"><div class="top"><span class="name">' + esc(t.title) + '</span>' +
    '<span><span class="pill p-' + esc(t.status) + '">' + esc(t.status.replace("_", " ")) + '</span> ' + badge + '</span></div>' +
    '<div>' + (t.tags || []).map(function (x) { return '<span class="tag">' + esc(x) + '</span>'; }).join("") + '</div>' +
    '<div class="meta">' + (owned ? '<span class="k">owner</span> ' + esc(t.owner_name || t.owner_agent_id) : "unassigned") +
    (t.workspace ? ' · <span class="k">ws</span> ' + esc(t.workspace) : "") + pr + '</div>' + actions + '</div>';
}

var STAGES = [["backlog", "Backlog"], ["definition", "Definition"], ["build", "Build"], ["review", "Review"], ["qa", "QA"], ["done", "Done"]];
// A done task is done, whatever lane it was last parked in — checking status
// first is what keeps the board's Done lane and the overview "done" tile from
// disagreeing. Otherwise an explicit stage wins, and failing that we infer a
// lane from the signals agents actually produce (PR + status), so cards move
// Backlog → … → Done as work progresses instead of jumping straight to Done.
function stageOf(t) {
  if (t.status === "done") return "done";
  if (t.stage && t.stage !== "backlog") return t.stage;
  if (t.pr_url) return "review";
  if (t.status === "in_progress" || t.status === "blocked") return "build";
  if (t.status === "claimed") return "definition";
  return "backlog";
}

function renderTasks(list, agents) {
  document.getElementById("c-tasks").textContent = list.length;
  var opts = '<option value="">reassign to…</option>' + agents.map(function (a) { return '<option value="' + a.id + '">' + esc(a.name) + '</option>'; }).join("");

  var byStage = {}; STAGES.forEach(function (s) { byStage[s[0]] = []; });
  list.forEach(function (t) { byStage[stageOf(t)].push(t); });
  document.getElementById("tasks").innerHTML = list.length
    ? STAGES.map(function (s) {
        var items = byStage[s[0]];
        return '<div class="lane"><div class="lane-h">' + s[1] + ' <span class="c">' + items.length + '</span></div>' +
          (items.map(function (t) { return taskCard(t, opts); }).join("") || '<div class="empty">—</div>') + '</div>';
      }).join("")
    : '<div class="empty">No tasks yet — agents break their objectives into tasks as they work; you supervise them here (release / reassign).</div>';

  var bugs = list.filter(function (t) { return (t.tags || []).indexOf("bug") >= 0; });
  document.getElementById("c-bugs").textContent = bugs.length;
  document.getElementById("bugs").innerHTML = bugs.map(function (t) { return taskCard(t, opts); }).join("") || '<div class="empty">No bugs — nothing tagged "bug".</div>';
}

function renderRoles(list) {
  document.getElementById("roles").innerHTML = list.map(function (r) {
    var tags = r.is_wildcard
      ? '<span class="tag">★ all tags</span>'
      : ((r.allowed_tags || []).map(function (x) { return '<span class="tag">' + esc(x) + '</span>'; }).join("")
         || '<span class="hint">no tags — can\\'t claim any task yet</span>');
    return '<div class="card"><span class="name">' + esc(r.name) + '</span> ' + tags + '</div>';
  }).join("") || '<div class="empty">No roles yet.</div>';
}

var DOC_CATS = [
  ["design", "Design"], ["technical", "Technical docs"], ["product", "Product docs"],
  ["backlog", "Backlog"], ["bug", "Bugs"], ["general", "General"],
];
// Minimal, dependency-free markdown → HTML. Input is HTML-escaped first, then a
// safe subset (headings, lists, code, bold, links, rules) is re-introduced.
function mdInline(s) {
  var BT = String.fromCharCode(96);
  s = s.replace(new RegExp(BT + "([^" + BT + "]+)" + BT, "g"), "<code>$1</code>");
  s = s.replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>");
  s = s.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, function (m, txt, url) {
    return /^https?:\\/\\//.test(url) ? '<a href="' + url + '" target="_blank" rel="noopener">' + txt + '</a>' : m;
  });
  return s;
}
function mdToHtml(src) {
  var FENCE = String.fromCharCode(96, 96, 96);
  var lines = esc(src).split("\\n"), out = [], inCode = false, list = null;
  function closeList() { if (list) { out.push("</" + list + ">"); list = null; } }
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    if (ln.replace(/^\\s+/, "").slice(0, 3) === FENCE) {
      if (inCode) { out.push("</code></pre>"); inCode = false; }
      else { closeList(); out.push("<pre><code>"); inCode = true; }
      continue;
    }
    if (inCode) { out.push(ln + "\\n"); continue; }
    if (/^\\s*(---+|\\*\\*\\*+)\\s*$/.test(ln)) { closeList(); out.push("<hr>"); continue; }
    var h = ln.match(/^(#{1,6})\\s+(.*)$/);
    if (h) { closeList(); var lv = h[1].length; out.push("<h" + lv + ">" + mdInline(h[2]) + "</h" + lv + ">"); continue; }
    var ul = ln.match(/^\\s*[-*]\\s+(.*)$/);
    if (ul) { if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; } out.push("<li>" + mdInline(ul[1]) + "</li>"); continue; }
    var ol = ln.match(/^\\s*\\d+[.)]\\s+(.*)$/);
    if (ol) { if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; } out.push("<li>" + mdInline(ol[1]) + "</li>"); continue; }
    if (/^\\s*$/.test(ln)) { closeList(); continue; }
    closeList(); out.push("<p>" + mdInline(ln) + "</p>");
  }
  if (inCode) out.push("</code></pre>");
  closeList();
  return out.join("");
}
var docQuery = "", lastDocs = [], openDocs = {};
function renderDocs(list) {
  lastDocs = list;
  document.getElementById("c-docs").textContent = list.length;
  var box = document.getElementById("docs");
  if (!list.length) { box.innerHTML = '<div class="empty">No documentation yet.</div>'; return; }
  var q = docQuery.trim().toLowerCase();
  var shown = q ? list.filter(function (d) {
    return (d.title || "").toLowerCase().indexOf(q) >= 0 || (d.content || "").toLowerCase().indexOf(q) >= 0;
  }) : list;
  if (!shown.length) { box.innerHTML = '<div class="empty">No docs match “' + esc(docQuery) + '”.</div>'; return; }
  var byCat = {};
  shown.forEach(function (d) { var c = d.category || "general"; (byCat[c] = byCat[c] || []).push(d); });
  var html = "";
  DOC_CATS.forEach(function (pair) {
    var docs = byCat[pair[0]]; if (!docs || !docs.length) return;
    html += '<div class="cat-title">' + esc(pair[1]) + ' <span class="badge">' + docs.length + '</span></div>';
    html += docs.map(function (d) {
      return '<div class="card clickable doc' + (openDocs[d.id] ? " open" : "") + '" data-doc="' + esc(d.id) + '">' +
        '<span class="name">' + esc(d.title) + '</span>' +
        '<div class="meta">' + d.chars + ' chars · ' + esc((d.updated_at || "").replace("T", " ").slice(0, 16)) +
        (d.updated_by ? ' · by ' + esc(d.updated_by) : "") + '</div>' +
        '<div class="doc-body">' + (d.content ? mdToHtml(d.content) : '<span class="empty-inline">(empty)</span>') + '</div>' +
        '</div>';
    }).join("");
  });
  box.innerHTML = html;
}
(function () {
  var qi = document.getElementById("doc-q");
  if (qi) qi.addEventListener("input", function () { docQuery = this.value; renderDocs(lastDocs); });
})();

function renderAudit(list) {
  document.getElementById("audit").innerHTML = list.map(function (e) {
    var when = (e.created_at || "").slice(11, 19);
    var subj = e.subject_id ? ' <span class="id">' + esc(e.subject_id) + '</span>' : "";
    var note = e.data && e.data.note ? ' — ' + esc(e.data.note) : "";
    var right = (e.outcome === "rejected" ? "rejected" : "") + (e.tokens ? (e.outcome === "rejected" ? " · " : "") + e.tokens + " tok" : "");
    return '<div class="ev' + (e.outcome === "rejected" ? " rej" : "") + '">' +
      '<span class="time">' + when + '</span>' +
      '<span><span class="who">' + esc(e.actor_name || "—") + '</span> <span class="type">' + esc(e.type) + '</span>' + subj + note + '</span>' +
      '<span class="right">' + right + '</span></div>';
  }).join("") || '<div class="empty">No activity yet.</div>';
}

function kv(k, v) { return '<div class="kv"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + '</span></div>'; }
function fmtUptime(s) {
  s = +s || 0; var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + "h " : "") + (h || m ? m + "m " : "") + sec + "s";
}
function renderProcesses(p) {
  var s = p.server || {};
  document.getElementById("server-proc").innerHTML =
    '<div class="card"><div class="top"><span class="name"><span class="dot active"></span>lanchu server</span>' +
    '<span><button data-act="restart-server">Restart</button> <button class="danger" data-act="stop-server">Stop</button></span></div>' +
    '<div class="proc-grid" style="margin-top:12px">' +
      kv("pid", s.pid) + kv("uptime", fmtUptime(s.uptimeSec)) + kv("port", s.port) +
      kv("version", "v" + s.version) + kv("memory", s.memMB + " MB") + kv("node", s.node) + kv("platform", s.platform) +
    '</div></div>';
  var terms = p.terminals || [];
  document.getElementById("c-proc").textContent = terms.length;
  document.getElementById("terminals").innerHTML = terms.map(function (t) {
    return '<div class="card"><div class="top"><span class="name"><span class="dot ' + (t.alive ? "active" : "idle") + '"></span>' + esc(t.name) + '</span>' +
      '<span><button data-act="focus-term" data-id="' + t.agentId + '" data-name="' + esc(t.name) + '">Focus</button> ' +
      '<button data-act="logs" data-id="' + t.agentId + '">Logs</button> ' +
      '<button class="danger" data-act="close-term" data-id="' + t.agentId + '" data-name="' + esc(t.name) + '">Close</button></span></div>' +
      '<div class="meta"><span class="k">' + esc(t.method) + '</span> ' + esc(t.id) + ' · ' + (t.alive ? "alive" : "not running") + '</div>' +
      '<div class="logbox" id="log-' + t.agentId + '" style="display:none"><pre></pre></div></div>';
  }).join("") || '<div class="empty">No agent terminals tracked yet — spawn an agent to see it here.</div>';
}
function refreshProcesses() {
  if (curView !== "processes") return;
  get("/api/processes").then(renderProcesses).catch(function () {});
}
// Keep the sidebar's Processes count live even while another view is open — the
// full render is throttled to when Processes is visible, but the badge is cheap.
function updateProcBadge() {
  get("/api/processes").then(function (p) {
    document.getElementById("c-proc").textContent = (p.terminals || []).length;
  }).catch(function () {});
}

function renderStats(board, audit) {
  var active = board.agents.filter(function (a) { return a.state === "active"; }).length;
  var viol = audit.filter(function (e) { return e.outcome === "rejected"; }).length;
  // Count "done" the same way the board's Done lane does, so tile and lane agree.
  var done = board.tasks.filter(function (t) { return stageOf(t) === "done"; }).length;
  var prs = board.tasks.filter(function (t) { return t.pr_url; }).length;
  var tiles = [
    { n: board.agents.length, l: "agents" },
    { n: active, l: "active" },
    { n: board.tasks.length, l: "tasks" },
    { n: done, l: "done" },
    { n: prs, l: "PRs" },
    { n: viol, l: "violations", bad: viol > 0 },
  ];
  document.getElementById("tiles").innerHTML = tiles.map(function (t) {
    return '<div class="tile' + (t.bad ? " bad" : "") + '"><div class="n">' + t.n + '</div><div class="l">' + t.l + '</div></div>';
  }).join("");
  document.getElementById("sidestat").innerHTML =
    '<b>' + active + '</b> active · <b>' + board.agents.length + '</b> agents<br><b>' + done + '</b> done · <b>' + board.tasks.length + '</b> tasks' +
    (viol ? ' · <span style="color:var(--bad)"><b>' + viol + '</b> violations</span>' : "");
}

// Orphans: things that exist as records but have nobody behind them. An org with
// no agents and no tasks is the "phantom org" case (a name that never matched a
// real folder); an idle agent with nothing assigned holds a seat doing nothing.
// Cleanup reuses the actions that already exist: remove org / retire agent.
function renderAttention(orgs, agents) {
  var items = [];
  (orgs || []).forEach(function (o) {
    if (o.agents === 0 && o.tasks === 0) {
      items.push('<div class="card"><div class="top"><span class="name">org “' + esc(o.name) + '”</span>' +
        '<button class="danger" data-act="remove-org" data-id="' + esc(o.name) + '">Remove org</button></div>' +
        '<div class="meta">No agents and no tasks. If it\\'s a leftover — e.g. a name that never matched a real folder — remove it' +
        (o.projects ? ' (also deletes its ' + o.projects + ' empty project record' + (o.projects > 1 ? 's' : '') + ')' : '') + '.</div></div>');
    }
  });
  (agents || []).forEach(function (a) {
    if (a.state === "idle" && a.open_tasks === 0) {
      items.push('<div class="card"><div class="top"><span class="name"><span class="dot idle"></span>' + esc(a.name) + '</span>' +
        '<button class="danger" data-act="retire" data-id="' + a.id + '">Retire</button></div>' +
        '<div class="meta">No live session and nothing assigned' + (a.worktree || a.workspace ? '' : ', and no bound folder') +
        ' — retire it, or give it work from the Work board.</div></div>');
    }
  });
  document.getElementById("attention").innerHTML = items.length
    ? '<h2 class="sub-h2">Needs attention — orphaned or idle</h2>' + items.join("")
    : "";
}

var busy = false, lastSig = "";
function refresh() {
  if (!org()) return;
  updateProcBadge();
  if (busy) return; busy = true;
  Promise.all([get("/api/board"), get("/api/roles"), get("/api/docs"), get("/api/audit"), get("/api/orgs")])
    .then(function (r) {
      var sig = JSON.stringify(r);
      if (sig === lastSig) return; // nothing changed — keep the DOM (and any open select) intact
      lastSig = sig;
      renderOrgOptions(r[4]);
      // An unknown org renders exactly like a real-but-empty one, so say so —
      // and point at the terminal, where orgs are actually created.
      var known = (r[4] || []).some(function (o) { return o.name === org(); });
      var ow = document.getElementById("orgwarn");
      ow.style.display = known ? "none" : "block";
      if (!known) ow.innerHTML = 'Org “' + esc(org()) + '” doesn\\'t exist — this field only picks existing orgs; the panel never creates one. To set it up, run this inside your repo folder: ' + cmdSnippet(initCmd());
      renderProjects(r[0].projects);
      renderProjectsView(r[0].projects, r[0].tasks, r[0].agents);
      renderAgents(r[0].agents);
      renderTasks(r[0].tasks, r[0].agents);
      renderRoles(r[1]); renderDocs(r[2]); renderAudit(r[3]);
      renderStats(r[0], r[3]);
      renderAttention(r[4], r[0].agents);
      updateContextCmds();
    }).catch(function () {}).then(function () { busy = false; });
}

var sse = null;
function connect() {
  if (sse) sse.close();
  var live = document.getElementById("live"), t = document.getElementById("live-t");
  sse = new EventSource("/events?org=" + encodeURIComponent(org()) + keyParam());
  sse.onopen = function () { live.className = "live on"; t.textContent = "live"; };
  sse.onmessage = function () { refresh(); };
  sse.onerror = function () { live.className = "live"; t.textContent = "reconnecting"; };
  refresh();
}
document.getElementById("org").addEventListener("change", connect);
// No creation here by design: the panel observes and guides; orgs (like every
// entity) are created from the terminal. Unknown names get the #orgwarn hint.
setInterval(refresh, 10000);
setInterval(refreshProcesses, 3000); // live pid/uptime + terminal liveness, only while the Processes view is open
routeFromHash();
connect();
</script>
</body>
</html>`;
}
