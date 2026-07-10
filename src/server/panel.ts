import { baseUrl } from "../config.js";

/**
 * Supervisor panel. Local, no auth. Live via SSE (/events) with a polling
 * fallback. A sidebar switches between views (Overview, Team, Work, Bugs, Docs,
 * Activity); supervisor actions (retire / release / reassign) and revealing an
 * agent's terminal happen without browser dialogs.
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
  input { padding: 6px 10px; border-radius: 9px; border: 1px solid var(--line); background: var(--bg);
          color: inherit; font: inherit; outline: none; transition: border-color .15s; width: 100%; }
  input:focus { border-color: var(--accent); }
  .live { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted);
          padding: 5px 10px; margin: 0 8px 8px; border: 1px solid var(--line); border-radius: 999px; background: var(--bg); }
  .live .pip { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); }
  .live.on .pip { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-bg); }

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
      <div class="orgfield"><span>org</span><input id="org" value="lanchu" autocomplete="off" /></div>
      <span id="live" class="live"><span class="pip"></span><span id="live-t">connecting</span></span>
      <ul class="nav" id="nav">
        <li data-view="overview">Overview</li>
        <li data-view="team">Team <span class="badge" id="c-agents">0</span></li>
        <li data-view="work">Work <span class="badge" id="c-tasks">0</span></li>
        <li data-view="bugs">Bugs <span class="badge" id="c-bugs">0</span></li>
        <li data-view="docs">Docs <span class="badge" id="c-docs">0</span></li>
        <li data-view="activity">Activity</li>
        <li data-view="processes">Processes <span class="badge" id="c-proc">0</span></li>
      </ul>
      <div class="sidefoot" id="sidestat"></div>
    </nav>

    <main class="content">
      <section class="view" id="v-overview">
        <h1 class="vhead">Overview</h1>
        <p class="vsub">Repositories in scope and the org at a glance.</p>
        <div class="projects" id="projects"></div>
        <div class="tiles" id="tiles"></div>
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
        <div id="server-proc"></div>
        <h2 class="sub-h2">Agent terminals</h2>
        <div id="terminals"></div>
      </section>
    </main>
  </div>
  <div id="toast"></div>

<script>
var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
  return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); };
var org = function () { return document.getElementById("org").value.trim(); };
var get = function (p) { return fetch(p + (p.indexOf("?") < 0 ? "?" : "&") + "org=" + encodeURIComponent(org())).then(function (r) { return r.json(); }); };
// owner/repo from a github-ish url, else the tail segment.
var repoLabel = function (url) { var m = String(url).match(/[:/]([^/]+\\/[^/]+?)(?:\\.git)?$/); return m ? m[1] : url; };
// collapse $HOME to ~ for readability.
var shortPath = function (p) { return p ? String(p).replace(/^\\/Users\\/[^/]+/, "~").replace(/^\\/home\\/[^/]+/, "~") : ""; };

function post(path, body) {
  return fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(function (r) { return r.json(); }).then(function (r) { refresh(); return r; });
}
function toast(msg, bad) {
  var t = document.createElement("div"); t.className = "toast" + (bad ? " bad" : ""); t.textContent = msg;
  document.getElementById("toast").appendChild(t);
  setTimeout(function () { t.remove(); }, 2600);
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
function closeTerm(id, name) {
  post("/agent/terminal/close", { agentId: id }).then(function (r) {
    toast((r && r.closed ? "Closed " : "Cleared ") + name + "'s terminal"); refreshProcesses();
  });
}
function toggleLogs(id) {
  var box = document.getElementById("log-" + id); if (!box) return;
  if (box.style.display !== "none") { box.style.display = "none"; return; }
  box.style.display = "block"; box.querySelector("pre").textContent = "loading…";
  fetch("/api/agent/logs?agentId=" + encodeURIComponent(id)).then(function (r) { return r.json(); }).then(function (r) {
    box.querySelector("pre").textContent = (r.logs || "").trim() || "(no output captured)";
    box.scrollTop = box.scrollHeight;
  }).catch(function () { box.querySelector("pre").textContent = "(couldn't read logs)"; });
}
function stopServer() {
  fetch("/server/stop", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(function () {});
  toast("Stopping the server — the panel will go offline.", true);
}

document.addEventListener("click", function (e) {
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
    return;
  }
  // Click anywhere on an agent card (but not on its controls) → reveal its terminal.
  if (e.target.closest && !e.target.closest("button, select")) {
    var card = e.target.closest(".card[data-agent]");
    if (card) reveal(card.getAttribute("data-agent"), card.getAttribute("data-name"));
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
function renderProjects(list) {
  var withInfo = (list || []).filter(function (p) { return p.repo_url || p.local_path; });
  document.getElementById("projects").innerHTML = withInfo.map(function (p) {
    var repo = p.repo_url ? '<a href="' + esc(p.repo_url) + '" target="_blank" rel="noopener">' + esc(repoLabel(p.repo_url)) + '</a>' : "";
    var path = p.local_path ? '<span class="path">' + esc(shortPath(p.local_path)) + '</span>' : "";
    var sep = repo && path ? '<span class="sep">·</span>' : "";
    return '<div class="repo-chip"><span class="pname">' + esc(p.name) + '</span><span class="sep">·</span>' + repo + sep + path + '</div>';
  }).join("") || '<div class="empty">No repository captured yet — it appears when an agent joins from a git checkout.</div>';
}

function renderAgents(list) {
  document.getElementById("c-agents").textContent = list.length;
  document.getElementById("agents").innerHTML = list.map(function (a) {
    var branch = a.branch ? ' · <span class="branch">⌥ ' + esc(a.branch) + '</span>' : "";
    var wt = a.worktree ? '<div class="meta"><span class="k">wt</span> <span class="path" style="font-family:var(--mono);font-size:11.5px">' + esc(shortPath(a.worktree)) + '</span></div>' : "";
    var reveal = a.state === "active" ? "focus terminal" : "open terminal";
    return '<div class="card clickable" data-agent="' + a.id + '" data-name="' + esc(a.name) + '" title="Click to ' + reveal + '">' +
      '<div class="top"><span class="name"><span class="dot ' + (a.state === "active" ? "active" : "idle") + '"></span>' +
      esc(a.name) + '</span><button class="danger" data-act="retire" data-id="' + a.id + '">Retire</button></div>' +
      '<div class="meta"><span class="k">role</span> ' + esc(a.role_name || "—") + ' · <b>' + a.open_tasks + '</b> open' + branch +
      (a.workspace ? ' · <span class="k">ws</span> ' + esc(a.workspace) : "") + '</div>' + wt +
      (a.objective ? '<div class="meta"><span class="k">obj</span> ' + esc(a.objective) + '</div>' : "") +
      '<div class="meta">' + esc(a.last_activity || "no activity yet") + '</div>' +
      '<div class="hint">' + (a.state === "active" ? "● click to focus its terminal" : "○ click to open a terminal") + '</div>' +
      '<div class="meta" style="color:var(--bad)" id="retire-msg-' + a.id + '"></div></div>';
  }).join("") || '<div class="empty">No agents yet.</div>';
}

function taskCard(t, opts) {
  var badge = t.stale ? '<span class="pill stale-pill">stale</span>' : (t.reserved ? '<span class="pill p-available">reserved</span>' : "");
  var owned = !!t.owner_agent_id;
  var pr = t.pr_url ? ' · <a class="pr-link" href="' + esc(t.pr_url) + '" target="_blank" rel="noopener">PR ↗</a>' : "";
  var actions = owned
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
function stageOf(t) { return t.stage || (t.status === "done" ? "done" : "backlog"); }

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
    : '<div class="empty">No tasks yet.</div>';

  var bugs = list.filter(function (t) { return (t.tags || []).indexOf("bug") >= 0; });
  document.getElementById("c-bugs").textContent = bugs.length;
  document.getElementById("bugs").innerHTML = bugs.map(function (t) { return taskCard(t, opts); }).join("") || '<div class="empty">No bugs — nothing tagged "bug".</div>';
}

function renderRoles(list) {
  document.getElementById("roles").innerHTML = list.map(function (r) {
    return '<div class="card"><span class="name">' + esc(r.name) + '</span> ' +
      (r.is_wildcard ? '<span class="tag">★ all tags</span>' : (r.allowed_tags || []).map(function (x) { return '<span class="tag">' + esc(x) + '</span>'; }).join("")) +
      '</div>';
  }).join("") || '<div class="empty">No roles yet.</div>';
}

function renderDocs(list) {
  document.getElementById("c-docs").textContent = list.length;
  document.getElementById("docs").innerHTML = list.map(function (d) {
    return '<div class="card"><span class="name">' + esc(d.title) + '</span>' +
      '<div class="meta">' + d.chars + ' chars · ' + esc((d.updated_at || "").replace("T", " ").slice(0, 16)) +
      (d.updated_by ? ' · by ' + esc(d.updated_by) : "") + '</div></div>';
  }).join("") || '<div class="empty">No documentation yet.</div>';
}

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

function renderStats(board, audit) {
  var active = board.agents.filter(function (a) { return a.state === "active"; }).length;
  var viol = audit.filter(function (e) { return e.outcome === "rejected"; }).length;
  var done = board.tasks.filter(function (t) { return t.status === "done"; }).length;
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

var busy = false, lastSig = "";
function refresh() {
  if (!org() || busy) return; busy = true;
  Promise.all([get("/api/board"), get("/api/roles"), get("/api/docs"), get("/api/audit")])
    .then(function (r) {
      var sig = JSON.stringify(r);
      if (sig === lastSig) return; // nothing changed — keep the DOM (and any open select) intact
      lastSig = sig;
      renderProjects(r[0].projects);
      renderAgents(r[0].agents);
      renderTasks(r[0].tasks, r[0].agents);
      renderRoles(r[1]); renderDocs(r[2]); renderAudit(r[3]);
      renderStats(r[0], r[3]);
    }).catch(function () {}).then(function () { busy = false; });
}

var sse = null;
function connect() {
  if (sse) sse.close();
  var live = document.getElementById("live"), t = document.getElementById("live-t");
  sse = new EventSource("/events?org=" + encodeURIComponent(org()));
  sse.onopen = function () { live.className = "live on"; t.textContent = "live"; };
  sse.onmessage = function () { refresh(); };
  sse.onerror = function () { live.className = "live"; t.textContent = "reconnecting"; };
  refresh();
}
document.getElementById("org").addEventListener("change", connect);
setInterval(refresh, 10000);
setInterval(refreshProcesses, 3000); // live pid/uptime + terminal liveness, only while the Processes view is open
routeFromHash();
connect();
</script>
</body>
</html>`;
}
