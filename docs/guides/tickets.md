# Connecting tickets

Commits tell you *what* changed; tickets usually hold the *why* — the root cause, the
rejected alternatives, the acceptance criteria. aiDimag can connect to your ticketing system
so that context flows into your memory.

## Supported providers

- **Jira**
- **GitHub Issues**
- **Linear**
- **A custom HTTP provider** (your own middleware — see `design/HTTP_PROVIDER.md` in the repo)
- **The team sync server** (share one credential with the whole team)

## Connect

```sh
dim ticket connect
```

This runs an interactive flow that asks for your provider and credentials and writes the
non-secret parts to `.aidimag/config.json` (the token stays in your local credentials file).

```sh
dim ticket status      # show what's connected
dim ticket show XXX-2100
```

## What you get

### Ticket ids extracted automatically (offline)

aiDimag pulls the ticket id from your **branch name** or **commit messages** using a pattern
in your config — no provider needed. Mined proposals are tagged with that id automatically.

### Live context at review time

When a provider *is* connected, `dim review` shows the ticket's title, type, status, and body
next to each proposal, so you can confirm the *why* before approving:

```
── 1 of 2 ── GOTCHA · mined from commit a1b2c3d4
   "refreshToken() twice concurrently logs the user out."
   ticket: XXX-2100 "Session drops on rapid navigation" (bug, done) — https://...
```

### Agents can fetch tickets

The MCP `ticket_get` tool lets an agent pull the current ticket (auto-detected from the
branch) at session end, so its proposals carry the real rationale.

## Branch conventions

You can define a branch-naming convention and have aiDimag warn or block on violations:

```sh
dim ticket branch-rule        # manage the convention; prints server-side rules too
dim branch XXX-2100           # create a conforming branch (fetches the title for the slug)
```

| Enforcement | Effect |
|---|---|
| `off` | No checking |
| `warn` | A heads-up at branch creation (`post-checkout`) |
| `push` | Blocks pushing a non-conforming branch (`pre-push`) |

## Team-shared credentials

So every teammate doesn't need their own ticket token, one person can share the credential
through the sync server:

```sh
dim ticket share
```

Members then resolve tickets via the server and hold **zero** ticket tokens locally.

Next: **[Team sync](/guides/team-sync)**.

