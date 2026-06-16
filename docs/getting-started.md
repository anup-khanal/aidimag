# Install & setup

This page gets aiDimag running in your repository.

## Prerequisites

- **Node.js 18 or newer** (`node --version` to check).
- A **git repository** — aiDimag stores memory per repo and installs git hooks.
- *(Optional)* An embedding provider for semantic search: an `OPENAI_API_KEY`, or a local
  [Ollama](https://ollama.com) install. Everything works without one (keyword search only).

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

## Connect your AI agent (optional but recommended)

If you use an MCP-capable agent, wire up the server so it can read and write memory live.
See **[MCP integration](/mcp)** for per-tool instructions (Claude Code, Cursor, Copilot).

If your tool just reads a context file, generate one instead:

```sh
dim generate-context          # writes CLAUDE.md
dim generate-context -f all   # CLAUDE.md + .cursorrules + copilot-instructions
```

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
**[5-minute quick start](/quickstart)**.

