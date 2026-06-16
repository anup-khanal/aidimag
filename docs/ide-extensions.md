# IDE extensions

aiDimag has native extensions for **VSCode** and **IntelliJ IDEA** so you can browse, add,
and verify memory without leaving your editor. Both shell out to the same `dim` CLI, so they
always behave consistently with the terminal.

::: tip Prerequisite
Install the `dim` CLI and run `dim init` in your repo first. The extensions call `dim` under
the hood and need it on your `PATH`.
:::

## VSCode extension

Located in `vscode-extension/`. A prebuilt `.vsix` is included.

**Features**

- **Memory Explorer** — a tree view of all memories, colour-coded by kind (including
  guardrails and skills), with a detail webview for each.
- **Add memory** — a guided flow; for guardrails it prompts for the enforcement level
  (never / ask-first / always).
- **Status bar** — a 🧠 indicator of memory health that turns a warning colour when
  memories go stale.
- **Knowledge inbox watcher** — drop docs into the repo's `knowledge/` folder and the
  extension auto-runs `dim knowledge sync` to summarize them into reviewable, pinned-on-approve
  proposals (toggle with `aidimag.knowledgeWatch`; also available as the
  *aidimag: Sync Knowledge Inbox* command). See [Knowledgebase](/guides/knowledgebase).
- **Commands** — verify, sync, sync knowledge, and the embedded dashboard.

**Install**

- From the prebuilt package: `code --install-extension vscode-extension/aidimag-vscode-*.vsix`
- To develop: open `vscode-extension/` and press `F5`; package with `vsce package`.

## IntelliJ plugin

Located in `intellij-plugin/`. Works in IntelliJ IDEA (and other JetBrains IDEs on the same
platform version).

**Features**

- **Memory Explorer tool window** — colour-coded nodes, a detail pane, search/filter by kind
  and status, and the guardrail enforcement level shown inline.
- **Add memory dialog** — with a guardrail-level selector that appears when you choose the
  guardrail kind.
- **Toolbar actions** — add, verify all, mine.
- **Embedded dashboard tab** (JCEF) and **status-bar widgets** for memory and sync health.
- **Knowledge inbox watcher** — drop docs into the repo's `knowledge/` folder and the plugin
  auto-runs `dim knowledge sync` (toggle in Settings; also the *Sync Knowledge Inbox* action).
- **Auto-sync** in the background.

Find the actions under **Tools → aiDimag**.

**Install**

- From the prebuilt zip in `intellij-plugin/build/distributions/`:
  Settings → Plugins → ⚙ → *Install Plugin from Disk…*
- To develop: `./gradlew runIde` from `intellij-plugin/`.

::: warning macOS PATH note
JetBrains IDEs launched from Finder/Toolbox sometimes run with a minimal `PATH` that doesn't
include your global npm bin directory, so `dim` can't be found. The plugin works around this
by inheriting your console environment; if you still hit "cannot run program dim", make sure
`dim` is installed globally (`npm link` or `npm i -g aidimag`).
:::

## Which surfaces do what?

| Task | CLI | VSCode | IntelliJ |
|---|---|---|---|
| Browse memories | `dim log` / `dim recall` | Memory Explorer | Memory Explorer |
| Add a memory | `dim remember` | Add flow | Add dialog |
| Verify | `dim verify` | command | toolbar |
| Review proposals | `dim review` | dashboard | dashboard |
| Ingest knowledge docs | `dim knowledge sync` | inbox watcher | inbox watcher |
| Full dashboard | `dim ui` | webview | JCEF tab |

All three read and write the same `.aidimag/memory.db`, so you can mix and match freely.

