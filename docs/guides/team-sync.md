# Team sync

By default aiDimag is single-player: memory lives in a local SQLite file. To share a **team
brain** for a repo, run a small sync server — no SaaS required.

## The model

- **Local-first.** Everyone still reads/writes their own local replica; nothing blocks on the
  network.
- **`dim sync` exchanges changes** — last-writer-wins by modification time, with tombstones so
  deletions propagate.
- **The server is a dumb ordered log.** All the smart merging, verification, and ranking stay
  on each client. The future hosted version uses this same protocol.

## Set up a server

Run it anywhere reachable — a laptop, a VPS, Fly.io:

```sh
dim serve --token <shared-secret> --db ./team-sync.db --port 8787
```

(See `deploy/` in the repo for a Dockerfile + Fly.io config — about 10 minutes to a private
hosted server.)

## Link a repo

Each team member, inside the repo:

```sh
dim cloud link --server http://your-server:8787 --brain myrepo --token <shared-secret>
dim sync
```

The server URL and brain name go in `.aidimag/config.json` (safe to commit). The **token**
goes in `~/.aidimag/credentials.json` — never in the repo. So onboarding a teammate is:

```sh
dim init
dim cloud link --token <secret>
dim sync
```

## Automatic sync

Sync also runs **automatically** (debounced, ~30s) after `remember`, `review`, `verify`,
`refute`, and `forget`. Disable it with `AIDIMAG_AUTO_SYNC=off`.

## Device login instead of pasting tokens

```sh
dim login
```

Shows a short code, opens the server's approval page, and an existing credential approves the
device. The minted token inherits that approver's brain scope and is revocable. `dim logout`
clears it.

## API keys (don't share the admin token)

The `--token` you start the server with is the **admin** token. Mint revocable, brain-scoped
member keys instead of sharing it:

```sh
AIDIMAG_ADMIN_TOKEN=... dim keys create --brain myrepo --label alice
# → aidimag_sk_...  (only valid for that brain)

dim keys list --brain myrepo
dim keys revoke --key aidimag_sk_...
```

## Cross-machine consensus

Every memory-lifecycle change (create / status / evidence / verification) is recorded in a
local append-only **event log** and shipped on sync. The server aggregates verification
reports across machines, so you can answer: *"How many machines confirm this memory passes at
commit X?"* — turning one developer's green check into team-wide confidence.

## Check status

```sh
dim cloud status
```

Next: **[Knowledgebase (planned)](/guides/knowledgebase)**.

