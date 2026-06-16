# Pre-commit checks

`dim check` moves verification **earlier** — instead of noticing a problem after code lands,
it scans your **staged changes** against active memory and guardrails *before* the commit.

## Run it manually

```sh
dim check
```

It looks at `git diff --cached` and, for the files you changed:

- **re-runs `STATIC_CHECK` evidence** — a now-failing check means your change contradicts a
  claim;
- **matches `never` guardrails** against the added lines — flags a change that does what a
  guardrail forbids;
- **reminds you about in-scope invariants/conventions** that don't have an automated check.

Example output:

```
✗ [GUARDRAIL] 🚫 NEVER guardrail: the staged change appears to do exactly what this forbids
    "Never call the production payments API from src; use the sandbox client..."
~ [CONVENTION] CONVENTION covers a file you changed — make sure it still holds (no automated check attached)
    "Handlers never touch the DB directly"
```

`✗` is a hard violation; `~` is an advisory reminder.

## Warn vs block

By default `dim check` only **warns** (exit 0). To make hard violations fail:

```sh
dim check --block      # exit 1 on a hard violation
```

Check against a ref instead of the staged index:

```sh
dim check -r HEAD~1
```

## Turn it into a pre-commit hook

aiDimag installs a `pre-commit` hook (additively) that runs `dim check --pre-commit`. It's a
**no-op until you opt in** via the `preCommitCheck` setting in `.aidimag/config.json`:

| `preCommitCheck` | Behavior on commit |
|---|---|
| unset / `false` | Hook does nothing |
| `"warn"` / `true` | Prints violations, allows the commit |
| `"block"` | Prints violations and **blocks** the commit on a hard violation |

Set it:

```json
{ "preCommitCheck": "block" }
```

Now a commit that trips a `never` guardrail is stopped:

```
✗ [GUARDRAIL] 🚫 NEVER guardrail: the staged change appears to do exactly what this forbids
dim check: 1 blocking violation(s). Resolve them or commit with --no-verify.
```

You can always bypass in a pinch with `git commit --no-verify`.

## How it compares to `dim verify`

| | `dim verify` | `dim check` |
|---|---|---|
| When | After code lands (and on hooks) | Before a commit, on staged changes |
| Scope | Whole store | Only memories touching changed files |
| Effect | Updates statuses | Reports/blocks; doesn't change statuses |

Think of `dim check` as the **shift-left** companion to `dim verify`: catch the contradiction
at author time, not after.

Next: **[Session briefings](/guides/session-briefing)**.

