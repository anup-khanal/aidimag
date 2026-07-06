# Verifying memories

Verification is what keeps aiDimag's memory **honest**. This guide explains what `dim verify`
does, when it runs, and how to read the results.

## What verification does

`dim verify` re-runs each memory's evidence against the **current** state of your code and
updates its status and confidence:

- **All machine-checkable evidence passes** → status becomes **verified**, confidence rises.
- **Any evidence fails** → status becomes **stale**, confidence is floored.
- **No evidence to run** → time **decay** slowly lowers confidence; if it drops too far, a
  verified memory is demoted to unverified.

## Cheap vs deep tier

| Tier | Evidence | When it runs |
|---|---|---|
| **Cheap** | STATIC_CHECK, COMMIT_REF | Automatically (git hooks) and on plain `dim verify` |
| **Deep** | TEST_RESULT, EXEC_TRACE | Only with `dim verify --deep` (it runs your tests) |

Run the cheap tier constantly; run the deep tier on a schedule or in CI.

## Running it

```sh
dim verify                 # cheap tier, all memories
dim verify --deep          # also run tests/exec traces
dim verify -i 4f3a9c21     # just one memory (prefix ok)
dim verify --quiet         # only print changes (used by hooks)
dim verify --trust         # review & approve synced-in evidence commands first
```

The exit code is **2** if anything went stale — handy for CI:

```sh
dim verify || echo "something is stale"
```

## Reading the output

```
✓ [UNVERIFIED → VERIFIED] conf 0.70→0.80  All DB access goes through src/db/store.ts
~ [VERIFIED → STALE]       conf 0.80→0.20  Money amounts are integer cents
    STATIC_CHECK: FAIL (command exited 1)
? [UNVERIFIED]             conf 0.55→0.52 (decayed)  We chose LWW over CRDTs
```

- `✓` verified, `~` stale, `?` unverified, `✗` refuted.
- The arrow shows a status change; `(decayed)` means only confidence moved (from age).

## Automatic verification

`dim init` installs git hooks that re-run the cheap tier for you:

| Hook | Trigger |
|---|---|
| `post-merge` | after `git pull` / merge |
| `post-checkout` | after switching branches |
| `post-rewrite` | after a rebase |

So most of the time you never run `dim verify` by hand — memory re-checks itself as the repo
moves. The hooks are **additive**: if you already have these hooks, aiDimag appends to them
and never clobbers your logic.

## Evidence trust gate (team sync)

Executable evidence (`STATIC_CHECK`, `TEST_RESULT`, `EXEC_TRACE`) is a shell command — and
with [team sync](/guides/team-sync), those commands can arrive from other machines. aiDimag
therefore **never executes evidence you didn't approve locally**:

- Evidence written or approved **on this machine** is trusted automatically.
- Evidence that **arrived via sync** is *skipped* during verification with the note
  `untrusted (synced) evidence — inspect & approve with dim verify --trust`.
- `dim verify --trust` lists each untrusted command alongside its claim and asks for a
  one-time approval before running anything.

## What "stale" means for agents

A stale memory isn't deleted — it's **down-ranked in search and clearly labeled**, so agents
are told *not to trust it* until it recovers. When you fix the code (or the claim), the next
verify flips it back toward verified and its confidence climbs again.

## Recovering a stale memory

1. Decide whether the **code** is wrong or the **claim** is outdated.
2. If the code drifted, fix it; re-run `dim verify`.
3. If the claim is genuinely no longer true, **refute** it (`dim refute <id>`) so it's kept
   as negative knowledge, or update it with a new memory.

Staleness is also **self-healing**: the moment a memory goes stale, `dim verify` drafts a
follow-up proposal (source `verify:stale`) into the [review queue](/guides/review-queue)
that quotes the failed evidence and asks whether the code drifted or the claim is outdated —
so a stale belief is never a dead end.

Next: **[The review queue](/guides/review-queue)**.
