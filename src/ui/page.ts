/**
 * Dashboard HTML — embedded as a template string so `tsc` is the whole build
 * (no asset pipeline). D3 v7 from CDN renders the memory graph.
 */

export const PAGE_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>aidimag — repo brain</title>
<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
<style>
  :root {
    --bg: #0f1117; --panel: #181b24; --border: #2a2f3d; --text: #d6d9e0; --dim: #8a90a0;
    --verified: #3fb950; --unverified: #8a90a0; --stale: #d29922; --refuted: #f85149; --path: #58a6ff;
  }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, "Segoe UI", sans-serif; height: 100vh; display: flex; flex-direction: column; }
  header { display: flex; align-items: center; gap: 16px; padding: 10px 18px; border-bottom: 1px solid var(--border); }
  header h1 { font-size: 16px; font-weight: 600; }
  header h1 span { color: var(--dim); font-weight: 400; font-size: 12px; margin-left: 8px; }
  .pill { padding: 2px 10px; border-radius: 999px; font-size: 12px; border: 1px solid var(--border); }
  .pill b { font-weight: 600; }
  .spacer { flex: 1; }
  button { background: #21262d; color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 5px 12px; font-size: 12px; cursor: pointer; }
  button:hover { background: #30363d; }
  button.primary { background: #1f6feb; border-color: #1f6feb; }
  button.danger:hover { background: #f8514922; border-color: var(--refuted); }
  main { flex: 1; display: flex; min-height: 0; }
  #graph { flex: 1; min-width: 0; }
  aside { width: 460px; border-left: 1px solid var(--border); overflow-y: auto; padding: 14px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--dim); margin: 14px 0 8px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; }
  .card .claim { font-size: 13px; margin-bottom: 6px; }
  .card .meta { font-size: 11px; color: var(--dim); display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .badge { padding: 1px 8px; border-radius: 999px; font-size: 10px; font-weight: 600; }
  .badge.VERIFIED { background: #3fb95022; color: var(--verified); }
  .badge.UNVERIFIED { background: #8a90a022; color: var(--unverified); }
  .badge.STALE { background: #d2992222; color: var(--stale); }
  .badge.REFUTED { background: #f8514922; color: var(--refuted); }
  .kind { color: var(--path); }
  .actions { margin-top: 8px; display: flex; gap: 6px; }
  .evidence { font-size: 11px; color: var(--dim); font-family: ui-monospace, monospace; margin-top: 4px; word-break: break-all; }
  .legend { display: flex; gap: 14px; padding: 8px 18px; font-size: 11px; color: var(--dim); border-top: 1px solid var(--border); }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 5px; vertical-align: -1px; }
  #toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #1f6feb; padding: 8px 18px; border-radius: 8px; display: none; font-size: 13px; }
  .empty { color: var(--dim); font-size: 12px; padding: 8px 0; }
  svg text { fill: var(--dim); font-size: 10px; pointer-events: none; }
</style>
</head>
<body>
<header>
  <h1>🧠 aidimag <span id="repo"></span></h1>
  <span class="pill" id="counts"></span>
  <div class="spacer"></div>
  <button class="primary" onclick="runVerify(false)">Verify</button>
  <button onclick="runVerify(true)">Verify --deep</button>
  <button onclick="load()">Refresh</button>
</header>
<main>
  <div id="graph"></div>
  <aside>
    <h2 id="proposals-h">Pending proposals</h2>
    <div id="proposals"></div>
    <h2>Memories</h2>
    <div id="memories"></div>
  </aside>
</main>
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
const COLORS = { VERIFIED: "#3fb950", UNVERIFIED: "#8a90a0", STALE: "#d29922", REFUTED: "#f85149" };
let state = null;

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.style.display = "block";
  setTimeout(() => t.style.display = "none", 2500);
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || r.status);
  return body;
}

async function load() {
  state = await api("/api/state");
  document.getElementById("repo").textContent = state.repoRoot;
  const s = state.summary.byStatus;
  document.getElementById("counts").innerHTML =
    \`<b>\${state.summary.total}</b> memories · ✓\${s.VERIFIED} ?\${s.UNVERIFIED} ~\${s.STALE} ✗\${s.REFUTED}\`;
  renderProposals(); renderMemories(); renderGraph();
}

function esc(s) { return s.replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c])); }

function renderProposals() {
  const el = document.getElementById("proposals");
  document.getElementById("proposals-h").textContent = \`Pending proposals (\${state.proposals.length})\`;
  if (!state.proposals.length) { el.innerHTML = '<div class="empty">Queue is empty.</div>'; return; }
  el.innerHTML = state.proposals.map(p => \`
    <div class="card">
      <div class="claim">\${esc(p.claim)}</div>
      <div class="meta"><span class="kind">\${p.kind}</span><span>via \${esc(p.source)}</span></div>
      <div class="actions">
        <button class="primary" onclick="act('/api/proposals/\${p.id}/approve','approved')">Approve</button>
        <button class="danger" onclick="act('/api/proposals/\${p.id}/reject','rejected')">Reject</button>
      </div>
    </div>\`).join("");
}

function renderMemories() {
  const el = document.getElementById("memories");
  if (!state.memories.length) { el.innerHTML = '<div class="empty">No memories yet — try <code>dim remember</code>.</div>'; return; }
  el.innerHTML = state.memories.map(m => \`
    <div class="card" id="mem-\${m.id}">
      <div class="claim">\${esc(m.claim)}</div>
      <div class="meta">
        <span class="badge \${m.status}">\${m.status}</span>
        <span class="kind">\${m.kind}</span>
        <span>conf \${m.confidence.toFixed(2)}</span>
        \${m.scope.paths.length ? "<span>📁 " + esc(m.scope.paths.join(", ")) + "</span>" : "<span>repo-wide</span>"}
      </div>
      \${m.grounding.map(e => \`<div class="evidence">\${e.type}(\${e.result}) \${esc(e.payload)}</div>\`).join("")}
      <div class="actions">
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

  const link = g.append("g").selectAll("line").data(links).join("line")
    .attr("stroke", d => d.kind === "contradicts" ? "#f85149" : "#2a2f3d")
    .attr("stroke-width", 1.2);

  const node = g.append("g").selectAll("g").data(nodes).join("g")
    .style("cursor", "pointer")
    .call(d3.drag()
      .on("start", (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on("drag", (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on("end", (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));

  node.filter(d => d.type === "memory").append("circle")
    .attr("r", d => 7 + d.conf * 10)
    .attr("fill", d => COLORS[d.status])
    .attr("fill-opacity", 0.85);
  node.filter(d => d.type === "path").append("rect")
    .attr("x", -7).attr("y", -7).attr("width", 14).attr("height", 14).attr("rx", 3)
    .attr("fill", "#58a6ff").attr("fill-opacity", 0.85);

  node.append("text").attr("dy", d => d.type === "memory" ? 7 + d.conf * 10 + 12 : 22).attr("text-anchor", "middle").text(d => d.label);

  node.on("click", (e, d) => {
    if (d.type !== "memory") return;
    const card = document.getElementById("mem-" + d.id);
    if (card) { card.scrollIntoView({ behavior: "smooth", block: "center" }); card.style.outline = "2px solid #1f6feb"; setTimeout(() => card.style.outline = "", 1500); }
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

