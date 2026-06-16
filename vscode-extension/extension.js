/**
 * aidimag VSCode extension — thin wrapper around the dim CLI + dashboard.
 *
 * Features:
 *  - Memory Explorer panel (TreeView) — colour-coded nodes (kind-tinted icons +
 *    status-tinted rows/badges, matching the IntelliJ plugin), grouped by
 *    status, expandable to evidence items, detail webview on click
 *  - "aidimag: Open Dashboard"  → spawns `dim ui` and embeds it in a webview
 *    (with a "🧠 Memory Explorer" button that reveals the dedicated side panel)
 *  - "aidimag: Add Memory"      → multi-step input flow (kind → claim → pin?)
 *  - "aidimag: Verify Memories" → runs `dim verify -q`, warns if STALE
 *  - "aidimag: Sync Team Memory"→ runs `dim sync`
 *  - "aidimag: Pin/Unpin Memory"→ quick-pick + tree context menu pin/unpin
 *  - "aidimag: Connect Ticketing App" → interactive `dim ticket connect`
 *  - "aidimag: Show Ticket"     → `dim ticket show`, prefilled from branch
 *  - "aidimag: Create Ticket Branch" → `dim branch <id>`
 *  - Knowledge inbox watcher → auto-runs `dim knowledge sync` when docs are dropped
 *  - Status bar: 🧠 memory counts + ☁ sync state
 *
 * Plain CommonJS: no build step, packageable with `vsce package` as-is.
 */

const vscode  = require("vscode");
const { spawn, execFile } = require("child_process");
const http    = require("http");
const fs      = require("fs");
const path    = require("path");

let uiProcess          = null;
let statusItem         = null;
let syncStatusItem     = null;
let lastSync           = null;   // { when: Date, summary: string, ok: boolean }
let memoryTreeProvider = null;
let knowledgeWatcher   = null;

// ─── config / helpers ──────────────────────────────────────────────────────

function cfg() {
  const c = vscode.workspace.getConfiguration("aidimag");
  return {
    dim:             c.get("dimPath") || "dim",
    port:            c.get("uiPort") || 4517,
    autoSyncMinutes: c.get("autoSyncMinutes") ?? 10,
    knowledgeWatch:  c.get("knowledgeWatch") ?? true,
  };
}

function repoRoot() {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length ? folders[0].uri.fsPath : null;
}

/** Inbox folder (repo-relative) from .aidimag/config.json → knowledge.folder; default "knowledge". */
function knowledgeFolder(root) {
  try {
    const raw = fs.readFileSync(path.join(root, ".aidimag", "config.json"), "utf8");
    const f = JSON.parse(raw)?.knowledge?.folder;
    if (typeof f === "string" && f.trim()) return f.trim();
  } catch { /* missing/invalid config → default */ }
  return "knowledge";
}


function runDim(args, cwd) {
  const { dim } = cfg();
  return new Promise((resolve, reject) => {
    execFile(dim, args, { cwd, timeout: 120_000 }, (err, stdout, stderr) => {
      if (err && err.code === "ENOENT") {
        reject(new Error(`'${dim}' not found. Install aidimag (npm i -g aidimag) or set aidimag.dimPath.`));
      } else if (err && err.code !== 2) {
        // exit 2 = "stale memories" signal from dim verify, not a failure
        reject(new Error(stderr || stdout || String(err)));
      } else {
        resolve({ stdout, stderr, exitCode: err ? err.code : 0 });
      }
    });
  });
}

function fetchState(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/state", timeout: 1500 }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

async function ensureUiServer() {
  const { dim, port } = cfg();
  const root = repoRoot();
  if (!root) throw new Error("Open a folder with an .aidimag/ directory first.");
  try { await fetchState(port); return port; } catch { /* not running */ }
  uiProcess = spawn(dim, ["ui", "--no-open", "--port", String(port)], { cwd: root, stdio: "ignore" });
  uiProcess.on("error", () => { uiProcess = null; });
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { await fetchState(port); return port; } catch { /* retry */ }
  }
  throw new Error("dashboard server did not start — is the dim CLI installed?");
}

// ─── Memory Tree ───────────────────────────────────────────────────────────

const KIND_ICONS = {
  DECISION:        "milestone",
  CONVENTION:      "list-ordered",
  GOTCHA:          "zap",
  FAILED_APPROACH: "x",
  INVARIANT:       "lock",
  ARCHITECTURE:    "circuit-board",
  TODO_CONTEXT:    "tasklist",
  GUARDRAIL:       "shield",
  SKILL:           "book",
};
const STATUS_ICONS  = { VERIFIED: "pass", STALE: "warning", UNVERIFIED: "question", REFUTED: "error" };
const STATUS_LABELS = { VERIFIED: "✓ VERIFIED", STALE: "~ STALE", UNVERIFIED: "? UNVERIFIED", REFUTED: "✗ REFUTED" };

