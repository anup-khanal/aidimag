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
| `dim verify` | Re-run evidence, update statuses (`--deep` for tests/exec, `-q` for hooks, `-i <id>` to scope; exit 2 if anything went stale) |
| `dim log` | Recent memories |
| `dim forget <id>` | Delete a memory |
| `dim ui` | Local web dashboard — memory list, review queue, verify buttons, visual graph (`-p <port>`, default 4517) |
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

## Verification (the wedge)

Memories are falsifiable claims; `dim verify` re-runs their evidence against the current repo state:

- **`STATIC_CHECK`** — payload is a shell command; exit 0 means the claim holds *(cheap tier)*
- **`COMMIT_REF`** — anchor commit must exist and be an ancestor of HEAD; `sha:path1,path2` also fails if anchored files changed since *(cheap tier)*
- **`TEST_RESULT`** — payload is a test command, run with `CI=1`; exit 0 = PASS *(deep tier: `--deep`)*
- **`EXEC_TRACE`** — payload is `command :: expected-output-regex`; the claim holds iff observed output matches *(deep tier: `--deep`)*
- **`HUMAN_ATTESTED`** — verifies once on attestation, then decays fastest (14-day half-life)

**Lifecycle**: any evidence FAILs → **STALE** (confidence floored to 0.20); all evidence PASSes → **VERIFIED** (confidence +0.10, capped 0.95). A recovered memory re-earns trust gradually. **REFUTED** is never automatic — it stays a deliberate human/agent action.

**Confidence decay**: memories that can't be machine-re-verified decay exponentially (45-day half-life; 14 days for human-attested). A VERIFIED memory whose confidence decays below 0.35 is demoted to UNVERIFIED — trust expires without re-confirmation.

`dim init` installs `post-merge` / `post-checkout` / `post-rewrite` git hooks (additive, never clobbers existing hooks) so cheap-tier re-verification runs on every pull, branch switch, and rebase. Run `dim verify --deep` on a schedule (or in CI) for the expensive tier.

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

**Tools**: `memory_search`, `memory_get_for_files`, `memory_write`, `memory_propose`, `memory_verify`, `memory_refute`, `memory_status`, `proposals_pending`
**Prompt**: `session_end_extraction` — run at session end to capture durable learnings
**Resource**: `aidimag://digest` — repo memory digest for session bootstrapping

## Status

Phase 1 (skeleton) ✅ — MCP server, SQLite + FTS5 store, `dim` CLI.
Phase 2 (capture) ✅ — commit miner, session-end extraction prompt, proposal queue with human review.
Phase 3 (verification v1) ✅ — STATIC_CHECK + COMMIT_REF runners, status lifecycle, git-hook re-verification.
Phase 4 (pilot) ✅ — piloted on a real repo; status-aware retrieval ranking (see PILOT.md).
Phase 5 (verification v2) ✅ — TEST_RESULT + EXEC_TRACE deep tier, confidence decay with auto-demotion.
Web dashboard ✅ — `dim ui`: memory browser, proposal review, verify buttons, force-directed memory graph.
Next: Phase 6 — team mode (shared store sync, contradiction resolution); npm publish; IDE extensions (can embed the dashboard in a webview).

