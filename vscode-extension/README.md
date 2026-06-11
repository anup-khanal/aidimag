# aidimag for VSCode

Embeds the aidimag repo-brain dashboard inside VSCode and surfaces memory health
in the status bar.

## Features

- **🧠 status bar item** — live counts (`12✓ 1? 0~`); turns warning-colored when
  any memory is STALE. Click → dashboard.
- **☁ sync status item** — team-sync state at a glance:
  - `☁ not linked` → click opens the dashboard's Cloud dialog
  - `☁ mybrain` → linked; click syncs now
  - `☁ mybrain ✓` → synced this session (tooltip shows last result + time)
  - `☁ mybrain ⚠` (warning color) → linked but no token stored
  - `☁ mybrain ✗` (error color) → last sync failed; click retries
  Refreshes on window focus and after every sync.
- **Auto-sync** — when the repo is cloud-linked (with a token), team memory syncs
  automatically every 10 minutes and once shortly after startup. Configure via
  `aidimag.autoSyncMinutes` (0 disables). Background failures never pop dialogs —
  the ☁ item just turns red.
- **aidimag: Open Dashboard** — full dashboard (memory list, review queue, verify
  buttons, force-directed memory graph) in a webview panel. Starts `dim ui`
  automatically if it isn't running.
- **aidimag: Verify Memories** — runs `dim verify -q`; warns when the codebase
  changed under a memory.
- **aidimag: Sync Team Memory** — runs `dim sync` against your linked team server.

## Requirements

The `dim` CLI must be installed (`npm i -g aidimag`) and the workspace must contain
an `.aidimag/` directory (`dim init`). Set `aidimag.dimPath` if `dim` isn't on PATH.

## Try it without packaging

1. Open this folder in VSCode
2. Press **F5** (Run Extension) — launches an Extension Development Host
3. In the dev host, open a repo that has `.aidimag/`

## Package for install/marketplace

```sh
npm i -g @vscode/vsce
cd vscode-extension && vsce package        # → aidimag-vscode-0.1.0.vsix
code --install-extension aidimag-vscode-0.1.0.vsix
```

