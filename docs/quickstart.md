# Quick start (5 minutes)

A hands-on tour from zero to a verified, self-correcting memory. Run these in any git repo
after `dim init`.

::: tip Don't want to start from an empty brain?
Run `dim bootstrap` first — it reads your repo (README, configs, layout) and proposes
starter memories for you to approve. See [Install & setup](/getting-started#seed-your-memory-optional-but-recommended).
:::

## 1. Remember your first fact

Write it as a **checkable statement**, not a vague note:

```sh
dim remember "All database access goes through src/db/store.ts; nothing else imports better-sqlite3" \
  -k CONVENTION \
  -p src/db \
  -e "STATIC_CHECK:grep -rL better-sqlite3 src --include=*.ts"
```

- `-k CONVENTION` — the kind.
- `-p src/db` — the scope (which files it applies to).
- `-e STATIC_CHECK:...` — evidence: a command that **passes only if the claim is true**.

aiDimag replies:

```
🧠 Got it — I'll remember:
? [CONVENTION] All database access goes through src/db/store.ts; nothing else imports better-sqlite3
    id=4f3a9c21 status=UNVERIFIED conf=0.70 scope=src/db
```

## 2. Verify it

```sh
dim verify
```

The evidence runs. If your repo really does funnel DB access through that file, the memory
becomes **verified**:

```
✓ [UNVERIFIED → VERIFIED] conf 0.70→0.80  All database access goes through src/db/store.ts...
```

## 3. Watch it catch a regression

Now imagine someone imports `better-sqlite3` somewhere it shouldn't be. Run verify again:

```
~ [VERIFIED → STALE] conf 0.80→0.20  All database access goes through src/db/store.ts...
    STATIC_CHECK: FAIL (command exited 1)
```

The memory is now **stale** — and any agent that searches for it is told not to trust it
until it's fixed. This is the core value: **the memory noticed the code drifted.**

## 4. Add a guardrail

Guardrails are rules agents must obey. Levels are `never`, `ask-first`, `always`:

```sh
dim remember "Never call the production payments API from src; use the sandbox client in src/payments/sandbox.ts" \
  -k GUARDRAIL -g never -p src/payments
```

## 5. Generate context for your AI tool

Turn your trusted memory into files any assistant reads at startup:

```sh
dim generate-context -f all
```

This writes `CLAUDE.md`, `.cursorrules`, and `.github/copilot-instructions.md`, with
guardrails listed first.

## 6. Capture knowledge from history

Let aiDimag mine your git log for memory candidates:

```sh
dim mine               # fast keyword heuristics
dim mine --llm --full  # LLM reads commits + diffs (needs Ollama or OPENAI_API_KEY)
dim mine --prs         # mine merged GitHub PRs + review comments (needs gh CLI)
```

Candidates don't become memory automatically — they queue for review:

```sh
dim review
```

`dim review` walks you through each proposal: **keep**, **reword**, **drop**, or **skip**.

::: tip Drop in reference docs too
Beyond git history, you can drop design docs, ADRs, or style guides into the repo's
`knowledge/` folder and run `dim knowledge sync` — aiDimag summarizes them into the same
review queue (approved claims become *pinned*). See [Knowledgebase](/guides/knowledgebase).
:::

## 7. See everything

```sh
dim status         # counts by status and kind
dim log            # recent memories
dim brief          # session briefing: guardrails, warnings, what to trust
dim gaps           # questions memory couldn't answer (what to document next)
dim ui             # open the web dashboard in your browser
```

## What you just learned

- Memories are **falsifiable claims** with **evidence**.
- `dim verify` keeps them honest — passing → verified, failing → stale.
- **Guardrails** encode hard rules; **generate-context** feeds every AI tool.
- Inferred knowledge is **proposed**, then approved with `dim review`.

Next, deepen any of these in the **Guides**, starting with
**[Writing claims & evidence](/guides/claims-and-evidence)**, or browse the full
**[CLI reference](/cli-reference)**.

