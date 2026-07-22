---
title: CLI Reference | Complete dim Command Guide
description: Complete reference for all dim CLI commands. Learn how to use dim init, remember, recall, verify, review, and all other aiDimag commands with examples.
head:
  - - meta
    - name: keywords
      content: dim CLI, aiDimag commands, dim reference, CLI documentation, dim init, dim remember, dim recall, dim verify, command line interface
  - - meta
    - property: og:title
      content: CLI Reference - Complete dim Command Guide
  - - meta
    - property: og:url
      content: https://aidimag.com/cli-reference
  - - link
    - rel: canonical
      href: https://aidimag.com/cli-reference
---

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

### `dim bootstrap`

Give a fresh repo an **instant starter brain**. Surveys the repo — README, docs, ADRs,
manifests (`package.json`, `Dockerfile`, CI workflows…), any existing `CLAUDE.md` /
`.cursorrules`, the directory shape, and the most-churned files in git history — and
LLM-extracts an initial set of falsifiable claims, each with a suggested `STATIC_CHECK`
where an honest one exists. Everything is queued for `dim review`; nothing becomes
active memory without you.

| Option | Meaning |
|---|---|
| `--force` | Re-run even if this repo was already bootstrapped (dedupe absorbs repeats) |

```sh
dim bootstrap        # right after dim init
dim review           # approve your starter brain
dim verify           # put the suggested checks to the test
```

Requires an LLM provider (local Ollama or `OPENAI_API_KEY`; see `AIDIMAG_LLM`).

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

### `dim gaps`

Show **knowledge gaps**: recent searches (from AI agents via MCP, or you via `dim recall`)
that returned *nothing*. Each one is a question your repo's brain couldn't answer — fill
the important ones with `dim remember`.

| Option | Meaning |
|---|---|
| `-d, --days <n>` | Look-back window in days (default 30) |
| `-n, --limit <n>` | Max entries (default 20) |
| `--clear` | Clear the search log after showing |

```sh
dim gaps
dim gaps -d 7 --clear
```

The top gaps also appear in the [session briefing](/guides/session-briefing), so agents
proactively ask you about them.

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
| `--trust` | Review evidence commands that arrived via **team sync** and approve them to run on this machine |
| `-q, --quiet` | Only print changes (used by git hooks) |

Exits with code `2` if anything went stale (useful in scripts/CI).

**Evidence trust gate**: executable evidence (`STATIC_CHECK` / `TEST_RESULT` /
`EXEC_TRACE`) runs shell commands — including automatically on every `git pull` via
hooks. Commands you author locally (or approve via `dim review`) are trusted; commands
that arrive via team sync are **skipped until you inspect and approve them** with
`dim verify --trust`. A teammate's (or attacker's) memory can never become code
execution on your machine without your sign-off.

**Staleness triggers capture**: when a memory newly flips to STALE, a recovery proposal
is drafted in the review queue — decide whether the code drifted (fix + re-verify) or
the claim is outdated (update/refute).

