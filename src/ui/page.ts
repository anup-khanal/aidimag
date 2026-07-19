/**
 * Dashboard HTML — embedded as a template string so `tsc` is the whole build
 * (no asset pipeline). D3 v7 from CDN renders the memory graph.
 */

export const PAGE_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>aiDimag — repo brain</title>
<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
<meta name="color-scheme" content="light dark">
<style>
  :root {
    --background: 210 40% 98%;
    --foreground: 222 47% 11%;
    --card: 0 0% 100%;
    --muted: 214 32% 94%;
    --muted-foreground: 215 16% 47%;
    --primary: 217 91% 53%;
    --primary-foreground: 0 0% 100%;
    --secondary: 214 32% 94%;
    --border: 214 32% 91%;
    --ring: 199 89% 48%;
    --radius: 0.75rem;
    --surface-glow: 0 0 0 1px rgba(37, 99, 235, 0.08), 0 8px 32px rgba(37, 99, 235, 0.08);
    --verified: #22c55e;
    --unverified: #64748b;
    --stale: #eab308;
    --refuted: #ef4444;
    --path: #2563eb;
  }
  .dark {
    --background: 222 47% 6%;
    --foreground: 210 40% 98%;
    --card: 222 47% 8%;
    --muted: 217 33% 14%;
    --muted-foreground: 215 20% 65%;
    --primary: 213 94% 68%;
    --primary-foreground: 222 47% 6%;
    --secondary: 217 33% 14%;
    --border: 217 33% 16%;
    --surface-glow: 0 0 0 1px rgba(96, 165, 250, 0.12), 0 8px 32px rgba(0, 0, 0, 0.35);
    --path: #60a5fa;
    --unverified: #94a3b8;
  }
  * { box-sizing: border-box; margin: 0; }
  html { color-scheme: light dark; }
  body {
    background-color: hsl(var(--background));
    background-image:
      radial-gradient(at 0% 0%, rgba(37, 99, 235, 0.12) 0, transparent 50%),
      radial-gradient(at 100% 0%, rgba(14, 165, 233, 0.1) 0, transparent 50%),
      radial-gradient(at 50% 100%, rgba(6, 182, 212, 0.08) 0, transparent 50%);
    color: hsl(var(--foreground));
    font: 14px/1.5 "Inter", ui-sans-serif, system-ui, sans-serif;
    font-feature-settings: "cv02", "cv03", "cv04", "cv11";
    height: 100vh;
    display: flex;
    flex-direction: column;
    -webkit-font-smoothing: antialiased;
  }
  html.dark body {
    background-image:
      radial-gradient(at 0% 0%, rgba(37, 99, 235, 0.18) 0, transparent 50%),
      radial-gradient(at 100% 0%, rgba(14, 165, 233, 0.12) 0, transparent 50%),
      radial-gradient(at 50% 100%, rgba(6, 182, 212, 0.1) 0, transparent 50%);
  }
  header {
    display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap;
    padding: 10px 16px;
    border-bottom: 1px solid hsl(var(--border) / 0.6);
    background: hsl(var(--card) / 0.82);
    backdrop-filter: blur(16px);
  }
  .brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .logo { width: 32px; height: 32px; flex-shrink: 0; border-radius: 10px; }
  .brand-text { min-width: 0; }
  header h1 { font-size: 15px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.2; }
  header .subtitle {
    display: block; font-size: 11px; font-weight: 500; color: hsl(var(--muted-foreground));
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 280px;
  }
  .pill {
    padding: 3px 10px; border-radius: 999px; font-size: 12px;
    border: 1px solid hsl(var(--border)); white-space: nowrap;
    background: hsl(var(--muted) / 0.6); color: hsl(var(--muted-foreground));
  }
  .pill b { font-weight: 600; color: hsl(var(--foreground)); }
  .spacer { flex: 1; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  button {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px; white-space: nowrap;
    background: hsl(var(--secondary)); color: hsl(var(--foreground));
    border: 1px solid hsl(var(--border)); border-radius: calc(var(--radius) - 2px);
    padding: 6px 12px; font-size: 12px; font-weight: 500; cursor: pointer;
    transition: background 0.15s, border-color 0.15s, opacity 0.15s;
  }
  button svg { width: 14px; height: 14px; flex: 0 0 auto; }
  button:hover:not(.primary) { background: hsl(var(--muted)); border-color: hsl(var(--primary) / 0.35); }
  button:focus-visible { outline: 2px solid hsl(var(--ring)); outline-offset: 2px; }
  button.primary {
    background: hsl(var(--primary)); border-color: transparent;
    color: hsl(var(--primary-foreground));
  }
  button.primary:hover { opacity: 0.9; background: hsl(var(--primary)); border-color: transparent; }
  button.icon { padding: 8px; width: 36px; height: 36px; }
  button.danger:hover { background: color-mix(in srgb, var(--refuted) 12%, transparent); border-color: var(--refuted); }
  main { flex: 1; display: flex; min-height: 0; }
  #graph { flex: 1; min-width: 0; background: hsl(var(--background) / 0.35); }
  aside {
    width: 460px; border-left: 1px solid hsl(var(--border) / 0.6);
    overflow-y: auto; padding: 16px;
    background: hsl(var(--card) / 0.55); backdrop-filter: blur(12px);
  }
  h2 { font-size: 14px; font-weight: 600; color: hsl(var(--foreground)); margin: 16px 0 10px; letter-spacing: -0.01em; }
  .card {
    background: hsl(var(--card) / 0.9);
    border: 1px solid hsl(var(--border) / 0.6);
    border-radius: var(--radius); padding: 12px 14px; margin-bottom: 10px;
    box-shadow: var(--surface-glow);
    transition: border-color 0.15s, transform 0.15s;
  }
  .card:hover { border-color: hsl(var(--primary) / 0.3); }
  .card .claim { font-size: 13px; margin-bottom: 6px; line-height: 1.5; }
  .card .meta { font-size: 11px; color: hsl(var(--muted-foreground)); display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .badge { padding: 2px 8px; border-radius: 999px; font-size: 10px; font-weight: 600; border: 1px solid transparent; }
  .badge.VERIFIED { background: color-mix(in srgb, var(--verified) 15%, transparent); color: var(--verified); }
  .badge.UNVERIFIED { background: color-mix(in srgb, var(--unverified) 15%, transparent); color: var(--unverified); }
  .badge.STALE { background: color-mix(in srgb, var(--stale) 15%, transparent); color: var(--stale); }
  .badge.REFUTED { background: color-mix(in srgb, var(--refuted) 15%, transparent); color: var(--refuted); }
  .kind { color: hsl(var(--primary)); font-weight: 500; }
  .actions { margin-top: 10px; display: flex; gap: 6px; flex-wrap: wrap; }
  .evidence { font-size: 11px; color: hsl(var(--muted-foreground)); font-family: ui-monospace, monospace; margin-top: 4px; word-break: break-all; }
  .legend {
    display: flex; gap: 14px; flex-wrap: wrap; padding: 8px 16px; font-size: 11px;
    color: hsl(var(--muted-foreground)); border-top: 1px solid hsl(var(--border) / 0.6);
    background: hsl(var(--card) / 0.65); backdrop-filter: blur(12px);
  }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 5px; vertical-align: -1px; }
  #toast {
    position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
    background: hsl(var(--card)); color: hsl(var(--foreground));
    border: 1px solid hsl(var(--border) / 0.6);
    padding: 10px 18px;
    border-radius: var(--radius); display: none; font-size: 13px; font-weight: 500; z-index: 50;
    box-shadow: var(--surface-glow);
  }
  .empty { color: hsl(var(--muted-foreground)); font-size: 12px; padding: 8px 0; }
  svg text { fill: hsl(var(--muted-foreground)); font-size: 10px; pointer-events: none; }
  dialog {
    background: hsl(var(--card)); color: hsl(var(--foreground));
    border: 1px solid hsl(var(--border) / 0.6);
    border-radius: calc(var(--radius) + 2px); padding: 20px; width: 480px; max-width: 92vw;
    box-shadow: var(--surface-glow);
  }
  dialog::backdrop { background: rgba(0,0,0,.55); backdrop-filter: blur(4px); }
  dialog h3 { font-size: 15px; font-weight: 700; margin-bottom: 12px; letter-spacing: -0.02em; }
  dialog label {
    display: block; font-size: 12px; color: hsl(var(--muted-foreground));
    margin: 12px 0 4px; font-weight: 500;
  }
  dialog input, dialog select, dialog textarea {
    width: 100%; background: hsl(var(--background)); color: hsl(var(--foreground));
    border: 1px solid hsl(var(--border)); border-radius: calc(var(--radius) - 2px);
    padding: 8px 10px; font-size: 13px; font-family: inherit;
  }
  dialog input:focus, dialog select:focus, dialog textarea:focus {
    outline: 2px solid hsl(var(--ring)); outline-offset: 1px; border-color: transparent;
  }
  dialog textarea { min-height: 64px; resize: vertical; }
  .dialog-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
  .ev-row { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
  .ev-row select { width: 160px; }
  .searchbar { display: flex; gap: 6px; margin-bottom: 10px; }
  .searchbar input {
    flex: 1; background: hsl(var(--background)); color: hsl(var(--foreground));
    border: 1px solid hsl(var(--border)); border-radius: calc(var(--radius) - 2px);
    padding: 8px 10px; font-size: 13px;
  }
  .searchbar input:focus { outline: 2px solid hsl(var(--ring)); outline-offset: 1px; border-color: transparent; }
  .searchbar select {
    background: hsl(var(--background)); color: hsl(var(--foreground));
    border: 1px solid hsl(var(--border)); border-radius: calc(var(--radius) - 2px);
    font-size: 12px; padding: 6px 8px;
  }
  .keyrow {
    font-size: 11px; font-family: ui-monospace, monospace;
    display: flex; justify-content: space-between; align-items: center;
    padding: 4px 0; border-bottom: 1px solid hsl(var(--border));
  }
  .hint { font-size: 11px; color: hsl(var(--muted-foreground)); margin-top: 6px; line-height: 1.5; }
  .theme-icon-sun { display: none; }
  html:not(.dark) .theme-icon-sun { display: block; }
  html:not(.dark) .theme-icon-moon { display: none; }
  html.dark .theme-icon-sun { display: none; }
  html.dark .theme-icon-moon { display: block; }
</style>
<script>
(function () {
  var k = "aidimag-ui-theme";
  var saved = localStorage.getItem(k);
  // Default dark; only use light when explicitly chosen.
  if (saved !== "light") document.documentElement.classList.add("dark");
})();
</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
</head>
<body>
<header>
  <div class="brand">
    <svg class="logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="dimGrad" x1="8" y1="8" x2="56" y2="56" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="#2563eb"/><stop offset="55%" stop-color="#0ea5e9"/><stop offset="100%" stop-color="#06b6d4"/>
        </linearGradient>
        <linearGradient id="dimGradSoft" x1="8" y1="8" x2="56" y2="56" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="#2563eb" stop-opacity="0.18"/><stop offset="100%" stop-color="#06b6d4" stop-opacity="0.18"/>
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="16" fill="url(#dimGradSoft)"/>
      <g transform="translate(8 8) scale(2)" stroke="url(#dimGrad)" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 18V5"/><path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4"/>
        <path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5"/>
        <path d="M17.997 5.125a4 4 0 0 1 2.526 5.77"/><path d="M18 18a4 4 0 0 0 2-7.464"/>
        <path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517"/>
        <path d="M6 18a4 4 0 0 1-2-7.464"/><path d="M6.003 5.125a4 4 0 0 0-2.526 5.77"/>
      </g>
      <circle cx="49" cy="49" r="11" fill="#10b981"/>
      <path d="M44 49.2l3.4 3.4L54.5 45" stroke="#ffffff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    </svg>
    <div class="brand-text">
      <h1>aiDimag</h1>
      <span class="subtitle" id="repo">Repo brain</span>
    </div>
  </div>
  <span class="pill" id="counts"></span>
  <div class="spacer"></div>
  <div class="toolbar">
  <button class="primary" onclick="document.getElementById('dlg-new').showModal()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>New memory</button>
  <button onclick="runMine()" title="Mine new commits since the last run (Shift+click: rescan all history)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 5.5 18 9"/><path d="M2 22l8-8"/><path d="M20.5 7.5 22 6a2.83 2.83 0 0 0-4-4l-1.5 1.5"/><path d="m9 11 4 4"/><path d="M16 2 8.5 9.5"/></svg>Mine commits</button>
  <button class="primary" onclick="runVerify(false)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/></svg>Verify</button>
  <button onclick="runVerify(true)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="m8 11 2 2 4-4"/></svg>Verify --deep</button>
  <button onclick="runSync()" id="btn-sync"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>Sync</button>
  <button onclick="runReindex()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>Reindex</button>
  <button onclick="openCloud()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>Cloud</button>
  <button onclick="openTickets()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/></svg>Tickets</button>
  <button onclick="load()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>Refresh</button>
  <button class="icon" type="button" onclick="toggleTheme()" id="btn-theme" aria-label="Toggle light/dark theme">
    <svg class="theme-icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>
    <svg class="theme-icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
  </button>
  </div>
</header>
<main>
  <div id="graph"></div>
  <aside>
    <h2 id="proposals-h">Pending proposals</h2>
    <div id="proposals"></div>
    <h2>Memories</h2>
    <div class="searchbar">
      <input id="q" placeholder="Search memories… (semantic when embeddings configured)" oninput="debouncedSearch()">
      <select id="q-kind" onchange="doSearch()">
        <option value="">all kinds</option>
        <option>DECISION</option><option>CONVENTION</option><option>GOTCHA</option>
        <option>FAILED_APPROACH</option><option>ARCHITECTURE</option><option>INVARIANT</option>
        <option>TODO_CONTEXT</option><option>GUARDRAIL</option><option>SKILL</option>
      </select>
    </div>
    <div id="memories"></div>
  </aside>
</main>

<!-- New memory dialog (dim remember) -->
<dialog id="dlg-new">
  <h3>＋ New memory</h3>
  <label>Claim (write it falsifiable — something a check could verify)</label>
  <textarea id="nm-claim" placeholder="All DB access goes through src/db/store.ts; nothing else imports better-sqlite3"></textarea>
  <label>Kind</label>
  <select id="nm-kind" onchange="toggleGuardrailLevel()">
    <option>DECISION</option><option>CONVENTION</option><option>GOTCHA</option>
    <option>FAILED_APPROACH</option><option>ARCHITECTURE</option><option>INVARIANT</option>
    <option>TODO_CONTEXT</option><option>GUARDRAIL</option><option>SKILL</option>
  </select>
  <div id="guardrail-section" style="display:none;">
    <label>Guardrail Level</label>
    <select id="nm-guardrail-level">
      <option value="ask-first">🤚 Ask First - Confirm before doing it</option>
      <option value="always">✅ Always - Block completely, refuse to proceed</option>
      <option value="never">🚫 Never - Just a suggestion</option>
    </select>
  </div>
  <label>Scope paths (comma-separated, empty = repo-wide)</label>
  <input id="nm-paths" placeholder="src/db, src/api/auth.ts">
  <label>Symbols (comma-separated, optional)</label>
  <input id="nm-symbols" placeholder="UserService, authenticate()">
  <label>
    <input type="checkbox" id="nm-pinned">
    📌 Pin this memory (exempt from time decay)
  </label>
  <label>Evidence (optional but recommended)</label>
  <div id="nm-evidence"></div>
  <button style="margin-top:6px" onclick="addEvidenceRow()">＋ add evidence</button>
  <div class="hint">STATIC_CHECK: shell command, exit 0 = claim holds · COMMIT_REF: sha · EXEC_TRACE: cmd :: regex · TEST_RESULT: test cmd</div>
  <div class="dialog-actions">
    <button onclick="document.getElementById('dlg-new').close()">Cancel</button>
    <button class="primary" onclick="saveMemory()">Save memory</button>
  </div>
</dialog>

<!-- Cloud settings dialog (dim cloud link / dim keys) -->
<dialog id="dlg-cloud">
  <h3>☁ Team sync</h3>
  <div id="cloud-status" class="hint"></div>
  <label>Server URL</label>
  <input id="cl-server" placeholder="http://localhost:3000">
  <label>Brain (team memory name)</label>
  <input id="cl-brain" placeholder="myrepo">
  <label>Access token (stored on this machine only, never in the repo)</label>
  <input id="cl-token" type="password" placeholder="aidimag_sk_…">
  <div class="dialog-actions">
    <button onclick="cloudUnlink()">Unlink</button>
    <button class="primary" onclick="cloudLink()">Link</button>
  </div>
  <h3 style="margin-top:18px">🔑 API keys (admin)</h3>
  <label>Admin token (used for this request only — not stored)</label>
  <input id="k-admin" type="password" placeholder="server admin token">
  <div class="ev-row">
    <input id="k-brain" placeholder="brain">
    <input id="k-label" placeholder="label (alice-laptop)">
    <button class="primary" onclick="keyCreate()">Create</button>
    <button onclick="keyList()">List</button>
  </div>
  <div id="keys-out"></div>
  <div class="dialog-actions">
    <button onclick="document.getElementById('dlg-cloud').close()">Close</button>
  </div>
</dialog>

<!-- Tickets dialog (dim ticket connect / share) -->
<dialog id="dlg-tickets">
  <h3>🎫 Tickets</h3>
  <div id="tk-status" class="hint"></div>
  <label>Provider</label>
  <select id="tk-provider" onchange="ticketsProviderHint()">
    <option value="jira">Jira</option>
    <option value="github">GitHub Issues</option>
    <option value="linear">Linear</option>
    <option value="http">HTTP middleware (your own)</option>
    <option value="remote">Remote (team sync server — zero local credentials)</option>
  </select>
  <div id="tk-url-row">
    <label id="tk-url-label">Base URL</label>
    <input id="tk-url" placeholder="https://acme.atlassian.net">
  </div>
  <div id="tk-token-row">
    <label id="tk-token-label">Credential (stored on this machine only, never in the repo)</label>
    <input id="tk-token" type="password" placeholder="email:apiToken">
  </div>
  <label>Ticket-id pattern (extracted from branch names &amp; commit messages)</label>
  <input id="tk-pattern" placeholder="[A-Z][A-Z0-9]+-\\\\d+">
  <label>Validate with a real ticket id (optional)</label>
  <input id="tk-test" placeholder="XXX-2100">
  <div class="dialog-actions">
    <button onclick="ticketsDisconnect()">Disconnect</button>
    <button class="primary" onclick="ticketsConnect()">Connect</button>
  </div>
  <h3 style="margin-top:18px">👥 Team credentials (admin)</h3>
  <div class="hint">Stores the provider + token on the linked sync server — teammates connect with provider “remote” and never hold a ticket credential.</div>
  <label>Admin token (used for this request only — not stored)</label>
  <input id="tk-admin" type="password" placeholder="server admin token">
  <div class="ev-row">
    <button class="primary" onclick="ticketsShare()">Share current config</button>
    <button class="danger" onclick="ticketsShare(true)">Remove from server</button>
  </div>
  <div class="dialog-actions">
    <button onclick="document.getElementById('dlg-tickets').close()">Close</button>
  </div>
</dialog>

<div class="legend">
  <span><span class="dot" style="background:var(--verified)"></span>VERIFIED</span>
  <span><span class="dot" style="background:var(--unverified)"></span>UNVERIFIED</span>
  <span><span class="dot" style="background:var(--stale)"></span>STALE</span>
  <span><span class="dot" style="background:var(--refuted)"></span>REFUTED</span>
  <span><span class="dot" style="background:var(--path); border-radius:2px"></span>scope path</span>
  <span style="margin-left:auto">node size = confidence · drag to rearrange · scroll to zoom</span>
</div>
<div id="toast"></div>

<script>
const COLORS = { VERIFIED: "#22c55e", UNVERIFIED: "#94a3b8", STALE: "#eab308", REFUTED: "#ef4444" };
let state = null;
let csrfToken = null;

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function graphPalette() {
  return {
    VERIFIED: cssVar("--verified", COLORS.VERIFIED),
    UNVERIFIED: cssVar("--unverified", COLORS.UNVERIFIED),
    STALE: cssVar("--stale", COLORS.STALE),
    REFUTED: cssVar("--refuted", COLORS.REFUTED),
    path: cssVar("--path", "#60a5fa"),
    link: "hsl(" + cssVar("--border", "217 33% 16%") + ")",
    primary: "hsl(" + cssVar("--primary", "217 91% 53%") + ")",
  };
}

function toggleTheme() {
  const root = document.documentElement;
  const dark = !root.classList.contains("dark");
  root.classList.toggle("dark", dark);
  localStorage.setItem("aidimag-ui-theme", dark ? "dark" : "light");
  if (state) renderGraph();
}

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.style.display = "block";
  setTimeout(() => t.style.display = "none", 2500);
}

