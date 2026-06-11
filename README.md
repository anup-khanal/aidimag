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
| `dim recall <query>` | Search memories — hybrid keyword + semantic (`-p` to scope to files) |
| `dim reindex` | Build/refresh semantic embeddings for all memories |
| `dim status` | Memory store summary (incl. pending proposals) |
| `dim mine` | Mine git history for memory candidates (`--full` to rescan all) |
| `dim review [approve\|reject] [id\|all]` | Review the proposal queue |
| `dim verify` | Re-run evidence, update statuses (`--deep` for tests/exec, `-q` for hooks, `-i <id>` to scope; exit 2 if anything went stale) |
| `dim log` | Recent memories |
| `dim forget <id>` | Delete a memory |
| `dim ui` | Web dashboard covering every workflow — add/search memories, review queue, verify, mine, sync, cloud link, API keys, memory graph (`-p <port>`, default 4517) |
| `dim serve` | Run a self-hosted team sync server (`--token`, `--db`, `--port`) |
| `dim login` / `dim logout` | Device-code login: approve this machine in the browser, token saved locally |
| `dim cloud link\|status\|unlink` | Bind the repo to a sync server brain |
| `dim sync` | Push/pull memory with the linked team server (also runs automatically after writes) |
| `dim keys create\|list\|revoke` | Mint/revoke brain-scoped API keys (admin token) |
| `dim mcp` | Run the MCP server (stdio) |

## Capture pipeline (Phase 2)

Nothing enters active memory without human approval:

1. **Commit miner** — runs automatically on every `git commit` (post-commit hook,
   installed by `dim init`): the new commit is scanned for decision/gotcha/failed-approach
   signals, and if something looks memory-worthy you get a one-line nudge
   (`🧠 aidimag: this commit looks memory-worthy — review with dim review`).
   Also runnable manually: `dim mine` (incremental, cursor-tracked) or `dim mine --full`.
   Each candidate is anchored with `COMMIT_REF` evidence and queued as a proposal.
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

`dim init` installs git hooks (additive, never clobbers existing hooks): `post-merge` / `post-checkout` / `post-rewrite` re-run cheap-tier verification on every pull, branch switch, and rebase, and `post-commit` mines each new commit for memory candidates. Run `dim verify --deep` on a schedule (or in CI) for the expensive tier.

## Semantic recall (optional, zero-config)

`dim recall` and the MCP `memory_search` tool run **hybrid retrieval**: FTS5 keyword
match + vector KNN (sqlite-vec), fused with reciprocal-rank fusion, then trust-ranked
(VERIFIED > UNVERIFIED > STALE). Embedding provider auto-detection:

| `AIDIMAG_EMBEDDINGS` | Behavior |
|---|---|
| `auto` *(default)* | OpenAI if `OPENAI_API_KEY` set → else local Ollama if running → else keyword-only |
| `openai` / `ollama` | Force a provider (`AIDIMAG_OPENAI_MODEL`, `AIDIMAG_OLLAMA_MODEL`, `AIDIMAG_OLLAMA_URL` to customize) |
| `off` | Keyword-only |

New memories are embedded on write; run `dim reindex` once to backfill (or after
switching models). Without any provider, everything still works — searches are just
literal-keyword only.

## Team mode (Phase 6 — self-hostable sync)

Share one repo brain across a team. The server is included — no SaaS required:

```sh
# somewhere reachable (laptop, VPS, Fly.io …)
dim serve --token <shared-secret> --db ./team-sync.db

# each member, in the repo
dim cloud link --server http://your-server:8787 --brain myrepo --token <shared-secret>
dim sync
```

- **Local-first**: agents always read the local SQLite replica; `dim sync` exchanges
  changes (last-writer-wins by `updated_at`; deletions propagate via tombstones).
  Sync also runs **automatically** (debounced, 30s) after `remember`, `review`,
  `verify`, `refute`, and `forget` — disable with `AIDIMAG_AUTO_SYNC=off`.
- **Device login (`dim login`)**: instead of pasting tokens, run `dim login` — the CLI
  shows a short code, opens the server's approval page in your browser, and an existing
  credential (admin token or member key) approves the device. The minted account token
  (`aidimag_at_…`) inherits the approver's brain scope and is revocable via `dim keys revoke`.
  This is the same device flow the hosted SaaS will drive with GitHub OAuth.
- **Event log + consensus**: every memory lifecycle change (create/status/evidence/
  verification) is recorded in a local append-only event log and shipped on sync.
  `GET /v1/consensus?brain=…` aggregates verification reports across machines —
  "N machines confirm this memory PASSes at HEAD sha X".
- `.aidimag/config.json` (server + brain name, **no secrets**) is committed to git, so
  teammates onboard with just `dim init && dim cloud link --token … && dim sync`.
  Tokens live in `~/.aidimag/credentials.json` (or `AIDIMAG_API_KEY`).
- The server is a dumb ordered log (node:http + SQLite) — merge logic, verification,
  and ranking all stay client-side. The future hosted SaaS wraps this same protocol.
- **API keys**: the `--token` you start the server with is the *admin* token. Mint
  revocable, brain-scoped member keys instead of sharing it:
  `AIDIMAG_ADMIN_TOKEN=… dim keys create --brain myrepo --label alice` →
  `aidimag_sk_…` (only valid for that brain; `dim keys revoke` kills it instantly).
- **Hosted deployment**: see [deploy/README.md](./deploy/README.md) — Dockerfile +
  Fly.io config, ~10 minutes to a private hosted server.

## VSCode extension

[`vscode-extension/`](./vscode-extension/) — dashboard webview + 🧠 status-bar memory
health (turns warning-colored when memories go STALE) + verify/sync commands.
`F5` to develop, `vsce package` to install (a prebuilt `.vsix` is included).

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
Semantic recall ✅ — hybrid FTS + sqlite-vec KNN with pluggable embeddings (OpenAI/Ollama, auto-detected).
Phase 6 (team mode v1) ✅ — self-hostable sync server (`dim serve`), LWW sync with tombstones (`dim sync`).
SaaS-ready auth ✅ — brain-scoped API keys (`dim keys`), Docker/Fly deployment (deploy/).
VSCode extension ✅ — dashboard webview, status-bar memory health (vscode-extension/).
SaaS groundwork ✅ — `dim login`/`logout` (device-code flow), append-only event log shipped on sync, cross-machine verification consensus (`/v1/consensus`), debounced auto-sync after writes.
Next: npm publish; hosted SaaS top layer (GitHub OAuth on the device flow, Postgres, billing per CLOUD_DESIGN.md); ticket-aware capture (Jira/GitHub/Linear context on proposals, per [TICKETS_DESIGN.md](./TICKETS_DESIGN.md)).

