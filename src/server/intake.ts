/**
 * Idea intake form (network mode, Piece 2 Task 1): a new web surface at
 * `/idea`, separate from the supervisor panel. Static HTML shell — the form
 * posts JSON to `/api/network/idea` client-side and every server response
 * field lands in the page via `textContent`, so nothing user-controlled is
 * ever interpolated into markup. See "Design: Idea intake & the moderator
 * (network mode — Piece 2)".
 */
export function intakeHtml(): string {
  return TEMPLATE;
}

const TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Lanchu — submit an idea</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230b7285'/%3E%3Cg fill='%23fff'%3E%3Crect x='16' y='19' width='24' height='6' rx='3'/%3E%3Crect x='16' y='29' width='32' height='6' rx='3'/%3E%3Crect x='16' y='39' width='18' height='6' rx='3'/%3E%3C/g%3E%3C/svg%3E" />
<style>
  :root {
    color-scheme: light dark;
    --bg: #f7f9fb; --surface: #ffffff;
    --fg: #0f172a; --muted: #64748b; --faint: #94a3b8;
    --line: #e6eaf0; --accent: #0b7285; --accent-weak: rgba(11,114,133,.10);
    --danger: #b42318;
    --radius: 14px; --shadow: 0 1px 2px rgba(16,24,40,.05), 0 1px 3px rgba(16,24,40,.05);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0a0e13; --surface: #111822;
      --fg: #e6edf3; --muted: #8b98a6; --faint: #5b6773;
      --line: #1e2732; --accent: #4dd0c1; --accent-weak: rgba(77,208,193,.12);
      --danger: #f97066;
      --shadow: none;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: var(--bg); color: var(--fg); padding: 24px;
         font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         -webkit-font-smoothing: antialiased; }
  .card { width: 100%; max-width: 560px; background: var(--surface); border: 1px solid var(--line);
          border-radius: var(--radius); box-shadow: var(--shadow); padding: 32px; }
  .brand { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12px;
           font-weight: 600; text-decoration: none; margin-bottom: 22px; }
  .brand svg { width: 18px; height: 18px; border-radius: 4px; flex: none; }
  h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: -.01em; }
  .sub { color: var(--muted); margin: 0 0 22px; }
  label { display: block; font-size: 12.5px; font-weight: 600; color: var(--muted); margin: 0 0 6px; }
  input, textarea { width: 100%; background: var(--bg); color: var(--fg); border: 1px solid var(--line);
                    border-radius: 8px; padding: 9px 12px; font: inherit; margin-bottom: 16px; }
  input:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: transparent; }
  textarea { min-height: 140px; resize: vertical; }
  button { background: var(--accent); color: #fff; border: 0; border-radius: 8px; padding: 10px 18px;
           font: inherit; font-weight: 600; cursor: pointer; }
  button[disabled] { opacity: .6; cursor: default; }
  .error { color: var(--danger); margin: 14px 0 0; }
  .error:empty { display: none; }
  .done h2 { font-size: 18px; margin: 0 0 8px; }
  .done p { margin: 0 0 10px; }
  .slug { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;
          background: var(--accent-weak); color: var(--accent); border-radius: 6px; padding: 2px 7px; }
  .hint { color: var(--faint); font-size: 12.5px; }
</style>
</head>
<body>
  <div class="card">
    <a class="brand" href="/">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0b7285"/><g fill="#fff"><rect x="16" y="19" width="24" height="6" rx="3"/><rect x="16" y="29" width="32" height="6" rx="3"/><rect x="16" y="39" width="18" height="6" rx="3"/></g></svg>
      lanchu
    </a>
    <div id="body">
      <h1>Submit an idea</h1>
      <p class="sub">Describe what you want built. Lanchu creates a project for it on the network.</p>
      <form id="form">
        <label for="title">Title</label>
        <input id="title" name="title" maxlength="200" required autocomplete="off" />
        <label for="description">What should be built?</label>
        <textarea id="description" name="description" maxlength="10000" required></textarea>
        <label for="repo">Repository URL <span class="hint">(optional)</span></label>
        <input id="repo" name="repo" type="url" autocomplete="off" placeholder="https://github.com/you/repo" />
        <div id="clarify" hidden>
          <label for="clarification" id="clarify-q"></label>
          <textarea id="clarification"></textarea>
        </div>
        <button type="submit" id="submit">Submit idea</button>
        <p class="error" id="error"></p>
      </form>
    </div>
  </div>
  <script>
    (function () {
      var form = document.getElementById("form");
      var error = document.getElementById("error");
      var submit = document.getElementById("submit");
      form.addEventListener("submit", function (ev) {
        ev.preventDefault();
        error.textContent = "";
        submit.disabled = true;
        var clarify = document.getElementById("clarify");
        var clarification = document.getElementById("clarification").value.trim();
        fetch("/api/network/idea", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: document.getElementById("title").value,
            description: document.getElementById("description").value,
            repo_url: document.getElementById("repo").value || undefined,
            clarification: clarification || undefined,
          }),
        })
          .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
          .then(function (res) {
            if (!res.ok) throw new Error(res.data && res.data.error ? res.data.error : "submission failed");
            if (res.data.clarification_needed) {
              // One follow-up question, asked in place; the resubmission
              // (clarification filled in) always proceeds.
              document.getElementById("clarify-q").textContent = res.data.question;
              clarify.hidden = false;
              submit.disabled = false;
              submit.textContent = "Submit with clarification";
              document.getElementById("clarification").focus();
              return;
            }
            var body = document.getElementById("body");
            body.textContent = "";
            var done = document.createElement("div");
            done.className = "done";
            var h2 = document.createElement("h2");
            h2.textContent = "Idea submitted";
            var p1 = document.createElement("p");
            p1.textContent = "Your project was created as ";
            var slug = document.createElement("span");
            slug.className = "slug";
            slug.textContent = res.data.org;
            p1.appendChild(slug);
            var p2 = document.createElement("p");
            p2.className = "hint";
            p2.textContent = "Project id: " + res.data.project_id;
            done.appendChild(h2);
            done.appendChild(p1);
            done.appendChild(p2);
            body.appendChild(done);
          })
          .catch(function (err) {
            submit.disabled = false;
            error.textContent = err && err.message ? err.message : "submission failed";
          });
      });
    })();
  </script>
</body>
</html>
`;
