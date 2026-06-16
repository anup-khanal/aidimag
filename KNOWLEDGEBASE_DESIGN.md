# Knowledgebase Ingestion — Design

> Drop project documents into a folder; aidimag summarizes them into reviewed,
> **pinned** memories that feed the Spec/Environment layers (`CLAUDE.md`, MCP).
>
> Status: **shipped** · Date: 2026-06-16

---

## Goal

Give a project a simple **knowledge inbox**. A human drops reference material —
design docs, ADRs, style guides, runbooks, onboarding notes — into a `knowledge/`
folder, and aidimag turns the durable facts inside them into pinned memories that
survive forever and flow into every AI tool via `dim generate-context`.

This is a third **capture source**, alongside the commit-miner and session-end
extraction. It does not replace either; it adds a deliberate, human-curated channel.

---

## Core principle — curate the source, review the claims

The human vouches that the **document** is relevant. The human does **not** vouch
that a machine's **summary** of it is accurate. The gap between those two is where
distortion lives (over-generalizing a suggestion into a hard rule, inventing a
guardrail, misreading nuance, surfacing stale info or secrets).

Because knowledge memories are **pinned**, the stakes are the highest in the system:

- pinned memories **never decay** — a wrong one stays wrong forever, and
- pinned memories **lead the generated context** — they're injected first into
  `CLAUDE.md` and every AI tool.

So the **human review gate stays**: extracted claims enter the proposal queue and
become pinned only after `dim review` approval. This preserves aidimag's core
guarantee — *nothing enters active memory without human approval*.

---

## Pipeline

```
knowledge/<doc>                  human drops files here (inbox; .gitkeep keeps it alive)
   │  auto-processed on drop while a host is running (dim ui / IDE extension);
   │  catch-up via `dim knowledge sync`, post-merge hook, session_start
   ▼
summarize → connected MCP agent (preferred) │ else OpenAI/Ollama provider
   │  extracts typed, scoped, FALSIFIABLE claims (not one blob)
   ▼
proposals  (source: "knowledge:<doc>", pin-on-approve intent)
   ├─ write   .aidimag/knowledge/<doc>.summary.md     (durable record: claims + source name + hash)
   └─ back up .aidimag/knowledge/processed/<doc>       (original preserved; inbox cleared)
   ▼
dim review → approve → PINNED memories → dim generate-context → CLAUDE.md / .cursorrules / …
```

---

## Decisions (locked)

| Topic | Decision |
|---|---|
| **Trust gate** | Files → **proposals** → `dim review` → **pinned**. Approval required by default. A `knowledge.requireReview: false` opt-out exists for power users who accept the risk. |
| **Summarizer** | **Agent-preferred, LLM fallback** (OpenAI / Ollama). Auto-summarization needs a connected agent *or* a configured provider; there is **no** naive offline extraction. |
| **Unavailable summarizer** | The file simply **waits in the inbox** (the inbox *is* the pending queue). Nothing is lost. It is auto-summarized the moment an agent or provider becomes available. Manual `dim remember --pin` is always an offline escape hatch. |
| **Processing trigger** | **Automatic on drop** while a long-running host is up (`dim ui`, IDE extensions). Catch-up triggers: `dim knowledge sync` (manual), `post-merge` hook, `session_start` (MCP). No standalone always-on daemon. |
| **Originals** | **Never deleted.** Backed up to `.aidimag/knowledge/processed/<doc>` after the summary + backup are fsync'd and proposals are queued; then the inbox copy is removed. |
| **Summary file** | Plain-text / Markdown at `.aidimag/knowledge/<doc>.summary.md`, embedding the source filename + content hash (for human review, provenance, and idempotent re-detection of edits / re-drops). |
| **Pinned semantics** | Approved knowledge memories are pinned — exempt from time decay, but still go STALE if attached evidence fails. "Never decays" ≠ "never falsifiable". |

---

## Supported vs unsupported files

A drop is **supported** only if it passes all three checks:

1. **Type allowlist** — text formats we can read as prose: `.md`, `.txt`, `.rst`,
   `.adoc`, `.org`, source files, `.json` / `.yaml` / `.toml`, `.csv`, `.html`
   (configurable via `knowledge.extensions`).
2. **Text sniff** — the bytes must be UTF-8 / text-decodable (catches a binary
   renamed to `.txt`).
