# aiDimag

> Persistent, verified memory for AI coding agents. CLI: **`dim`** (*dimag* = brain).

aiDimag gives any MCP-compatible agent (Claude Code, Cursor, Copilot, …) a memory of your
codebase that survives across sessions — decisions, conventions, gotchas, failed approaches,
**guardrails**, and reusable **skills** — stored as **falsifiable claims with grounding
evidence** in `.aidimag/` next to your code. It also generates the static context files
(`CLAUDE.md`, `.cursorrules`, …) that *non-MCP* tools read, so every AI tool benefits.

See [DESIGN.md](./DESIGN.md) for the full design.

## Documentation

Full, plain-English docs live in [`docs/`](./docs) (a [VitePress](https://vitepress.dev)
site) — installation, a 5-minute quick start, every CLI command with examples, scenario
guides, MCP/IDE setup, configuration, FAQ, and a glossary.

```sh
npm install
npm run docs:dev      # live local preview at http://localhost:5173
npm run docs:build    # static site → docs/.vitepress/dist
```

On push to `main`, the site auto-deploys to **GitHub Pages** via
[`.github/workflows/deploy-docs.yml`](./.github/workflows/deploy-docs.yml) — enable Pages
once (Settings → Pages → Source: *GitHub Actions*). Before publishing, replace the
`your-org` placeholders and confirm the `base` path in
[`docs/.vitepress/config.ts`](./docs/.vitepress/config.ts).


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
| `dim bootstrap` | **Instant starter brain**: survey README/docs/manifests/structure/git-churn, LLM-extract an initial memory set with suggested checks (queued for review; idempotent, `--force` to re-run) |
| `dim remember "<claim>"` | Store a memory (`-k` kind, `-p` paths, `-e TYPE:payload` evidence, `-g never\|ask-first\|always` for `GUARDRAIL`, `--pin`) |
| `dim recall <query>` | Search memories — hybrid keyword + semantic (`-p` to scope to files) |
| `dim reindex` | Build/refresh semantic embeddings for all memories |
| `dim status` | Memory store summary (incl. pending proposals) |
| `dim generate-context` | Render verified memory into static context files (`-f claude\|cursorrules\|copilot\|all`); `--auto`/`--no-auto` keeps them refreshed after verify/review/sync |
| `dim check` | Pre-commit contradiction check: scan the staged diff against active memories + guardrails (`--block` to exit 1, `-r <ref>` to diff a ref) |
| `dim brief` | Print a session-start briefing: in-scope memory, guardrails, stale warnings, and questions to ask before coding |
| `dim mine` | Mine git history for memory candidates (`--full` to rescan all; `--llm` = deep mining: the LLM reads each commit's message **and diff** and synthesizes claims + suggested checks) |
| `dim harvest` | Harvest durable facts YOU typed into AI chats (Claude Code transcripts, secrets redacted, local-only) into the review queue (`--all`, `--install-hook` for a SessionEnd hook) |
| `dim review [approve\|reject] [id\|all]` | Review the proposal queue — **auto-triaged best-first** (evidence, source trust, scope; penalized for similarity to past rejections). Plain `dim review` opens a conversational walkthrough; `approve all --min-score 0.7` batch-approves above a bar |
| `dim verify` | Re-run evidence, update statuses (`--deep` for tests/exec, `-q` for hooks, `-i <id>` to scope, `--trust` to review & approve synced-in evidence commands; exit 2 if anything went stale). Memories that flip to STALE auto-draft a **recovery proposal** so staleness never dead-ends |
| `dim ticket connect\|status\|show\|share\|branch-rule` | Connect Jira / GitHub Issues / Linear / your own HTTP middleware / the team sync server (interactive flow) — proposals then carry ticket context. `share` puts the team credential on the sync server (members hold zero ticket tokens); `branch-rule` manages the branch convention and prints GitHub/GitLab/Bitbucket server-side rules |
| `dim branch <ticket-id>` | Create a convention-conforming branch (fetches the ticket title for the slug when connected) |
| `dim log` | Recent memories |
| `dim gaps` | Knowledge gaps: zero-hit searches from agents/CLI — the facts your brain is missing (`-d <days>`, `--clear`) |
| `dim pin <id>` / `dim unpin <id>` | Pin/unpin a memory (pinned = exempt from time decay, still falsifiable by evidence) |
| `dim refute <id>` | Mark a memory REFUTED — kept as negative knowledge (unlike `forget`, which deletes) |
| `dim forget <id>` | Delete a memory |
| `dim ui [start\|stop]` | Web dashboard covering every workflow — add/search memories, review queue, verify, mine, sync, cloud link, API keys, memory graph (`-p <port>`, default 4517; `stop` to stop the server) |
| `dim serve` | Run a self-hosted team sync server (`--token`, `--db`, `--port`) |
| `dim login` / `dim logout` | Device-code login: approve this machine in the browser, token saved locally |
| `dim cloud link\|status\|unlink` | Bind the repo to a sync server brain |
| `dim sync` | Push/pull memory with the linked team server (also runs automatically after writes) |
| `dim keys create\|list\|revoke` | Mint/revoke brain-scoped API keys (admin token) |
| `dim mcp` | Run the MCP server (stdio) |

## Capture pipeline (Phase 2)

Nothing enters active memory without human approval:

0. **Repo bootstrap** — `dim bootstrap` (suggested by `dim init`) surveys the repo — README/
   docs/ADRs, manifests, existing `CLAUDE.md`/`.cursorrules`, directory shape, most-churned
   files — and LLM-extracts an initial set of falsifiable claims with suggested
   `STATIC_CHECK`s. Day-one brain, review-gated, idempotent.
1. **Commit miner** — runs automatically on every `git commit` (post-commit hook,
   installed by `dim init`): the new commit is scanned for decision/gotcha/failed-approach
   signals, and if something looks memory-worthy you get a one-line nudge
   (`🧠 aidimag: this commit looks memory-worthy — review with dim review`).
   Also runnable manually: `dim mine` (incremental, cursor-tracked) or `dim mine --full`.
   **`dim mine --llm`** is the deep tier: the LLM reads each commit's message *and diff*
   and synthesizes real falsifiable claims with suggested `STATIC_CHECK`s — far higher
   quality than the keyword heuristics (which remain the zero-config/hook fallback).
   Merge/squash commits are mined too — GitHub PR titles and descriptions in merge
   bodies are promoted to the claim. Each candidate is anchored with `COMMIT_REF`
   evidence and queued as a proposal. **Ticket-aware**: the ticket id is extracted
   offline from the branch name / commit message (pattern in `.aidimag/config.json`);
   with a provider connected (`dim ticket connect`), review shows live ticket context.
2. **Session-end extraction** — agents invoke the `session_end_extraction` MCP prompt and
   call `memory_propose` with falsifiable, evidence-backed claims.
3. **In-chat context notes** — the `context_note` MCP tool captures durable facts the
   *user* states mid-conversation ("we use X because Y", "never touch Z") the moment they
   say them — verbatim quote preserved, `HUMAN_ATTESTED` evidence attached, queued for review.
4. **Chat transcript harvesting** — `dim harvest` mines the local Claude Code session
   transcripts for this repo (`~/.claude/projects/<slug>/*.jsonl`) and LLM-extracts the
   facts you typed into falsifiable claims (secret-looking lines redacted first; local-only).
   `dim harvest --install-hook` wires a Claude Code `SessionEnd` hook so it runs per-session.
5. **Knowledge-gap logging** — every `memory_search` / `dim recall` is logged locally;
   zero-hit queries are surfaced by `dim gaps` and in the session briefing, so the questions
   your brain *couldn't* answer become prompts to fill them.
6. **Review** — `dim review` walks you through the queue conversationally:
   keep, reword before saving, drop, or skip each proposal (`list`/`approve`/`reject`
   subcommands remain for scripting; dedupe prevents re-proposal of rejected claims).
   The queue is **auto-triaged**: proposals are scored (machine-checkable evidence,
   source trust, concrete scope) and penalized for similarity to claims you previously
   rejected (the correction loop) or to existing memory — you always see the best
   candidates first, and `dim review approve all --min-score 0.7` batch-approves
   above a bar.

## Verification (the wedge)

Memories are falsifiable claims; `dim verify` re-runs their evidence against the current repo state:

- **`STATIC_CHECK`** — payload is a shell command; exit 0 means the claim holds *(cheap tier)*
- **`COMMIT_REF`** — anchor commit must exist and be an ancestor of HEAD; `sha:path1,path2` also fails if anchored files changed since *(cheap tier)*
- **`TEST_RESULT`** — payload is a test command, run with `CI=1`; exit 0 = PASS *(deep tier: `--deep`)*
- **`EXEC_TRACE`** — payload is `command :: expected-output-regex`; the claim holds iff observed output matches *(deep tier: `--deep`)*
- **`HUMAN_ATTESTED`** — verifies once on attestation, then decays fastest (14-day half-life)

**Evidence trust gate (supply-chain guard)**: executable evidence runs shell commands on
your machine — automatically, via git hooks. Payloads authored locally (`dim remember`,
proposal approval) are trusted; payloads that arrive via **team sync are never executed
until you inspect and approve them** with `dim verify --trust`. Until then they're
skipped and can't flip statuses.

**Staleness is a capture trigger, not a dead end**: when a memory newly flips to STALE,
aiDimag drafts a recovery proposal in the review queue ("this belief's evidence now fails —
code drift or outdated claim?") so every broken belief gets a decision, not silence.

**Lifecycle**: any evidence FAILs → **STALE** (confidence floored to 0.20); all evidence PASSes → **VERIFIED** (confidence +0.10, capped 0.95). A recovered memory re-earns trust gradually. **REFUTED** is never automatic — it stays a deliberate human/agent action.

**Confidence decay**: memories that can't be machine-re-verified decay exponentially (45-day half-life; 14 days for human-attested). A VERIFIED memory whose confidence decays below 0.35 is demoted to UNVERIFIED — trust expires without re-confirmation.

`dim init` installs git hooks (additive, never clobbers existing hooks): `post-merge` / `post-checkout` / `post-rewrite` re-run cheap-tier verification on every pull, branch switch, and rebase, and `post-commit` mines each new commit for memory candidates. Run `dim verify --deep` on a schedule (or in CI) for the expensive tier.

## Spec · Verifier · Environment (Karpathy 3-layer)

aiDimag maps Andrej Karpathy's AISN 2026 framework onto a memory system so *every* AI
coding tool — MCP-aware or not — works from the same verified spec (see
[KARPATHY_LAYERS.md](./KARPATHY_LAYERS.md)):

- **Environment — `dim generate-context`**: renders trustworthy memory (VERIFIED +
  UNVERIFIED + pinned, never STALE/REFUTED) into the static files non-MCP tools read at
  session start — `CLAUDE.md`, `.cursorrules`, `.github/copilot-instructions.md`
  (`-f all` writes them all). `--auto` persists `generateContext.auto` in
  `.aidimag/config.json`, and from then on `dim verify` / `dim review` / `dim sync`
  regenerate the files automatically whenever the verified memory set changes — the spec
  self-heals with zero manual steps.
- **Environment — `GUARDRAIL` kind**: behavioral rules with an enforcement level —
  `never` (🚫 refuse + explain), `ask-first` (🤚 confirm with the user), `always`
  (✅ do without asking). Set on write: `dim remember "…" -k GUARDRAIL -g never`.
  Guardrails lead the generated context, surface in the session briefing, and are
  enforced by `dim check` and `memory_critique`.
- **Environment — `SKILL` kind**: reusable step-by-step procedures
  (`"Deploy: 1) … 2) … 3) …"`) rendered as ordered lists in the context file and
  surfaced by semantic match.
- **Verifier — `dim check`**: shifts verification *left*. Before a commit lands it scans
  the staged diff against the memories scoped to the changed files — re-running
  `STATIC_CHECK` evidence, keyword-matching `never` guardrails against added lines, and
  flagging in-scope invariants/conventions. Opt-in pre-commit hook follows
  `preCommitCheck` (`"warn"` | `"block"`) in `.aidimag/config.json`.
- **Verifier — `memory_critique` (MCP)**: a "second critic" grounded in *real verified
  memory* rather than another model's opinion. An agent calls it before committing with a
  summary of what it did; it returns guardrail violations, contradictions, confirmations,
  and coverage gaps.
- **Spec — `dim brief` / `session_start` (MCP)**: a session-start interview. Surfaces
  in-scope memory and guardrails, flags STALE memories not to trust, lists coverage gaps,
  and suggests clarifying questions to ask the human before writing code.


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
  **Hardened**: keys and account tokens are stored **SHA-256-hashed at rest** (a leaked
  server DB leaks no live credentials), the unauthenticated device-auth endpoints are
  **rate-limited per IP** (20/min — user codes can't be brute-forced within their TTL),
  and error responses never echo internals.
- **Hosted deployment**: see [deploy/README.md](./deploy/README.md) — Dockerfile +
  Fly.io config, ~10 minutes to a private hosted server.

## VSCode extension

[`vscode-extension/`](./vscode-extension/) — dashboard webview + Memory Explorer tree +
🧠 status-bar memory health (turns warning-colored when memories go STALE) + verify/sync
commands. The add-memory flow supports `GUARDRAIL` (with enforcement-level picker) and
`SKILL` kinds. `F5` to develop, `vsce package` to install (a prebuilt `.vsix` is included).

## IntelliJ plugin

[`intellij-plugin/`](./intellij-plugin/) — IntelliJ IDEA plugin with an embedded
dashboard tool window and the same core `dim` actions (verify/sync/login/tickets)
under **Tools > aiDimag**. The native Memory Explorer colour-codes `GUARDRAIL`/`SKILL`
nodes and shows the guardrail enforcement level in the list and detail panes.

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

**Tools**: `memory_search`, `memory_get_for_files`, `memory_write`, `memory_propose`, `context_note` (in-chat fact capture: the moment the user states a durable fact — "we use X because Y", "never touch Z" — the agent notes it into the review queue with `HUMAN_ATTESTED` evidence), `memory_verify`, `memory_refute`, `memory_status`, `memory_critique`, `proposals_pending`, `ticket_get`. Every `memory_search` is logged locally; zero-hit queries become **coverage gaps** (`dim gaps`) — the questions agents asked that memory couldn't answer.
**Prompts**: `session_start` — briefing + interview to run before coding · `session_end_extraction` — capture durable learnings at session end
**Resources**: `aidimag://digest` — repo memory digest · `aidimag://session-briefing` — in-scope memory, guardrails, stale warnings, and gaps

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
VSCode extension ✅ — dashboard webview, Memory Explorer tree panel, detail webview, status-bar memory health (vscode-extension/).
IntelliJ plugin ✅ — native Memory Explorer panel with colour-coded nodes, detail pane, toolbar, JCEF dashboard tab, status-bar widgets, auto-sync (intellij-plugin/).
SaaS groundwork ✅ — `dim login`/`logout` (device-code flow), append-only event log shipped on sync, cross-machine verification consensus (`/v1/consensus`), debounced auto-sync after writes.
Tickets T1–T5 ✅ — ticket-id extraction (branch/commit, offline), `TicketProvider` contract with Jira/GitHub/Linear/HTTP adapters (interactive `dim ticket connect`), `TICKET_REF` evidence, review-time enrichment, branch convention enforcement, team-shared credentials via sync server, public HttpProvider contract ([HTTP_PROVIDER.md](./HTTP_PROVIDER.md)), ticket-aware session end with MCP `ticket_get` tool.
Pinned memories ✅ — `dim pin`/`unpin`: exempt from time decay, still falsifiable by evidence (both IDE extensions support pin/unpin).
Karpathy 3-layer ✅ — `dim generate-context` (CLAUDE.md/.cursorrules/copilot-instructions, with `--auto` refresh on verify/review/sync), `GUARDRAIL` + `SKILL` memory kinds, `dim check` pre-commit contradiction detector (opt-in hook), `memory_critique` MCP tool, `dim brief` + `session_start` MCP prompt/`aidimag://session-briefing` resource. Both IDE extensions surface the new kinds (VSCode 0.5.0, IntelliJ 0.3.0).
Passive capture ✅ — `context_note` MCP tool (live in-chat fact capture with verbatim quotes + `HUMAN_ATTESTED` evidence), `dim harvest` (Claude Code transcript mining, secret redaction, `--install-hook` SessionEnd automation), search-gap logging (`dim gaps`, zero-hit queries surfaced in `dim brief`/`session_start`).
Cold-start & capture quality ✅ — `dim bootstrap` (day-one starter brain from repo survey with suggested checks), `dim mine --llm` (diff-aware LLM commit mining), STALE → recovery proposals (staleness never dead-ends), review-queue auto-triage with correction-loop penalty (`dim review approve all --min-score`).
Security hardening ✅ — evidence trust gate (synced-in shell commands never execute until locally approved via `dim verify --trust`), sync-server credentials hashed at rest, per-IP rate limiting on device auth, no internal error leakage; `knowledge.requireReview:false` auto-approvals no longer pin.
Test suite ✅ — 23 unit tests across the store (lifecycle, proposals, gaps, trust gate), capture pipeline (triage, harvest, extraction, miner), and verification engine (decay math, lifecycle, trust gate, stale recovery).

## Karpathy 3-Layer Integration (shipped — see [KARPATHY_LAYERS.md](./KARPATHY_LAYERS.md))

Inspired by Andrej Karpathy's AISN 2026 framework (Spec → Verifier → Environment),
these features make aiDimag the shared spec/verifier/environment for *all* AI coding tools:

| # | Feature | Layer | Status |
|---|---|---|---|
| 1 | **`dim generate-context`** — build `CLAUDE.md` / `.cursorrules` / `copilot-instructions.md` from verified memory (`--auto` self-heals on verify/review/sync) | Environment | ✅ shipped |
| 2 | **`GUARDRAIL` memory kind** — `never` / `ask-first` / `always` enforcement levels | Environment | ✅ shipped |
| 3 | **`memory_critique` MCP tool** — "second critic" grounded in real verified memory | Verifier | ✅ shipped |
| 4 | **`dim check` pre-commit** — diff-vs-memory contradiction detection (opt-in hook) | Verifier | ✅ shipped |
| 5 | **`SKILL` memory kind** — reusable procedures surfaced by semantic match | Environment | ✅ shipped |
| 6 | **Session-start interview** — `dim brief` + `session_start` MCP prompt | Spec | ✅ shipped |

## Knowledgebase ingestion (shipped — see [KNOWLEDGEBASE_DESIGN.md](./KNOWLEDGEBASE_DESIGN.md))

A `knowledge/` inbox folder: drop project docs (design docs, ADRs, style guides,
runbooks) and aiDimag summarizes the durable facts into **reviewed, pinned memories**
that flow into `CLAUDE.md` and every AI tool via `dim generate-context`.

- **Curate the source, review the claims** — you vouch the *document* is relevant; a
  machine writes the *claims*, so extracted claims enter the proposal queue and become
  pinned only after `dim review` approval (default on). Opting out with
  `knowledge.requireReview: false` auto-approves — but as **unpinned** memories that stay
  subject to decay and evidence checks: pinning (highest blast radius) always requires a
  human. Pin the keepers with `dim pin`.
- **Summarizer** — connected MCP agent preferred, OpenAI/Ollama fallback. With neither
  available, files **wait in the inbox** (the inbox is the pending queue) and are
  auto-summarized the moment an agent or provider appears. Manual `dim remember --pin` is
  always an offline escape hatch.
- **Originals are never deleted** — backed up to `.aidimag/knowledge/processed/`, with a
  reviewable plain-text summary at `.aidimag/knowledge/<doc>.summary.md`.
- **PDF and DOCX are supported** — text is extracted locally (`pdf-parse` / `mammoth`)
  before summarization; scanned/image-only PDFs are skipped with a reason.
- **Unsupported files** (other binaries, oversized, empty) are set
  aside in `.aidimag/knowledge/skipped/` with a reason — never processed, never deleted.
  Large text docs are **chunked** into multiple scoped, deduplicated memories.
- **Surface area**: `dim knowledge sync | watch | status | list`, a `knowledge_ingest` MCP
  prompt (+ `knowledge_pending` / `knowledge_ingest_submit` tools), a `knowledge` config
  block, and a folder watcher hosted by `dim ui` / the IDE extensions (with `post-merge` +
  `session_start` as catch-up).

## Next

### Other

npm publish; hosted SaaS top layer (GitHub OAuth, Postgres, billing per [CLOUD_DESIGN.md](./CLOUD_DESIGN.md)); PR review-comment mining (GitHub Action / `gh` integration); Cursor/Copilot chat-history harvesting + `@dimag` VS Code chat participant; closed-ticket mining; container isolation for deep-tier evidence runners; CLI monolith split; ticket open questions (multi-pattern repos, redaction) per [TICKETS_DESIGN.md](./TICKETS_DESIGN.md); CI workflow for the test suite.


