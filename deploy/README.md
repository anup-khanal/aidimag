# Deploying the aidimag sync server (hosted "SaaS" v0)

This turns `dim serve` into a hosted team service in ~10 minutes. It's the
self-hostable core of the future SaaS — OAuth/billing layer on top comes later
(see ../CLOUD_DESIGN.md).

## Option A — Fly.io (recommended, ~$2/mo or free tier)

```sh
cd deploy
fly launch --copy-config --no-deploy            # creates the app from fly.toml
fly volumes create aidimag_data --size 1        # persistent SQLite volume
fly secrets set AIDIMAG_SYNC_TOKEN=$(openssl rand -hex 32)   # ADMIN token — save it!
cd .. && npm run build && fly deploy --config deploy/fly.toml --dockerfile deploy/Dockerfile
```

Your server: `https://aidimag-sync.fly.dev`

## Option B — any Docker host (Railway, Render, a VPS)

```sh
npm run build
docker build -f deploy/Dockerfile -t aidimag-sync .
docker run -d -p 8787:8787 -v aidimag_data:/data \
  -e AIDIMAG_SYNC_TOKEN=<admin-token> aidimag-sync
```

Put HTTPS in front (Caddy/Traefik/cloud LB) before real use — tokens travel as
Bearer headers.

## Onboard a team

```sh
# 1. Owner mints a brain-scoped key (admin token never leaves the owner)
AIDIMAG_ADMIN_TOKEN=<admin-token> dim keys create \
  --server https://aidimag-sync.fly.dev --brain myrepo --label team

# 2. Each member links + syncs (key from step 1, NOT the admin token)
dim cloud link --server https://aidimag-sync.fly.dev --brain myrepo --token aidimag_sk_...
dim sync
```

Revoke a laptop or leaked key anytime:

```sh
AIDIMAG_ADMIN_TOKEN=... dim keys list   --server https://aidimag-sync.fly.dev
AIDIMAG_ADMIN_TOKEN=... dim keys revoke --server https://aidimag-sync.fly.dev --key aidimag_sk_...
```

## Security model (v0)

| Credential | Scope | Where it lives |
|---|---|---|
| Admin token (`AIDIMAG_SYNC_TOKEN`) | mint/revoke keys, all brains | Fly secret + owner's password manager |
| `aidimag_sk_…` key | one brain, sync only | each member's `~/.aidimag/credentials.json` |

Claims may contain code fragments — keep the server private to the team, use
HTTPS, and rotate keys on departure. E2E encryption mode is on the roadmap
(CLOUD_DESIGN.md).

## What the real SaaS adds later
GitHub OAuth (`dim login`), Stripe per-seat billing, Postgres instead of SQLite,
hosted team dashboard, consensus verification reports, audit/export APIs.
The sync protocol stays identical — clients won't change.

