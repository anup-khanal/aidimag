# Knowledgebase ingestion

Drop project documents into a `knowledge/` **inbox folder** and aiDimag summarizes the
durable facts inside them into **reviewed, pinned memories** that flow into `CLAUDE.md`
and every AI tool. It's a third capture source, alongside the
[commit miner](/how-it-works) and [session-end extraction](/mcp).

## The idea

A human drops reference material — design docs, ADRs, style guides, runbooks, onboarding
notes — into the repo's `knowledge/` folder. aiDimag classifies each file, summarizes it
into typed, scoped, **falsifiable** claims, and queues them as proposals. After you approve
them with `dim review`, they become **pinned** memories.

```
knowledge/<doc>          you drop files here
   │  processed automatically (while dim ui or an IDE extension is running),
   │  with catch-up via dim knowledge sync, the post-merge hook, or session_start
   ▼
summarized → by a connected MCP agent (preferred), else an OpenAI/Ollama provider
   │  into typed, scoped, falsifiable claims (deduplicated across chunks)
   ▼
proposals → you approve them with dim review → PINNED memories
   ├─ a plain-text summary is saved at .aidimag/knowledge/<doc>.summary.md
   └─ the original is backed up to .aidimag/knowledge/processed/<doc>
```

`dim init` creates the inbox (with a `.gitkeep`) and gitignores `.aidimag/knowledge/` and
the dropped docs, so processing a doc never accidentally commits sensitive source.

## Commands

```sh
dim knowledge sync       # process the inbox now (summarize new docs into proposals)
dim knowledge watch      # foreground watcher for terminal users (processes on drop)
dim knowledge status     # pending / unsupported / skipped / processed counts
dim knowledge list       # processed docs and the memories they produced
```

`sync` is the default subcommand, so `dim knowledge` on its own processes the inbox.

## How processing is triggered

You rarely need to run anything by hand. Docs are picked up:

- **automatically on drop** while a long-running host is up — `dim ui` or the
  [VSCode / IntelliJ extensions](/ide-extensions) watch the inbox;
- **on `git pull`/merge** via the `post-merge` hook `dim init` installs;
- **at session start** — the MCP `session_start` prompt nudges a connected agent when docs
  are waiting;
- **manually** with `dim knowledge sync` (or `dim knowledge watch` for terminal-only users).

If no summarizer is available (no connected agent, no configured provider), the file simply
**waits** in the inbox and is processed once one becomes available. Nothing is lost.

## Summarizer: agent-preferred, LLM fallback

- A **connected MCP agent** is preferred — run the `knowledge_ingest` prompt and the agent
  reads each pending doc, extracts claims, and submits them with the `knowledge_ingest_submit`
  tool. See [MCP integration](/mcp).
- Otherwise aiDimag uses a configured **LLM provider** (OpenAI / Ollama).

Either way the output is identical: typed, scoped, falsifiable claims queued for review.

## Key decisions

- **You still approve.** You vouch the *document* is relevant; a machine writes the *claims*,
  so extracted claims go through the [review queue](/guides/review-queue) before becoming
  pinned. A `knowledge.requireReview: false` opt-out exists for power users who accept the
  risk (claims are then auto-pinned).
- **Originals are never deleted** — they're backed up to `.aidimag/knowledge/processed/`
  before the inbox copy is removed.
- **A readable summary is kept** at `.aidimag/knowledge/<doc>.summary.md` so you can see what
  was understood (it records the source filename + content hash).
- **Large text documents are chunked** into multiple scoped, deduplicated memories.
- **Unsupported files** (binaries, oversized, empty) are set aside in
  `.aidimag/knowledge/skipped/` with a `<file>.reason.txt` — never processed, never deleted.
  PDF/DOCX support is a fast-follow.
- **Idempotent** — a doc's content hash is recorded, so re-dropping an unchanged file is a
  no-op (it's retired without re-proposing).

## Configuration

Tune the inbox in `.aidimag/config.json` under the `knowledge` block — see
[Configuration](/configuration#knowledge). Defaults work out of the box.

## Why pinned?

Reference material is exactly the "stays with the project forever, shouldn't fade with age"
case that [pinned memories](/guides/pinned) were built for — while remaining falsifiable, so
a claim extracted from a style guide still goes stale if its evidence later fails.

