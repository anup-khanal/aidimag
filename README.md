# aidimag

> Persistent, verified memory for AI coding agents. CLI: **`dim`** (*dimag* = brain).

aidimag gives any MCP-compatible agent (Claude Code, Cursor, Copilot, …) a memory of your
codebase that survives across sessions — decisions, conventions, gotchas, failed approaches —
stored as **falsifiable claims with grounding evidence** in `.aidimag/` next to your code.

See [DESIGN.md](./DESIGN.md) for the full design.

## Quick start

```sh
npm install && npm run build

# in any git repo:
dim init
dim remember "All DB access goes through src/db/store.ts" -k INVARIANT -p src/db \
  -e "STATIC_CHECK:grep -rL better-sqlite3 src --include=*.ts"
dim recall db access
dim status
```

## CLI

| Command | Description |
| --- | --- |
| `dim init` | Initialize `.aidimag/` in the current repo |
| `dim remember "<claim>"` | Store a memory (`-k` kind, `-p` paths, `-e TYPE:payload` evidence) |
| `dim recall <query>` | Search memories (`-p` to scope to files) |
| `dim status` | Memory store summary (incl. pending proposals) |
| `dim mine` | Mine git history for memory candidates (`--full` to rescan all) |
| `dim review [approve\|reject] [id\|all]` | Review the proposal queue |
| `dim verify` | Re-run evidence, update statuses *(Phase 3)* |
| `dim log` | Recent memories |
| `dim forget <id>` | Delete a memory |
| `dim mcp` | Run the MCP server (stdio) |

## Capture pipeline (Phase 2)

Nothing enters active memory without human approval:

1. **Commit miner** — `dim mine` scans git history (incrementally, cursor-tracked) for
   decision/gotcha/failed-approach signals in commit messages, anchors each candidate with
   `COMMIT_REF` evidence, and queues it as a proposal.
2. **Session-end extraction** — agents invoke the `session_end_extraction` MCP prompt and
   call `memory_propose` with falsifiable, evidence-backed claims.
3. **Review** — `dim review` lists the queue; `approve` materializes a real memory,
   `reject` discards (dedupe prevents re-proposal of the same claim).

## MCP server

Add to your agent config (e.g. `.mcp.json` for Claude Code):

```json
{
  "mcpServers": {
    "aidimag": {
      "command": "npx",
      "args": ["-y", "aidimag", "mcp"],
      "env": { "AIDIMAG_REPO": "/path/to/your/repo" }
    }
  }
}
```

**Tools**: `memory_search`, `memory_get_for_files`, `memory_write`, `memory_propose`, `memory_refute`, `memory_status`, `proposals_pending`
**Prompt**: `session_end_extraction` — run at session end to capture durable learnings
**Resource**: `aidimag://digest` — repo memory digest for session bootstrapping

## Status

Phase 1 (skeleton) ✅ — MCP server, SQLite + FTS5 store, `dim` CLI.
Phase 2 (capture) ✅ — commit miner, session-end extraction prompt, proposal queue with human review.
Next: Phase 3 — evidence runners (STATIC_CHECK + COMMIT_REF) + git-hook re-verification.

