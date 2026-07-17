# aiDimag for VSCode

Browse, add, and verify your repo's aiDimag memory without leaving VSCode — a Memory
Explorer tree, an embedded dashboard, and memory/sync health in the status bar.

## Features

### Memory Explorer

- **Tree view** of every memory, colour-coded by kind — including `GUARDRAIL` and `SKILL`.
- **Detail webview** per memory: claim, status, confidence, scope, and evidence.
- **Add Memory** (`aidimag: Add Memory`, ➕ in the view toolbar) — a guided flow. Choosing
  `GUARDRAIL` prompts for the enforcement level (`never` / `ask-first` / `always`); any
  memory can be pinned.
- **Context-menu actions** per memory: 📌 Pin / Unpin and ✗ Refute.
- **Refresh** button; the tree also auto-refreshes after changes.

### Status bar

- **🧠 memory health** — live counts (`12✓ 1? 0~`); turns warning-colored when any memory is
  STALE. Click → dashboard.
- **☁ sync status** — team-sync state at a glance:
  - `☁ not linked` → click opens the dashboard's Cloud dialog
  - `☁ mybrain` → linked; click syncs now
  - `☁ mybrain ✓` → synced this session (tooltip shows last result + time)
  - `☁ mybrain ⚠` (warning color) → linked but no token stored; click logs this device in
  - `☁ mybrain ✗` (error color) → last sync failed; click retries

  Refreshes on window focus and after every sync.
- **Auto-sync** — when the repo is cloud-linked (with a token), team memory syncs
  automatically every 10 minutes and once shortly after startup. Configure via
  `aidimag.autoSyncMinutes` (0 disables). Background failures never pop dialogs —
  the ☁ item just turns red.

### Knowledge inbox watcher

- Drop project docs (design notes, ADRs, style guides, runbooks) into the repo's
  `knowledge/` folder and the extension auto-runs `dim knowledge sync` to summarize
  them into **reviewable, pinned-on-approve** memory proposals — no terminal needed.
- Catches up on anything already waiting when the workspace opens, then watches for
  new drops. A notification points you to the dashboard's review queue when claims
  are produced.
- Toggle with `aidimag.knowledgeWatch` (on by default); the inbox folder follows
  `knowledge.folder` in `.aidimag/config.json`.

### Commands

- **aidimag: Add Memory** — guided add (kind, claim, guardrail level, pin).
- **aidimag: Pin/Unpin Memory** — quick-pick a memory to pin or unpin.
- **aidimag: Open Dashboard** — full dashboard (memory list, review queue, verify
  buttons, force-directed memory graph) in a webview panel. Starts `dim ui`
  automatically if it isn't running.
- **aidimag: Verify Memories** — runs `dim verify -q`; warns when the codebase
  changed under a memory.
- **aidimag: Sync Team Memory** — runs `dim sync` against your linked team server.
- **aidimag: Login (approve this device)** — runs `dim login` in an integrated
  terminal: shows the device code, opens the server's approval page in the
  browser, and saves the token once approved.
- **aidimag: Connect Ticketing App** — runs the interactive `dim ticket connect`
  flow in a terminal (Jira, GitHub Issues, Linear, your own HTTP middleware, or
  `remote` via the team sync server). The dashboard's 🎫 Tickets dialog offers
  the same configuration with a form UI, including the admin "share team
  credentials" panel.
- **aidimag: Show Ticket** — `dim ticket show <id>` with the id prefilled from
  the current branch name; output opens in a panel with a deep-link button.
- **aidimag: Create Ticket Branch** — `dim branch <id>`: fetches the ticket
  title when connected and checks out a convention-conforming branch
  (`feature/XXX-2100-serialize-token-refresh`).
- **aidimag: Sync Knowledge Inbox** — manually run `dim knowledge sync` to
  summarize dropped docs into review proposals.

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
cd vscode-extension && vsce package        # → aidimag-vscode-<version>.vsix
code --install-extension aidimag-vscode-<version>.vsix
```

Current version: **0.6.0** (a prebuilt `.vsix` is included in this folder).

## Author

**Anup Khanal**