async function api(path, opts) {
  opts = opts || {};
  const method = (opts.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    if (!csrfToken) throw new Error("missing CSRF token — reload the page");
    opts.headers = { ...(opts.headers || {}), "X-Aidimag-Csrf-Token": csrfToken };
  }
  const r = await fetch(path, opts);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || r.status);
  return body;
}

async function load() {
  state = await api("/api/state");
  csrfToken = state.csrfToken;
  document.getElementById("repo").textContent = state.repoRoot;
  const s = state.summary.byStatus;
  document.getElementById("counts").innerHTML =
    \`<b>\${state.summary.total}</b> memories · ✓\${s.VERIFIED} ?\${s.UNVERIFIED} ~\${s.STALE} ✗\${s.REFUTED}\`;
  renderProposals(); renderMemories(); renderGraph();
}

function esc(s) { return s.replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }

function renderProposals() {
  const el = document.getElementById("proposals");
  document.getElementById("proposals-h").textContent = \`Pending proposals (\${state.proposals.length})\`;
  if (!state.proposals.length) { el.innerHTML = '<div class="empty">Queue is empty.</div>'; return; }
  el.innerHTML = state.proposals.map(p => \`
    <div class="card">
      <div class="claim">\${esc(p.claim)}</div>
      <div class="meta"><span class="kind">\${p.kind}</span><span>via \${esc(p.source)}</span>\${p.ticketRef ? \`<span>🎫 \${esc(p.ticketRef)}</span>\` : ""}</div>
      <div class="actions">
        <button class="primary" onclick="act('/api/proposals/\${p.id}/approve','approved')">Approve</button>
        <button class="danger" onclick="act('/api/proposals/\${p.id}/reject','rejected')">Reject</button>
      </div>
    </div>\`).join("");
}

function renderMemories(list) {
  const el = document.getElementById("memories");
  const items = list ?? state.memories;
  if (!items.length) { el.innerHTML = '<div class="empty">No matching memories.</div>'; return; }
  el.innerHTML = items.map(m => \`
    <div class="card" id="mem-\${m.id}">
      <div class="claim">\${esc(m.claim)}</div>
      <div class="meta">
        <span class="badge \${m.status}">\${m.status}</span>
        \${m.pinned ? '<span class="badge" title="Pinned: never decays with age (evidence failure can still mark it stale)">📌 PINNED</span>' : ""}
        <span class="kind">\${m.kind}</span>
        <span>conf \${m.confidence.toFixed(2)}</span>
        \${m.scope.paths.length ? "<span>📁 " + esc(m.scope.paths.join(", ")) + "</span>" : "<span>repo-wide</span>"}
      </div>
      \${m.grounding.map(e => \`<div class="evidence">\${e.type}(\${e.result}) \${esc(e.payload)}</div>\`).join("")}
      <div class="actions">
        \${m.pinned
          ? \`<button onclick="act('/api/memories/\${m.id}/unpin','unpinned')">Unpin</button>\`
          : \`<button onclick="act('/api/memories/\${m.id}/pin','pinned 📌')">Pin</button>\`}
        \${m.status !== "REFUTED" ? \`<button class="danger" onclick="act('/api/memories/\${m.id}/refute','refuted')">Refute</button>\` : ""}
        <button class="danger" onclick="if(confirm('Delete permanently?'))act('/api/memories/\${m.id}/forget','forgotten')">Forget</button>
      </div>
    </div>\`).join("");
}

async function act(path, verb) {
  try { await api(path, { method: "POST" }); toast("Memory " + verb); load(); }
  catch (e) { toast("Error: " + e.message); }
}

async function runVerify(deep) {
  toast(deep ? "Running deep verification…" : "Verifying…");
  try {
    const r = await api("/api/verify" + (deep ? "?deep=1" : ""), { method: "POST" });
    toast(\`Checked \${r.checked}: \${r.verified} verified, \${r.stale} stale, \${r.decayed} decayed\`);
    load();
  } catch (e) { toast("Error: " + e.message); }
}

// ---------------------------------------------------------------- new memory

function addEvidenceRow() {
  const row = document.createElement("div");
  row.className = "ev-row";
  row.innerHTML = \`
    <select>
      <option>STATIC_CHECK</option><option>COMMIT_REF</option>
      <option>TEST_RESULT</option><option>EXEC_TRACE</option><option>HUMAN_ATTESTED</option>
    </select>
    <input placeholder="payload">
    <button onclick="this.parentElement.remove()">✕</button>\`;
  document.getElementById("nm-evidence").appendChild(row);
}

function toggleGuardrailLevel() {
  const kind = document.getElementById("nm-kind").value;
  const section = document.getElementById("guardrail-section");
  section.style.display = kind === "GUARDRAIL" ? "block" : "none";
}

async function saveMemory() {
  const claim = document.getElementById("nm-claim").value.trim();
  if (claim.length < 10) { toast("Claim is too short"); return; }
  const kind = document.getElementById("nm-kind").value;
  const evidence = [...document.querySelectorAll("#nm-evidence .ev-row")]
    .map(r => ({ type: r.querySelector("select").value, payload: r.querySelector("input").value.trim() }))
    .filter(e => e.payload);
  const paths = document.getElementById("nm-paths").value.split(",").map(s => s.trim()).filter(Boolean);
  const symbols = document.getElementById("nm-symbols").value.split(",").map(s => s.trim()).filter(Boolean);
  const pinned = document.getElementById("nm-pinned").checked;
  const guardrailLevel = kind === "GUARDRAIL" ? document.getElementById("nm-guardrail-level").value : undefined;
  
  try {
    await api("/api/memories", {
      method: "POST",
      body: JSON.stringify({ kind, claim, paths, symbols, evidence, pinned, guardrailLevel }),
    });
    document.getElementById("dlg-new").close();
    document.getElementById("nm-claim").value = "";
    document.getElementById("nm-paths").value = "";
    document.getElementById("nm-symbols").value = "";
    document.getElementById("nm-pinned").checked = false;
    document.getElementById("nm-evidence").innerHTML = "";
    toast("Memory saved");
    load();
  } catch (e) { toast("Error: " + e.message); }
}

// ---------------------------------------------------------------- search

let searchTimer = null;
function debouncedSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(doSearch, 300);
}

async function doSearch() {
  const q = document.getElementById("q").value.trim();
  const kind = document.getElementById("q-kind").value;
  if (!q && !kind) { renderMemories(); return; }
  try {
    const r = await api(\`/api/search?q=\${encodeURIComponent(q)}&kind=\${encodeURIComponent(kind)}\`);
    renderMemories(r.results);
    if (q && !r.semantic) toast("Keyword match only — configure embeddings for semantic search");
  } catch (e) { toast("Error: " + e.message); }
}

// ---------------------------------------------------------------- mine / sync / reindex

async function runMine(ev) {
  const full = ev && ev.shiftKey;
  toast(full ? "Rescanning full git history…" : "Mining git history…");
  try {
    const r = await api("/api/mine" + (full ? "?full=1" : ""), { method: "POST" });
    if (r.noCommits) {
      toast("No git commits yet — make an initial commit, then try again.");
      return;
    }
    if (r.noNewCommits) {
      toast("No new commits since the last mine — Shift+click Mine commits to rescan all history.");
      return;
    }
    if (r.scanned > 0 && r.proposed === 0) {
      toast("Scanned " + r.scanned + " commit(s): none matched memory-worthy signals (try descriptive messages or dim mine --llm)");
      return;
    }
    toast(\`Scanned \${r.scanned} commit(s): \${r.proposed} proposal(s) queued\`);
    load();
  } catch (e) { toast("Error: " + e.message); }
}

async function runSync() {
  toast("Syncing…");
  try {
    const r = await api("/api/sync", { method: "POST" });
    const mem = (n) => n + (n === 1 ? " memory" : " memories");
    let msg;
    if (r.memoriesPushed) msg = "Sent " + mem(r.memoriesPushed);
    else if (r.memoriesQueued) msg = "Already on server (" + mem(r.memoriesQueued) + " unchanged)";
    else msg = "Nothing to send";
    if (r.applied) msg += ", received " + r.applied + " update" + (r.applied === 1 ? "" : "s");
    else if (r.pulled) msg += ", pulled " + r.pulled + " (already up to date locally)";
    else msg += ", nothing new from team";
    if (r.needsFullUploadConfirm) {
      msg += " — run dim sync in terminal to confirm upload";
    }
    toast(msg);
    load();
  } catch (e) { toast("Sync: " + e.message); }
}

async function runReindex() {
  toast("Reindexing embeddings…");
  try {
    const r = await api("/api/reindex", { method: "POST" });
    toast(r.provider ? \`Indexed \${r.indexed} with \${r.provider}\` : "No embedding provider — run Ollama or set OPENAI_API_KEY");
  } catch (e) { toast("Error: " + e.message); }
}

// ---------------------------------------------------------------- cloud + keys

function openCloud() {
  const c = state && state.cloud;
  document.getElementById("cloud-status").textContent = c
    ? \`Linked: \${c.server} → brain '\${c.brain}' (\${c.hasToken ? "token stored" : "⚠ NO TOKEN — paste API key and Link"})\`
    : "Not linked to a team server yet. For local aidimag-cloud dev use http://localhost:3000";
  if (c) {
    document.getElementById("cl-server").value = c.server;
    document.getElementById("cl-brain").value = c.brain;
  }
  document.getElementById("dlg-cloud").showModal();
}

async function cloudLink() {
  try {
    await api("/api/cloud/link", {
      method: "POST",
      body: JSON.stringify({
        server: document.getElementById("cl-server").value.trim(),
        brain: document.getElementById("cl-brain").value.trim(),
        token: document.getElementById("cl-token").value.trim() || undefined,
      }),
    });
    document.getElementById("cl-token").value = "";
    toast("Linked — use Sync to exchange memory");
    load(); openCloud();
  } catch (e) { toast("Error: " + e.message); }
}

async function cloudUnlink() {
  try { await api("/api/cloud/unlink", { method: "POST" }); toast("Unlinked"); load(); openCloud(); }
  catch (e) { toast("Error: " + e.message); }
}

function keyParams() {
  return {
    server: document.getElementById("cl-server").value.trim(),
    adminToken: document.getElementById("k-admin").value.trim(),
  };
}

async function keyCreate() {
  const p = keyParams();
  if (!p.adminToken) { toast("Admin token required"); return; }
  try {
    const r = await api("/api/keys", {
      method: "POST",
      body: JSON.stringify({ ...p, brain: document.getElementById("k-brain").value.trim(), label: document.getElementById("k-label").value.trim() || undefined }),
    });
    document.getElementById("keys-out").innerHTML =
      \`<div class="hint">New key (shown once — copy now):</div><div class="keyrow"><span>\${esc(r.key)}</span><button onclick="navigator.clipboard.writeText('\${esc(r.key)}').then(()=>toast('Copied'))">Copy</button></div>\`;
  } catch (e) { toast("Error: " + e.message); }
}

async function keyList() {
  const p = keyParams();
  if (!p.adminToken) { toast("Admin token required"); return; }
  try {
    const r = await api(\`/api/keys?server=\${encodeURIComponent(p.server)}\`, {
      headers: { "X-Aidimag-Admin-Token": p.adminToken },
    });
    document.getElementById("keys-out").innerHTML = r.keys.length
      ? r.keys.map(k => \`<div class="keyrow"><span>\${k.revoked_at ? "✗" : "✓"} \${esc(k.key)} → \${esc(k.brain)}\${k.label ? " (" + esc(k.label) + ")" : ""}</span></div>\`).join("")
      : '<div class="hint">No keys yet.</div>';
  } catch (e) { toast("Error: " + e.message); }
}

// ---------------------------------------------------------------- tickets

const TK_HINTS = {
  jira:   { url: "Jira site URL", urlPh: "https://acme.atlassian.net", token: "email:apiToken (or a PAT)", needUrl: true,  needToken: true },
  github: { url: "Repo URL", urlPh: "https://github.com/acme/api", token: "GitHub token (repo read)", needUrl: true,  needToken: true },
  linear: { url: "", urlPh: "", token: "Linear API key", needUrl: false, needToken: true },
  http:   { url: "Middleware endpoint (GET /ticket/:id)", urlPh: "https://tickets.internal.acme.com", token: "Bearer token (optional)", needUrl: true, needToken: true },
  remote: { url: "", urlPh: "", token: "", needUrl: false, needToken: false },
};

function ticketsProviderHint() {
  const h = TK_HINTS[document.getElementById("tk-provider").value];
  document.getElementById("tk-url-row").style.display = h.needUrl ? "" : "none";
  document.getElementById("tk-token-row").style.display = h.needToken ? "" : "none";
  if (h.needUrl) {
    document.getElementById("tk-url-label").textContent = h.url;
    document.getElementById("tk-url").placeholder = h.urlPh;
  }
  if (h.needToken) document.getElementById("tk-token-label").textContent = h.token + " — stored on this machine only, never in the repo";
}

function openTickets() {
  const t = state && state.tickets;
  document.getElementById("tk-status").textContent = t
    ? \`Connected: \${t.provider}\${t.baseUrl ? " at " + t.baseUrl : ""} (\${t.hasCredential ? "credential stored" : "⚠ NO CREDENTIAL"})\`
    : "No ticketing app connected — proposals will miss the why from your tickets.";
  if (t) {
    document.getElementById("tk-provider").value = t.provider;
    if (t.baseUrl) document.getElementById("tk-url").value = t.baseUrl;
    document.getElementById("tk-pattern").value = t.pattern || "";
  }
  ticketsProviderHint();
  document.getElementById("dlg-tickets").showModal();
}

async function ticketsConnect() {
  try {
    const r = await api("/api/tickets/connect", {
      method: "POST",
      body: JSON.stringify({
        provider: document.getElementById("tk-provider").value,
        baseUrl: document.getElementById("tk-url").value.trim() || undefined,
        token: document.getElementById("tk-token").value.trim() || undefined,
        pattern: document.getElementById("tk-pattern").value.trim() || undefined,
        testId: document.getElementById("tk-test").value.trim() || undefined,
      }),
    });
    document.getElementById("tk-token").value = "";
    toast(r.validated ? \`Connected ✓ validated with \${r.validated.id}: \${r.validated.title}\` : "Tickets connected");
    load(); openTickets();
  } catch (e) { toast("Error: " + e.message); }
}

async function ticketsDisconnect() {
  try { await api("/api/tickets/disconnect", { method: "POST" }); toast("Tickets disconnected"); load(); openTickets(); }
  catch (e) { toast("Error: " + e.message); }
}

async function ticketsShare(remove) {
  const adminToken = document.getElementById("tk-admin").value.trim();
  if (!adminToken) { toast("Admin token required"); return; }
  try {
    await api("/api/tickets/share", {
      method: "POST",
      body: JSON.stringify(remove ? { adminToken, remove: true } : {
        adminToken,
        provider: document.getElementById("tk-provider").value,
        baseUrl: document.getElementById("tk-url").value.trim() || undefined,
        credential: document.getElementById("tk-token").value.trim() || undefined,
      }),
    });
    document.getElementById("tk-token").value = "";
    toast(remove ? "Team ticket config removed" : "Team credentials stored on the server — teammates use provider 'remote'");
  } catch (e) { toast("Error: " + e.message); }
}

let sim = null;
function renderGraph() {
  const container = document.getElementById("graph");
  container.innerHTML = "";
  const W = container.clientWidth, H = container.clientHeight;

  const nodes = [], links = [], pathNodes = new Map();
  for (const m of state.memories) {
    nodes.push({ id: m.id, type: "memory", label: m.claim.slice(0, 36) + (m.claim.length > 36 ? "…" : ""), status: m.status, conf: m.confidence });
    for (const p of m.scope.paths) {
      if (!pathNodes.has(p)) { pathNodes.set(p, { id: "path:" + p, type: "path", label: p }); }
      links.push({ source: m.id, target: "path:" + p, kind: "scope" });
    }
    for (const l of m.links) {
      if (l.fromId === m.id) links.push({ source: l.fromId, target: l.toId, kind: l.relation });
    }
  }
  nodes.push(...pathNodes.values());

  const svg = d3.select(container).append("svg").attr("width", W).attr("height", H);
  const g = svg.append("g");
  svg.call(d3.zoom().scaleExtent([0.3, 4]).on("zoom", e => g.attr("transform", e.transform)));

  if (sim) sim.stop();
  sim = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id(d => d.id).distance(90))
    .force("charge", d3.forceManyBody().strength(-220))
    .force("center", d3.forceCenter(W / 2, H / 2))
    .force("collide", d3.forceCollide(28));

  const palette = graphPalette();

  const link = g.append("g").selectAll("line").data(links).join("line")
    .attr("stroke", d => d.kind === "contradicts" ? palette.REFUTED : palette.link)
    .attr("stroke-width", 1.2);

  const node = g.append("g").selectAll("g").data(nodes).join("g")
    .style("cursor", "pointer")
    .call(d3.drag()
      .on("start", (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on("drag", (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on("end", (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));

  node.filter(d => d.type === "memory").append("circle")
    .attr("r", d => 7 + d.conf * 10)
    .attr("fill", d => palette[d.status] || palette.UNVERIFIED)
    .attr("fill-opacity", 0.85);
  node.filter(d => d.type === "path").append("rect")
    .attr("x", -7).attr("y", -7).attr("width", 14).attr("height", 14).attr("rx", 3)
    .attr("fill", palette.path).attr("fill-opacity", 0.85);

  node.append("text").attr("dy", d => d.type === "memory" ? 7 + d.conf * 10 + 12 : 22).attr("text-anchor", "middle").text(d => d.label);

  node.on("click", (e, d) => {
    if (d.type !== "memory") return;
    const card = document.getElementById("mem-" + d.id);
    if (card) { card.scrollIntoView({ behavior: "smooth", block: "center" }); card.style.outline = "2px solid " + palette.primary; setTimeout(() => card.style.outline = "", 1500); }
  });

  sim.on("tick", () => {
    link.attr("x1", d => d.source.x).attr("y1", d => d.source.y).attr("x2", d => d.target.x).attr("y2", d => d.target.y);
    node.attr("transform", d => \`translate(\${d.x},\${d.y})\`);
  });
}

window.addEventListener("resize", () => state && renderGraph());
load();
</script>
</body>
</html>`;

