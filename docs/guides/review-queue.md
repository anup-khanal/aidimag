# The review queue

aiDimag never adds *inferred* knowledge to active memory behind your back. Anything the
commit miner or an AI agent comes up with becomes a **proposal** that waits for your
approval. This is the human gate that lets you trust what's in the store.

## Where proposals come from

- **Commit miner** — after each commit (or via `dim mine`), candidate memories are extracted
  from your diffs and messages.
- **Agent session-end** — an agent calls `memory_propose` with durable learnings.
- **Knowledgebase ingestion** — summarized documents become proposals too (pinned on
  approval). See [Knowledgebase](/guides/knowledgebase).

Things **you** write with `dim remember` skip the queue — you're the author.

## Review interactively

In a terminal, just run:

```sh
dim review
```

You'll be walked through each proposal one at a time:

```
🧠 3 memories are waiting for your review.

── 1 of 3 ── GOTCHA · mined from commit a1b2c3d4

   "Calling refreshToken() twice concurrently double-rotates and logs the user out."

   applies to: src/auth/refresh.ts
   evidence:   COMMIT_REF:a1b2c3d4

   [k]eep · [r]eword · [d]rop · [s]kip ?
```

- **keep** — approve as-is; it becomes active memory.
- **reword** — edit the claim before saving.
- **drop** — reject it (and it won't be re-proposed — dedupe remembers).
- **skip** — decide later.

## Review non-interactively (scripting)

```sh
dim review list                 # show pending proposals
dim review approve 1caf9d77      # approve one (id prefix ok)
dim review approve all           # approve everything pending
dim review reject 1caf9d77
dim review reject all
```

## In the dashboard or IDE

`dim ui` and both IDE extensions show the same queue with click-to-approve, which is nicer
when you have a lot to triage. See [Web dashboard](/dashboard).

## Why a human gate?

Inferred memory is a *guess* — a miner's heuristic or a model's summary. Letting guesses
become trusted, decay-exempt facts automatically would undermine the whole "verified memory"
promise. The review step is fast (most proposals are a one-key keep/drop) and it's what makes
the store trustworthy.

::: tip Ticket context
If your repo is connected to a ticketing system, review shows live ticket details next to
each proposal, so you can confirm the *why* before approving. See
[Connecting tickets](/guides/tickets).
:::

Next: **[Guardrails](/guides/guardrails)**.