```sh
dim verify
dim verify --deep
dim verify -i 4f3a9c21
dim verify --trust     # after a sync brought in new evidence commands
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
| `--full` | Rescan the entire history instead of just new commits (with `--prs`: rescan all merged PRs) |
| `--llm` | **Deep mining**: the LLM reads each commit's message *and diff* and synthesizes falsifiable claims + suggested checks (needs Ollama/`OPENAI_API_KEY`; slower, much higher quality than the keyword heuristics) |
| `--prs` | **PR mining**: mine merged GitHub PRs — descriptions and *review comments*, where reviewers state the unwritten rules ("we never…", "this caused the outage…"). Needs the [`gh` CLI](https://cli.github.com) (authenticated) and an LLM provider. Proposals carry the merge commit as evidence (source `pr-miner`) |
| `--quiet` | Minimal output (used by the post-commit hook) |

```sh
dim mine
dim mine --full
dim mine --llm --full   # highest-quality pass over the whole history
dim mine --prs          # newly merged PRs + review threads since the last run
```

### `dim harvest`

Harvest durable facts **you typed into AI chats** into the review queue. Reads the local
Claude Code session transcripts for this repo (`~/.claude/projects/<repo-slug>/*.jsonl`),
extracts falsifiable claims from *your* messages with the configured LLM
(OpenAI/Ollama — same auto-detection as knowledge ingestion), and queues them as proposals
(source `harvest:claude-code`) with `HUMAN_ATTESTED` evidence.

**Privacy:** local-only and opt-in by invocation. Secret-looking lines (API keys, tokens,
passwords) are redacted *before* anything reaches the LLM. Nothing becomes active memory
without `dim review`.

| Option | Meaning |
|---|---|
| `--all` | Rescan every session (ignore the cursor; dedupe absorbs repeats) |
| `--install-hook` | Add a Claude Code `SessionEnd` hook (`.claude/settings.json`) so every session is harvested automatically when it closes |
| `-q, --quiet` | Only speak up when proposals are queued (hook mode) |

```sh
dim harvest                  # scan sessions since the last run
dim harvest --all            # rescan everything
dim harvest --install-hook   # automate it per-session
```

Cursor/Copilot chat harvesting is planned; for those tools the `context_note`
[MCP tool](/mcp) captures user-stated facts live instead.

### `dim review [action] [id]`

Review the proposal queue. With no action in a terminal, it opens a conversational
walkthrough (keep / reword / drop / skip). Scriptable actions: `list`, `approve`, `reject`.

The queue is **auto-triaged**: every proposal gets a 0–1 score from local signals —
machine-checkable evidence, source trust (user-stated > curated docs > miners), concrete
scope — and is *penalized* for similarity to claims you previously rejected (what you
drop teaches the queue) or to existing memory. The walkthrough and `list` show the best
candidates first, with the score and its reasons.

| Option | Meaning |
|---|---|
| `--min-score <s>` | With `approve all`: only approve proposals triaged at or above this score |

```sh
dim review                             # interactive walkthrough, best-first
dim review list
dim review approve 1caf9d77
dim review approve all --min-score 0.7 # batch-approve the confident ones
dim review reject all
```

### `dim knowledge <sync|watch|status|list>`

Manage the [knowledge inbox](/guides/knowledgebase): summarize project docs dropped into the
`knowledge/` folder into reviewed, pinned-on-approve memory proposals. `sync` is the default.
Text formats plus **PDF and DOCX** are supported (text is extracted locally before
summarization).

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

### `dim ui [action]`

Manage the local web dashboard (memory browser, review queue, verify, graph).

| Argument | Meaning |
|---|---|
| `action` | `start` (default) or `stop` |

| Option | Meaning |
|---|---|
| `-p, --port <n>` | Port (default 4517) |
| `--no-open` | Don't open the browser automatically (start only) |

```sh
dim ui              # start the dashboard
dim ui start        # explicit start
dim ui -p 5000      # start on custom port
dim ui stop         # stop the server
dim ui stop -p 5000 # stop server on custom port
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

Device-code login: approve this machine in the browser; the token is saved to `.aidimag/config.json` (per-project). Requires the repo to be linked first with `dim cloud link`.

```sh
# First link the repo (without token)
dim cloud link --server https://cloud.aidimag.com --brain myrepo-abc123

# Then login via browser
dim login

# Logout removes the token from config
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
| `AIDIMAG_LLM` | Text-LLM provider for mining/harvest/bootstrap/knowledge: `auto` (default) / `openai` / `ollama` / `off` |
| `OPENAI_API_KEY` | Enables OpenAI embeddings + text extraction |
| `AIDIMAG_OPENAI_MODEL`, `AIDIMAG_OLLAMA_MODEL`, `AIDIMAG_OLLAMA_URL` | Customize embedding providers |
| `AIDIMAG_AUTO_SYNC` | Set to `off` to disable debounced auto-sync after writes |
| `AIDIMAG_API_KEY` | Auth token for sync (alternative to the credentials file) |
| `AIDIMAG_SYNC_TOKEN`, `AIDIMAG_ADMIN_TOKEN` | Server/admin tokens for `dim serve` / `dim keys` |
| `AIDIMAG_DEBUG` | Set to `1` to print errors from best-effort paths (auto-sync, embeddings, LLM mining skips, gap logging) that are normally silent |