// Color-coding (mirrors the IntelliJ plugin). These map to theme colors
// contributed in package.json under "contributes.colors", whose hex values
// match the IntelliJ MemoryExplorerPanel palette.
const STATUS_COLOR_IDS = {
  VERIFIED:   "aidimag.status.verified",
  STALE:      "aidimag.status.stale",
  UNVERIFIED: "aidimag.status.unverified",
  REFUTED:    "aidimag.status.refuted",
};
const KIND_COLOR_IDS = {
  DECISION:        "aidimag.kind.decision",
  CONVENTION:      "aidimag.kind.convention",
  GOTCHA:          "aidimag.kind.gotcha",
  FAILED_APPROACH: "aidimag.kind.failedApproach",
  INVARIANT:       "aidimag.kind.invariant",
  ARCHITECTURE:    "aidimag.kind.architecture",
  TODO_CONTEXT:    "aidimag.kind.todoContext",
  GUARDRAIL:       "aidimag.kind.guardrail",
  SKILL:           "aidimag.kind.skill",
};
const STATUS_BADGES = { VERIFIED: "✓", STALE: "~", UNVERIFIED: "?", REFUTED: "✗" };

function statusThemeColor(status) {
  const id = STATUS_COLOR_IDS[status];
  return id ? new vscode.ThemeColor(id) : undefined;
}
function kindThemeColor(kind) {
  const id = KIND_COLOR_IDS[kind];
  return id ? new vscode.ThemeColor(id) : undefined;
}

/**
 * Tints each memory row's text + badge by status (the FileDecoration API is the
 * only way to color a TreeItem's label). Status is encoded in a synthetic
 * resourceUri so the decoration re-resolves automatically when status changes.
 */
class MemoryDecorationProvider {
  constructor() {
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeFileDecorations = this._onDidChange.event;
  }
  provideFileDecoration(uri) {
    if (uri.scheme !== "aidimag-memory") return undefined;
    const status = new URLSearchParams(uri.query).get("status");
    const color  = statusThemeColor(status);
    if (!color) return undefined;
    return {
      badge:   STATUS_BADGES[status],
      color,
      tooltip: status,
    };
  }
}

class MemoryTreeProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData  = this._onDidChangeTreeData.event;
    this.memories = [];
  }

  refresh(memories) {
    this.memories = memories || [];
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) { return element; }

  getChildren(element) {
    // Root → status group nodes
    if (!element) {
      if (!this.memories.length) {
        const tip = new vscode.TreeItem("No memories yet — run \"dim remember\" first.");
        tip.contextValue = "aidimag.empty";
        return [tip];
      }
      return ["VERIFIED", "STALE", "UNVERIFIED", "REFUTED"]
        .map((s) => this._makeGroup(s, this.memories.filter((m) => m.status === s)))
        .filter((g) => g !== null);
    }
    // Group → memory nodes
    if (element.contextValue === "aidimag.group") {
      return (element._items || []).map((m) => this._makeMemory(m));
    }
    // Memory → evidence nodes
    if (element.contextValue && element.contextValue.startsWith("aidimag.memory")) {
      return (element._memory.grounding || []).map((e) => this._makeEvidence(e));
    }
    return [];
  }

  _makeGroup(status, items) {
    if (!items.length && status === "REFUTED") return null;   // hide empty REFUTED
    const label = `${STATUS_LABELS[status]} (${items.length})`;
    const state = items.length > 0
      ? (["VERIFIED", "STALE"].includes(status)
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed)
      : vscode.TreeItemCollapsibleState.None;
    const item       = new vscode.TreeItem(label, state);
    item.iconPath    = new vscode.ThemeIcon(STATUS_ICONS[status] || "circle", statusThemeColor(status));
    item.contextValue = "aidimag.group";
    item._items      = items;
    return item;
  }

  _makeMemory(m) {
    const short = m.claim.length > 72 ? m.claim.slice(0, 72) + "…" : m.claim;
    const hasEv = (m.grounding || []).length > 0;
    const state = hasEv
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    const item         = new vscode.TreeItem(`[${m.kind}] ${short}`, state);
    const confPct      = Math.round((m.confidence || 0.5) * 100);
    item.description   = `${confPct}%${m.pinned ? "  📌" : ""}`;
    item.tooltip       = new vscode.MarkdownString(
      `**${m.kind}** · \`${m.status}\` · ${confPct}%${m.pinned ? " · 📌 pinned" : ""}\n\n${m.claim}`
    );
    item.iconPath      = new vscode.ThemeIcon(KIND_ICONS[m.kind] || "circle-outline", kindThemeColor(m.kind));
    item.contextValue  = m.pinned ? "aidimag.memory.pinned" : "aidimag.memory.unpinned";
    // Synthetic URI lets MemoryDecorationProvider tint the row by status.
    item.resourceUri   = vscode.Uri.parse(
      `aidimag-memory:/${encodeURIComponent(m.id || m.claim.slice(0, 16))}?status=${m.status}`,
    );
    item._memory       = m;
    item.command       = {
      command:   "aidimag.openMemoryDetail",
      title:     "Open Detail",
      arguments: [m],
    };
    return item;
  }

  _makeEvidence(e) {
    const short = e.payload.length > 60 ? e.payload.slice(0, 60) + "…" : e.payload;
    const icon  = e.result === "PASS" ? "pass-filled" : e.result === "FAIL" ? "error" : "circle-outline";
    const label = `${e.result === "PASS" ? "✓" : e.result === "FAIL" ? "✗" : "·"} ${e.type}  ${short}`;
    const item  = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.tooltip      = `${e.type}: ${e.payload}`;
    item.iconPath     = new vscode.ThemeIcon(icon);
    item.contextValue = "aidimag.evidence";
    return item;
  }
}

