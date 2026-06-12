# Tickets Design — ticket-aware memory capture

> Status: T1, T1.5, and core T2 **implemented** (2026-06-11) — see the phasing
> table. Remaining: RemoteProvider via sync server (T3), HttpProvider contract
> doc + Linear (T4), TICKET_REF evidence type (needs evidence-table CHECK
> migration), interactive `dim ticket connect` browser flow.

## Motivation

The Phase 4 pilot's hardest finding: **commit messages carry no rationale** on
most repos ("fix font", "cleanup" → 0/19 mining candidates). But the *why*
almost always exists — it lives in the ticket, not in git. A commit saying
"fix race in token refresh" attached to JIRA XXX-2100 ("Users randomly logged
out on mobile; root cause: concurrent refresh from two tabs; decided to
serialize via mutex rather than dedupe at the gateway because…") is a
DECISION + GOTCHA memory of pilot-grade quality — assembled for free.

Tickets attack the proven weakest link of capture (missing rationale) using
data that already exists and is already linked to commits by convention
(branch names, message prefixes).

## Architecture principle: contract + adapters, not a mandatory service

aidimag core only ever knows ONE thing:

```ts
interface TicketProvider {
  getTicket(id: string): Promise<Ticket | null>;
}
```

All API parsing, auth, pagination, and rate-limit handling lives behind that
boundary. The "middleware" is a **contract**, with several interchangeable
homes:

```
TicketProvider (core contract)
 ├─ JiraProvider       direct API, local creds          ← solo dev
 ├─ GitHubProvider     direct API (issues), local creds
 ├─ LinearProvider     direct API, local creds
 ├─ RemoteProvider     asks the team sync server        ← teams, ZERO local creds
 └─ HttpProvider       any URL implementing the contract ← enterprises / internal tools
```

Why not a standalone middleware service as the default: aidimag is
local-first, zero-infrastructure — SQLite next to the code, no daemon, the
only optional service is the sync server. A mandatory ticket service would be
the first component to break that promise (deploy it, secure it, debug
"is it Jira, the middleware, or aidimag?"). In-process adapters run the same
code with no ops burden.

### The sync server as the team's ticket middleman (the killer use case)

For teams, the middleware role fits the **already-deployed sync server**:

```
dev's aidimag ──getTicket──→ sync server (existing, authenticated) ──→ Jira
```

- **One Jira token for the whole team**, configured once by the admin on the
  server. Individual devs never touch ticketing API keys at all.
- Server-side caching → Jira rate limits stop mattering.
- Ticket data rides the already-authenticated sync channel (brain-scoped keys
  / account tokens — no new auth surface).
- This is where the hosted SaaS is going anyway: hosted integrations are a
  classic team-tier feature.

### HttpProvider: the escape hatch that makes the contract the product

Anyone can stand up their own translation service for an obscure internal
ticketing system, implement `GET /ticket/:id` returning the normalized shape,
and point aidimag at it — without touching aidimag's code.

## Normalized ticket shape (v1 — deliberately minimal)

```ts
interface Ticket {
  id: string;                    // "XXX-2100"
  url: string;                   // deep link for provenance / review UI
  title: string;
  body: string;                  // description, markdown-ish, truncated (~2KB)
  type: "bug" | "story" | "task" | "epic" | "other";
  status: "open" | "in_progress" | "done" | "other";
  labels: string[];
  parent?: { id: string; title: string };  // epic context — scoping signal
}
```

Deliberately NOT in v1: comments, attachments, custom fields, transitions —
that's where every ticketing integration goes to die. Title + body + type
covers ~90% of memory-formation value.

### Kind mapping (classification enrichment)

| Ticket type | Memory kind bias |
|---|---|
| bug | GOTCHA (root cause), FAILED_APPROACH (what didn't fix it) |
| story | DECISION / ARCHITECTURE |
| task / chore | CONVENTION |
| acceptance criteria in body | INVARIANT candidates |

Ticket text still runs through the miner's signal heuristics — blind ingestion
of "Fix login bug" (empty description) must NOT reach the proposal queue, or
review fatigue kills the human gate.

## Capture flow integration

**Hard rule: ticket fetch is lazy and non-blocking.** Jira being down must
never slow a commit or break a sync.

```
git commit
  └─ post-commit hook (existing): extract ticket id ONLY
       — regex on branch name (feature/XXX-2100-…) and message prefix (XXX-2100: …)
       — instant, offline, no network
       — id stored on the queued proposal (ticket_ref column)
…later (review time, or async background):
  └─ getTicket(id) → enrich proposal:
       — claim built from commit subject + ticket title/body why-extraction
       — rationale cites the ticket; evidence gains TICKET_REF:XXX-2100
       — kind re-classified using ticket type
```

### New evidence type: `TICKET_REF`

- Payload: `XXX-2100` (provider resolves to URL).
- Verification semantics (cheap tier): ticket exists; optionally flag when a
  ticket referenced by a VERIFIED memory is reopened (knowledge may be stale).
- Pairs with COMMIT_REF on the same memory: ticket = the why, commit = the what.

### Joins that compound later

Ticket id becomes a join key across the brain: "show me all memories from the
auth epic" (parent/epic), memory ↔ ticket ↔ commits cross-referencing, and a
consensus/event-layer dimension (events already carry payload JSON — add
`ticketId` when known).

## Configuration & credentials UX

Repo (committed, no secrets) — `.aidimag/config.json`:

```json
{
  "tickets": {
    "provider": "jira",                    // jira | github | linear | remote | http
    "pattern": "[A-Z][A-Z0-9]+-\\d+",     // ticket-id regex for branch/message extraction
    "baseUrl": "https://acme.atlassian.net"  // or HttpProvider endpoint
  }
}
```

Credentials (never the repo) — `~/.aidimag/credentials.json`, mode 0600, same
store as sync tokens.

Friendly connect flow (matches `dim login` ergonomics):

```
dim ticket connect jira
  → asks base URL
  → opens the API-token page in the browser
  → prompts for paste, validates with a live getTicket round-trip
  → stores the token locally, prints a warm confirmation
dim ticket status | disconnect
dim ticket show XXX-2100        # debugging / trust-building
```

Teammates inherit the *configuration* via git and supply only the *credential*
— or nothing at all when the team uses RemoteProvider (sync server holds the
team token; admin configures once via `dim serve` env / dashboard).

## Natural-language interaction (applies beyond tickets)

The current surface is dev-tool terse ("1 proposal(s) queued"). For a tool
whose pitch is trustworthy knowledge, nudges should read like a colleague:

> 🧠 Looks like you just wrapped up XXX-2100 ("Serialize token refresh").
> I drafted 2 memories from the ticket + your commits — take a look?  (dim review)

Principles:
- The **commit-time nudge** stays one line and non-blocking (already shipped);
  ticket context makes it specific instead of generic.
- **Review becomes conversational**: show the claim, ask keep / reword / drop;
  accept free-text edits before approval.
- The **MCP agent is often the better prompting surface**: at session end the
  agent can ask naturally ("you fixed the race — should I remember that token
  refresh must never run concurrently?"). CLI nudges remain the no-agent path.
- Manual prompting is the *fallback*, not the primary path — the best prompt
  is the one the branch name already answered.

## Branch naming enforcement (admin-defined convention)

Teams use wildly different ticket formats (`ABC123`, `abcd-12234`, `1234-ab`).
The admin defines the convention once, committed to the repo; every member's
hooks enforce it automatically after `dim init` — no per-dev setup.

### Config (committed, no secrets) — `.aidimag/config.json`

```json
{
  "tickets": {
    "provider": "jira",
    "pattern": "[A-Z][A-Z0-9]+-\\d+",
    "branch": {
      "pattern": "^(feature|bugfix|hotfix|chore)/[A-Z][A-Z0-9]+-\\d+(-[a-z0-9-]+)?$",
      "exempt": ["main", "develop", "release/.*"],
      "enforce": "push"        // "push" (block) | "warn" | "off"
    }
  }
}
```

### Enforcement layers (honest about what git allows)

Git has **no client-side hook that can prevent branch creation** —
`git branch` / `git checkout -b` fires nothing blockable. So enforcement is
layered:

| Layer | Blocks? | Mechanism |
|---|---|---|
| Creation (local) | warn only | `post-checkout` hook (already installed): on branch-creation checkouts, validate the name; print a friendly warning + the rename command (`git branch -m feature/XXX-2100-…`) |
| **Push** | **✅ yes** | new `pre-push` hook: refuse to push refs whose branch name fails the pattern (unless exempt). A branch that can't be pushed is effectively unusable → compliance without blocking local experimentation |
| Server | ✅ yes | the same regex applied as GitHub rulesets / GitLab push rules / Bitbucket branch restrictions — catches `--no-verify` bypassers. `dim ticket branch-rule --print github` emits the config to paste |
| Creation UX (carrot) | n/a | `dim branch XXX-2100`: fetches the ticket title via TicketProvider and creates `feature/XXX-2100-serialize-token-refresh` — correctly formed, less typing than doing it by hand |

Design choices:
- **Local creation stays free** (scratch branches, experiments); the gate sits
  at the team boundary (push). `enforce: "warn"` mode for gradual rollout.
- Friendly language per the NL principle:
  > 🌿 `my-fix` doesn't match the team's branch convention
  > (`feature/<TICKET>-<desc>`). Rename with:
  > `git branch -m feature/XXX-2100-my-fix` — or next time:
  > `dim branch XXX-2100`
- The branch pattern **embeds the ticket pattern**, so a conforming branch
  name always yields an extractable ticket id — closing the loop with capture:
  enforced convention ⇒ reliable `TICKET_REF` on every proposal mined from
  that branch's commits.
- Exempt list covers trunk/release branches and CI bots.

## Phasing

| Phase | Scope |
|---|---|
| T1 ✅ | `TicketProvider` interface + ticket-id extraction in the post-commit miner (per-commit from the message; branch-name fallback on incremental mines; stored as `proposals.ticket_ref`; no network) |
| T1.5 ✅ | Branch convention enforcement: `pre-push` block + `post-checkout` warn via hidden `dim branch-check` (`tickets.branch.{pattern,exempt,enforce}` in committed config); `dim branch <ticket-id>` helper (id-only without a provider; title slug with one) |
| T2 ✅ (core) | JiraProvider + GitHubProvider + HttpProvider, `dim ticket connect/status/disconnect/show` (flag-based), lazy enrichment in interactive review (5s timeout, offline-safe). Remaining: `TICKET_REF` evidence type (evidence-table CHECK migration), interactive browser connect flow |
| T3 | RemoteProvider via sync server (team-shared credentials, caching); dashboard config UI; `dim ticket branch-rule --print github\|gitlab` for server-side rule generation |
| T4 | HttpProvider contract doc (public, versioned); Linear + others as demand shows |
| T5 | Conversational review (`dim review` interactive rewording) ✅ shipped early with the NL layer; agent-side session-end ticket awareness remains |

## Open questions

1. Ticket-id extraction on repos with multiple patterns (monorepo with two
   Jira projects) — list of patterns? per-path config?
2. Should TICKET_REF failures (ticket deleted/moved) flip memories STALE, or
   only annotate? (Leaning: annotate only — ticket lifecycle is weaker signal
   than code evidence.)
3. Body truncation strategy: first N chars vs "description until first heading"
   vs why-marker extraction. Needs corpus testing on real tickets.
4. Privacy: ticket text may be more sensitive than code comments (customer
   names, incident details). Enrichment must be visible/editable at review
   before anything becomes active memory; consider a `tickets.redact` pattern
   list in config.
5. Rate limits on RemoteProvider: per-brain caching TTL? (Jira default ~50K
   req/day is generous; GitHub 5K/h is not.)
6. Branch enforcement vs. existing repos: rolling out `enforce: "push"` on a
   repo with hundreds of legacy branch names — grandfather existing branches
   (only validate branches created after the config landed)? `warn` period
   first by convention?

