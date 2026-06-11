/**
 * aidimag VSCode extension — thin wrapper around the dim CLI + dashboard.
 *
 * Features:
 *  - "aidimag: Open Dashboard"  → spawns `dim ui` and embeds it in a webview panel
 *  - "aidimag: Verify Memories" → runs `dim verify -q`, warns if anything went STALE
 *  - "aidimag: Sync Team Memory"→ runs `dim sync`
 *  - Status bar: 🧠 memory counts, turns warning-colored when STALE memories exist
 *
 * Plain CommonJS on purpose: no build step, packageable with `vsce package` as-is.
 */

const vscode = require("vscode");
const { spawn, execFile } = require("child_process");
const http = require("http");

let uiProcess = null;
let statusItem = null;
let syncStatusItem = null;
let lastSync = null; // { when: Date, summary: string, ok: boolean }

function cfg() {
  const c = vscode.workspace.getConfiguration("aidimag");
  return {
    dim: c.get("dimPath") || "dim",
    port: c.get("uiPort") || 4517,
    autoSyncMinutes: c.get("autoSyncMinutes") ?? 10,
  };
}

function repoRoot() {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length ? folders[0].uri.fsPath : null;
}

function runDim(args, cwd) {
  const { dim } = cfg();
  return new Promise((resolve, reject) => {
    execFile(dim, args, { cwd, timeout: 120000 }, (err, stdout, stderr) => {
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
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

async function ensureUiServer() {
  const { dim, port } = cfg();
  const root = repoRoot();
  if (!root) throw new Error("Open a folder with an .aidimag/ directory first.");
  try {
    await fetchState(port);
    return port; // already running
  } catch {
    /* not running — start it */
  }
  uiProcess = spawn(dim, ["ui", "--no-open", "--port", String(port)], { cwd: root, stdio: "ignore" });
  uiProcess.on("error", () => { uiProcess = null; });
  // wait for it to come up
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      await fetchState(port);
      return port;
    } catch { /* retry */ }
  }
  throw new Error("dashboard server did not start — is the dim CLI installed?");
}

async function openDashboard() {
  try {
    const port = await ensureUiServer();
    const panel = vscode.window.createWebviewPanel(
      "aidimagDashboard",
      "🧠 aidimag",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.webview.html = `<!DOCTYPE html>
<html style="height:100%">
<body style="margin:0;height:100%;overflow:hidden">
  <iframe src="http://localhost:${port}" style="width:100%;height:100vh;border:0"></iframe>
</body>
</html>`;
  } catch (err) {
    vscode.window.showErrorMessage(`aidimag: ${err.message}`);
  }
}

async function verify() {
  const root = repoRoot();
  if (!root) return;
  try {
    const { stdout, exitCode } = await runDim(["verify", "-q"], root);
    if (exitCode === 2) {
      const pick = await vscode.window.showWarningMessage(
        "aidimag: some memories went STALE — the codebase changed under them.",
        "Open Dashboard"
      );
      if (pick) openDashboard();
    } else {
      vscode.window.setStatusBarMessage("aidimag: memories verified ✓", 4000);
    }
    refreshStatusBar();
  } catch (err) {
    vscode.window.showErrorMessage(`aidimag verify: ${err.message}`);
  }
}

async function sync(opts) {
  const silent = opts && opts.silent;
  const root = repoRoot();
  if (!root) return;
  syncStatusItem.text = "☁ syncing…";
  try {
    const { stdout } = await runDim(["sync"], root);
    lastSync = { when: new Date(), summary: stdout.trim(), ok: true };
    if (!silent) vscode.window.setStatusBarMessage(`aidimag: ${stdout.trim()}`, 6000);
    refreshStatusBar();
  } catch (err) {
    lastSync = { when: new Date(), summary: err.message, ok: false };
    // background failures stay quiet — the ☁ ✗ status item carries the signal
    if (!silent) vscode.window.showErrorMessage(`aidimag sync: ${err.message}`);
  }
  refreshSyncStatus();
}

// ---------------------------------------------------------------- auto-sync

let autoSyncTimer = null;

async function isCloudLinked() {
  const root = repoRoot();
  if (!root) return false;
  try {
    const { stdout } = await runDim(["cloud", "status"], root);
    return !/Not cloud-linked/i.test(stdout) && !/token:\s*MISSING/.test(stdout);
  } catch {
    return false;
  }
}

function scheduleAutoSync(context) {
  if (autoSyncTimer) {
    clearInterval(autoSyncTimer);
    autoSyncTimer = null;
  }
  const minutes = cfg().autoSyncMinutes;
  if (!minutes || minutes <= 0) return;
  autoSyncTimer = setInterval(async () => {
    if (await isCloudLinked()) await sync({ silent: true });
  }, minutes * 60 * 1000);
  context.subscriptions.push({ dispose: () => autoSyncTimer && clearInterval(autoSyncTimer) });
}

async function refreshSyncStatus() {
  const root = repoRoot();
  if (!root || !syncStatusItem) return;
  try {
    const { stdout } = await runDim(["cloud", "status"], root);
    if (/Not cloud-linked/i.test(stdout)) {
      syncStatusItem.text = "☁ not linked";
      syncStatusItem.tooltip = "aidimag: no team sync configured — click to open the dashboard (☁ Cloud) and link a server";
      syncStatusItem.command = "aidimag.openDashboard";
      syncStatusItem.backgroundColor = undefined;
      syncStatusItem.show();
      return;
    }
    const brain = (stdout.match(/brain:\s*(\S+)/) || [])[1] || "?";
    const tokenMissing = /token:\s*MISSING/.test(stdout);
    const lastTxt = lastSync
      ? `\nLast sync ${lastSync.when.toLocaleTimeString()}: ${lastSync.summary}`
      : "\nNot synced this session";
    if (tokenMissing) {
      syncStatusItem.text = `☁ ${brain} ⚠`;
      syncStatusItem.tooltip = `aidimag: linked to brain '${brain}' but NO TOKEN stored — click to open the dashboard and add one${lastTxt}`;
      syncStatusItem.command = "aidimag.openDashboard";
      syncStatusItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    } else if (lastSync && !lastSync.ok) {
      syncStatusItem.text = `☁ ${brain} ✗`;
      syncStatusItem.tooltip = `aidimag: last sync FAILED — click to retry${lastTxt}`;
      syncStatusItem.command = "aidimag.sync";
      syncStatusItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    } else {
      syncStatusItem.text = lastSync ? `☁ ${brain} ✓` : `☁ ${brain}`;
      syncStatusItem.tooltip = `aidimag: team brain '${brain}' — click to sync now${lastTxt}`;
      syncStatusItem.command = "aidimag.sync";
      syncStatusItem.backgroundColor = undefined;
    }
    syncStatusItem.show();
  } catch {
    syncStatusItem.hide(); // dim CLI not reachable — memory item already signals that
  }
}

async function refreshStatusBar() {
  const root = repoRoot();
  if (!root || !statusItem) return;
  try {
    const { stdout } = await runDim(["status"], root);
    const m = stdout.match(/VERIFIED=(\d+)\s+UNVERIFIED=(\d+)\s+STALE=(\d+)/);
    if (m) {
      const [, v, u, s] = m;
      statusItem.text = `🧠 ${v}✓ ${u}? ${s}~`;
      statusItem.tooltip = `aidimag: ${v} verified, ${u} unverified, ${s} stale — click for dashboard`;
      statusItem.backgroundColor =
        Number(s) > 0 ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
      statusItem.show();
    }
  } catch {
    statusItem.text = "🧠 aidimag";
    statusItem.tooltip = "aidimag dashboard (dim CLI not reachable)";
    statusItem.show();
  }
}

function activate(context) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusItem.command = "aidimag.openDashboard";
  syncStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);

  context.subscriptions.push(
    vscode.commands.registerCommand("aidimag.openDashboard", openDashboard),
    vscode.commands.registerCommand("aidimag.verify", verify),
    vscode.commands.registerCommand("aidimag.sync", sync),
    statusItem,
    syncStatusItem
  );

  refreshStatusBar();
  refreshSyncStatus();
  scheduleAutoSync(context);
  // initial background sync shortly after startup (if linked)
  setTimeout(async () => {
    if (cfg().autoSyncMinutes > 0 && (await isCloudLinked())) await sync({ silent: true });
  }, 5000);
  // reschedule when the user changes the interval setting
  vscode.workspace.onDidChangeConfiguration(
    (e) => e.affectsConfiguration("aidimag.autoSyncMinutes") && scheduleAutoSync(context),
    null,
    context.subscriptions
  );
  // re-check after git operations are likely (window focus)
  vscode.window.onDidChangeWindowState(
    (s) => {
      if (s.focused) {
        refreshStatusBar();
        refreshSyncStatus();
      }
    },
    null,
    context.subscriptions
  );
}

function deactivate() {
  if (uiProcess) {
    try { uiProcess.kill(); } catch { /* ignore */ }
  }
}

module.exports = { activate, deactivate };

