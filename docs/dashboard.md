# Web dashboard

The dashboard is a local web app for everything you'd otherwise do on the command line —
handy when you'd rather click than type.

## Open it

```sh
dim ui
```

This starts a small local server (default port **4517**) and opens your browser. Stop it with
`Ctrl+C` or `dim ui stop`.

```sh
dim ui -p 5000      # custom port
dim ui --no-open    # start the server without opening a browser
dim ui stop         # stop the server
dim ui stop -p 5000 # stop server on custom port
```

## What's inside

- **Memory browser** — every memory with its kind, status, confidence, scope, and evidence.
  Filter and search to find what you need.
- **Review queue** — approve, reword, or reject pending proposals from the commit miner and
  agent sessions.
- **Verify buttons** — re-run evidence on demand and watch statuses update.
- **Mine** — scan git history for new candidates.
- **Sync & cloud** — link to a team server, sync, and manage API keys.
- **Memory graph** — a force-directed visualization of memories and their links
  (supports / contradicts / refines), so you can see how knowledge connects.

## When to use the dashboard vs the CLI

| You want to… | Best surface |
|---|---|
| Quickly add a one-off memory | CLI (`dim remember`) |
| Skim and triage a big review queue | Dashboard |
| See how memories relate visually | Dashboard graph |
| Script or automate | CLI |
| Work without leaving your editor | [IDE extension](/ide-extensions) |

The dashboard, CLI, and IDE extensions all operate on the same local database, so changes in
one show up everywhere.

