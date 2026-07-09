import { baseUrl } from "../config.js";

/**
 * Supervisor panel. Local, no auth. Live via SSE (/events) with a polling
 * fallback. Surfaces agents, tasks, roles, docs and the audit log, and offers
 * supervisor actions (retire / release / reassign) without browser dialogs.
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

  header { position: sticky; top: 0; z-index: 10; background: color-mix(in srgb, var(--bg) 88%, transparent);
           backdrop-filter: saturate(1.2) blur(8px); border-bottom: 1px solid var(--line);
           padding: 14px 28px; display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
  .brand { font-weight: 700; font-size: 17px; letter-spacing: -.01em; }
  .brand small { font-weight: 500; color: var(--muted); font-size: 13px; margin-left: 8px; }
  .spacer { flex: 1; }
  .field { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 13px; }
  input { padding: 6px 11px; border-radius: 9px; border: 1px solid var(--line); background: var(--surface);
          color: inherit; font: inherit; outline: none; transition: border-color .15s; }
  input:focus { border-color: var(--accent); }
  .live { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted);
          padding: 4px 10px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); }
  .live .pip { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); }
  .live.on .pip { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-bg); }
  .stats { display: flex; gap: 18px; color: var(--muted); font-size: 13px; }
  .stats b { color: var(--fg); font-variant-numeric: tabular-nums; }
  .stats .warnstat { color: var(--bad); }

  main { padding: 24px 28px 64px; max-width: 1400px; margin: 0 auto; }
  .grid { display: grid; grid-template-columns: repeat(12, 1fr); gap: 20px; }
  .col-6 { grid-column: span 6; } .col-4 { grid-column: span 4; } .col-12 { grid-column: 1 / -1; }
  @media (max-width: 900px) { .col-6, .col-4 { grid-column: 1 / -1; } }

  section > h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .07em; color: var(--faint);
                 margin: 2px 0 12px; display: flex; align-items: center; gap: 8px; }
  section > h2 .count { color: var(--muted); font-weight: 600; }

  .card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius);
          padding: 13px 15px; margin-bottom: 10px; box-shadow: var(--shadow); transition: border-color .15s, transform .05s; }
  .card:hover { border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); }
  .card .top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .name { font-weight: 600; letter-spacing: -.01em; }
  .meta { color: var(--muted); font-size: 12.5px; margin-top: 3px; }
  .meta .k { color: var(--faint); }
  .id { font-family: var(--mono); font-size: 11.5px; color: var(--faint); }

  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; }
  .dot.active { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-bg); }
  .dot.idle { background: var(--warn); box-shadow: 0 0 0 3px var(--warn-bg); }

  .pill { display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 9px; border-radius: 999px;
          letter-spacing: .01em; }
  .p-available { background: var(--surface-2); color: var(--muted); border: 1px solid var(--line); }
  .p-claimed { background: var(--info-bg); color: var(--info); }
  .p-in_progress { background: var(--warn-bg); color: var(--warn); }
  .p-blocked { background: var(--bad-bg); color: var(--bad); }
  .p-done { background: var(--ok-bg); color: var(--ok); }
  .stale-pill { background: var(--bad-bg); color: var(--bad); }
  .tag { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 7px; margin: 4px 4px 0 0;
         background: var(--accent-weak); color: var(--accent); font-weight: 500; }

  .actions { margin-top: 10px; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  button, select { font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 8px; border: 1px solid var(--line);
                   background: var(--surface); color: var(--fg); cursor: pointer; transition: background .12s, border-color .12s; }
  button:hover { border-color: var(--accent); background: var(--accent-weak); }
  button.danger:hover { border-color: var(--bad); color: var(--bad); background: var(--bad-bg); }

  .empty { color: var(--faint); font-size: 13px; padding: 8px 2px; }

  #agents, #tasks { max-height: 66vh; overflow-y: auto; padding-right: 4px; }
  #audit { max-height: 44vh; overflow-y: auto; padding-right: 4px; }
  ::-webkit-scrollbar { width: 9px; height: 9px; }
  ::-webkit-scrollbar-thumb { background: var(--line); border-radius: 9px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--faint); }
  ::-webkit-scrollbar-track { background: transparent; }

  .ev { display: grid; grid-template-columns: 74px 1fr auto; gap: 10px; padding: 7px 10px; border-radius: 8px;
        align-items: baseline; font-size: 13px; }
  .ev:nth-child(odd) { background: var(--surface-2); }
  .ev.rej { background: var(--bad-bg); box-shadow: inset 2px 0 0 var(--bad); }
  .ev .time { font-family: var(--mono); font-size: 12px; color: var(--faint); }
  .ev .who { font-weight: 600; }
  .ev .type { font-family: var(--mono); font-size: 12px; color: var(--accent); }
  .ev.rej .type { color: var(--bad); }
  .ev .right { font-size: 12px; color: var(--muted); text-align: right; white-space: nowrap; }
</style>
</head>
<body>
  <header>
    <div class="brand">Lanchu <small>control &amp; trust panel</small></div>
    <div class="spacer"></div>
    <div class="stats" id="stats"></div>
    <div class="field"><span>org</span><input id="org" value="lanchu" autocomplete="off" /></div>
    <span id="live" class="live"><span class="pip"></span><span id="live-t">connecting</span></span>
  </header>

  <main>
    <div class="grid">
      <section class="col-6"><h2>Team <span class="count" id="c-agents"></span></h2><div id="agents"></div></section>
      <section class="col-6"><h2>Work <span class="count" id="c-tasks"></span></h2><div id="tasks"></div></section>
      <section class="col-6"><h2>Roles</h2><div id="roles"></div></section>
      <section class="col-6"><h2>Documentation <span class="count" id="c-docs"></span></h2><div id="docs"></div></section>
      <section class="col-12"><h2>Activity — audit log</h2><div id="audit"></div></section>
    </div>
  </main>

<script>
var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
  return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); };
var org = function () { return document.getElementById("org").value.trim(); };
var get = function (p) { return fetch(p + (p.indexOf("?") < 0 ? "?" : "&") + "org=" + encodeURIComponent(org())).then(function (r) { return r.json(); }); };
function post(path, body) {
  return fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(function (r) { return r.json(); }).then(function (r) { refresh(); return r; });
}
function retire(id) {
  post("/agent/retire", { agentId: id }).then(function (r) {
    var el = document.getElementById("retire-msg-" + id);
    if (el && r && r.retired === false) el.textContent = "blocked — " + r.blockedBy.length + " open task(s) to hand off first";
  });
}
function reassign(id) {
  var sel = document.querySelector('select[data-task="' + id + '"]');
  if (sel && sel.value) post("/task/reassign", { taskId: id, toAgentId: sel.value });
}
document.addEventListener("click", function (e) {
  var b = e.target.closest ? e.target.closest("button[data-act]") : null;
  if (!b) return;
  var act = b.getAttribute("data-act"), id = b.getAttribute("data-id");
  if (act === "retire") retire(id);
  else if (act === "release") post("/task/release", { taskId: id });
  else if (act === "reassign") reassign(id);
});

function renderAgents(list) {
  document.getElementById("c-agents").textContent = list.length;
  document.getElementById("agents").innerHTML = list.map(function (a) {
    return '<div class="card"><div class="top"><span class="name"><span class="dot ' + (a.state === "active" ? "active" : "idle") + '"></span>' +
      esc(a.name) + '</span><button class="danger" data-act="retire" data-id="' + a.id + '">Retire</button></div>' +
      '<div class="meta"><span class="k">role</span> ' + esc(a.role_name || "—") + ' · <b>' + a.open_tasks + '</b> open' +
      (a.workspace ? ' · <span class="k">ws</span> ' + esc(a.workspace) : "") + '</div>' +
      (a.objective ? '<div class="meta"><span class="k">obj</span> ' + esc(a.objective) + '</div>' : "") +
      '<div class="meta">' + esc(a.last_activity || "no activity yet") + '</div>' +
      '<div class="meta" style="color:var(--bad)" id="retire-msg-' + a.id + '"></div></div>';
  }).join("") || '<div class="empty">No agents yet.</div>';
}

function renderTasks(list, agents) {
  document.getElementById("c-tasks").textContent = list.length;
  var opts = '<option value="">reassign to…</option>' + agents.map(function (a) { return '<option value="' + a.id + '">' + esc(a.name) + '</option>'; }).join("");
  document.getElementById("tasks").innerHTML = list.map(function (t) {
    var badge = t.stale ? '<span class="pill stale-pill">stale</span>' : (t.reserved ? '<span class="pill p-available">reserved</span>' : "");
    var owned = !!t.owner_agent_id;
    var actions = owned
      ? '<div class="actions"><button data-act="release" data-id="' + t.id + '">Release</button>' +
        '<select data-task="' + t.id + '">' + opts + '</select>' +
        '<button data-act="reassign" data-id="' + t.id + '">Reassign</button></div>'
      : "";
    return '<div class="card"><div class="top"><span class="name">' + esc(t.title) + '</span>' +
      '<span><span class="pill p-' + esc(t.status) + '">' + esc(t.status.replace("_", " ")) + '</span> ' + badge + '</span></div>' +
      '<div>' + (t.tags || []).map(function (x) { return '<span class="tag">' + esc(x) + '</span>'; }).join("") + '</div>' +
      '<div class="meta">' + (owned ? '<span class="k">owner</span> ' + esc(t.owner_name || t.owner_agent_id) : "unassigned") +
      (t.workspace ? ' · <span class="k">ws</span> ' + esc(t.workspace) : "") + '</div>' + actions + '</div>';
  }).join("") || '<div class="empty">No tasks yet.</div>';
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

function renderStats(board, audit) {
  var active = board.agents.filter(function (a) { return a.state === "active"; }).length;
  var viol = audit.filter(function (e) { return e.outcome === "rejected"; }).length;
  var done = board.tasks.filter(function (t) { return t.status === "done"; }).length;
  document.getElementById("stats").innerHTML =
    '<span><b>' + board.agents.length + '</b> agents · <b>' + active + '</b> active</span>' +
    '<span><b>' + board.tasks.length + '</b> tasks · <b>' + done + '</b> done</span>' +
    (viol ? '<span class="warnstat"><b>' + viol + '</b> violations</span>' : "");
}

var busy = false, lastSig = "";
function refresh() {
  if (!org() || busy) return; busy = true;
  Promise.all([get("/api/board"), get("/api/roles"), get("/api/docs"), get("/api/audit")])
    .then(function (r) {
      var sig = JSON.stringify(r);
      if (sig === lastSig) return; // nothing changed — keep the DOM (and any open select) intact
      lastSig = sig;
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
connect();
</script>
</body>
</html>`;
}
