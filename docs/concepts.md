# Core concepts

This page explains every moving part in plain English. If you read only one reference page,
read this one.

## Memory

A **memory** is a single piece of knowledge about your codebase, written as a short,
checkable statement (a *claim*). Each memory has:

- a **kind** (decision, convention, guardrail, …),
- a **claim** (the statement itself),
- a **scope** (which files/symbols it applies to — or the whole repo),
- optional **evidence** (how to check it's true),
- a **status** and a **confidence** score,
- and flags like **pinned**.

## Kinds

Kinds are just categories that help organize and surface the right knowledge:

- **Decision** — a choice + the rejected alternatives.
- **Convention** — a rule the repo follows consistently.
- **Gotcha** — surprising behavior that wasted time.
- **Failed approach** — a dead end, recorded so nobody retries it.
- **Architecture** — how components fit together.
- **Invariant** — something that must always/never hold.
- **Guardrail** — a behavioral rule for agents with an enforcement **level**:
  `never`, `ask-first`, or `always`. See [Guardrails](/guides/guardrails).
- **Skill** — a reusable procedure, often written as numbered steps. See [Skills](/guides/skills).
- **Todo context** — unfinished work + how to pick it back up.

## Status

Every memory is always in exactly one of four states:

![The life of a memory: proposal → memory → verified or stale, with pin and forget exits](/diagram-lifecycle.svg){.dim-diagram}

| Status | Meaning |
|---|---|
| **Unverified** | Stored, but its evidence hasn't confirmed it (or it has none yet). |
| **Verified** | Its machine-checkable evidence currently passes. Trust it. |
| **Stale** | Evidence that used to pass now **fails** — the code changed under it. Don't trust it until it recovers. |
| **Refuted** | Deliberately marked false (by a human or agent). Kept as *negative knowledge* — "we believed this until it stopped being true." |

The important rule: **a failing check always makes a memory stale**, no matter what else
is true about it. That's what keeps memory honest.

## Evidence

Evidence is *how a claim proves itself*. Types:

| Evidence | What the payload is | Tier |
|---|---|---|
| **STATIC_CHECK** | A shell command; exit code 0 means the claim holds | cheap |
| **COMMIT_REF** | A commit SHA that must exist/be an ancestor (optionally `sha:path1,path2`) | cheap |
| **TEST_RESULT** | A test command, run with `CI=1`; exit 0 = pass | deep |
| **EXEC_TRACE** | `command :: expected-output-regex`; passes if output matches | deep |
| **HUMAN_ATTESTED** | "A human said so" — verifies once, then decays fastest | — |
| **TICKET_REF** | Links the memory to a ticket (e.g. `XXX-2100`) | — |

"Cheap" evidence runs automatically (e.g. on every `git pull`). "Deep" evidence runs only
when you ask (`dim verify --deep`), because it executes tests.

## Confidence and decay

Each memory carries a **confidence** between 0 and 1. Two forces move it:

- **Evidence** — passing checks raise it; failing checks floor it.
- **Time** — knowledge that can't be machine-re-verified **decays** (loses confidence
  gradually). A verified memory whose confidence decays too far is quietly demoted back to
  unverified. Trust *expires* unless it's re-confirmed.

This is deliberate: a fact nobody has checked in months should be trusted less than one
that passed its check this morning.

## Pinned memories

Some knowledge should never expire — a foundational architectural decision, a hard rule.
You can **pin** a memory:

- Pinned memories are **exempt from time decay** (they won't fade just from age).
- They are **still falsifiable** — if their evidence fails, they still go stale.

"Never decays" is not the same as "never wrong." See [Pinned memories](/guides/pinned).

## Proposals and the review gate

aiDimag never adds memory behind your back. Knowledge that's *inferred* — by the commit
miner, by an agent at the end of a session — enters a **proposal queue** instead of becoming
active memory. You approve, reword, or reject each one with `dim review`. This is the
**human gate**, and it's the reason you can trust what's in the store. See
[The review queue](/guides/review-queue).

## The three layers (Spec · Verifier · Environment)

aiDimag is organized around a simple framework popularized by Andrej Karpathy:

- **Spec** — give the agent your understanding in a usable form. aiDimag injects relevant
  memories and a session briefing.
- **Verifier** — let the work be checked. aiDimag re-runs evidence, offers `memory_critique`,
  and catches contradictions before commits with `dim check`.
- **Environment** — a persistent, improving workspace. The `.aidimag/` folder, generated
  `CLAUDE.md`, guardrails, and skills.

You don't need to think about these layers to use aiDimag, but they explain why the
features fit together the way they do.

## Where everything lives

```
your-repo/
├── .aidimag/
│   ├── memory.db          # the SQLite store (gitignored by default)
│   └── config.json        # repo settings (safe to commit — no secrets)
├── CLAUDE.md              # generated context (optional)
└── .git/hooks/            # additive hooks aidimag installs
```

Next: **[How it works](/how-it-works)** for the mechanics, or
**[Getting started](/getting-started)** to set it up.

