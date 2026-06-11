# Phase 6 Design — aidimag Cloud (Team Memory Sync)

> Status: in progress (updated 2026-06-11). Self-hostable core shipped; SaaS
> groundwork (device login, event log, consensus, auto-sync) shipped — see
> "Implementation status" below. Remaining: hosted infra (Postgres, GitHub
> OAuth, Stripe, hosted console).

## Architecture principle: local-first, cloud as sync — never as query path

The cloud is a **sync + aggregation layer**, not a remote database the agent queries.

| Concern | Where it lives | Why |
|---|---|---|
| Memory reads (`memory_search`, recall) | **Local SQLite** (full replica) | Agents query dozens of times/session; must be instant + offline |
| Verification (evidence runs) | **Local machines** | Evidence only means something against *a checkout of the repo*; the server can't run your greps/tests |
| Truth for sync | **Cloud append-only event log** | Git-like model; merge conflicts resolved deterministically |
| Aggregation | **Cloud** | "3 of 4 machines confirm this memory PASSes at HEAD" → consensus confidence |
| Team dashboard | **Cloud-hosted `dim ui`** | Same page already built; reads Postgres instead of SQLite |

### Sync model
- Append-only **events**: `memory_created`, `status_changed`, `evidence_result`,
  `refuted`, `superseded`, `proposal_*`. Each client keeps a sync cursor.
- `dim sync` = push events since cursor, pull events since cursor, apply to local DB.
  Runs automatically (debounced) after `remember` / `review` / `verify`.
- **Conflict resolution = verification arbitration**: when two memories contradict,
  whichever claim's evidence PASSes at current HEAD wins; the loser flips STALE with a
  `contradicts` link. Metadata conflicts: last-writer-wins.

## Auth model

```
Account (human)   dim login → browser OAuth (GitHub) → device token in ~/.aidimag/credentials
Team              owns repo-brains + billing (per-seat)
Repo API key      aidimag_sk_… scoped to ONE repo brain — for CI & headless agents (AIDIMAG_API_KEY)
```

- Tokens are Bearer over HTTPS; keys revocable individually.
- **Secrets never live in the repo.** `.aidimag/config` (committed!) holds only the
  cloud brain ID; `memory.db*` and credentials stay gitignored.
- Later: optional E2E encryption (team passphrase → client-side key; server stores
  ciphertext; search stays local so nothing is lost server-side).

## Setup UX

```sh
# owner, once
dim login
dim cloud init        # create + link cloud brain; writes brain-id to .aidimag/config
dim sync

# teammate, two minutes
dim login
git clone … && dim init   # finds brain-id in committed config
dim sync                  # pulls entire team brain → instant onboarding
```

## Infrastructure

### v1 — minimal viable cloud (1–2 weeks, ~$5–20/mo)
- **API**: Hono or Fastify (TypeScript, shares types with the CLI) on Fly.io/Railway
- **DB**: Postgres (Neon/Supabase)
  - `events` (append-only log — the truth)
  - `memories` (materialized view for dashboard)
  - `users`, `teams`, `repo_brains`, `api_keys`
  - `verification_reports` (machine, memory, evidence result, repo HEAD sha)
- **Endpoints (~6)**: `POST /sync/push`, `GET /sync/pull?since=`, `POST /auth/device`,
  key/team CRUD. Hard logic (merge/verify/rank) stays in the already-built client.
- **Auth**: GitHub OAuth (Auth.js or Clerk) + device-code flow for CLI
- **Billing**: Stripe per-seat
- **Console**: hosted `dim ui` (reuse the existing page, Postgres-backed)

### v2 — when teams are real
- WebSocket push (teammate's memory appears mid-session)
- Managed deep-verification runners: server-side sandboxes cloning the repo and
  running `dim verify --deep` on schedule → feeds consensus confidence
- Ticket middleman: the sync server holds team-shared ticketing credentials and
  proxies/caches `getTicket` for all members (see TICKETS_DESIGN.md, phase T3)
- Audit log / export APIs (governance: "what did our agents believe and when")
- Enterprise: SSO/SAML, VPC or on-prem deployment

### Deliberately NOT built
- Server-side search / vector infra (reads are local)
- Kubernetes / microservices (one API + one Postgres until far past PMF)

## New CLI surface
```
dim login | logout            device OAuth                          ✅ built (device-code flow on dim serve)
dim cloud init|link|unlink    manage repo-brain binding             ✅ link/unlink/status built (init = hosted-only)
dim sync [--push|--pull]      manual sync (auto otherwise)          ✅ built incl. debounced auto-sync after writes
dim keys create|revoke|list   repo-scoped API keys                  ✅ built (revoke also kills account tokens)
```

## Implementation status (2026-06-11)

| Piece | Status |
|---|---|
| Self-hostable sync server (`dim serve`), LWW + tombstones | ✅ shipped |
| Brain-scoped API keys (`dim keys`) | ✅ shipped |
| Device-code login (`dim login`/`logout`, `/v1/auth/device|approve|token`, `aidimag_at_…` account tokens with inherited brain scope) | ✅ shipped |
| Append-only event log (local `events` table, `schema_version` + machine id per event, pushed on sync to `/v1/events`, idempotent ingest) | ✅ shipped |
| Verification consensus (`verification_report` events anchored to HEAD sha; `GET /v1/consensus` aggregates latest report per machine) | ✅ shipped |
| Auto-sync (debounced 30s after remember/review/verify/refute/forget; `AIDIMAG_AUTO_SYNC=off` to disable) | ✅ shipped |
| GitHub OAuth on the approval page, Postgres, Stripe billing, hosted console | ⏳ hosted-infra phase (after npm publish) |
| Event-sourced *replication* (events as the sync truth, replacing row snapshots) | ⏳ later — snapshots remain the replication mechanism; events are the audit/consensus layer |

## Monetization mapping
- Free OSS: everything local (today's product)
- Team ($15–25/seat/mo): sync, shared brain, hosted console, consensus verification
- Enterprise: SSO, audit, on-prem, cross-repo org memory
- Add-ons: managed deep-verify runners, hosted embeddings

## Open questions
1. Event schema versioning across CLI versions (carry `schema_version` per event; server is permissive, clients migrate)
2. Partial sync for monorepos (scope filters per path prefix?)
3. Abuse/size limits: max claim length, evidence payload linting (no secrets in payloads — add a pre-push scanner)
4. Privacy review before launch: claims often contain code fragments → data-processing terms, optional E2E mode

