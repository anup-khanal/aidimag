# Install & setup

This page gets aiDimag running in your repository.

## Prerequisites

- **Node.js 18 or newer** (`node --version` to check).
- A **git repository** — aiDimag stores memory per repo and installs git hooks.
- *(Optional)* An embedding provider for semantic search: an `OPENAI_API_KEY`, or a local
  [Ollama](https://ollama.com) install. Everything works without one (keyword search only).
- *(Optional)* A text-LLM provider (same options: OpenAI key or local Ollama) unlocks the
  smartest capture features: `dim bootstrap`, `dim mine --llm`, and session harvesting.

## The whole setup at a glance

```sh
dim init                # 1. create the memory store + git hooks
dim bootstrap           # 2. (optional) seed memory from your codebase
dim generate-context    # 3. feed your AI tools (or wire up MCP)
dim status              # 4. confirm it's alive
```

Each step is explained below.

## Install

::: tip Which command do I run?
aiDimag installs **two identical commands**: `dim` (short, day-to-day) and `aidimag`
(explicit). Use whichever you like — this documentation uses `dim`.
:::

### Option A — from npm (once published)

```sh
npm install -g aidimag
dim --version
```

### Option B — run without installing

```sh
npx aidimag init
```

### Option C — from source (current repo)

```sh
git clone <repo-url> aidimag
cd aidimag
npm install
npm run build
npm link        # makes `dim` and `aidimag` available globally
```

## Initialize a repo

From inside any git repository:

```sh
dim init
```

This:

1. Creates `.aidimag/` with the memory database and a `config.json`.
2. Adds the database files to your `.gitignore` (your local memory stays private).
3. Installs additive git hooks (re-verify on pull, mine on commit, etc.).
4. Prints an MCP config snippet you can paste into your agent.

You'll see something like:

```
Initialized aidimag in /path/to/your-repo/.aidimag
Installed git hooks: post-merge, post-checkout, post-rewrite, post-commit (re-verify on pull/checkout)

Add the MCP server to your agent config, e.g. for Claude Code (.mcp.json):
{
  "mcpServers": {
    "aidimag": { "command": "npx", "args": ["-y", "aidimag", "mcp"], "env": { "AIDIMAG_REPO": "/path/to/your-repo" } }
  }
}
```

## Seed your memory (optional but recommended)

A brand-new brain is empty. If you have an LLM provider available (Ollama running, or
`OPENAI_API_KEY` set), let aiDimag read your repo once and propose starter memories —
architecture, conventions, invariants — from your README, configs, and directory layout:

```sh
dim bootstrap
```

Nothing is saved automatically: everything lands in the **review queue**, and you approve
or drop each proposal with `dim review`. You can also mine your git history:

```sh
dim mine --full        # keyword heuristics, fast, no LLM needed
dim mine --llm --full  # LLM reads commits + diffs — slower, much higher quality
```

## Connect your AI agent (optional but recommended)

If you use an MCP-capable agent, wire up the server so it can read and write memory live.
See **[MCP integration](/mcp)** for per-tool instructions (Claude Code, Cursor, Copilot).

If your tool just reads a context file (Copilot, Cursor, Windsurf, etc.), generate one:

```sh
dim generate-context --format all --auto
```

This writes `CLAUDE.md`, `.cursorrules`, `.windsurfrules`, `AGENTS.md`, and `.github/copilot-instructions.md` with all verified/unverified memories. The `--auto` flag enables **automatic regeneration** — these files will stay fresh after `dim review`, `dim verify`, `dim sync`, etc.

::: warning Auto-regeneration is opt-in
Without `--auto`, you must manually run `dim generate-context` after approving new memories. Use `--auto` to keep context files in sync automatically.
:::

## Set up semantic search (optional)

By default search is keyword-only. To enable semantic recall:

- **OpenAI:** `export OPENAI_API_KEY=sk-...`
- **Ollama:** install and run it locally (auto-detected).

Then build the index once:

```sh
dim reindex
```

The behavior is controlled by `AIDIMAG_EMBEDDINGS` (`auto` by default — OpenAI if a key is
set, else Ollama if running, else keyword-only).

## Verify it's working

```sh
dim remember "All DB access goes through src/db/store.ts" -k CONVENTION -p src/db
dim status
dim recall db access
```

If `dim status` shows your memory, you're set. Continue to the
**[5-minute quick start](/quickstart)** or **[Cloud sync TLDR](/cloud-quickstart)** if you're
using aiDimag Cloud.

## If something misbehaves

aiDimag keeps best-effort features (auto-sync, embeddings, LLM mining) silent when they
fail, so they never interrupt your work. To see what's actually happening, run any
command with debug output:

```sh
AIDIMAG_DEBUG=1 dim <command>
```

More fixes in the **[FAQ & troubleshooting](/faq)**.

