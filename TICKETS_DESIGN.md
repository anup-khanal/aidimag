# Tickets Design — ticket-aware memory capture (future)

> Status: design draft (2026-06-11). Not yet implemented. Builds on the capture
> pipeline (Phase 2), the post-commit capture hook, and team sync (Phase 6).

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

## Phasing

| Phase | Scope |
|---|---|
| T1 | `TicketProvider` interface + ticket-id extraction in the post-commit miner (id stored on proposals; no network) |
| T2 | JiraProvider + GitHubProvider, `dim ticket connect/status/show`, lazy enrichment at review time, `TICKET_REF` evidence |
| T3 | RemoteProvider via sync server (team-shared credentials, caching); dashboard config UI |
| T4 | HttpProvider contract doc (public, versioned); Linear + others as demand shows |
| T5 | Conversational review (`dim review` interactive rewording); agent-side session-end ticket awareness |

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

