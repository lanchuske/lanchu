import { baseUrl } from "../config.js";

/**
 * Minimal supervisor panel. Read-only, local, no auth. Polls /api/board.
 * A richer live panel (SSE) is a follow-up; this proves the wiring end to end.
 */
export function panelHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Lanchu — panel</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { opacity: .6; margin-bottom: 20px; }
  .row { display: flex; gap: 24px; flex-wrap: wrap; }
  .col { flex: 1 1 320px; min-width: 300px; }
  .card { border: 1px solid color-mix(in srgb, currentColor 15%, transparent); border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; }
  .name { font-weight: 600; }
  .tag { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); opacity: .8; margin-right: 4px; }
  .state-active { color: #16a34a; } .state-idle { color: #d97706; }
  .muted { opacity: .55; font-size: 12px; }
  input { padding: 6px 10px; border-radius: 8px; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); background: transparent; color: inherit; }
</style>
</head>
<body>
  <h1>Lanchu</h1>
  <div class="sub">Local control &amp; trust panel · <span id="base">${baseUrl()}</span></div>
  <div style="margin-bottom:16px">
    org: <input id="org" value="acme" /> <span class="muted">the panel polls every 2s</span>
  </div>
  <div class="row">
    <div class="col"><h1>Agents</h1><div id="agents"></div></div>
    <div class="col"><h1>Tasks</h1><div id="tasks"></div></div>
  </div>
<script>
async function tick() {
  const org = document.getElementById('org').value.trim();
  if (!org) return;
  try {
    const r = await fetch('/api/board?org=' + encodeURIComponent(org));
    const b = await r.json();
    document.getElementById('agents').innerHTML = (b.agents||[]).map(a =>
      '<div class="card"><span class="name">' + a.name + '</span> '
      + '<span class="state-' + a.state + '">● ' + a.state + '</span>'
      + '<div class="muted">' + (a.last_activity || 'no activity yet') + '</div></div>'
    ).join('') || '<div class="muted">no agents</div>';
    document.getElementById('tasks').innerHTML = (b.tasks||[]).map(t =>
      '<div class="card"><span class="name">' + t.title + '</span> '
      + '<span class="muted">[' + t.status + ']</span><br>'
      + (t.tags||[]).map(x => '<span class="tag">' + x + '</span>').join('')
      + '<span class="muted"> ' + (t.owner_agent_id ? '· owner set' : '· unassigned') + '</span></div>'
    ).join('') || '<div class="muted">no tasks</div>';
  } catch (e) { /* server may be starting */ }
}
setInterval(tick, 2000); tick();
</script>
</body>
</html>`;
}
