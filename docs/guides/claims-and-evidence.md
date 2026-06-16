# Writing claims & evidence

The quality of your memory comes down to two things: writing **falsifiable claims** and
attaching **evidence**. This guide shows how to do both well.

## What makes a good claim

A claim should be a statement that could, in principle, be **checked against the code** and
found true or false.

| ❌ Vague (avoid) | ✅ Falsifiable (good) |
|---|---|
| "The auth code is tricky." | "JWT refresh in `src/auth/refresh.ts` must run before the middleware chain; reordering breaks session renewal." |
| "We use a service layer." | "All HTTP handlers call a `*Service` class; handlers never touch the DB directly." |
| "Don't break the API." | "Every response from `src/api/` is validated against the Zod schema in `src/api/schemas.ts`." |

Tips:

- **Be specific and scoped.** Name files, symbols, and conditions.
- **State the consequence.** "…reordering breaks session renewal" tells the reader *why*.
- **One idea per memory.** Split compound rules so each can be verified independently.

## Scope it

Use `-p` (paths) and `-s` (symbols) to say where a memory applies. Scoped memories surface
exactly when an agent touches those files:

```sh
dim remember "Money amounts are integer cents, never floats" \
  -k INVARIANT -p src/billing -s Money
```

Leave scope off only for genuinely repo-wide rules.

## Attach evidence

Evidence is what lets a memory **verify itself** over time. Pick the cheapest type that
proves the claim.

### STATIC_CHECK — a shell command

The most useful type. The command should exit `0` **only if the claim holds**.

```sh
# "Nothing outside src/db imports better-sqlite3"
dim remember "All DB access goes through src/db/store.ts" -k CONVENTION -p src/db \
  -e "STATIC_CHECK:grep -rL better-sqlite3 src --include=*.ts"

# "The routes directory exists"
-e "STATIC_CHECK:test -d src/routes"

# "No TODO markers left in the payments module"
-e "STATIC_CHECK:! grep -rq TODO src/payments"
```

### COMMIT_REF — anchor to a commit

Proves a decision was made at a known commit. Add `:path1,path2` to also fail if those files
change later.

```sh
-e "COMMIT_REF:abc1234"
-e "COMMIT_REF:abc1234:src/auth/refresh.ts"
```

### TEST_RESULT — a test command (deep tier)

Runs only with `dim verify --deep`. Exit 0 = pass.

```sh
-e "TEST_RESULT:npm test -- auth/refresh.test.ts"
```

### EXEC_TRACE — command output must match (deep tier)

Format is `command :: expected-output-regex`.

```sh
-e "EXEC_TRACE:node -e 'console.log(typeof config.port)' :: number"
```

### HUMAN_ATTESTED — last resort

"A human said so." It verifies once, then decays fastest, because nobody is re-checking it.
Use it only when no machine check is possible.

## Multiple pieces of evidence

You can attach several. A memory goes **stale** if *any* piece fails, and **verified** when
all the machine-checkable ones pass:

```sh
dim remember "Public API responses are schema-validated" -k INVARIANT -p src/api \
  -e "STATIC_CHECK:grep -rq schema.parse src/api" \
  -e "TEST_RESULT:npm test -- api/contract.test.ts"
```

## Verify your work

After adding evidence, confirm it actually checks what you think:

```sh
dim verify -i <id>
```

If it flips to **verified**, your evidence works. If it's unexpectedly **stale**, your
command is wrong (or the claim is already false) — fix one of them.

## Why bother with evidence?

A claim without evidence can only ever be *unverified* and will slowly **decay** until it's
demoted. A claim *with* evidence re-confirms itself automatically as the code evolves — and
loudly goes stale the moment reality diverges. That self-correction is the entire point of
aidimag.

Next: **[Verifying memories](/guides/verifying)**.

