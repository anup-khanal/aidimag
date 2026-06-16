# What is aidimag? (Plain-English Guide)

> **aidimag** = "AI" + "dimag" (*dimag* means **brain** in Hindi/Nepali).
> It gives AI coding assistants a **long-term memory of your codebase** — one that
> fact-checks itself so it never feeds your AI stale or wrong information.

---

## The problem it solves

Every time you start a new session with an AI coding assistant (Claude Code, Copilot,
Cursor...), it wakes up with **amnesia**. It has to re-explore your project from
scratch: how it's organized, which rules you follow, what hacks exist and why, what
was already tried and failed. That wastes time, tokens, and money — every single session.

Worse: if you try to fix this with a simple notes file, those notes **rot**. The code
changes, the notes don't, and now your AI confidently acts on outdated information —
which is more dangerous than knowing nothing.

**aidimag fixes both problems:**

1. **Memory** — it stores what's been learned about your project so any AI assistant
   can recall it instantly in the next session.
2. **Trust** — every memory comes with attached *proof* (a check that can be re-run),
   and aidimag re-checks them automatically whenever your code changes. If a memory no
   longer holds, it gets flagged — *before* it can mislead your AI.

Think of it as **a brain for your repo with a built-in lie detector**.

---

## How it works (the 2-minute version)

### 1. Memories are claims with proof
A memory isn't a loose note — it's a *checkable statement* plus evidence:

> **Claim**: "All network calls go through `src/services/dataService.js`; pages never call fetch directly."
> **Proof**: a small check command that passes only while that's true.

Kinds of memories: decisions, conventions, gotchas, failed approaches, architecture
notes, invariants, and unfinished-work context.

### 2. Every memory has a trust status
| Status | Meaning |
|---|---|
| ✓ **VERIFIED** | Its proof passed recently — safe to rely on |
| ? **UNVERIFIED** | Recorded but not yet proven |
| ~ **STALE** | Its proof just **failed** — the code changed; don't trust it |
| ✗ **REFUTED** | A human/AI explicitly marked it false — kept as "we used to believe this" |

### 3. It re-checks itself automatically
When you `git pull`, switch branches, or rebase, aidimag quietly re-runs the cheap
proofs. If something broke a convention, the related memory flips to STALE instantly.
Heavier proofs (running tests, executing code) run on demand with `--deep`.

Memories also **age**: if a memory can't be re-checked for weeks, its confidence
decays — just like your own certainty about old facts fades.

### 4. New memories need your approval
AI sessions and a git-history scanner can *propose* memories, but nothing becomes
"real" memory until you approve it (`dim review`). You stay in control of what your
repo's brain believes.

### 5. Any AI assistant can plug in
aidimag speaks **MCP** (Model Context Protocol) — the standard plug used by Claude
Code, Copilot, Cursor, and others. Once connected, your AI can search memories,
check what applies to files it's about to edit, propose new memories, and trigger
re-verification — all on its own.

---

## How to use it in another project

aidimag is installed on this machine as the `dim` command. For any project:

### Step 1 — Initialize (once per repo)
```sh
cd /path/to/your/project
dim init
```
This creates a `.aidimag/` folder (the brain), installs git hooks (the auto
fact-checker), and prints the config snippet for your AI assistant.

### Step 2 — Connect your AI assistant
Put this in the project's MCP config (e.g. `.mcp.json` for Claude Code — `dim init`
prints it pre-filled for you):
```json
{
  "mcpServers": {
    "aidimag": {
      "command": "dim",
      "args": ["mcp"],
      "env": { "AIDIMAG_REPO": "/path/to/your/project" }
    }
  }
}
```

### Step 3 — Feed the brain
Three ways, use any mix:

- **You add facts directly** (best with proof attached):
  ```sh
  dim remember "All DB access goes through src/db/store.ts" \
    -k INVARIANT -p src/db \
    -e "STATIC_CHECK:! grep -rln 'import sqlite' src/pages"
  ```
- **Mine your git history** for decisions/gotchas hidden in commit messages:
  ```sh
  dim mine        # then: dim review  →  approve / reject
  ```
- **Let your AI propose memories at session end** — ask it to run the
  `session_end_extraction` prompt; its proposals land in your review queue.

### Step 4 — Live with it (this part is automatic)
- Your AI starts each session by recalling relevant memories instead of re-exploring.
- Git hooks re-verify memories on every pull/checkout — stale knowledge gets flagged.
- Check in occasionally:
  ```sh
  dim status          # how many memories, how trustworthy
  dim verify --deep   # also run test/execution proofs (slower)
  dim recall auth     # search the brain yourself
  ```

### Everyday cheat sheet
| Command | What it does |
|---|---|
| `dim init` | Give a repo a brain |
| `dim remember "..."` | Store a fact (add `-e TYPE:proof`) |
| `dim recall <words>` | Search memories (`-p <path>` = "what applies to this file?") |
| `dim mine` | Harvest memory candidates from git history |
| `dim review` | Approve/reject proposed memories |
| `dim verify` | Re-run proofs now (`--deep` = include tests/exec) |
| `dim pin <id>` / `dim unpin <id>` | Pin = never decays with age (evidence still applies) |
| `dim status` / `dim log` | Health check / recent memories |
| `dim refute <id>` | Mark a memory false (kept as negative knowledge) |
| `dim forget <id>` | Delete a memory entirely |
| `dim generate-context` | Auto-build `CLAUDE.md` / `.cursorrules` from verified memories *(coming soon)* |
| `dim check` | Pre-commit: warn if staged changes contradict memories *(coming soon)* |
| `dim ui` | **Open the visual dashboard in your browser** — every workflow has a UI here (add/search memories, approve proposals, verify, mine git history, team sync setup, API keys, memory graph), so you never *need* the CLI day-to-day |

---

## Why this beats a notes file (or generic "AI memory" tools)

| | Notes file / CLAUDE.md | Generic AI memory | **aidimag** |
|---|---|---|---|
| Survives across sessions | ✓ | ✓ | ✓ |
| Works with *any* AI tool | ✗ (per-tool) | varies | ✓ (MCP + auto-generated CLAUDE.md/.cursorrules) |
| Knows *which files* a fact applies to | ✗ | ✗ | ✓ |
| **Detects when a fact goes stale** | ✗ | ✗ | ✓ auto, on every git pull |
| Confidence fades without re-confirmation | ✗ | ✗ | ✓ |
| Remembers what *didn't* work | manual | ✗ | ✓ first-class |
| You approve what gets remembered | — | ✗ | ✓ review queue |
| Enforces guardrails (always/never/ask-first) | ✗ | ✗ | ✓ *(coming soon)* |
| Pre-commit contradiction check | ✗ | ✗ | ✓ *(coming soon)* |
| Pin important memories forever | ✗ | ✗ | ✓ `dim pin` |

The one-line pitch: **AI models keep getting smarter, but they still forget your
project every session. aidimag is the memory they keep — and the only one that
proves it's still telling the truth.**