// ─── Memory tree refresh helper ────────────────────────────────────────────

async function refreshMemoryTree() {
  if (!memoryTreeProvider) return;
  try {
    const port  = await ensureUiServer();
    const state = await fetchState(port);
    memoryTreeProvider.refresh(state.memories || []);
  } catch {
    memoryTreeProvider.refresh([]);
  }
}

// ─── Memory detail webview ─────────────────────────────────────────────────

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function openMemoryDetail(memory) {
  if (!memory) return;
  const m     = memory._memory || memory;
  const title = `🧠 ${m.claim.slice(0, 40)}…`;
  const panel = vscode.window.createWebviewPanel(
    "aidimagMemoryDetail", title, vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.webview.html = buildDetailHtml(m);

  panel.webview.onDidReceiveMessage(async (msg) => {
    const root = repoRoot();
    if (!root) return;
    if (msg.command === "pin") {
      await runDim([m.pinned ? "unpin" : "pin", m.id.slice(0, 8)], root).catch(() => {});
      vscode.window.setStatusBarMessage(
        m.pinned ? "aidimag: memory unpinned — decay resumes" : "aidimag: memory pinned 📌", 5000,
      );
      panel.dispose();
      refreshStatusBar();
      refreshMemoryTree();
    } else if (msg.command === "verify") {
      panel.dispose();
      verify();
    } else if (msg.command === "refute") {
      const ok = await vscode.window.showWarningMessage(
        `Refute: "${m.claim.slice(0, 80)}"?`, "Refute", "Cancel",
      );
      if (ok === "Refute") {
        await runDim(["refute", m.id.slice(0, 8)], root).catch(() => {});
        panel.dispose();
        refreshStatusBar();
        refreshMemoryTree();
      }
    }
  });
}

function buildDetailHtml(m) {
  const STATUS_COLORS = {
    VERIFIED: "#22c55e", STALE: "#f97316", UNVERIFIED: "#9ca3af", REFUTED: "#ef4444",
  };
  const KIND_COLORS = {
    DECISION: "#3b82f6", CONVENTION: "#14b8a6", GOTCHA: "#f97316",
    FAILED_APPROACH: "#ef4444", INVARIANT: "#a855f7", ARCHITECTURE: "#6366f1",
    TODO_CONTEXT: "#6b7280", GUARDRAIL: "#dc2626", SKILL: "#0ea5e9",
  };
  const sColor  = STATUS_COLORS[m.status] || "#9ca3af";
  const kColor  = KIND_COLORS[m.kind]     || "#9ca3af";
  const confPct = Math.round((m.confidence || 0.5) * 100);
  const confClr = confPct >= 75 ? "#22c55e" : confPct >= 40 ? "#f97316" : "#ef4444";
  const scope   = [
    ...((m.scope && m.scope.paths)   || []),
    ...((m.scope && m.scope.symbols) || []),
  ].join(", ") || "—";

  const evidenceRows = (m.grounding || []).length
    ? (m.grounding).map((e) => `
        <div class="ev-row">
          <span class="ev-icon ${e.result === "PASS" ? "pass" : e.result === "FAIL" ? "fail" : ""}">${
            e.result === "PASS" ? "✓" : e.result === "FAIL" ? "✗" : "·"
          }</span>
          <span class="ev-type">${escHtml(e.type)}</span>
          <span class="ev-payload">${escHtml(e.payload)}</span>
        </div>`).join("")
    : `<span class="dim">No evidence attached</span>`;

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  *   { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0; padding: 20px; max-width: 720px;
  }
  h2  { font-size: 1em; font-weight: 600; margin: 0 0 12px; }
  .claim {
    background: var(--vscode-textBlockQuote-background);
    border-left: 4px solid ${kColor};
    padding: 12px 16px; border-radius: 4px;
    font-size: 1.05em; line-height: 1.6; margin-bottom: 20px;
  }
  .badges { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
  .badge {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 3px 10px; border-radius: 12px; font-size: 0.8em; font-weight: 600;
    border: 1.5px solid; white-space: nowrap;
  }
  .badge-kind   { color: ${kColor}; border-color: ${kColor}; }
  .badge-status { color: ${sColor}; border-color: ${sColor}; }
  .badge-pin    { color: #f59e0b; border-color: #f59e0b; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; display: inline-block; }
  table   { border-collapse: collapse; width: 100%; margin-bottom: 20px; }
  td      { padding: 4px 8px 4px 0; vertical-align: top; }
  td:first-child { color: var(--vscode-descriptionForeground); white-space: nowrap; width: 90px; }
  td:last-child  { font-weight: 500; }
  .conf-wrap { display: inline-flex; align-items: center; gap: 8px; }
  .conf-bar  { width: 100px; height: 7px; border-radius: 4px; background: var(--vscode-progressBar-background, #444); overflow: hidden; }
  .conf-fill { height: 100%; border-radius: 4px; background: ${confClr}; width: ${confPct}%; }
  .section   { font-size: 0.75em; font-weight: 700; text-transform: uppercase; letter-spacing: .06em;
               color: var(--vscode-descriptionForeground); margin: 20px 0 8px; }
  .ev-row  { display: flex; gap: 10px; margin-bottom: 5px; font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
  .ev-icon { width: 14px; font-weight: 700; flex-shrink: 0; }
  .ev-icon.pass { color: #22c55e; }
  .ev-icon.fail { color: #ef4444; }
  .ev-type { color: var(--vscode-descriptionForeground); white-space: nowrap; min-width: 120px; }
  .ev-payload { overflow: hidden; text-overflow: ellipsis; }
  .actions { display: flex; gap: 10px; margin-top: 24px; }
  button {
    padding: 7px 16px; border-radius: 5px; border: none;
    cursor: pointer; font-size: 0.9em; font-family: inherit;
  }
  .btn-pin    { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn-verify { background: var(--vscode-button-background);          color: var(--vscode-button-foreground); }
  .btn-refute { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); color: var(--vscode-errorForeground, #f48771); }
  button:hover { filter: brightness(1.12); }
  .pin-note, .dim { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-top: 8px; }
  code { font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
</style>
</head><body>

<div class="claim">${escHtml(m.claim)}</div>

<div class="badges">
  <span class="badge badge-kind">${escHtml(m.kind)}</span>
  <span class="badge badge-status"><span class="dot"></span>${escHtml(m.status)}</span>
  ${m.pinned ? '<span class="badge badge-pin">📌 PINNED</span>' : ""}
</div>

<table>
  <tr><td>Confidence</td><td>
    <span class="conf-wrap">
      <span class="conf-bar"><span class="conf-fill"></span></span>
      ${confPct}%
    </span>
  </td></tr>
  <tr><td>ID</td><td><code>${m.id ? escHtml(m.id.slice(0, 8)) : "—"}</code></td></tr>
  <tr><td>Ticket</td><td>${escHtml(m.ticket_ref || "—")}</td></tr>
  <tr><td>Scope</td><td>${escHtml(scope)}</td></tr>
  <tr><td>Created</td><td>${m.created_at ? escHtml(m.created_at.slice(0, 10)) : "—"}</td></tr>
</table>

<div class="section">Evidence (${(m.grounding || []).length})</div>
<div class="evidence">${evidenceRows}</div>

<div class="actions">
  <button class="btn-pin"    onclick="post('pin')"   >${m.pinned ? "📌 Unpin" : "📌 Pin"}</button>
  <button class="btn-verify" onclick="post('verify')">✓ Verify All</button>
  <button class="btn-refute" onclick="post('refute')">✗ Refute</button>
</div>
${m.pinned ? '<p class="pin-note">📌 Pinned: exempt from time decay. Evidence failure can still mark it stale.</p>' : ""}

<script>
  const vscode = acquireVsCodeApi();
  function post(command) { vscode.postMessage({ command }); }
</script>
</body></html>`;
}

// ─── Add Memory flow ───────────────────────────────────────────────────────

const KIND_DESCRIPTIONS = {
  DECISION:        "Why we chose X over Y",
  CONVENTION:      "Team coding standards",
  GOTCHA:          "Subtle bugs / edge cases",
  FAILED_APPROACH: "What we tried and abandoned",
  INVARIANT:       "Must-always / must-never invariants",
  ARCHITECTURE:    "High-level system structure",
  TODO_CONTEXT:    "Unfinished work context",
  GUARDRAIL:       "Behavioral rule: never / ask-first / always",
  SKILL:           "Reusable step-by-step procedure",
};

async function addMemory() {
  const root = repoRoot();
  if (!root) { vscode.window.showErrorMessage("aidimag: open a folder first."); return; }

  const kindPick = await vscode.window.showQuickPick(
    Object.keys(KIND_DESCRIPTIONS).map((k) => ({ label: k, description: KIND_DESCRIPTIONS[k] })),
    { placeHolder: "Select memory kind" },
  );
  if (!kindPick) return;

  const claim = await vscode.window.showInputBox({
    prompt:       `Enter the ${kindPick.label} claim`,
    placeHolder:  "e.g. We chose LWW over CRDTs because the team stays under 10 people.",
    validateInput: (v) => (v && v.trim() ? null : "Claim cannot be empty."),
  });
  if (!claim) return;

  // GUARDRAIL memories need an enforcement level.
  let guardrailLevel = null;
  if (kindPick.label === "GUARDRAIL") {
    const levelPick = await vscode.window.showQuickPick([
      { label: "never",     description: "🚫 Agents must refuse and explain why" },
      { label: "ask-first", description: "🤚 Confirm with the user before doing it" },
      { label: "always",    description: "✅ Do it automatically, no need to ask" },
    ], { placeHolder: "Guardrail enforcement level" });
    if (!levelPick) return;
    guardrailLevel = levelPick.label;
  }

  const pinPick = await vscode.window.showQuickPick([
    { label: "No",       description: "Normal confidence decay over time" },
    { label: "📌 Pin",   description: "Never decays with age (evidence failure still applies)" },
  ], { placeHolder: "Pin this memory?" });
  if (!pinPick) return;

  const pinned = pinPick.label !== "No";
  try {
    const args = ["remember", claim.trim(), "-k", kindPick.label];
    if (guardrailLevel) args.push("-g", guardrailLevel);
    if (pinned) args.push("--pin");
    await runDim(args, root);
    vscode.window.setStatusBarMessage(
      `aidimag: memory saved${pinned ? " 📌" : ""} ✓`, 5000,
    );
    refreshStatusBar();
    refreshMemoryTree();
  } catch (err) {
    vscode.window.showErrorMessage(`aidimag add: ${err.message}`);
  }
}

// ─── Tree context-menu item actions ───────────────────────────────────────

async function pinMemoryItem(item) {
  const root = repoRoot();
  if (!root || !item || !item._memory) return;
  const m = item._memory;
  try {
    await runDim([m.pinned ? "unpin" : "pin", m.id.slice(0, 8)], root);
    vscode.window.setStatusBarMessage(
      m.pinned ? "aidimag: memory unpinned." : "aidimag: memory pinned 📌", 5000,
    );
    refreshStatusBar();
    refreshMemoryTree();
  } catch (err) {
    vscode.window.showErrorMessage(`aidimag pin: ${err.message}`);
  }
}

async function refuteMemoryItem(item) {
  const root = repoRoot();
  if (!root || !item || !item._memory) return;
  const m  = item._memory;
  const ok = await vscode.window.showWarningMessage(
    `Refute: "${m.claim.slice(0, 80)}"?`, "Refute", "Cancel",
  );
  if (ok !== "Refute") return;
  try {
    await runDim(["refute", m.id.slice(0, 8)], root);
    vscode.window.setStatusBarMessage("aidimag: memory refuted.", 4000);
    refreshStatusBar();
    refreshMemoryTree();
  } catch (err) {
    vscode.window.showErrorMessage(`aidimag refute: ${err.message}`);
  }
}

// ─── Dashboard webview ─────────────────────────────────────────────────────

async function openDashboard() {
  try {
    const port = await ensureUiServer();
    const panel = vscode.window.createWebviewPanel(
      "aidimagDashboard", "🧠 aidimag",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.webview.html = `<!DOCTYPE html>
<html style="height:100%">
<head><meta charset="UTF-8"><style>
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; background: var(--vscode-editor-background); }
  #aidimag-bar {
    flex: 0 0 auto; display: flex; align-items: center; justify-content: flex-end; gap: 8px;
    padding: 6px 12px; background: var(--vscode-sideBar-background, #252526);
    border-bottom: 1px solid var(--vscode-panel-border, #333);
  }
  #aidimag-reveal {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 5px 12px; border: none; border-radius: 6px; cursor: pointer;
    font-family: var(--vscode-font-family); font-size: 12px; font-weight: 600;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  }
  #aidimag-reveal:hover { filter: brightness(1.1); }
  #aidimag-frame { flex: 1 1 auto; width: 100%; border: 0; }
</style></head>
<body>
  <div id="aidimag-bar">
    <button id="aidimag-reveal" title="Reveal the Memory Explorer panel in the side bar">🧠 Memory Explorer</button>
  </div>
  <iframe id="aidimag-frame" src="http://localhost:${port}"></iframe>
  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById("aidimag-reveal")
      .addEventListener("click", () => vscode.postMessage({ command: "revealMemoryExplorer" }));
  </script>
</body>
</html>`;

    panel.webview.onDidReceiveMessage((msg) => {
      if (msg && msg.command === "revealMemoryExplorer") revealMemoryExplorer();
    });
  } catch (err) {
    vscode.window.showErrorMessage(`aidimag: ${err.message}`);
  }
}

/** Reveals & focuses the Memory Explorer view (its own Activity Bar container). */
async function revealMemoryExplorer() {
  try {
    // VS Code auto-registers `<viewId>.focus` for contributed views.
    await vscode.commands.executeCommand("aidimag.memoryExplorer.focus");
  } catch {
    // Fallback: open the container, then refresh.
    try { await vscode.commands.executeCommand("workbench.view.extension.aidimag"); } catch { /* ignore */ }
  }
  refreshMemoryTree();
}

// ─── Verify ────────────────────────────────────────────────────────────────

async function verify() {
  const root = repoRoot();
  if (!root) return;
  try {
    const { exitCode } = await runDim(["verify", "-q"], root);
    if (exitCode === 2) {
      const pick = await vscode.window.showWarningMessage(
        "aidimag: some memories went STALE — the codebase changed under them.", "Open Dashboard",
      );
      if (pick) openDashboard();
    } else {
      vscode.window.setStatusBarMessage("aidimag: memories verified ✓", 4000);
    }
    refreshStatusBar();
    refreshMemoryTree();
  } catch (err) {
    vscode.window.showErrorMessage(`aidimag verify: ${err.message}`);
  }
}

// ─── Sync ──────────────────────────────────────────────────────────────────

async function sync(opts) {
  const silent = opts && opts.silent;
  const root   = repoRoot();
  if (!root) return;
  syncStatusItem.text = "☁ syncing…";
  try {
    const { stdout } = await runDim(["sync"], root);
    lastSync = { when: new Date(), summary: stdout.trim(), ok: true };
    if (!silent) vscode.window.setStatusBarMessage(`aidimag: ${stdout.trim()}`, 6000);
    refreshStatusBar();
  } catch (err) {
    lastSync = { when: new Date(), summary: err.message, ok: false };
    if (!silent) vscode.window.showErrorMessage(`aidimag sync: ${err.message}`);
  }
  refreshSyncStatus();
}

// ─── Login ─────────────────────────────────────────────────────────────────

function login() {
  const root = repoRoot();
  if (!root) { vscode.window.showErrorMessage("aidimag: open a folder first."); return; }
  const term = vscode.window.createTerminal({ name: "aidimag login", cwd: root });
  term.show();
  term.sendText(`${cfg().dim} login`);
}

// ─── Tickets ───────────────────────────────────────────────────────────────

function connectTickets() {
  const root = repoRoot();
  if (!root) { vscode.window.showErrorMessage("aidimag: open a folder first."); return; }
  const term = vscode.window.createTerminal({ name: "aidimag tickets", cwd: root });
  term.show();
  term.sendText(`${cfg().dim} ticket connect`);
}

function branchTicketId(root) {
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, timeout: 5000 }, async (err, stdout) => {
      if (err) return resolve(null);
      const branch = stdout.trim();
      let pattern = "[A-Z][A-Z0-9]+-\\d+";
      try {
        const { stdout: st } = await runDim(["ticket", "status"], root);
        const m = st.match(/pattern:\s*(\S+)/);
        if (m) pattern = m[1];
      } catch { /* not connected */ }
      try {
        const m = branch.match(new RegExp(pattern));
        resolve(m ? m[0] : null);
      } catch { resolve(null); }
    });
  });
}

async function showTicket() {
  const root = repoRoot();
  if (!root) return;
  const detected = await branchTicketId(root);
  const id = await vscode.window.showInputBox({
    prompt: "Ticket id (e.g. XXX-2100 or #123)",
    value: detected || "",
    placeHolder: "XXX-2100",
  });
  if (!id) return;
  try {
    const { stdout } = await runDim(["ticket", "show", id], root);
    const out = vscode.window.createOutputChannel("aidimag ticket", { log: false });
    out.clear(); out.append(stdout); out.show(true);
    const url = (stdout.match(/https?:\/\/\S+/) || [])[0];
    if (url) {
      const pick = await vscode.window.showInformationMessage(stdout.split("\n")[0], "Open in browser");
      if (pick) vscode.env.openExternal(vscode.Uri.parse(url));
    }
  } catch (err) {
    const msg  = /no ticketing app connected/i.test(err.message)
      ? "aidimag: no ticketing app connected." : `aidimag ticket: ${err.message}`;
    const pick = await vscode.window.showErrorMessage(msg, ...(/connected/.test(msg) ? ["Connect now"] : []));
    if (pick) connectTickets();
  }
}

async function ticketBranch() {
  const root = repoRoot();
  if (!root) return;
  const id = await vscode.window.showInputBox({
    prompt: "Ticket id to branch from (creates feature/<ID>-<title-slug>)",
    placeHolder: "XXX-2100",
  });
  if (!id) return;
  const term = vscode.window.createTerminal({ name: "aidimag branch", cwd: root });
  term.show();
  term.sendText(`${cfg().dim} branch ${id}`);
}

// ─── Pin/Unpin quick-pick (existing command, kept for command palette) ──────

async function pinMemory() {
  const root = repoRoot();
  if (!root) return;
  try {
    const port     = await ensureUiServer();
    const state    = await fetchState(port);
    const memories = (state.memories || []).filter((m) => m.status !== "REFUTED");
    if (!memories.length) {
      vscode.window.showInformationMessage("aidimag: no memories yet — store one with `dim remember` first.");
      return;
    }
    const items = memories.map((m) => ({
      label:       `${m.pinned ? "📌 " : ""}${m.claim.length > 80 ? m.claim.slice(0, 80) + "…" : m.claim}`,
      description: `${m.kind} · ${m.status} · conf ${m.confidence.toFixed(2)}`,
      detail:      m.pinned
        ? "Pinned — select to unpin (normal confidence decay resumes)"
        : "Select to pin: never decays with age (evidence failure can still mark it stale)",
      memory: m,
    }));
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: "Pin/unpin a memory",
      matchOnDescription: true,
    });
    if (!pick) return;
    const m = pick.memory;
    await runDim([m.pinned ? "unpin" : "pin", m.id.slice(0, 8)], root);
    vscode.window.setStatusBarMessage(
      m.pinned ? "aidimag: memory unpinned — decay resumes" : "aidimag: memory pinned 📌", 5000,
    );
    refreshStatusBar();
    refreshMemoryTree();
  } catch (err) {
    vscode.window.showErrorMessage(`aidimag pin: ${err.message}`);
  }
}

// ─── Status bar ────────────────────────────────────────────────────────────

let autoSyncTimer = null;

async function isCloudLinked() {
  const root = repoRoot();
  if (!root) return false;
  try {
    const { stdout } = await runDim(["cloud", "status"], root);
    return !/Not cloud-linked/i.test(stdout) && !/token:\s*MISSING/.test(stdout);
  } catch { return false; }
}

function scheduleAutoSync(context) {
  if (autoSyncTimer) { clearInterval(autoSyncTimer); autoSyncTimer = null; }
  const minutes = cfg().autoSyncMinutes;
  if (!minutes || minutes <= 0) return;
  autoSyncTimer = setInterval(async () => {
    if (await isCloudLinked()) await sync({ silent: true });
  }, minutes * 60_000);
  context.subscriptions.push({ dispose: () => autoSyncTimer && clearInterval(autoSyncTimer) });
}

// ─── Knowledge inbox watcher ───────────────────────────────────────────────
// Mirrors `dim ui` / `dim knowledge watch`: when a doc is dropped into the
// knowledge inbox, run `dim knowledge sync` (debounced) so it's summarized into
// review proposals without leaving the editor. Best-effort; failures are silent.

let knowledgeSyncTimer = null;
let knowledgeSyncing   = false;

async function runKnowledgeSync({ manual = false } = {}) {
  const root = repoRoot();
  if (!root) return;
  if (knowledgeSyncing) return;
  knowledgeSyncing = true;
  try {
    const { stdout } = await runDim(["knowledge", "sync"], root);
    const processed = (stdout.match(/Processed (\d+) doc/) || [])[1];
    if (processed && Number(processed) > 0) {
      vscode.window.showInformationMessage(
        `aidimag: summarized ${processed} knowledge doc(s) into the review queue — run “aidimag: Open Dashboard” to review.`
      );
      refreshMemoryTree();
      refreshStatusBar();
    } else if (manual) {
      vscode.window.showInformationMessage("aidimag: knowledge inbox is up to date.");
    }
  } catch (err) {
    if (manual) vscode.window.showErrorMessage(`aidimag knowledge sync: ${err.message}`);
  } finally {
    knowledgeSyncing = false;
  }
}

function setupKnowledgeWatcher(context) {
  if (knowledgeWatcher) { knowledgeWatcher.dispose(); knowledgeWatcher = null; }
  if (knowledgeSyncTimer) { clearTimeout(knowledgeSyncTimer); knowledgeSyncTimer = null; }
  const root = repoRoot();
  if (!root || !cfg().knowledgeWatch) return;

  const folder  = knowledgeFolder(root);
  const pattern = new vscode.RelativePattern(root, `${folder}/**`);
  knowledgeWatcher = vscode.workspace.createFileSystemWatcher(pattern);
  const onDrop = (uri) => {
    // ignore the .gitkeep sentinel and dotfiles
    if (path.basename(uri.fsPath).startsWith(".")) return;
    if (knowledgeSyncTimer) clearTimeout(knowledgeSyncTimer);
    knowledgeSyncTimer = setTimeout(() => runKnowledgeSync(), 1000);
  };
  knowledgeWatcher.onDidCreate(onDrop);
  knowledgeWatcher.onDidChange(onDrop);
  context.subscriptions.push(
    knowledgeWatcher,
    { dispose: () => knowledgeSyncTimer && clearTimeout(knowledgeSyncTimer) },
  );
  // catch up on anything already waiting in the inbox
  runKnowledgeSync();
}


async function refreshSyncStatus() {
  const root = repoRoot();
  if (!root || !syncStatusItem) return;
  try {
    const { stdout } = await runDim(["cloud", "status"], root);
    if (/Not cloud-linked/i.test(stdout)) {
      syncStatusItem.text        = "☁ not linked";
      syncStatusItem.tooltip     = "aidimag: no team sync — click to open dashboard and link a server";
      syncStatusItem.command     = "aidimag.openDashboard";
      syncStatusItem.backgroundColor = undefined;
      syncStatusItem.show(); return;
    }
    const brain       = (stdout.match(/brain:\s*(\S+)/) || [])[1] || "?";
    const tokenMissing = /token:\s*MISSING/.test(stdout);
    const lastTxt     = lastSync
      ? `\nLast sync ${lastSync.when.toLocaleTimeString()}: ${lastSync.summary}`
      : "\nNot synced this session";
    if (tokenMissing) {
      syncStatusItem.text            = `☁ ${brain} ⚠`;
      syncStatusItem.tooltip         = `aidimag: linked to '${brain}' but NO TOKEN — click to log in${lastTxt}`;
      syncStatusItem.command         = "aidimag.login";
      syncStatusItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    } else if (lastSync && !lastSync.ok) {
      syncStatusItem.text            = `☁ ${brain} ✗`;
      syncStatusItem.tooltip         = `aidimag: last sync FAILED — click to retry${lastTxt}`;
      syncStatusItem.command         = "aidimag.sync";
      syncStatusItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    } else {
      syncStatusItem.text            = lastSync ? `☁ ${brain} ✓` : `☁ ${brain}`;
      syncStatusItem.tooltip         = `aidimag: team brain '${brain}' — click to sync now${lastTxt}`;
      syncStatusItem.command         = "aidimag.sync";
      syncStatusItem.backgroundColor = undefined;
    }
    syncStatusItem.show();
  } catch { syncStatusItem.hide(); }
}

async function refreshStatusBar() {
  const root = repoRoot();
  if (!root || !statusItem) return;
  try {
    const { stdout } = await runDim(["status"], root);
    const m = stdout.match(/VERIFIED=(\d+)\s+UNVERIFIED=(\d+)\s+STALE=(\d+)/);
    if (m) {
      const [, v, u, s] = m;
      const p = (stdout.match(/pinned:\s*(\d+)/) || [])[1];
      statusItem.text = `🧠 ${v}✓ ${u}? ${s}~`;
      statusItem.tooltip =
        `aidimag: ${v} verified, ${u} unverified, ${s} stale` +
        (p ? `, ${p} pinned 📌` : "") + ` — click for dashboard`;
      statusItem.backgroundColor =
        Number(s) > 0 ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
      statusItem.show();
    }
  } catch {
    statusItem.text    = "🧠 aidimag";
    statusItem.tooltip = "aidimag dashboard (dim CLI not reachable)";
    statusItem.show();
  }
}

// ─── Activate ──────────────────────────────────────────────────────────────

function activate(context) {
  // ── status bar items ──
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusItem.command = "aidimag.openDashboard";
  syncStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);

  // ── memory tree view ──
  memoryTreeProvider = new MemoryTreeProvider();
  const treeView = vscode.window.createTreeView("aidimag.memoryExplorer", {
    treeDataProvider: memoryTreeProvider,
    showCollapseAll:  true,
  });

  // ── status-based row coloring (mirrors IntelliJ) ──
  const memoryDecorations = vscode.window.registerFileDecorationProvider(
    new MemoryDecorationProvider(),
  );

  context.subscriptions.push(
    // existing commands
    vscode.commands.registerCommand("aidimag.openDashboard",  openDashboard),
    vscode.commands.registerCommand("aidimag.verify",          verify),
    vscode.commands.registerCommand("aidimag.sync",            sync),
    vscode.commands.registerCommand("aidimag.login",           login),
    vscode.commands.registerCommand("aidimag.pinMemory",       pinMemory),
    vscode.commands.registerCommand("aidimag.connectTickets",  connectTickets),
    vscode.commands.registerCommand("aidimag.showTicket",      showTicket),
    vscode.commands.registerCommand("aidimag.ticketBranch",    ticketBranch),
    // new tree commands
    vscode.commands.registerCommand("aidimag.addMemory",              addMemory),
    vscode.commands.registerCommand("aidimag.refreshMemoryExplorer",  refreshMemoryTree),
    vscode.commands.registerCommand("aidimag.openMemoryDetail",       openMemoryDetail),
    vscode.commands.registerCommand("aidimag.pinMemoryItem",          (item) => pinMemoryItem(item)),
    vscode.commands.registerCommand("aidimag.unpinMemoryItem",        (item) => pinMemoryItem(item)),
    vscode.commands.registerCommand("aidimag.refuteMemoryItem",       refuteMemoryItem),
    vscode.commands.registerCommand("aidimag.knowledgeSync",          () => runKnowledgeSync({ manual: true })),
    vscode.commands.registerCommand("aidimag.revealMemoryExplorer",   revealMemoryExplorer),
    // disposables
    statusItem, syncStatusItem, treeView, memoryDecorations,
  );

  // initial data load
  refreshStatusBar();
  refreshSyncStatus();
  refreshMemoryTree();
  scheduleAutoSync(context);
  setupKnowledgeWatcher(context);

  // initial background sync 5s after startup (if linked)
  setTimeout(async () => {
    if (cfg().autoSyncMinutes > 0 && (await isCloudLinked())) await sync({ silent: true });
  }, 5000);

  // reschedule when autoSyncMinutes changes
  vscode.workspace.onDidChangeConfiguration(
    (e) => {
      if (e.affectsConfiguration("aidimag.autoSyncMinutes")) scheduleAutoSync(context);
      if (e.affectsConfiguration("aidimag.knowledgeWatch"))  setupKnowledgeWatcher(context);
    },
    null, context.subscriptions,
  );

  // refresh on window focus
  vscode.window.onDidChangeWindowState(
    (s) => {
      if (s.focused) {
        refreshStatusBar();
        refreshSyncStatus();
        refreshMemoryTree();
      }
    },
    null, context.subscriptions,
  );
}

function deactivate() {
  if (uiProcess) { try { uiProcess.kill(); } catch { /* ignore */ } }
}

module.exports = { activate, deactivate };
