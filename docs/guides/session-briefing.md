# Session briefings

A **session briefing** grounds an agent (or you) *before* any code is written. Instead of
diving in and guessing, you start from what the project already knows about the area you're
about to touch.

## Print a briefing

```sh
dim brief
```

Example:

```
# Session briefing
branch: feature/XXX-2100-token-refresh · ticket: XXX-2100
in scope: 4 changed file(s)

## Guardrails in scope ⚠️
- 🚫 NEVER: Never call the production payments API from src...

## Relevant memory
- (VERIFIED, CONVENTION) All DB access goes through src/db/store.ts
- (VERIFIED, GOTCHA) refreshToken() run twice concurrently logs the user out

## Stale — do NOT trust without re-verifying
- (INVARIANT) Money amounts are integer cents

## No memory coverage
- src/payments/new-flow.ts

## Unanswered questions (searches that found nothing)
- "webhook retry policy" (asked 3×)

## Ask the user before guessing
- A INVARIANT for src/billing is STALE — has it changed?
- No memory covers src/payments/new-flow.ts — want me to explore it first?
- Past sessions searched for "webhook retry policy" and found nothing — do you know the answer?
```

## What it pulls together

The briefing looks at your current branch (and the files changed on it) and surfaces:

- **Guardrails in scope** — the rules that apply to what you're touching.
- **Relevant memory** — the highest-confidence conventions, gotchas, and decisions for these
  files.
- **Stale warnings** — memory you should *not* trust until re-verified.
- **Coverage gaps** — changed files no memory knows anything about.
- **Unanswered questions** — recent searches (yours or an agent's) that found *nothing*;
  the questions the brain keeps being asked but can't answer (see `dim gaps`).
- **Suggested questions** — things to ask the human instead of guessing.

## For agents (MCP)

The same briefing is available to MCP agents two ways:

- the **`session_start` prompt** — tells the agent to read the briefing and *interview you*
  (ask the suggested questions) before coding;
- the **`aidimag://session-briefing` resource** — the raw briefing as a resource.

A good agent loop is: run `session_start` → ask the clarifying questions → respect the
guardrails → use `memory_search` as it goes → `memory_critique` before finishing. See
[MCP integration](/mcp).

## Why start here?

Most wasted AI effort comes from acting on stale assumptions or missing context. The briefing
front-loads exactly the things that prevent that: the rules, the known traps, and the gaps
worth a question. It's the "Spec" layer in one command.

Next: **[Connecting tickets](/guides/tickets)**.

