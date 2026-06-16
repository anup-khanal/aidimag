# Skills

A **skill** is a reusable, step-by-step procedure your team runs repeatedly — how you
deploy, how you cut a release, how you reset a local environment. Storing it as memory means
agents (and people) can recall the exact steps instead of guessing.

## Create one

Write the steps as a numbered list inside the claim:

```sh
dim remember "Deploy: 1) run npm test 2) bump the version 3) git tag v<x.y.z> 4) push tags 5) fly deploy" \
  -k SKILL
```

aiDimag recognizes the `1) … 2) …` pattern and renders it as an ordered list in generated
context files:

```md
## Skills (reusable procedures)
- **Deploy**
  1. run npm test
  2. bump the version
  3. git tag v<x.y.z>
  4. push tags
  5. fly deploy
```

## Scope a skill (optional)

If a procedure only applies to part of the repo, scope it:

```sh
dim remember "Reset local DB: 1) docker compose down -v 2) docker compose up -d 3) npm run migrate" \
  -k SKILL -p docker-compose.yml
```

## How skills surface

- **Generated context** — skills get their own section in `CLAUDE.md` etc.
- **Search** — `dim recall deploy` (or an agent's `memory_search`) finds the matching skill
  by keyword/semantic match, so the right procedure shows up exactly when it's relevant.

## When to use a skill vs a convention

| Use a **skill** when… | Use a **convention** when… |
|---|---|
| It's a *procedure* with ordered steps | It's a *rule* about how code is written |
| You'd otherwise paste the same steps repeatedly | It describes a consistent pattern |
| "How do we deploy / release / migrate?" | "Handlers never touch the DB directly" |

## Tip: pin your core procedures

Deployment and release steps rarely change and shouldn't expire. Pin them:

```sh
dim remember "Release: 1) ... 2) ... 3) ..." -k SKILL --pin
```

Next: **[Pinned memories](/guides/pinned)**.

