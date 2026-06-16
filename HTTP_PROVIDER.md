# HttpProvider contract — bring your own ticket middleware

> Contract version: **v1** (stable). aidimag treats this document as the public,
> versioned interface; breaking changes will bump the version and keep v1 working.

aidimag never needs to understand your ticketing system. If it speaks this tiny
HTTP contract, `dim` can enrich memory proposals from it — Jira behind a
corporate proxy, Redmine, Trac, a spreadsheet, anything.

## The whole contract

One endpoint:

```
GET <baseUrl>/ticket/<id>
```

- `<id>` is URL-encoded (e.g. `XXX-2100`, `%23123` for `#123`).
- Optional auth: aidimag sends `Authorization: Bearer <token>` when the user
  stored a credential (`dim ticket connect http`); send nothing otherwise.
- aidimag aborts the request after **5 seconds** — ticket fetch is lazy and
  non-blocking by design, so a slow middleware degrades gracefully (the
  proposal just shows the raw ticket id).

### Responses

| Case | Status | Body |
|---|---|---|
| Found | `200` | the normalized `Ticket` JSON below |
| Not found | `404` | anything (ignored) |
| Anything else | `4xx`/`5xx` | treated as a transient provider error |

### The normalized `Ticket` shape (v1)

```jsonc
{
  "id": "XXX-2100",                  // required — echo the requested id (canonical form ok)
  "url": "https://tickets.acme.com/XXX-2100",  // required — deep link for provenance / review UI
  "title": "Users randomly logged out on mobile",  // required
  "body": "Root cause: concurrent token refresh from two tabs…",  // required; "" if none; truncate to ~2KB
  "type": "bug",                     // required — one of: bug | story | task | epic | other
  "status": "done",                  // required — one of: open | in_progress | done | other
  "labels": ["auth", "mobile"],      // required — [] if none
  "parent": { "id": "XXX-2000", "title": "Auth hardening epic" }  // optional — epic/parent context
}
```

Rules of thumb when mapping your system:

- **`type`** drives memory-kind classification (bug → GOTCHA/FAILED_APPROACH,
  story → DECISION/ARCHITECTURE, task → CONVENTION). When unsure, use `other`.
- **`status`** is used for staleness hints (a reopened ticket on a VERIFIED
  memory may mean stale knowledge). Map your workflow states to the four values.
- **`body`** should carry the *why* — description text, markdown-ish is fine.
  Truncate server-side (~2KB); aidimag truncates again defensively.
- Deliberately **not** in v1: comments, attachments, custom fields,
  transitions. Don't send them; they'll be ignored.

## Minimal reference implementation

```js
// node ticket-middleware.mjs — 20 lines, zero deps
import { createServer } from "node:http";

createServer(async (req, res) => {
  const m = req.url.match(/^\/ticket\/(.+)$/);
  if (!m) { res.writeHead(404); return res.end(); }
  const t = await lookupInYourSystem(decodeURIComponent(m[1])); // ← your code
  if (!t) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    id: t.key, url: t.link, title: t.summary,
    body: (t.description ?? "").slice(0, 2048),
    type: t.isBug ? "bug" : "other",
    status: t.closed ? "done" : "open",
    labels: t.tags ?? [],
  }));
}).listen(8899);
```

Point aidimag at it:

```
dim ticket connect http --url http://localhost:8899 [--token <bearer>]
dim ticket show XXX-2100        # round-trip test
```

## Notes for teams

- The **sync server speaks the same contract** internally: `dim ticket share`
  stores your provider + credential server-side, and members fetch through
  `GET /v1/ticket?brain=…&id=…` with their existing sync tokens (10-minute
  server-side cache). An HttpProvider middleware can therefore also be shared
  team-wide without distributing its bearer token.
- Rate limits live behind YOUR middleware — aidimag fetches lazily (review
  time, `dim ticket show`, `dim branch`) and never in commit hooks.

