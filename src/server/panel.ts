import { createHash } from "node:crypto";
import { baseUrl } from "../config.js";

/**
 * Supervisor panel. Open on loopback; when the server sets LANCHU_ACCESS_KEY the
 * page prompts for it and sends it on every request (Bearer header, or ?key= for
 * SSE). Live via SSE (/events) with a polling fallback. A sidebar switches
 * between views (Overview, Team, Work, Bugs, Docs, Activity); supervisor actions
 * (retire / release / reassign) and revealing an agent's terminal happen without
 * browser dialogs.
 */
const TEMPLATE = `<!doctype html>
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
  .quota { font-size: 11px; font-variant-numeric: tabular-nums; color: var(--faint);
           border: 1px solid var(--line); border-radius: 8px; padding: 1px 7px; margin-left: 6px; }
  .quota.near { color: var(--warn); border-color: var(--warn); background: var(--warn-bg); }
  .quota.over { color: var(--bad); border-color: var(--bad); background: var(--bad-bg); }

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
  .doc-readers { margin-top: 10px; padding-top: 8px; border-top: 1px dashed var(--line);
                 display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
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

  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; box-sizing: border-box; }
  .dot.active { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-bg); }
  .dot.idle { background: var(--warn); box-shadow: 0 0 0 3px var(--warn-bg); }
  .dot.bad { background: var(--bad); box-shadow: 0 0 0 3px var(--bad-bg); }
  .dot.unknown { background: var(--faint); }
  /* tri-state presence: working pulses green, idle is amber, off is a gray hollow */
  .dot.working { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-bg); animation: dotpulse 2.2s ease-in-out infinite; }
  .dot.off { background: transparent; border: 2px solid var(--faint); }
  @keyframes dotpulse { 50% { box-shadow: 0 0 0 5px var(--ok-bg); } }
  .preslegend { color: var(--faint); font-size: 12px; margin: -6px 0 12px; }
  .preslegend .dot { margin-right: 3px; }

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
  /* An empty lane costs no board width: just its header, rotated content-free. */
  .lane.slim { min-width: 0; flex: 0 0 auto; }
  .lane.slim .lane-h { white-space: nowrap; }
  .lane-more { width: 100%; margin-top: 6px; }
  /* task cards: clamp long titles to ~3 lines; click expands (same pattern as Docs) */
  .card.task { cursor: pointer; }
  .card.task .name { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .card.task.open .name { -webkit-line-clamp: unset; }
  .card.task.open { border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); }
  /* the lane row scrolls sideways — show that more lanes exist off-screen */
  .board-wrap { position: relative; }
  .board-more { position: absolute; top: 0; bottom: 8px; right: 0; display: none; align-items: center;
                padding: 0 6px 0 46px; background: linear-gradient(to right, transparent, var(--bg) 62%);
                color: var(--muted); font-size: 12px; font-weight: 600; cursor: pointer; user-select: none; }
  .board-wrap.overflowing .board-more { display: flex; }

  /* ── org-life graph ── */
  .gwin { display: flex; gap: 6px; margin-bottom: 12px; }
  .gwin button.on { border-color: var(--accent); color: var(--accent); background: var(--accent-weak); font-weight: 600; }
  .gwrap { position: relative; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); }
  #gsvg { display: block; width: 100%; height: 560px; }
  #gsvg circle.agent { fill: var(--accent); }
  /* node ring = the same presence tri-state as every dot */
  #gsvg circle.agent.working { stroke: var(--ok); stroke-width: 2.5px; }
  #gsvg circle.agent.idle { stroke: var(--warn); stroke-width: 2px; }
  #gsvg circle.agent.off { fill: var(--faint); stroke: var(--line); stroke-width: 2px; }
  #gsvg circle.docn { fill: var(--info); }
  #gsvg circle.arean { fill: var(--warn); opacity: .75; }
  #gsvg g.retired { opacity: .35; }
  #gsvg g.gnode { cursor: pointer; }
  #gsvg text.glabel { font-size: 10.5px; fill: var(--muted); text-anchor: middle; pointer-events: none; }
  #gsvg line { stroke: var(--faint); stroke-opacity: .45; }
  #gsvg line.msg, #gsvg line.handoff { stroke: var(--accent); stroke-opacity: .55; }
  #gsvg line.flow { stroke: var(--info); stroke-opacity: .55; }
  #gsvg line.conflict, #gsvg line.bounce { stroke: var(--warn); stroke-opacity: .8; }
  #gsvg line.bounce { stroke-dasharray: 5 4; }
  .gempty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--faint); font-size: 13px; }
  .glegend { display: flex; gap: 16px; flex-wrap: wrap; color: var(--muted); font-size: 12px; margin-top: 10px; align-items: center; }
  .glegend span { display: inline-flex; align-items: center; gap: 6px; }
  .gsw { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .gsw.agent { background: var(--accent); } .gsw.docn { background: var(--info); } .gsw.arean { background: var(--warn); opacity: .75; }
  /* agent-ring swatches: the same presence tri-state as the dots */
  .gsw.ringw { background: var(--accent); box-shadow: 0 0 0 2px var(--ok); }
  .gsw.ringi { background: var(--accent); box-shadow: 0 0 0 2px var(--warn); }
  .gsw.ringo { background: var(--faint); box-shadow: 0 0 0 2px var(--line); }
  .gln { width: 18px; height: 0; border-top: 2px solid var(--faint); display: inline-block; }
  .gln.msg { border-color: var(--accent); } .gln.flow { border-color: var(--info); } .gln.warnl { border-color: var(--warn); border-top-style: dashed; }

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
  /* compact stat row — the numbers orient, the sections below are the home */
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(104px, 1fr)); gap: 10px; }
  .tile { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 10px 14px; box-shadow: var(--shadow); }
  .tile .n { font-size: 20px; font-weight: 700; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
  .tile .l { color: var(--muted); font-size: 11.5px; margin-top: 1px; }
  .tile.bad .n { color: var(--bad); }

  /* ── overview: working-now strip + inline feeds ── */
  .wnow { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px; }
  .wnow .card { margin-bottom: 0; }
  .conf { padding: 8px 10px; border-radius: 8px; background: var(--warn-bg); box-shadow: inset 2px 0 0 var(--warn);
          font-size: 12.5px; color: var(--muted); margin-bottom: 6px; }
  .conf .who { color: var(--fg); font-weight: 600; }
  .conf .time { font-family: var(--mono); font-size: 11.5px; color: var(--faint); margin-right: 6px; }
  /* Shipped rows share the conf layout but read as delivery, not warning. */
  .conf.ship { background: var(--ok-bg); box-shadow: inset 2px 0 0 var(--ok); }
  .conf.ship a { color: var(--accent); font-weight: 600; }

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
  .ev.clamp { cursor: pointer; }
  .ev .evmore { color: var(--accent); font-size: 11px; font-weight: 600; }
  .id-link { color: var(--accent); cursor: pointer; text-decoration: none; font-size: 12.5px; }
  .id-link:hover { text-decoration: underline; }

  /* ── roles: holders + muted orphan chips ── */
  .holder { display: inline-flex; align-items: center; gap: 3px; margin-left: 8px; }
  .rolechip { display: inline-block; font-size: 11.5px; padding: 2px 9px; border-radius: 999px; margin-right: 4px;
              background: var(--surface-2); color: var(--faint); border: 1px solid var(--line); }

  ::-webkit-scrollbar { width: 9px; height: 9px; }
  ::-webkit-scrollbar-thumb { background: var(--line); border-radius: 9px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--faint); }
  ::-webkit-scrollbar-track { background: transparent; }

  /* ── greenzone banner (org-wide maintenance window) ── */
  .gz { background: var(--warn-bg, #fff7e6); border: 1px solid var(--warn, #b8860b); border-radius: 10px;
        padding: 10px 14px; margin-bottom: 14px; font-size: 13px; }
  .gz b { text-transform: uppercase; letter-spacing: .05em; font-size: 11.5px; }
  .gz .gz-agent { display: inline-block; margin-left: 8px; padding: 1px 8px; border-radius: 999px;
                  border: 1px solid var(--line); font-size: 11.5px; }
  .gz .gz-agent.ok { border-color: var(--ok, #2e7d32); color: var(--ok, #2e7d32); }

  /* ── coordinator lease ── */
  .coord-pill { background: var(--accent-bg, #eef4ff); color: var(--accent); border: 1px solid var(--accent); }
  .coordline { font-size: 11.5px; color: var(--muted); padding: 2px 0; }
  .coordline b { color: var(--text); }
  .coordline.expired { color: var(--bad); }

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
      <div id="coordline" class="coordline" style="display:none"></div>
      <ul class="nav" id="nav">
        <li data-view="overview">Overview</li>
        <li data-view="projects">Projects <span class="badge" id="c-projects">0</span></li>
        <li data-view="team">Team <span class="badge" id="c-agents">0</span></li>
        <li data-view="work">Work <span class="badge" id="c-tasks">0</span></li>
        <li data-view="graph">Org life</li>
        <li data-view="bugs">Bugs <span class="badge" id="c-bugs">0</span></li>
        <li data-view="docs">Docs <span class="badge" id="c-docs">0</span></li>
        <li data-view="memory">Memory <span class="badge" id="c-memory">0</span></li>
        <li data-view="tests">Tests <span class="badge" id="c-tests">0</span></li>
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
      <div id="greenzone" class="gz" style="display:none"></div>
      <section class="view" id="v-overview">
        <h1 class="vhead">Overview</h1>
        <p class="vsub">An <b>org</b> groups everything below it: <b>projects</b> (each a repo + local folder), the <b>agents</b> working across them, and their <b>tasks</b>.</p>
        <div class="tiles" id="tiles"></div>
        <h2 class="sub-h2">Working now</h2>
        <div class="wnow" id="wnow"></div>
        <h2 class="sub-h2">Recently shipped</h2>
        <div id="ov-shipped"></div>
        <div class="cols">
          <div><h2 class="sub-h2">Latest activity</h2><div id="ov-audit"></div></div>
          <div><h2 class="sub-h2">Conflicts &amp; warnings</h2><div id="ov-conflicts"></div></div>
        </div>
        <h2 class="sub-h2">Projects</h2>
        <div class="projects" id="projects"></div>
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
        <div class="preslegend"><span class="dot working"></span>working — recent MCP call · <span class="dot idle"></span>idle — online, no recent calls · <span class="dot off"></span>off — no transport or terminal</div>
        <div id="agents"></div>
        <h2 class="sub-h2">Roles</h2>
        <div id="roles"></div>
      </section>

      <section class="view" id="v-work">
        <h1 class="vhead">Work</h1>
        <p class="vsub">Tasks across the SDLC — definition, build, review, QA, done — with owner, PR and governance signals. Click a card to read its full title.</p>
        <div class="gwin" id="btabs">
          <button data-btab="open" class="on">Open <span class="c" id="bt-open">0</span></button>
          <button data-btab="shipped">Shipped <span class="c" id="bt-shipped">0</span></button>
          <button data-btab="all">All <span class="c" id="bt-all">0</span></button>
        </div>
        <div class="board-wrap" id="board-wrap">
          <div class="board" id="tasks"></div>
          <div class="board-more" id="board-more" title="More lanes off-screen — click to scroll">more →</div>
        </div>
      </section>

      <section class="view" id="v-graph">
        <h1 class="vhead">Org life</h1>
        <p class="vsub">A living picture from the audit log: who talks to whom, who works where, which docs are alive. Node size = recent activity (time-decayed); amber edges are conflicts or backward moves. Click a node to jump to it.</p>
        <div class="gwin" id="gwin">
          <button data-win="1h">1h</button><button data-win="24h" class="on">24h</button><button data-win="7d">7d</button>
        </div>
        <div class="gwrap"><svg id="gsvg"></svg><div class="gempty" id="gempty" style="display:none">No activity in this window yet.</div></div>
        <div class="glegend">
          <span><i class="gsw ringw"></i> working</span>
          <span><i class="gsw ringi"></i> idle</span>
          <span><i class="gsw ringo"></i> off</span>
          <span><i class="gsw docn"></i> doc</span>
          <span><i class="gsw arean"></i> work area</span>
          <span><i class="gln msg"></i> message / handoff</span>
          <span><i class="gln flow"></i> stage flow</span>
          <span><i class="gln warnl"></i> conflict / bounce</span>
        </div>
      </section>

      <section class="view" id="v-bugs">
        <h1 class="vhead">Bugs</h1>
        <p class="vsub">Tasks tagged <span class="tag">bug</span>.</p>
        <div id="bugs"></div>
      </section>

      <section class="view" id="v-docs">
        <h1 class="vhead">Documentation</h1>
        <p class="vsub">Shared definitions and knowledge kept current by the team — with <b>Memory</b>, the org's knowledge home. Every agent read is on the record: cards show usage and who consulted what (the raw <code>doc.read</code> events stay out of Activity by default).</p>
        <input id="doc-q" class="doc-search" type="search" placeholder="Filter docs by title or content…" autocomplete="off" spellcheck="false">
        <div id="docs"></div>
      </section>

      <section class="view" id="v-memory">
        <h1 class="vhead">Memory</h1>
        <p class="vsub">Persistent learnings in three scopes — org, project, agent — each with provenance: who or what wrote it, and when. Event-derived entries are distilled automatically from the audit log; agents add their own with <code>memory_set</code>. Read-only here.</p>
        <div id="memory"></div>
      </section>

      <section class="view" id="v-tests">
        <h1 class="vhead">Tests</h1>
        <p class="vsub">The org's QA registry — suites and cases with last status, pass-rate history and coverage gaps. Agents and CI record runs with <code>test_report</code>; the safety net grows on the record, not in anyone's context.</p>
        <div id="tests"></div>
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
        <h2 class="sub-h2">Context spend (24h)</h2>
        <p class="vsub">What each MCP tool and agent put into context windows (chars ≈ 4·tokens) — the empirical loop for tuning knowledge caps and budgets.</p>
        <div id="ctx-spend"><div class="empty">loading…</div></div>
        <h2 class="sub-h2">Lanchu MCP — live transports</h2>
        <div id="mcp-agents"><div class="empty">loading…</div></div>
        <h2 class="sub-h2">Project MCP servers</h2>
        <div id="mcp-projects"><div class="empty">loading…</div></div>
      </section>
    </main>
  </div>
  <div id="toast"></div>

<script>
var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
  return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); };
var org = function () { return document.getElementById("org").value.trim(); };
var BUILD_ID = "__LANCHU_BUILD__"; // stamped by the server at render time

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
  // Activity id-links jump to the thing: task → Work board, doc → Docs expanded.
  var il = e.target.closest ? e.target.closest("a.id-link") : null;
  if (il) {
    if (il.getAttribute("data-kind") === "doc") { openDocs[il.getAttribute("data-ref")] = true; renderDocs(lastDocs); location.hash = "docs"; }
    else location.hash = "work";
    return;
  }
  // Clamped activity rows expand/collapse on click.
  var evEl = e.target.closest ? e.target.closest(".ev[data-ev]") : null;
  if (evEl) { var k = evEl.getAttribute("data-ev"); openEvs[k] = !openEvs[k]; renderAuditRows(); return; }
  var b = e.target.closest ? e.target.closest("button[data-act]") : null;
  if (b) {
    var act = b.getAttribute("data-act"), id = b.getAttribute("data-id"), nm = b.getAttribute("data-name") || "agent";
    if (act === "retire") retire(id);
    else if (act === "release") post("/task/release", { taskId: id });
    else if (act === "focus-term") reveal(id, nm);
    else if (act === "logs") toggleLogs(id);
    else if (act === "close-term") closeTerm(id, nm);
    else if (act === "restart-server") { requestRestartGreenzone(); }
    else if (act === "stop-server") stopServer();
    else if (act === "remove-org") removeOrg(b, id);
    else if (act === "show-all-done") { showAllDone = true; renderBoard(); }
    return;
  }
  // Click anywhere on an agent card (but not on its controls) → reveal its terminal.
  if (e.target.closest && !e.target.closest("button, select, a")) {
    var card = e.target.closest(".card[data-agent]");
    if (card) { reveal(card.getAttribute("data-agent"), card.getAttribute("data-name")); return; }
    // Click a doc card → expand/collapse its content (remembered across refreshes).
    var doc = e.target.closest(".card.doc[data-doc]");
    if (doc) { openDocs[doc.getAttribute("data-doc")] = doc.classList.toggle("open"); return; }
    // Click a task card → expand/collapse its clamped title (same pattern).
    var tc = e.target.closest(".card.task[data-task-card]");
    if (tc) { openTasks[tc.getAttribute("data-task-card")] = tc.classList.toggle("open"); }
  }
});

// Reassign is a single control: choosing an agent in the select acts immediately.
document.addEventListener("change", function (e) {
  var sel = e.target;
  if (!sel || !sel.getAttribute || !sel.getAttribute("data-reassign") || !sel.value) return;
  var name = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : "agent";
  post("/task/reassign", { taskId: sel.getAttribute("data-reassign"), toAgentId: sel.value })
    .then(function () { toast("Reassigned to " + name); });
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
  // The board renders while hidden (scrollWidth 0) — measure when it becomes visible.
  if (name === "work") updateBoardMore();
  if (name === "graph") fetchGraph();
}
document.getElementById("nav").addEventListener("click", function (e) {
  var li = e.target.closest("li[data-view]"); if (!li) return;
  location.hash = li.getAttribute("data-view");
});
document.getElementById("btabs").addEventListener("click", function (e) {
  var b = e.target.closest("button[data-btab]"); if (!b) return;
  boardTab = b.getAttribute("data-btab");
  showAllDone = false; // each visit starts compact again
  var bs = document.querySelectorAll("#btabs button");
  for (var i = 0; i < bs.length; i++) bs[i].classList.toggle("on", bs[i] === b);
  renderBoard();
});
function routeFromHash() {
  var name = (location.hash || "#overview").slice(1);
  if (name === "orglife") name = "graph"; // the nav label is "Org life" but the view is #graph — accept the guessable hash
  // A typo'd or stale hash would toggle every view off (blank content area) —
  // fall back to overview and normalize the URL without adding a history entry.
  if (!document.getElementById("v-" + name)) name = "overview";
  if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
  showView(name);
}
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
    // Which GitHub account(s) this project's contributors push as.
    var ghLogins = {};
    Object.keys(owners).forEach(function (id) { var a = agentById[id]; if (a && a.gh_login) ghLogins[a.gh_login] = (ghLogins[a.gh_login] || 0) + 1; });
    var ghNames = Object.keys(ghLogins);
    var gh = ghNames.length
      ? '<div class="meta"><span class="k">gh</span> ' + ghNames.map(esc).join(", ") +
        (ghNames.length === 1 && Object.keys(owners).length > 1
          ? ' <span class="pill p-available" title="GitHub-side attribution is ambiguous — per-agent commit authors still tell them apart">' + Object.keys(owners).length + ' contributors share this account</span>'
          : "") + '</div>'
      : "";
    return '<div class="card proj-card"><div class="top"><span class="name">' + esc(p.name) + '</span>' +
      '<span class="meta"><b>' + pts.length + '</b> tasks · <b>' + done + '</b> done · <b>' + Object.keys(owners).length + '</b> contributors</span></div>' +
      repo + path + (br ? '<div class="meta"><span class="k">branches</span> ' + br + '</div>' : "") + gh + '</div>';
  }).join("") || '<div class="empty">No projects yet. A project is a repo + its local folder, so it\\'s created from inside that folder — in your terminal, run ' + cmdSnippet(initCmd()) + ' then have an agent join (it appears here with its repo and path).</div>';
}

// Agent colors come from the board (persisted, per-org de-collided slots —
// bug fix: 'qa-gate'/'product' used to hash to the same hue). The hash below
// MIRRORS src/core/colors.ts and is only the fallback for names the board
// doesn't carry (e.g. retired actors in old Activity rows).
var COLOR_BY_NAME = {};
var AGENT_PALETTE = ["#e69f00", "#56b4e9", "#009e73", "#f0e442", "#0072b2", "#d55e00", "#cc79a7", "#9467bd", "#17becf", "#999999"];
function agentColorHex(name) {
  var h = 0x811c9dc5;
  for (var i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  h = (h + 1984) >>> 0; // same SALT as core/colors.ts
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16; h = h >>> 0;
  return AGENT_PALETTE[h % AGENT_PALETTE.length];
}
function colorChip(name) {
  var hex = COLOR_BY_NAME[name] || agentColorHex(name);
  return '<span class="cdot" style="background:' + hex + '" title="agent color (same in terminal + tile)"></span>';
}

// One presence dot, one meaning, every surface. Tooltip spells out the state.
var PRESENCE_TIP = {
  working: "working — MCP tool call within the working window (~2 min)",
  idle: "idle — online (transport or terminal) but no recent calls",
  off: "off — no transport and no alive terminal; click to reopen"
};
function presDot(p) {
  p = PRESENCE_TIP[p] ? p : "off";
  return '<span class="dot ' + p + '" title="' + PRESENCE_TIP[p] + '"></span>';
}
function presLegend() {
  return '<div class="preslegend">' + presDot("working") + 'working · ' + presDot("idle") + 'idle · ' + presDot("off") + 'off</div>';
}

function renderAgents(list) {
  document.getElementById("c-agents").textContent = list.length;
  // GitHub-side attribution is ambiguous when several agents push as one
  // account — count logins so shared identities get a visible chip.
  var ghCounts = {};
  list.forEach(function (a) { if (a.gh_login) ghCounts[a.gh_login] = (ghCounts[a.gh_login] || 0) + 1; });
  document.getElementById("agents").innerHTML = list.map(function (a) {
    var branch = a.branch ? ' · <span class="branch">⌥ ' + esc(a.branch) + '</span>' : "";
    var wt = a.worktree ? '<div class="meta"><span class="k">wt</span> <span class="path" style="font-family:var(--mono);font-size:11.5px">' + esc(shortPath(a.worktree)) + '</span></div>' : "";
    var taskTitle = a.active_task_title ? (a.active_task_title.length > 90 ? a.active_task_title.slice(0, 90) + "…" : a.active_task_title) : "";
    var task = a.active_task_id ? '<div class="meta"><span class="k">task</span> <span title="' + esc(a.active_task_title || "") + '">' + esc(taskTitle) + '</span></div>' : "";
    var gh = a.gh_login || a.git_author_name
      ? '<div class="meta">' +
        (a.gh_login
          ? '<span class="k">gh</span> ' + esc(a.gh_login) +
            (ghCounts[a.gh_login] > 1 ? ' <span class="pill p-available" title="GitHub sees one author for these agents — commit authors still tell them apart">' + ghCounts[a.gh_login] + ' agents share this account</span>' : "")
          : '<span class="k">gh</span> <span class="hint">not detected</span>') +
        (a.git_author_name ? ' · <span class="k">author</span> ' + esc(a.git_author_name) : "") +
        '</div>'
      : "";
    var reveal = a.presence !== "off" ? "focus terminal" : "open terminal";
    // Auto-wake trace: show "nudged" while the last nudge is recent (10 min);
    // "unreachable" when the sweep spent its budget and gave up — this agent
    // needs the supervisor (focus its terminal or retire it), not more typing.
    var nudged = a.unreachable
      ? '<span class="pill stale-pill" title="auto-wake gave up: nudges went unanswered and notices are still waiting — focus its terminal or retire it">unreachable</span> '
      : a.nudged_at && (Date.now() - new Date(a.nudged_at).getTime() < 600000)
      ? '<span class="pill p-in_progress" title="auto-woken at ' + esc(a.nudged_at.slice(11, 19)) + ' — queued notices were waiting">nudged</span> '
      : "";
    var coord = COORD && COORD.agent_id === a.id
      ? ' <span class="pill coord-pill" title="holds the coordinator lease' + (COORD.expired ? " (EXPIRED)" : "") + '">coordinator' + (COORD.expired ? " ⌛" : "") + '</span>'
      : "";
    return '<div class="card clickable" data-agent="' + a.id + '" data-name="' + esc(a.name) + '" title="Click to ' + reveal + '">' +
      '<div class="top"><span class="name">' + presDot(a.presence) +
      colorChip(a.name) + esc(a.name) + coord + '</span><span>' + nudged + '<button class="danger" data-act="retire" data-id="' + a.id + '">Retire</button></span></div>' +
      '<div class="meta"><span class="k">role</span> ' + esc(a.role_name || "—") +
      (a.model ? ' · <span class="k">model</span> ' + esc(a.model) : "") + ' · <b>' + a.open_tasks + '</b> open' + branch +
      (a.workspace ? ' · <span class="k">ws</span> ' + esc(a.workspace) : "") +
      ' · <span class="k">mcp</span> ' + (a.live_transports > 0 ? a.live_transports + " live" : "not connected") +
      (a.live_transports > 1 ? ' <span class="pill stale-pill" title="two terminals sharing one identity causes misattribution">' + a.live_transports + ' transports</span>' : "") +
      '</div>' + wt + task +
      (a.objective ? '<div class="meta"><span class="k">obj</span> ' + esc(a.objective) + '</div>' : "") +
      gh +
      '<div class="meta"><span class="k">last</span> ' + esc(a.last_activity || "no activity yet") + '</div>' +
      '<div class="hint">' + (a.presence !== "off" ? "● click to focus its terminal" : "○ click to open a terminal") + '</div>' +
      '<div class="meta" style="color:var(--bad)" id="retire-msg-' + a.id + '"></div></div>';
  }).join("") || '<div class="empty">No agents yet. Agents are started from the terminal — inside a project folder, run ' + cmdSnippet('lanchu spawn "your objective"') + ' and supervise it from here.</div>';
}

// Coordinator lease (at most one coordinating agent per org): chip on the
// holder's card + a sidebar line with lease age; expired leases are flagged.
var COORD = null;
function renderCoordinator() {
  var el = document.getElementById("coordline");
  if (!COORD) { el.style.display = "none"; return; }
  var age = Math.max(0, Math.round((Date.now() - new Date(COORD.acquired_at).getTime()) / 60000));
  el.className = "coordline" + (COORD.expired ? " expired" : "");
  el.innerHTML = COORD.expired
    ? "no coordinator — <b>" + esc(COORD.agent_name) + "</b>'s lease expired"
    : "coordinator: <b>" + esc(COORD.agent_name) + "</b> · " + (age < 1 ? "just now" : age + "m");
  el.style.display = "block";
}

var openTasks = {}; // task cards expanded by the user, kept across refreshes (like openDocs)
function taskCard(t, opts) {
  var badge = t.stale ? '<span class="pill stale-pill">stale</span>' : (t.reserved ? '<span class="pill p-available">reserved</span>' : "");
  // 2+ rejections = the definition itself is the problem; flag it prominently.
  if (t.rejection_count >= 2) badge += ' <span class="pill stale-pill" title="rejected ' + t.rejection_count + ' times — fix the definition before anyone retries">needs definition</span>';
  var owned = !!t.owner_agent_id;
  var pr = t.pr_url ? ' · <a class="pr-link" href="' + esc(t.pr_url) + '" target="_blank" rel="noopener">PR ↗</a>' : "";
  var rej = t.last_rejection
    ? '<div class="meta"><span class="k">rejected</span> ' + esc(t.last_rejection.reason.replace(/_/g, " ")) + ' by ' + esc(t.last_rejection.by) +
      (t.rejection_count > 1 ? ' (×' + t.rejection_count + ')' : '') + ' — ' + esc(t.last_rejection.note) + '</div>'
    : "";
  // Supervisor overrides only make sense on open work — a done task has nothing
  // to release or reassign. Reassign is ONE control: picking an agent acts.
  var actions = owned && t.status !== "done"
    ? '<div class="actions"><button data-act="release" data-id="' + t.id + '">Release</button>' +
      '<select data-reassign="' + t.id + '" title="Picking an agent reassigns this task immediately">' + opts + '</select></div>'
    : "";
  return '<div class="card task' + (openTasks[t.id] ? " open" : "") + '" data-task-card="' + t.id + '" title="Click to ' + (openTasks[t.id] ? "collapse" : "expand") + '">' +
    '<div class="top"><span class="name">' + esc(t.title) + '</span>' +
    '<span><span class="pill p-' + esc(t.status) + '">' + esc(t.status.replace("_", " ")) + '</span> ' + badge + '</span></div>' +
    '<div>' + (t.tags || []).map(function (x) { return '<span class="tag">' + esc(x) + '</span>'; }).join("") + '</div>' +
    '<div class="meta">' + (owned ? '<span class="k">owner</span> ' + esc(t.owner_name || t.owner_agent_id) : "unassigned") +
    (t.workspace ? ' · <span class="k">ws</span> ' + esc(t.workspace) : "") + pr + '</div>' + rej + actions + '</div>';
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

// When a task shipped, for newest-first ordering and the "when" column.
function doneStamp(t) { return t.done_at || t.updated_at || t.created_at || ""; }

// Which lanes each board tab shows: shipped work stays one click away instead
// of hiding at the end of the horizontal scroll (task-mrg88fqr1).
var boardTab = "open";
var showAllDone = false;
var lastBoardList = [], lastBoardOpts = "";
function renderBoard() {
  var list = lastBoardList, opts = lastBoardOpts;
  var byStage = {}; STAGES.forEach(function (s) { byStage[s[0]] = []; });
  list.forEach(function (t) { byStage[stageOf(t)].push(t); });
  byStage.done.sort(function (a, b) { return doneStamp(a) < doneStamp(b) ? 1 : -1; }); // newest first
  document.getElementById("bt-open").textContent = list.length - byStage.done.length;
  document.getElementById("bt-shipped").textContent = byStage.done.length;
  document.getElementById("bt-all").textContent = list.length;
  var stages = boardTab === "open" ? STAGES.filter(function (s) { return s[0] !== "done"; })
    : boardTab === "shipped" ? STAGES.filter(function (s) { return s[0] === "done"; })
    : STAGES;
  document.getElementById("tasks").innerHTML = list.length
    ? stages.map(function (s) {
        var items = byStage[s[0]];
        // An empty lane never costs board width — slim header only (unless it's
        // the tab's sole lane, where the empty state should say something).
        if (!items.length && stages.length > 1)
          return '<div class="lane slim"><div class="lane-h">' + s[1] + ' <span class="c">0</span></div></div>';
        var cards = items, more = "";
        if (s[0] === "done" && !showAllDone && items.length > 15) {
          cards = items.slice(0, 15);
          more = '<button class="lane-more" data-act="show-all-done">show all (' + items.length + ')</button>';
        }
        return '<div class="lane"><div class="lane-h">' + s[1] + ' <span class="c">' + items.length + '</span></div>' +
          (cards.map(function (t) { return taskCard(t, opts); }).join("") || '<div class="empty">' + (boardTab === "shipped" ? "Nothing shipped yet." : "—") + '</div>') + more + '</div>';
      }).join("")
    : '<div class="empty">No tasks yet — agents break their objectives into tasks as they work; you supervise them here (release / reassign).</div>';
  updateBoardMore();
}

function renderTasks(list, agents) {
  document.getElementById("c-tasks").textContent = list.length;
  var opts = '<option value="">Reassign to…</option>' + agents.map(function (a) { return '<option value="' + a.id + '">' + esc(a.name) + '</option>'; }).join("");
  lastBoardList = list; lastBoardOpts = opts;
  renderBoard();

  var bugs = list.filter(function (t) { return (t.tags || []).indexOf("bug") >= 0; });
  document.getElementById("c-bugs").textContent = bugs.length;
  document.getElementById("bugs").innerHTML = bugs.map(function (t) { return taskCard(t, opts); }).join("") || '<div class="empty">No bugs — nothing tagged "bug".</div>';
}

// The lane row scrolls sideways; when lanes continue past the viewport, show the
// "more →" affordance (and hide it once the user reaches the end).
function updateBoardMore() {
  var wrap = document.getElementById("board-wrap"), b = document.getElementById("tasks");
  if (!wrap || !b) return;
  wrap.classList.toggle("overflowing", b.scrollLeft + b.clientWidth < b.scrollWidth - 4);
}

function fmtTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n % 1e3 ? 1 : 0) + "k";
  return String(n);
}

function budgetChip(r) {
  if (!r.token_quota) return "";
  var used = r.used_tokens || 0;
  var pct = Math.min(100, Math.round((used / r.token_quota) * 100));
  var cls = used >= r.token_quota ? "quota over" : pct >= 80 ? "quota near" : "quota";
  return '<span class="' + cls + '" title="self-reported tokens vs quota">' +
    fmtTokens(used) + " / " + fmtTokens(r.token_quota) + " tokens (" + pct + "%)</span>";
}

// Roles worth reading first: the ones agents actually hold or that can claim
// work. Orphan roles (no tags, no wildcard, nobody holding them) collapse into
// a muted chip row instead of shouting "no tags" once per card.
function renderRoles(list, agents) {
  var holders = {};
  (agents || []).forEach(function (a) {
    if (a.role_name) (holders[a.role_name] = holders[a.role_name] || []).push(a);
  });
  var used = [], orphan = [];
  (list || []).forEach(function (r) {
    var alive = r.is_wildcard || (r.allowed_tags || []).length || (holders[r.name] || []).length;
    (alive ? used : orphan).push(r);
  });
  var card = function (r) {
    var who = (holders[r.name] || []).map(function (a) {
      return '<span class="holder">' + colorChip(a.name) + esc(a.name) + '</span>';
    }).join("");
    var tags = r.is_wildcard
      ? '<span class="tag">★ all tags</span>'
      : ((r.allowed_tags || []).map(function (x) { return '<span class="tag">' + esc(x) + '</span>'; }).join("")
         || '<span class="hint">no tags — can\\'t claim any task yet</span>');
    return '<div class="card"><div class="top"><span class="name">' + esc(r.name) + '</span>' +
      '<span class="meta">' + (who || '<span class="empty-inline">nobody holds this role</span>') + '</span></div>' +
      '<div>' + tags + budgetChip(r) +
      (r.preferred_model ? '<span class="quota" title="default model tier for spawns with this role">' + esc(r.preferred_model) + '</span>' : "") +
      '</div></div>';
  };
  document.getElementById("roles").innerHTML =
    (used.map(card).join("") || '<div class="empty">No roles yet.</div>') +
    (orphan.length
      ? '<div class="cat-title">Unused roles <span class="badge">' + orphan.length + '</span></div>' +
        '<div class="meta"><span class="rolechips">' + orphan.map(function (r) { return '<span class="rolechip">' + esc(r.name) + '</span>'; }).join(" ") +
        '</span> <span class="hint">no tags, no holders — give one tags from the terminal (<code>lanchu roles</code>) or leave it parked</span></div>'
      : "");
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
      // Knowledge analytics: unread docs are prune candidates; docs read often
      // but not updated in a while are refresh candidates.
      var reads = d.read_count || 0;
      var staleHot = reads >= 3 && d.last_read_at && d.updated_at && d.last_read_at > d.updated_at &&
        (Date.now() - new Date(d.updated_at).getTime()) > 24 * 3600e3;
      var flag = reads === 0
        ? ' <span class="pill p-available" title="no agent has consulted this doc yet — prune candidate?">never read</span>'
        : (staleHot ? ' <span class="pill stale-pill" title="read often but not updated lately — refresh candidate?">stale but hot</span>' : "");
      var readMeta = reads
        ? ' · <b>' + reads + '</b> read' + (reads === 1 ? "" : "s") +
          (d.last_read_by ? ' · last by ' + esc(d.last_read_by) + ' ' + esc((d.last_read_at || "").replace("T", " ").slice(0, 16)) : "")
        : "";
      var readers = (d.readers || []).length
        ? '<div class="meta doc-readers"><span class="k">consulted by</span> ' + d.readers.map(function (r) {
            return '<span class="holder">' + colorChip(r.name || "?") + esc(r.name || r.agent_id) + ' <span class="hint">(' + r.reads + '×, last ' + esc((r.last_read_at || "").replace("T", " ").slice(5, 16)) + ')</span></span>';
          }).join(" ") + '</div>'
        : "";
      return '<div class="card clickable doc' + (openDocs[d.id] ? " open" : "") + '" data-doc="' + esc(d.id) + '">' +
        '<span class="name">' + esc(d.title) + '</span>' + flag +
        '<div class="meta">' + d.chars + ' chars · ' + esc((d.updated_at || "").replace("T", " ").slice(0, 16)) +
        (d.updated_by ? ' · by ' + esc(d.updated_by) : "") + readMeta + '</div>' +
        '<div class="doc-body">' + (d.content ? mdToHtml(d.content) : '<span class="empty-inline">(empty)</span>') + readers + '</div>' +
        '</div>';
    }).join("");
  });
  box.innerHTML = html;
}
(function () {
  var qi = document.getElementById("doc-q");
  if (qi) qi.addEventListener("input", function () { docQuery = this.value; renderDocs(lastDocs); });
})();

// Activity rows: raw ids resolve to their task/doc titles (as jump links), and
// wall-of-text notes clamp with a click-to-expand — remembered across refreshes.
var openEvs = {}, evTaskTitles = {}, evDocTitles = {}, lastAudit = [];
var EV_NOTE_CLAMP = 150;
function evRow(e) {
  var when = (e.created_at || "").slice(11, 19);
  var subj = "";
  if (e.subject_id) {
    var tTitle = evTaskTitles[e.subject_id], dTitle = evDocTitles[e.subject_id];
    var label = tTitle || dTitle;
    subj = label
      ? ' <a class="id-link" data-kind="' + (tTitle ? "task" : "doc") + '" data-ref="' + esc(e.subject_id) + '" title="' + esc(e.subject_id) + '">' +
        esc(label.length > 46 ? label.slice(0, 46) + "…" : label) + '</a>'
      : ' <span class="id">' + esc(e.subject_id) + '</span>';
  }
  var noteRaw = e.data && e.data.note ? String(e.data.note) : "";
  var long = noteRaw.length > EV_NOTE_CLAMP;
  var open = !!openEvs[e.id];
  var note = noteRaw ? " — " + esc(long && !open ? noteRaw.slice(0, EV_NOTE_CLAMP) + "…" : noteRaw) : "";
  var right = (e.outcome === "rejected" ? "rejected" : "") + (e.tokens ? (e.outcome === "rejected" ? " · " : "") + e.tokens + " tok" : "") +
    (long ? ' <span class="evmore">' + (open ? "less ▲" : "more ▼") + '</span>' : "");
  return '<div class="ev' + (e.outcome === "rejected" ? " rej" : "") + (long ? " clamp" : "") + '"' + (long ? ' data-ev="' + e.id + '"' : "") + '>' +
    '<span class="time">' + when + '</span>' +
    '<span>' + (e.actor_name ? colorChip(e.actor_name) : "") + '<span class="who">' + esc(e.actor_name || "—") + '</span> <span class="type">' + esc(e.type) + '</span>' + subj + note + '</span>' +
    '<span class="right">' + right + '</span></div>';
}

var MEMORY_SCOPES = [["org", "Org"], ["project", "Projects"], ["agent", "Agents"]];
function renderMemory(list) {
  list = list || [];
  document.getElementById("c-memory").textContent = list.length;
  document.getElementById("memory").innerHTML = MEMORY_SCOPES.map(function (sc) {
    var entries = list.filter(function (m) { return m.scope === sc[0]; });
    if (!entries.length) return "";
    return '<h2 class="sub-h2">' + sc[1] + '</h2>' + entries.map(function (m) {
      var who = m.scope === "agent" ? colorChip(m.subject_name) + esc(m.subject_name) : esc(m.subject_name);
      var prov = m.source === "agent"
        ? "written by " + esc(m.writer_name || "an agent")
        : m.source === "event"
          ? "distilled from event " + esc(m.source_ref || "?")
          : "distilled (curation run)";
      return '<div class="card"><div class="top"><span class="name">' + who +
        ' <span class="type">' + esc(m.key) + '</span></span>' +
        '<span class="meta">' + esc((m.updated_at || "").slice(0, 16).replace("T", " ")) + '</span></div>' +
        '<div class="meta">' + esc(m.value) + '</div>' +
        '<div class="hint">' + prov + '</div></div>';
    }).join("");
  }).join("") || '<div class="empty">No memories yet. They accrue automatically from events (merged PRs, conflict hot zones, role changes) and from agents\\' own <code>memory_set</code> calls.</div>';
}

// QA registry: suites → cases with last status, pass-rate history and gaps.
function renderTests(suites) {
  suites = suites || [];
  var totalCases = suites.reduce(function (n, s) { return n + s.cases.length; }, 0);
  document.getElementById("c-tests").textContent = totalCases;
  document.getElementById("tests").innerHTML = suites.map(function (s) {
    var badges = '<span class="badge">' + s.cases.length + ' case' + (s.cases.length === 1 ? "" : "s") + '</span>' +
      (s.failing ? ' <span class="pill p-blocked">' + s.failing + ' failing</span>' : "") +
      (s.planned_gaps ? ' <span class="pill p-available">' + s.planned_gaps + ' planned</span>' : "");
    var rows = s.cases.map(function (c) {
      var dot = c.planned ? "unknown" : c.last_status === "pass" ? "active" : c.last_status === "fail" ? "bad" : "unknown";
      var rate = c.recent_runs
        ? ' · <span class="k">pass rate</span> <b>' + c.recent_passes + '/' + c.recent_runs + '</b>'
        : "";
      var last = c.last_ran_at
        ? ' · <span class="k">last</span> ' + esc(c.last_status) +
          (c.last_duration_ms != null ? " in " + c.last_duration_ms + "ms" : "") +
          (c.last_commit ? ' @ <span class="id">' + esc(String(c.last_commit).slice(0, 7)) + '</span>' : "") +
          (c.last_ran_by ? " by " + esc(c.last_ran_by) : "") +
          " " + esc((c.last_ran_at || "").replace("T", " ").slice(5, 16))
        : "";
      var gap = c.planned ? ' <span class="pill p-available" title="identified coverage, not written yet">planned — not implemented</span>' : "";
      return '<div class="meta trow"><span class="dot ' + dot + '"></span> <b>' + esc(c.name) + '</b>' + gap + rate + last + '</div>';
    }).join("");
    return '<div class="card"><div class="top"><span class="name">' + esc(s.name) + '</span><span>' + badges + '</span></div>' +
      rows +
      (s.last_ran_at ? '<div class="hint">suite last ran ' + esc((s.last_ran_at || "").replace("T", " ").slice(0, 16)) + '</div>' : "") +
      '</div>';
  }).join("") || '<div class="empty">No test runs recorded yet. After running a suite, an agent (or CI) records it with <code>test_report({ suite, commit, cases: [{ name, status, durationMs }] })</code> — cases marked <code>planned</code> register coverage gaps.</div>';
}

// One source renders both audit surfaces so expand-on-click stays in sync.
function renderAuditRows() {
  document.getElementById("audit").innerHTML = lastAudit.map(evRow).join("") || '<div class="empty">No activity yet.</div>';
  var ov = document.getElementById("ov-audit");
  if (ov) ov.innerHTML = lastAudit.slice(0, 8).map(evRow).join("") || '<div class="empty">No activity yet.</div>';
}
function renderAudit(list) {
  lastAudit = list || [];
  renderAuditRows();
}

// Overview is the supervisor's home: who is working right now (name → task →
// branch/worktree), the freshest slice of the audit log, and any friction
// (conflict warnings, rejected actions) — all on one screen.
function renderOverview(board, audit) {
  // "Working now" means WORKING — a fresh MCP call — not merely connected;
  // idle-online teammates stay on the Team view with their amber dot.
  var live = board.agents.filter(function (a) { return a.presence === "working"; });
  document.getElementById("wnow").innerHTML = live.map(function (a) {
    var task = a.active_task_title ? (a.active_task_title.length > 76 ? a.active_task_title.slice(0, 76) + "…" : a.active_task_title) : "";
    var branch = a.branch ? '<span class="branch">⌥ ' + esc(a.branch) + '</span>' : "";
    var wt = a.worktree ? '<div class="meta"><span class="k">wt</span> <span style="font-family:var(--mono);font-size:11px">' + esc(shortPath(a.worktree)) + '</span></div>' : "";
    return '<div class="card clickable" data-agent="' + a.id + '" data-name="' + esc(a.name) + '" title="Click to focus its terminal">' +
      '<div class="top"><span class="name">' + presDot(a.presence) + colorChip(a.name) + esc(a.name) + '</span>' + branch + '</div>' +
      '<div class="meta">' + (task ? '<span class="k">task</span> <span title="' + esc(a.active_task_title) + '">' + esc(task) + '</span>' : '<span class="empty-inline">no active task</span>') + '</div>' + wt + '</div>';
  }).join("") || '<div class="empty">Nobody is working right now — agents appear here while their MCP calls are fresh.</div>';

  // Momentum without leaving home: the last 8 shipped tasks, PR link prominent.
  var shipped = board.tasks.filter(function (t) { return stageOf(t) === "done"; })
    .sort(function (a, b) { return doneStamp(a) < doneStamp(b) ? 1 : -1; }).slice(0, 8);
  document.getElementById("ov-shipped").innerHTML = shipped.map(function (t) {
    var m = (t.pr_url || "").match(/\\/pull\\/(\\d+)/);
    var pr = t.pr_url ? ' <a href="' + esc(t.pr_url) + '" target="_blank" rel="noopener">' + (m ? "PR #" + m[1] : "PR") + '</a>' : "";
    var title = t.title.length > 96 ? t.title.slice(0, 96) + "…" : t.title;
    return '<div class="conf ship"><span class="time">' + esc(doneStamp(t).slice(5, 16).replace("T", " ")) + '</span>' +
      '<span class="who">' + esc(t.owner_name || "—") + '</span> <span title="' + esc(t.title) + '">' + esc(title) + '</span>' + pr + '</div>';
  }).join("") || '<div class="empty">Nothing shipped yet — done tasks land here, newest first.</div>';

  var confs = audit.filter(function (e) {
    return e.type === "conflict.detected" || e.type === "scope.violation" || e.outcome === "rejected";
  }).slice(0, 6);
  document.getElementById("ov-conflicts").innerHTML = confs.map(function (e) {
    var whom = e.type === "conflict.detected" && e.data && e.data.conflicts && e.data.conflicts.length
      ? " overlaps " + esc(e.data.conflicts.map(function (c) { return c.with_agent; }).join(", "))
      : "";
    return '<div class="conf"><span class="time">' + esc((e.created_at || "").slice(11, 19)) + '</span>' +
      '<span class="who">' + esc(e.actor_name || "—") + '</span> ' + esc(e.type) + whom +
      (e.subject_id ? ' · <span class="id">' + esc(e.subject_id) + '</span>' : "") + '</div>';
  }).join("") || '<div class="empty">No conflicts or rejected actions in the recent log — healthy.</div>';
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
      kv("running build", "v" + s.version) + kv("memory", s.memMB + " MB") + kv("node", s.node) + kv("platform", s.platform) +
    '</div></div>';
  var terms = p.terminals || [];
  document.getElementById("c-proc").textContent = terms.length;
  document.getElementById("terminals").innerHTML = terms.map(function (t) {
    return '<div class="card"><div class="top"><span class="name">' + presDot(t.presence || (t.alive ? "idle" : "off")) + esc(t.name) + '</span>' +
      '<span><button data-act="focus-term" data-id="' + t.agentId + '" data-name="' + esc(t.name) + '">Focus</button> ' +
      '<button data-act="logs" data-id="' + t.agentId + '">Logs</button> ' +
      '<button class="danger" data-act="close-term" data-id="' + t.agentId + '" data-name="' + esc(t.name) + '">Close</button></span></div>' +
      '<div class="meta"><span class="k">' + esc(t.method) + '</span> ' + esc(t.id) + ' · ' + (t.alive ? "alive" : "not running") + '</div>' +
      '<div class="logbox" id="log-' + t.agentId + '" style="display:none"><pre></pre></div></div>';
  }).join("") || '<div class="empty">No agent terminals tracked yet — spawn an agent to see it here.</div>';
}
// MCP visibility: Lanchu's own transports per agent, and the MCP servers each
// project checkout declares (read-only, credentials never leave the server).
function renderMcps(m) {
  var agents = m.agents || [];
  document.getElementById("mcp-agents").innerHTML = agents.map(function (a) {
    var live = a.live_transports > 0;
    var dupe = a.live_transports > 1
      ? ' <span class="pill stale-pill" title="two terminals sharing one identity causes misattribution">' + a.live_transports + ' transports</span>' : "";
    var gap = !live && a.open_sessions > 0
      ? ' <span class="hint">(session on record, transport down — reconnects on its next tool call)</span>' : "";
    return '<div class="card"><div class="top"><span class="name">' + presDot(a.presence || (live ? "idle" : "off")) +
      colorChip(a.name) + esc(a.name) + dupe + '</span>' +
      '<span class="meta">' + a.live_transports + ' live · ' + a.open_sessions + ' session' + (a.open_sessions === 1 ? "" : "s") + '</span></div>' +
      '<div class="meta"><span class="k">client</span> ' + esc((a.clients || []).join(", ") || "—") +
      ' · <span class="k">last mcp activity</span> ' + esc((a.last_activity_at || "").replace("T", " ").slice(0, 16) || "never") + gap + '</div></div>';
  }).join("") || '<div class="empty">No agents yet.</div>';

  var projects = m.projects || [];
  document.getElementById("mcp-projects").innerHTML = projects.map(function (p) {
    var servers = (p.servers || []).map(function (s) {
      var dot = s.status === "reachable" ? "active" : s.status === "unreachable" ? "bad" : "unknown";
      return '<div class="meta"><span class="dot ' + dot + '" title="' + esc(s.status) + '"></span> <b>' + esc(s.name) + '</b>' +
        ' · <span class="k">' + esc(s.transport) + '</span> <span class="path" style="font-family:var(--mono);font-size:11.5px">' + esc(s.target) + '</span>' +
        ' · <span class="hint">' + esc(s.source) + '</span></div>';
    }).join("");
    return '<div class="card"><div class="top"><span class="name">' + esc(p.name) + '</span>' +
      (p.local_path ? '<span class="path" style="font-family:var(--mono);font-size:11.5px">' + esc(shortPath(p.local_path)) + '</span>' : "") + '</div>' +
      (servers || '<div class="empty">' + (p.local_path
        ? 'No MCP servers configured in this checkout — add one from the terminal: ' + cmdSnippet("claude mcp add <name> <url-or-command>")
        : "No folder captured for this project yet — its MCPs appear once an agent joins from the checkout.") + '</div>') +
      '</div>';
  }).join("") || '<div class="empty">No projects yet.</div>';
}
// Probing project MCP servers costs real HTTP round-trips, so poll it an order
// of magnitude slower than pid/uptime.
var mcpFetchedAt = 0;
function fmtChars(n) {
  n = +n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}
function renderCtxSpend(d) {
  var tools = (d.by_tool || []), agents = (d.by_agent || []);
  if (!tools.length) {
    document.getElementById("ctx-spend").innerHTML = '<div class="empty">No tool responses measured yet.</div>';
    return;
  }
  function rows(list, keyName, chipped) {
    return list.map(function (r) {
      var label = chipped ? colorChip(r[keyName]) + esc(r[keyName]) : esc(r[keyName]);
      return '<div class="ev"><span>' + label + '</span>' +
        '<span class="right">' + r.calls + ' calls · ' + fmtChars(r.chars) + ' chars (~' + fmtChars(Math.round(r.chars / 4)) + ' tok)</span></div>';
    }).join("");
  }
  document.getElementById("ctx-spend").innerHTML =
    '<div class="card"><div class="meta">by tool</div>' + rows(tools, "tool", false) + '</div>' +
    '<div class="card"><div class="meta">by agent</div>' + rows(agents, "agent", true) + '</div>';
}
var ctxSpendFetchedAt = 0;
function refreshProcesses() {
  if (curView !== "processes") return;
  get("/api/processes").then(renderProcesses).catch(function () {});
  if (Date.now() - mcpFetchedAt > 15000) {
    mcpFetchedAt = Date.now();
    get("/api/mcps").then(renderMcps).catch(function () {});
  }
  if (Date.now() - ctxSpendFetchedAt > 15000) {
    ctxSpendFetchedAt = Date.now();
    get("/api/context-spend").then(renderCtxSpend).catch(function () {});
  }
}
// Keep the sidebar's Processes count live even while another view is open — the
// full render is throttled to when Processes is visible, but the badge is cheap.
function updateProcBadge() {
  get("/api/processes").then(function (p) {
    document.getElementById("c-proc").textContent = (p.terminals || []).length;
  }).catch(function () {});
}

function renderStats(board, audit) {
  // Count by the presence tri-state so the tile agrees with the dots.
  var active = board.agents.filter(function (a) { return a.presence === "working"; }).length;
  var viol = audit.filter(function (e) { return e.outcome === "rejected"; }).length;
  // Count "done" the same way the board's Done lane does, so tile and lane agree.
  var done = board.tasks.filter(function (t) { return stageOf(t) === "done"; }).length;
  var prs = board.tasks.filter(function (t) { return t.pr_url; }).length;
  // Release pressure: merged-but-unreleased commits across the org's projects
  // (computed server-side from each checkout's last tag; red once any project
  // crosses the release threshold).
  var rel = board.release || [];
  var unreleased = rel.reduce(function (s, r) { return s + r.unreleased; }, 0);
  var relHot = rel.some(function (r) { return r.threshold_hit; });
  var tiles = [
    { n: board.agents.length, l: "agents" },
    { n: active, l: "working" },
    { n: board.tasks.length, l: "tasks" },
    { n: done, l: "done" },
    { n: prs, l: "PRs" },
    { n: unreleased, l: "unreleased", bad: relHot },
    { n: viol, l: "violations", bad: viol > 0 },
  ];
  document.getElementById("tiles").innerHTML = tiles.map(function (t) {
    return '<div class="tile' + (t.bad ? " bad" : "") + '"><div class="n">' + t.n + '</div><div class="l">' + t.l + '</div></div>';
  }).join("");
  document.getElementById("sidestat").innerHTML =
    '<b>' + active + '</b> working · <b>' + board.agents.length + '</b> agents<br><b>' + done + '</b> done · <b>' + board.tasks.length + '</b> tasks' +
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
      items.push('<div class="card"><div class="top"><span class="name">' + presDot(a.presence) + esc(a.name) + '</span>' +
        '<button class="danger" data-act="retire" data-id="' + a.id + '">Retire</button></div>' +
        '<div class="meta">No live session and nothing assigned' + (a.worktree || a.workspace ? '' : ', and no bound folder') +
        ' — retire it, or give it work from the Work board.</div></div>');
    }
  });
  document.getElementById("attention").innerHTML = items.length
    ? '<h2 class="sub-h2">Needs attention — orphaned or idle</h2>' + items.join("")
    : "";
}

// ── org-life graph: dependency-free force layout over /api/graph ──
var gWindow = "24h", gPos = {}, gSig = "";
function fetchGraph() {
  if (curView !== "graph") return;
  get("/api/graph?window=" + gWindow).then(renderGraph).catch(function () {});
}
function ghash(s) { var h = 9; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
function renderGraph(g) {
  var svg = document.getElementById("gsvg");
  var nodes = g.nodes || [], edges = g.edges || [];
  document.getElementById("gempty").style.display = nodes.length ? "none" : "flex";
  if (!nodes.length) { svg.innerHTML = ""; gSig = ""; return; }
  var sig = gWindow + "|" + JSON.stringify(g);
  if (sig === gSig) return; // identical data — keep the current layout still
  gSig = sig;
  var W = svg.clientWidth || 900, H = 560;
  // Seed unseen nodes deterministically (hash → position) so the layout is
  // stable across refreshes; known nodes keep their place and drift smoothly.
  nodes.forEach(function (n) {
    if (!gPos[n.id]) {
      var h = ghash(n.id);
      gPos[n.id] = { x: W / 2 + ((h % 1000) / 1000 - .5) * W * .55, y: H / 2 + ((Math.floor(h / 1000) % 1000) / 1000 - .5) * H * .55 };
    }
  });
  var pts = nodes.map(function (n) { return { x: gPos[n.id].x, y: gPos[n.id].y }; });
  var idx = {}; nodes.forEach(function (n, i) { idx[n.id] = i; });
  var springs = edges.filter(function (e) { return idx[e.from] !== undefined && idx[e.to] !== undefined; });
  // Fruchterman–Reingold: pairwise repulsion, weighted attraction on edges,
  // mild pull to the center, displacement capped by a cooling temperature.
  var k = Math.sqrt((W * H) / nodes.length) * .7, temp = 70;
  for (var it = 0; it < 130; it++) {
    var dx = [], dy = [];
    for (var i0 = 0; i0 < pts.length; i0++) { dx.push(0); dy.push(0); }
    for (var i = 0; i < pts.length; i++) {
      for (var j = i + 1; j < pts.length; j++) {
        var rx = pts[i].x - pts[j].x, ry = pts[i].y - pts[j].y;
        var d = Math.sqrt(rx * rx + ry * ry) || .1, f = (k * k) / d / d;
        dx[i] += rx * f; dy[i] += ry * f; dx[j] -= rx * f; dy[j] -= ry * f;
      }
      dx[i] += (W / 2 - pts[i].x) * .02; dy[i] += (H / 2 - pts[i].y) * .02;
    }
    springs.forEach(function (e) {
      var a = idx[e.from], b = idx[e.to];
      var rx = pts[a].x - pts[b].x, ry = pts[a].y - pts[b].y;
      var d = Math.sqrt(rx * rx + ry * ry) || .1;
      var f = (d / k) * (0.6 + Math.min(1.4, e.weight));
      dx[a] -= rx / d * f; dy[a] -= ry / d * f; dx[b] += rx / d * f; dy[b] += ry / d * f;
    });
    for (var m = 0; m < pts.length; m++) {
      var len = Math.sqrt(dx[m] * dx[m] + dy[m] * dy[m]) || .1, cap = Math.min(len, temp);
      pts[m].x = Math.max(36, Math.min(W - 36, pts[m].x + dx[m] / len * cap));
      pts[m].y = Math.max(30, Math.min(H - 30, pts[m].y + dy[m] / len * cap));
    }
    temp *= .96;
  }
  nodes.forEach(function (n, i) { gPos[n.id] = { x: pts[i].x, y: pts[i].y }; });

  var out = "";
  springs.forEach(function (e) {
    var a = gPos[e.from], b = gPos[e.to];
    out += '<line class="' + esc(e.kind) + '" x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) +
      '" x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) +
      '" stroke-width="' + (1 + Math.min(4, 1.6 * Math.sqrt(e.weight))).toFixed(1) + '"></line>';
  });
  nodes.forEach(function (n) {
    var p = gPos[n.id];
    var r = n.kind === "agent" ? 8 + Math.min(16, 6 * Math.sqrt(n.weight)) : 5 + Math.min(10, 4 * Math.sqrt(n.weight));
    var cls = n.kind === "agent" ? "agent " + esc(n.presence || n.state || "") : (n.kind === "doc" ? "docn" : "arean");
    var label = n.label.length > 22 ? n.label.slice(0, 22) + "…" : n.label;
    out += '<g class="gnode' + (n.state === "retired" ? " retired" : "") + '" data-id="' + esc(n.id) + '" data-kind="' + esc(n.kind) + '">' +
      '<circle class="' + cls + '" cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="' + r.toFixed(1) + '"><title>' + esc(n.label) + '</title></circle>' +
      '<text class="glabel" x="' + p.x.toFixed(1) + '" y="' + (p.y + r + 13).toFixed(1) + '">' + esc(label) + '</text></g>';
  });
  svg.innerHTML = out;
}
// Observe-only: clicking a node just navigates to the thing it represents.
document.getElementById("gsvg").addEventListener("click", function (e) {
  var n = e.target.closest ? e.target.closest("g.gnode") : null; if (!n) return;
  var kind = n.getAttribute("data-kind"), id = n.getAttribute("data-id");
  if (kind === "agent") location.hash = "team";
  else if (kind === "doc") { openDocs[id.slice(4)] = true; renderDocs(lastDocs); location.hash = "docs"; }
  else location.hash = "work";
});
document.getElementById("gwin").addEventListener("click", function (e) {
  var b = e.target.closest ? e.target.closest("button[data-win]") : null; if (!b) return;
  gWindow = b.getAttribute("data-win");
  var bs = document.querySelectorAll("#gwin button");
  for (var i = 0; i < bs.length; i++) bs[i].classList.toggle("on", bs[i] === b);
  gSig = ""; // force a re-layout for the new window
  fetchGraph();
});

var busy = false, lastSig = "";
function refresh() {
  if (!org()) return;
  updateProcBadge();
  fetchGraph(); // no-op unless the Org life view is open
  if (busy) return; busy = true;
  Promise.all([get("/api/board"), get("/api/roles"), get("/api/docs"), get("/api/audit"), get("/api/orgs"), get("/api/memory"), get("/api/tests"), get("/api/coordinator")])
    .then(function (r) {
      var sig = JSON.stringify(r);
      if (sig === lastSig) return; // nothing changed — keep the DOM (and any open select) intact
      lastSig = sig;
      COORD = r[7] && r[7].agent_id ? r[7] : null;
      renderCoordinator();
      renderOrgOptions(r[4]);
      // An unknown org renders exactly like a real-but-empty one, so say so —
      // and point at the terminal, where orgs are actually created.
      var known = (r[4] || []).some(function (o) { return o.name === org(); });
      var ow = document.getElementById("orgwarn");
      ow.style.display = known ? "none" : "block";
      if (!known) ow.innerHTML = 'Org “' + esc(org()) + '” doesn\\'t exist — this field only picks existing orgs; the panel never creates one. To set it up, run this inside your repo folder: ' + cmdSnippet(initCmd());
      COLOR_BY_NAME = {};
      (r[0].agents || []).forEach(function (a) { if (a.color) COLOR_BY_NAME[a.name] = a.color.hex; });
      renderProjects(r[0].projects);
      renderProjectsView(r[0].projects, r[0].tasks, r[0].agents);
      renderAgents(r[0].agents);
      renderTasks(r[0].tasks, r[0].agents);
      // id → title lookups for the activity rows, before anything renders them.
      evTaskTitles = {}; (r[0].tasks || []).forEach(function (t) { evTaskTitles[t.id] = t.title; });
      evDocTitles = {}; (r[2] || []).forEach(function (d) { evDocTitles[d.id] = d.title; });
      renderRoles(r[1], r[0].agents); renderDocs(r[2]); renderAudit(r[3]); renderMemory(r[5]); renderTests(r[6]);
      renderStats(r[0], r[3]);
      renderOverview(r[0], r[3]);
      renderAttention(r[4], r[0].agents);
      updateContextCmds();
    }).catch(function () {}).then(function () { busy = false; });
}

// ── greenzone: coordinated restart. The button opens a maintenance window;
// agents confirm via greenzone_ack; the banner tracks N/M until it executes. ──
function requestRestartGreenzone() {
  authFetch("/greenzone/request", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ org: org(), action: "restart" }) })
    .then(function (r) { return r.json(); })
    .then(function (r) {
      if (r.error) { toast(r.error, true); return; }
      toast(r.state === "done" ? "No live agents — restarting now…" : "Greenzone requested — agents are reaching a safe point");
      refreshGreenzone();
    });
}
function refreshGreenzone() {
  if (!org()) return;
  get("/api/greenzone").then(function (gz) {
    var el = document.getElementById("greenzone");
    if (!gz || gz.state === "idle") { el.style.display = "none"; return; }
    var chips = (gz.required || []).map(function (a) {
      return '<span class="gz-agent' + (a.confirmed_at ? " ok" : "") + '">' + esc(a.name) + (a.confirmed_at ? " ✓" : " …") + "</span>";
    }).join("");
    var body;
    if (gz.state === "done") {
      body = "<b>Greenzone</b> " + esc(gz.action || "") + " executed" + (gz.timed_out ? " (timeout — not everyone confirmed)" : "") + chips;
      // The banner clears once the restarted server reports idle again.
    } else if (gz.state === "cancelled" || gz.state === "expired") {
      body = "<b>Greenzone</b> " + esc(gz.action || "") + " " + gz.state +
        (gz.state === "expired" ? " (its timer never fired — the pending op did not run)" : " — the pending op will not run") + chips;
    } else {
      var left = Math.max(0, Math.round((new Date(gz.deadline).getTime() - Date.now()) / 1000));
      var age = Math.max(0, Math.round((Date.now() - new Date(gz.requested_at).getTime()) / 1000));
      // A window past its deadline is stuck (timer lost): say so and lead with
      // the override; the server also self-expires it on the next touch.
      var stuck = left === 0;
      body = "<b>Greenzone</b> " + esc(gz.action || "") + (stuck ? " STUCK — requested " + age + "s ago, deadline passed" : " requested " + age + "s ago — " + (gz.confirmed || 0) + "/" + (gz.required || []).length +
        " confirmed · executes in ≤" + left + "s") + chips +
        ' <button class="danger" onclick="cancelGreenzone()" title="Abort the window: the pending op will not run (audited, agents are noticed)">Cancel</button>';
    }
    el.innerHTML = body;
    el.style.display = "block";
  }).catch(function () {});
}
function cancelGreenzone() {
  authFetch("/greenzone/cancel", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ org: org() }) })
    .then(function (r) { return r.json(); })
    .then(function (r) {
      toast(r.error ? r.error : "Greenzone cancelled — the pending op will not run", !!r.error);
      refreshGreenzone();
    });
}
setInterval(refreshGreenzone, 3000);

// A hello with a different build id means this tab's client code predates the
// running server — reload instead of rendering fresh payloads with stale logic.
var reloading = false;
function staleReload() {
  if (reloading) return;
  reloading = true;
  var b = document.createElement("div");
  b.textContent = "panel updated, reloading";
  b.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:99;text-align:center;padding:6px 10px;font:12px/1.4 system-ui,sans-serif;background:var(--accent);color:#fff;";
  document.body.appendChild(b);
  setTimeout(function () { location.reload(); }, 700);
}

var sse = null;
function connect() {
  if (sse) sse.close();
  var live = document.getElementById("live"), t = document.getElementById("live-t");
  sse = new EventSource("/events?org=" + encodeURIComponent(org()) + keyParam());
  sse.onopen = function () { live.className = "live on"; t.textContent = "live"; };
  sse.onmessage = function (e) {
    var m = null;
    try { m = JSON.parse(e.data); } catch (err) {}
    if (m && m.type === "hello") {
      if (m.build && m.build !== BUILD_ID) staleReload();
      return;
    }
    refresh();
  };
  sse.onerror = function () { live.className = "live"; t.textContent = "reconnecting"; };
  refresh();
}
document.getElementById("org").addEventListener("change", connect);
document.getElementById("tasks").addEventListener("scroll", updateBoardMore);
window.addEventListener("resize", updateBoardMore);
document.getElementById("board-more").addEventListener("click", function () {
  document.getElementById("tasks").scrollBy({ left: 320, behavior: "smooth" });
});
// No creation here by design: the panel observes and guides; orgs (like every
// entity) are created from the terminal. Unknown names get the #orgwarn hint.
setInterval(refresh, 10000);
setInterval(refreshProcesses, 3000); // live pid/uptime + terminal liveness, only while the Processes view is open
routeFromHash();
connect();
</script>
</body>
</html>`;

// Changes exactly when the panel's HTML/JS changes, so a tab can tell its client
// code no longer matches the running server (the id is hashed before stamping,
// otherwise it would depend on itself).
export const PANEL_BUILD_ID = createHash("sha256").update(TEMPLATE).digest("hex").slice(0, 12);

export function panelHtml(): string {
  return TEMPLATE.replace("__LANCHU_BUILD__", PANEL_BUILD_ID);
}
