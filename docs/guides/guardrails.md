# Guardrails

A **guardrail** is a behavioral rule for AI agents — not just a fact to know, but an
instruction to obey. Each guardrail has an **enforcement level** that tells the agent how
strict it is.

## The three levels

| Level | Icon | Meaning |
|---|---|---|
| `never` | 🚫 | The agent must **refuse** to do this and explain why |
| `ask-first` | 🤚 | The agent must **confirm with you** before doing it |
| `always` | ✅ | The agent should **do it automatically**, no need to ask |

## Create one

```sh
# A hard "never"
dim remember "Never call the production payments API from src; use the sandbox client in src/payments/sandbox.ts" \
  -k GUARDRAIL -g never -p src/payments

# An "ask-first"
dim remember "Ask before adding a new third-party dependency" -k GUARDRAIL -g ask-first

# An "always"
dim remember "Always run the formatter before committing" -k GUARDRAIL -g always
```

`-g` (`--guardrail-level`) is required for guardrails; if you omit it, it defaults to
`ask-first`.

## Where guardrails show up

Guardrails are the **highest-signal** memory, so aiDimag surfaces them everywhere:

- **Generated context** — they're listed **first** in `CLAUDE.md` / `.cursorrules` /
  `copilot-instructions.md`, with their level icons.
- **Session briefing** — in-scope guardrails appear at the top of `dim brief` and the
  `session_start` prompt.
- **`memory_critique`** — when an agent reviews its work, guardrail violations are flagged
  before anything else.
- **`dim check`** — a `never` guardrail whose forbidden action shows up in a staged diff is
  reported (and can block the commit).

## How `dim check` enforces a "never"

If you stage a change that appears to do exactly what a `never` guardrail forbids:

```
✗ [GUARDRAIL] 🚫 NEVER guardrail: the staged change appears to do exactly what this forbids
    "Never call the production payments API from src; use the sandbox client..."
```

With the pre-commit hook in `block` mode, that commit is stopped. See
[Pre-commit checks](/guides/dim-check).

## Guardrails are still verifiable

A guardrail can carry evidence like any other memory. For example, attach a `STATIC_CHECK`
that greps for the forbidden call, so the guardrail goes **stale** if someone bypasses it —
turning a soft rule into a checked one:

```sh
dim remember "Never import the production client in src" -k GUARDRAIL -g never -p src \
  -e "STATIC_CHECK:! grep -rq prodClient src"
```

## Tips

- Phrase a `never` so the forbidden thing is **named** (specific function, module, API) —
  that's what `dim check` keyword-matches against.
- Use `always` sparingly; reserve it for safe, mechanical actions.
- Pin guardrails you never want to expire: add `--pin`.

Next: **[Skills](/guides/skills)**.

