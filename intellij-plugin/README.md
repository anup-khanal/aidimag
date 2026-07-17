# aiDimag for IntelliJ IDEA

IntelliJ plugin that mirrors the VSCode extension with JetBrains-native UI. Current
version: **1.0.0** (built artifacts under `build/distributions/`).

## Features

- **Memory Explorer tool window** (`aidimag`) — a native, colour-coded list of every memory:
  - kinds incl. `GUARDRAIL` and `SKILL`; the guardrail enforcement level (🚫 never / 🤚
    ask-first / ✅ always) is shown inline in the list and detail pane.
  - filter by kind and status, plus a search box.
  - a detail pane with claim, status, confidence, pinned state, scope, and evidence.
  - toolbar actions: **Add Memory**, **Verify All**, **Mine Commits**.
  - context menu: **Pin/Unpin**, **Edit**, **Verify This**, **Verify All**, **Refute**.
- **Add Memory dialog** — comprehensive form with kind, claim, paths, symbols, evidence, pin, 
  and guardrail-level selector for `GUARDRAIL` memories.
- **Edit Memory dialog** — edit claim, kind, guardrail level, add/remove evidence.
- **Embedded dashboard tab** (JCEF) — the full `dim ui` dashboard inside the IDE.
- **Status-bar widgets** — 🧠 memory health and ☁ sync status, with background auto-sync.
- **Knowledge inbox watcher** — drop docs (design notes, ADRs, style guides, runbooks)
  into the repo's `knowledge/` folder and the plugin auto-runs `dim knowledge sync` to
  summarize them into reviewable, pinned-on-approve memory proposals. Catches up on
  open, then watches for new drops; toggle in Settings.
- **Actions in Tools > aiDimag**:
  - Open Dashboard
  - Verify Memories
  - Sync Team Memory
  - Sync Knowledge Inbox
  - Login (approve this device)
  - Connect Ticketing App
  - Show Ticket
  - Create Ticket Branch
- **Settings** (**Settings > Tools > aiDimag**) — CLI path, UI port, auto-sync interval,
  and the knowledge-inbox watcher toggle.

## Requirements

The `dim` CLI must be installed (`npm i -g aidimag`) and the project must contain an
`.aidimag/` directory (`dim init`).

> **macOS PATH note:** JetBrains IDEs launched from Finder/Toolbox can run with a minimal
> `PATH`. The plugin inherits your console environment to find `dim`; if you still see
> "cannot run program dim", install `dim` globally so GUI apps can locate it.

## Dev run

```bash
cd intellij-plugin
./gradlew runIde
```

## Build plugin zip

```bash
cd intellij-plugin
./gradlew buildPlugin
```

The built artifact lands under `intellij-plugin/build/distributions/`.

## Author

**Anup Khanal**

