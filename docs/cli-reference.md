# CLI reference

Every `dim` command, with plain-English descriptions and examples. The `dim` and `aidimag`
commands are identical; this page uses `dim`.

Run `dim --help` or `dim <command> --help` any time for the built-in version.

[[toc]]

## Memory basics

### `dim init`

Initialize aiDimag in the current repo: creates `.aidimag/`, gitignores the database,
creates the `knowledge/` inbox, installs git hooks, and prints an MCP config snippet.

```sh
dim init
```

### `dim remember <claim>`

Store a memory directly (you are the author, so it's saved without review).

| Option | Meaning |
|---|---|
| `-k, --kind <kind>` | Kind (default `GOTCHA`). One of decision/convention/gotcha/failed_approach/architecture/invariant/todo_context/guardrail/skill |
| `-p, --path <paths...>` | File paths the memory applies to |
| `-s, --symbol <symbols...>` | Symbols (functions/classes) it applies to |
| `-e, --evidence <spec...>` | Evidence as `TYPE:payload` (repeatable) |
| `-g, --guardrail-level <level>` | For `GUARDRAIL`: `never` / `ask-first` / `always` |
| `--pin` | Pin it: exempt from time decay (evidence can still mark it stale) |

```sh
# A convention with a self-checking command
dim remember "Routes live in src/routes and are registered in src/app.ts" \
  -k CONVENTION -p src/routes -e "STATIC_CHECK:test -d src/routes"

# A guardrail
dim remember "Never log raw access tokens" -k GUARDRAIL -g never

# A pinned architectural decision
dim remember "We use last-writer-wins, not CRDTs, for sync" -k DECISION --pin
```

### `dim recall [query...]`

Search memories — hybrid keyword + semantic (when embeddings are configured).

| Option | Meaning |
|---|---|
| `-p, --path <paths...>` | Restrict to memories scoped to these paths |
| `-k, --kind <kind>` | Filter by kind |
| `-n, --limit <n>` | Max results (default 10) |
| `--all` | Include refuted memories |

```sh
dim recall token refresh
dim recall -p src/payments
dim recall -k GUARDRAIL
```

### `dim status`

Summary of the store: totals by status and kind, pinned count, and pending proposals.

```sh
dim status
```

### `dim log`

Show recent memories.

```sh
dim log -n 20
```

### `dim refute <id>`

Mark a memory **refuted** (false). Unlike `forget`, it's kept as negative knowledge.

```sh
dim refute 4f3a9c21
dim refute 4f3a9c21 -s 9b2e10aa   # superseded by a newer memory
```

### `dim forget <id>`

Delete a memory permanently. Prefer `refute` so the "we no longer believe this" history is
kept.

```sh
dim forget 4f3a9c21
```

### `dim pin <id>` / `dim unpin <id>`

Pin (exempt from time decay) or unpin a memory. See [Pinned memories](/guides/pinned).

```sh
dim pin 4f3a9c21
dim unpin 4f3a9c21
```

## Verification & search index

### `dim verify`

Re-run evidence and update statuses.

| Option | Meaning |
|---|---|
| `-i, --id <ids...>` | Only verify specific memory ids (prefix ok) |
| `-d, --deep` | Also run expensive evidence (tests, exec traces) |
| `-q, --quiet` | Only print changes (used by git hooks) |

Exits with code `2` if anything went stale (useful in scripts/CI).

```sh
dim verify
dim verify --deep
dim verify -i 4f3a9c21
```

### `dim reindex`

Build or refresh semantic embeddings for all memories (needed after enabling/switching an
embedding provider).

```sh
dim reindex
```

## Capture & review

### `dim mine`

Mine git history for memory candidates (queued as proposals, never auto-saved).

| Option | Meaning |
|---|---|
| `--full` | Rescan the entire history instead of just new commits |
| `--quiet` | Minimal output (used by the post-commit hook) |

```sh
dim mine
dim mine --full
```

### `dim review [action] [id]`

Review the proposal queue. With no action in a terminal, it opens a conversational
walkthrough (keep / reword / drop / skip). Scriptable actions: `list`, `approve`, `reject`.

```sh
dim review                  # interactive walkthrough
dim review list
dim review approve 1caf9d77
dim review approve all
dim review reject all
```

### `dim knowledge <sync|watch|status|list>`

Manage the [knowledge inbox](/guides/knowledgebase): summarize project docs dropped into the
`knowledge/` folder into reviewed, pinned-on-approve memory proposals. `sync` is the default.

| Subcommand | What it does |
|---|---|
| `sync` | Process the inbox now — summarize new docs into proposals (review with `dim review`) |
| `watch` | Foreground watcher that processes the inbox whenever a doc is dropped (`-d, --debounce <ms>`) |
| `status` | Pending / unsupported / skipped / processed counts |
| `list` | Processed docs and the memories they produced |

```sh
dim knowledge sync
dim knowledge status
dim knowledge watch
```

## Context for AI tools

### `dim generate-context`

Render trusted memory into static context files for non-MCP tools.

| Option | Meaning |
|---|---|
| `-f, --format <format>` | `claude` (default), `cursorrules`, `copilot`, or `all` |
| `--auto` | Persist auto-regeneration: refresh after verify/review/sync |
| `--no-auto` | Disable auto-regeneration |

```sh
dim generate-context
dim generate-context -f all
dim generate-context --auto       # keep it fresh automatically
```

See [Generating context files](/guides/generate-context).

### `dim check`

Pre-commit contradiction check: scan the staged diff against active memories and guardrails.

| Option | Meaning |
|---|---|
| `-r, --ref <ref>` | Diff against a ref instead of the staged index (e.g. `HEAD~1`) |
| `--block` | Exit 1 on a hard violation (default: warn only) |
| `--pre-commit` | Hook mode: behavior follows `preCommitCheck` in config (no-op if unset) |

```sh
dim check
dim check --block
dim check -r HEAD~1
```

See [Pre-commit checks](/guides/dim-check).

### `dim brief`

Print a session-start briefing: in-scope memory, guardrails, stale warnings, and questions
to ask before coding. See [Session briefings](/guides/session-briefing).

```sh
dim brief
```

## Tickets & branches

### `dim ticket <connect|status|show|share|branch-rule>`

Connect a ticketing system (Jira, GitHub Issues, Linear, a custom HTTP provider, or the team
sync server) so proposals carry ticket context. See [Connecting tickets](/guides/tickets).

```sh
dim ticket connect
dim ticket status
dim ticket show XXX-2100
```

### `dim branch <ticket-id>`

Create a convention-conforming branch for a ticket (fetches the title for the slug when a
provider is connected).

```sh
dim branch XXX-2100 -p feature
```

## Team sync & cloud

### `dim ui`

Open the local web dashboard (memory browser, review queue, verify, graph).

| Option | Meaning |
|---|---|
| `-p, --port <n>` | Port (default 4517) |
| `--no-open` | Don't open the browser automatically |

```sh
dim ui
dim ui -p 5000
```

### `dim serve`

Run a self-hosted team sync server.

```sh
dim serve --token <shared-secret> --db ./team-sync.db --port 8787
```

### `dim cloud <link|status|unlink>`

Bind the repo to a sync server brain.

```sh
dim cloud link --server http://your-server:8787 --brain myrepo --token <secret>
dim cloud status
dim cloud unlink
```

### `dim sync`

Push/pull memory with the linked team server (also runs automatically after writes).

```sh
dim sync
```

### `dim login` / `dim logout`

Device-code login: approve this machine in the browser; the token is saved locally.

```sh
dim login
dim logout
```

### `dim keys <create|list|revoke>`

Mint or revoke brain-scoped API keys (requires the admin token).

```sh
AIDIMAG_ADMIN_TOKEN=... dim keys create --brain myrepo --label alice
dim keys list --brain myrepo
dim keys revoke --key aidimag_sk_...
```

See [Team sync](/guides/team-sync).

## Agent integration

### `dim mcp`

Run the MCP server over stdio. Usually invoked by your agent's config, not by hand. See
[MCP integration](/mcp).

```sh
dim mcp
```

## Environment variables

| Variable | Purpose |
|---|---|
| `AIDIMAG_REPO` | Repo root the MCP server / CLI should use |
| `AIDIMAG_EMBEDDINGS` | `auto` (default) / `openai` / `ollama` / `off` |
| `OPENAI_API_KEY` | Enables OpenAI embeddings |
| `AIDIMAG_OPENAI_MODEL`, `AIDIMAG_OLLAMA_MODEL`, `AIDIMAG_OLLAMA_URL` | Customize embedding providers |
| `AIDIMAG_AUTO_SYNC` | Set to `off` to disable debounced auto-sync after writes |
| `AIDIMAG_API_KEY` | Auth token for sync (alternative to the credentials file) |
| `AIDIMAG_SYNC_TOKEN`, `AIDIMAG_ADMIN_TOKEN` | Server/admin tokens for `dim serve` / `dim keys` |