3. **Size + content sanity** — under `knowledge.maxBytes` (default ~1 MB) and non-empty.

Anything else is **set aside, never processed, never deleted**:

| Case | Handling |
|---|---|
| Binary / image / archive / media, executables | Moved to `.aidimag/knowledge/skipped/` — "unsupported type" |
| Too large | Above the hard `knowledge.maxBytes` cap → skipped ("exceeds maxBytes"). Large *text* docs under the cap are **chunked** (see below), not skipped. |
| Empty / whitespace-only | Skipped — "no content" |
| `.pdf` / `.docx` | Skipped in v1 — "needs a parser"; **fast-follow** via pdf-parse / mammoth |
| Looks like text but undecodable / encrypted | Skipped — "not text-decodable" |
| Supported but no summarizer yet | **Not** skipped — stays in inbox as pending, retried later |

Key distinction: **unsupported → moved to `skipped/`** (we know we can't), whereas
**no summarizer yet → stays in the inbox** (we can, just not right now). Each skipped
file gets a `<file>.reason.txt`, and counts/reasons surface in `dim knowledge status`,
so nothing fails silently.

---

## Chunking large text documents

A long doc shouldn't become one giant memory or blow the summarizer's context window.
Text documents above a soft threshold (`knowledge.chunkBytes`, e.g. ~16 KB) are split
into **structure-aware chunks** before summarization:

- Prefer natural boundaries — Markdown headings / sections, then paragraphs — so a chunk
  is a coherent unit, not a byte-count cut mid-sentence.
- Each chunk is summarized independently into its own scoped claims, then the whole
  doc's proposals are **deduplicated** (a fact repeated across sections yields one
  memory, not many).
- Provenance is preserved: the single `.aidimag/knowledge/<doc>.summary.md` records all
  chunks and their claims under one source (`knowledge:<doc>`), and the `processed/`
  backup keeps the intact original.
- Files above the hard `knowledge.maxBytes` cap are still **skipped** — chunking is for
  *large* docs, not unbounded ones.

---

## New surface area

- **CLI**
  - `dim knowledge sync` — process the inbox now (manual + catch-up)
  - `dim knowledge watch` — foreground watcher for terminal-only users (processes the
    inbox on drop; same code the `dim ui` / IDE hosts call internally)
  - `dim knowledge status` — pending / skipped counts with reasons
  - `dim knowledge list` — processed docs and the memories they produced
- **MCP**
  - `knowledge_ingest` prompt — lets an in-session agent process the inbox itself
  - (optional) `knowledge_pending` tool — list files awaiting summarization
- **Config** (`.aidimag/config.json` → `knowledge` block)
  ```json
  {
    "knowledge": {
      "folder": "knowledge",
      "summarizer": "auto",        // auto | agent | llm | off
      "requireReview": true,        // false = auto-pin (opt-out)
      "backup": true,               // keep originals in processed/
      "extensions": [".md", ".txt", ".rst", ".adoc", ".json", ".yaml"],
      "maxBytes": 1048576,
      "chunkBytes": 16384
    }
  }
  ```
- **Schema** — ride on the existing proposal `source` / dedupe machinery; encode the
  pin-on-approve intent in the `source` tag (`knowledge:<doc>`) to avoid a migration.
- **Hosts / triggers** — a folder watcher inside `dim ui` and the IDE extensions for
  on-drop processing; `post-merge` hook and `session_start` as catch-up.

---

## Safety guarantees

- **No data loss** — the inbox copy is removed only *after* the summary file and the
  `processed/` backup are written and the proposals are queued; a mid-run crash leaves
  the original untouched.
- **Nothing silent** — `dim knowledge status` always shows what's pending, processed,
  and skipped (with reasons).
- **Nothing auto-trusted** — machine summaries require approval by default.
- **Secrets stay private** — `dim init` gitignores `.aidimag/knowledge/` (summaries and
  backups) by default, so processing a doc never accidentally commits sensitive source.

---

## In scope (this phase)

- **Chunking large text documents** into multiple scoped, deduplicated memories
  (structure-aware splitting; see above).
- **`dim knowledge watch`** — a standalone foreground watcher for terminal-only users,
  alongside the `dim ui` / IDE-extension hosts.

## Out of scope (fast-follow)

- PDF / DOCX parsing (parser libraries behind a flag).

