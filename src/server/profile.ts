/**
 * Public profile page (network mode, Piece 1 Task 3): a new web surface at
 * `/@handle`, separate from the supervisor panel. Static HTML shell — the
 * handle is read from `location.pathname` client-side (never interpolated
 * server-side), and every field from the API is set via `textContent`, so a
 * Person's free-text bio can never inject markup into the page. See
 * "Design: Person identity & Membership (network mode — Piece 1)".
 */
export function profileHtml(): string {
  return TEMPLATE;
}

const TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Lanchu — profile</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230b7285'/%3E%3Cg fill='%23fff'%3E%3Crect x='16' y='19' width='24' height='6' rx='3'/%3E%3Crect x='16' y='29' width='32' height='6' rx='3'/%3E%3Crect x='16' y='39' width='18' height='6' rx='3'/%3E%3C/g%3E%3C/svg%3E" />
<style>
  :root {
    color-scheme: light dark;
    --bg: #f7f9fb; --surface: #ffffff;
    --fg: #0f172a; --muted: #64748b; --faint: #94a3b8;
    --line: #e6eaf0; --accent: #0b7285; --accent-weak: rgba(11,114,133,.10);
    --radius: 14px; --shadow: 0 1px 2px rgba(16,24,40,.05), 0 1px 3px rgba(16,24,40,.05);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0a0e13; --surface: #111822;
      --fg: #e6edf3; --muted: #8b98a6; --faint: #5b6773;
      --line: #1e2732; --accent: #4dd0c1; --accent-weak: rgba(77,208,193,.12);
      --shadow: none;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: var(--bg); color: var(--fg); padding: 24px;
         font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         -webkit-font-smoothing: antialiased; }
  .card { width: 100%; max-width: 480px; background: var(--surface); border: 1px solid var(--line);
          border-radius: var(--radius); box-shadow: var(--shadow); padding: 32px; }
  .brand { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12px;
           font-weight: 600; text-decoration: none; margin-bottom: 22px; }
  .brand svg { width: 18px; height: 18px; border-radius: 4px; flex: none; }
  h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: -.01em; }
  .since { color: var(--faint); font-size: 12.5px; margin: 0 0 18px; }
  .bio { white-space: pre-wrap; margin: 0 0 18px; }
  .bio:empty { display: none; }
  .gh { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600;
        color: var(--accent); background: var(--accent-weak); border-radius: 999px; padding: 5px 12px;
        text-decoration: none; }
  .state { color: var(--muted); }
  .ledger { border-top: 1px solid var(--line); margin-top: 18px; padding-top: 14px; }
  .ledger h2 { font-size: 12.5px; font-weight: 600; color: var(--muted); margin: 0 0 8px;
               text-transform: uppercase; letter-spacing: .04em; }
  .ledger .total { margin: 0 0 10px; }
  .ledger .total strong { font-size: 18px; }
  .ledger ul { list-style: none; margin: 0; padding: 0; }
  .ledger li { display: flex; justify-content: space-between; gap: 12px; padding: 4px 0;
               font-size: 12.5px; color: var(--muted); }
  .ledger li .pid { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden;
                    text-overflow: ellipsis; white-space: nowrap; }
  .ledger li .w { flex: none; color: var(--fg); font-weight: 600; }
</style>
</head>
<body>
  <div class="card">
    <a class="brand" href="/">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0b7285"/><g fill="#fff"><rect x="16" y="19" width="24" height="6" rx="3"/><rect x="16" y="29" width="32" height="6" rx="3"/><rect x="16" y="39" width="18" height="6" rx="3"/></g></svg>
      lanchu
    </a>
    <div id="body"><p class="state">Loading…</p></div>
  </div>
  <script>
    (function () {
      var handle = decodeURIComponent(location.pathname.slice(2));
      var body = document.getElementById("body");
      function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
      }
      fetch("/api/profile/" + encodeURIComponent(handle))
        .then(function (r) { return r.status === 200 ? r.json() : Promise.reject(r.status); })
        .then(function (p) {
          document.title = "@" + p.handle + " — Lanchu";
          body.textContent = "";
          body.appendChild(el("h1", null, "@" + p.handle));
          body.appendChild(el("p", "since", "Member since " + new Date(p.created_at).toLocaleDateString(undefined, { year: "numeric", month: "long" })));
          body.appendChild(el("p", "bio", p.bio || ""));
          if (p.github_login) {
            var a = document.createElement("a");
            a.className = "gh";
            a.href = "https://github.com/" + encodeURIComponent(p.github_login);
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            a.title = "Self-declared by this Person — not verified via GitHub OAuth.";
            a.textContent = "GitHub: " + p.github_login;
            body.appendChild(a);
          }
          // Piece 4 Task 4: the transparent contribution ledger — real
          // totals from contribution_event, per-project ids only (same
          // anonymization boundary as the network directory).
          var c = p.contributions;
          if (c) {
            var ledger = el("div", "ledger");
            ledger.appendChild(el("h2", null, "Contributions"));
            var total = el("p", "total");
            var strong = document.createElement("strong");
            strong.textContent = String(c.totalWeight);
            total.appendChild(strong);
            total.appendChild(document.createTextNode(
              " total weight across " + c.count + " verified contribution" + (c.count === 1 ? "" : "s")));
            ledger.appendChild(total);
            if (c.projects && c.projects.length) {
              var list = document.createElement("ul");
              c.projects.forEach(function (proj) {
                var li = document.createElement("li");
                var pid = el("span", "pid", "project " + proj.projectId);
                pid.title = proj.projectId;
                li.appendChild(pid);
                li.appendChild(el("span", "w", String(proj.totalWeight)));
                list.appendChild(li);
              });
              ledger.appendChild(list);
            }
            body.appendChild(ledger);
          }
        })
        .catch(function () {
          body.textContent = "";
          body.appendChild(el("p", "state", "No Lanchu profile found for @" + handle + "."));
        });
    })();
  </script>
</body>
</html>
`;
