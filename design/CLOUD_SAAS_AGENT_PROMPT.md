# AI Agent Prompt — Build aiDimag Cloud MVP

Copy everything below the line into a new agent session to start implementation.

---

## Mission

Build **aiDimag Cloud** — a lightweight Node.js hosted service that lets users sign up, subscribe, create cloud sync **projects** (brains), mint **API keys**, and sync their local aidimag memory databases from the existing CLI/IDE clients.

**Read first:** `design/CLOUD_SAAS_REQUIREMENTS.md` in the aidimag OSS repo (or a copy in your cloud repo's `docs/`). Also skim aidimag's `src/sync/server.ts`, `src/sync/client.ts` for protocol reference.

**Local development path:** `aidimag/aidimag-cloud/` (inside OSS repo). **Production path:** [anupkhanal/aidimag-cloud](https://github.com/anupkhanal/aidimag-cloud) — migrate before launch.

```bash
cd aidimag/aidimag-cloud   # already inside aidimag clone
npm install
```

**Do not** change the local-first architecture: agents query local SQLite; the cloud is sync-only.

Keep cloud code in **`aidimag-cloud/`** — do not scatter cloud routes into the OSS `src/` tree.

---

## Hard constraints

1. **Local dev:** work in **`aidimag-cloud/`** at the root of the aidimag clone (`"aidimag": "file:.."`). **Before launch:** migrate to `git@github.com:anup-khanal/aidimag-cloud.git`.
2. **Hostinger MVP hosting:** ~200 GB disk, ~3 GB RAM; **platform + sync data in Hostinger MySQL**; deploy **aidimag-cloud repo root** after migration.
3. **Production repo:** [anupkhanal/aidimag-cloud](https://github.com/anupkhanal/aidimag-cloud) — `git@github.com:anup-khanal/aidimag-cloud.git`
4. **Node 20**, lightweight stack: **Fastify** (or Hono) + **Drizzle** + **MySQL 8** (`mysql2`).
5. **Billing:** Stripe subscriptions; **bill per active API key** (revoked keys free).
6. **Auth:** Web signup/login (email + GitHub OAuth); CLI uses existing Bearer `aidimag_sk_*` and device flow.
7. **Roles:** `user` (self-service admin) + `super_admin` (platform operator).
8. **Visual design:** Modern SaaS UI with **shadcn/ui + Tailwind CSS**. Theme with aidimag brand colors (`#2563eb`, `#0ea5e9`, `#06b6d4`); copy logo/assets from `../docs/public/` into `public/`. Dark mode support required.
9. **Compatibility:** Must work with published aidimag CLI commands:
   - `dim cloud link --server <url> --brain <id> --token <key>`
   - `dim sync`
   - `dim login` / `dim logout`
   - `dim keys create|list|revoke` (against cloud server with user auth)

---

## Repository layout (`aidimag-cloud/` — local dev folder)

Work inside the existing folder at **`aidimag/aidimag-cloud/`** (sibling to `src/`, `docs/`, etc.):

```
aidimag-cloud/                 # repo root = Hostinger app root
  package.json
  tsconfig.json
  drizzle.config.ts
  docs/
    REQUIREMENTS.md            # copy of ../design/CLOUD_SAAS_REQUIREMENTS.md (optional)
  src/
    server.ts                  # Fastify entry
    config.ts                  # env validation (Zod)
    types/
      sync.ts                  # SyncItem, EventItem (from aidimag npm or copied)
    db/
      schema.ts
      migrations/
    routes/
      v1/                      # Sync API (aidimag-compatible)
        push.ts
        pull.ts
        events.ts
        consensus.ts
        keys.ts
        auth-device.ts
        health.ts
      api/
        auth.ts
        projects.ts
        billing.ts
        webhooks-stripe.ts
      admin/
        users.ts
        metrics.ts
    services/
      sync.ts                  # Port from aidimag src/sync/server.ts
      keys.ts
      billing.ts
      projects.ts
    middleware/
      auth-session.ts
      auth-bearer.ts
      require-super-admin.ts
  web/                         # Vite + React + shadcn/ui
    components/
      ui/
      layout/
      marketing/
      app/
    lib/utils.ts
    pages/
      ...
    styles/globals.css
    index.html
    main.tsx
    tailwind.config.ts
    components.json
  public/                      # logo.svg etc. (copied from aidimag docs/public)
  README.md
  .env.example
```

**OSS dependency (local dev):** `"aidimag": "file:.."` in package.json. Switch to `"^1.0.0"` from npm when migrating to the standalone repo.

---

## Implementation order

### Step 1 — Scaffold & config
- Work in **`aidimag-cloud/`** (already created inside the aidimag repo).
- Initialize/scaffold at folder root with TypeScript, Fastify, Drizzle, Zod, dotenv.
- Use `"aidimag": "file:.."` for the local OSS dependency.
- Add `"aidimag": "^1.0.0"` dependency; add `src/types/sync.ts` if types aren't exported from npm.
- Initialize `web/` with **Vite + React + TypeScript + Tailwind**.
- Run **shadcn/ui init** (`npx shadcn@latest init`) — style: **New York** or **Default**, base color: **Zinc**, CSS variables: **yes**.
- Override shadcn `--primary` / `--ring` in `globals.css` to aidimag blue/cyan (see requirements §11.0).
- Install core shadcn components: `button`, `card`, `input`, `label`, `form`, `table`, `dialog`, `dropdown-menu`, `badge`, `tabs`, `alert`, `toast`, `sonner`, `accordion`, `progress`, `skeleton`, `separator`, `alert-dialog`, `navigation-menu`.
- Env schema: `DATABASE_URL`, `SESSION_SECRET`, `APP_URL`, `STRIPE_*`, `GITHUB_*`, `SUPER_ADMIN_EMAIL`.
- Single `npm run dev` starts API + Vite dev proxy; `npm run build` produces Hostinger-deployable output.

### Step 2 — MySQL schema + migrations
Implement tables from requirements §10 (Drizzle **mysql** dialect):
- Platform: `users`, `subscriptions`, `projects`, `api_keys`
- Sync: port from `src/sync/server.ts` SQLite schema → `sync_items`, `sync_latest`, `sync_events`, `device_codes`, `account_tokens`
- Use `JSON` columns for payloads where reasonable; fall back to `LONGTEXT` for large memory snapshots
- Seed script: promote `SUPER_ADMIN_EMAIL` to `super_admin` on first login
- Connection pool: max 5–10 connections (Hostinger shared MySQL limits)

### Step 3 — Sync API (`/v1/*`)
Port handlers from `src/sync/server.ts` with these changes:
- Multi-tenant: resolve Bearer token from `api_keys.key_hash` or `account_tokens`
- Enforce `key.brain === query.brain`
- Reject push/events if user suspended or subscription inactive (configurable grace)
- Keep response shapes identical to self-host server

Test with local aidimag CLI:
```sh
dim cloud link --server http://localhost:3000 --brain test-brain --token aidimag_sk_...
dim sync
```

### Step 4 — Account API
- Signup/login/logout (Lucia or Auth.js sessions)
- GitHub OAuth
- CRUD projects (auto-generate unique `brain_id`)
- CRUD keys via `/api/projects/:id/keys` — display secret once; store hash only
- Quota: count active keys vs `subscriptions.key_quota` before create

### Step 5 — Stripe billing
- Create Stripe products/prices for plans in requirements §7 (monthly + yearly)
- `POST /api/billing/checkout` → Stripe Checkout Session
- Webhook: `checkout.session.completed`, `customer.subscription.updated/deleted` → update `subscriptions`
- `GET /api/billing/portal` → Stripe Customer Portal
- Block key creation when over quota; show upgrade path in API error + UI

### Step 6 — Web UI (shadcn + Tailwind)

Use requirements §11.0 as the design spec. **Every page must use shadcn components** — no unstyled HTML.

Marketing (public):
- `/` — gradient hero, feature `Card` grid, CTA buttons, footer with OSS docs link
- `/pricing` — plan cards with monthly/yearly `Switch`, FAQ `Accordion`
- `/how-it-works` — numbered steps + copyable code blocks
- Shared `MarketingNav` with logo, links, Login/Signup buttons, dark mode toggle

App (auth required):
- `AppShell` — sidebar or top nav, user `DropdownMenu`, subscription `Badge`
- `/app` — project `Table` or cards, key usage `Progress`
- `/app/projects/:id` — `Tabs` (Setup / Keys), `Dialog` for one-time key reveal, copy buttons
- `/app/billing`, `/app/settings`
- `/approve` — device login card

Admin (`super_admin`):
- `AdminShell` — separate nav under `/admin`
- Metrics `Card` grid, users `Table` with search

Polish:
- `sonner` toasts for create/revoke/copy actions
- `Skeleton` loaders on data fetch
- Empty states with CTA
- Mobile-responsive (Tailwind breakpoints)
- `ThemeProvider` for light/dark mode

### Step 7 — Super-admin & ops
- Admin metrics: total users, active keys, MRR from Stripe
- Suspend user → invalidate sync
- README with Hostinger deploy steps: hPanel MySQL setup, Node web app config, env vars, Stripe webhook URL

### Step 8 — Tests & acceptance
- Integration test: signup → create project → mint key → push/pull round-trip
- Test quota block + revoke
- Test Stripe webhook handler (mock)
- Verify all items in requirements §16 acceptance criteria

---

## Key implementation notes

### API key format
Match existing server: prefix `aidimag_sk_`, generate with `randomBytes`, store SHA-256 hash, show full key only on create (same UX as `dim keys create`).

### brain_id generation
URL-safe unique id per project, e.g. `slug-${randomBase32(4)}`. User sees it in `dim cloud link --brain`.

### Do NOT use per-user memory.db files on disk
All sync state lives in **Hostinger MySQL** (`JSON`/`LONGTEXT` columns) mirroring current SQLite payloads. Each brain is a row namespace, not a file — cleaner for multi-tenant auth and billing even though 200 GB disk could hold SQLite files.

### CORS
Only needed if SPA on different origin; prefer same-origin Fastify static serve for MVP.

### shadcn theme setup (required first UI task)

After `shadcn init`, customize `web/styles/globals.css`:

```css
:root {
  --primary: 217 91% 53%;           /* aidimag #2563eb */
  --primary-foreground: 0 0% 100%;
  --ring: 199 89% 48%;              /* aidimag #0ea5e9 */
}
.dark {
  --primary: 213 94% 68%;           /* lighter blue for dark mode */
}
```

Use gradient utilities for marketing hero: `bg-gradient-to-br from-blue-600 via-sky-500 to-cyan-400`.

### Extract vs copy sync logic
Port handler logic into `src/services/sync.ts` in **aidimag-cloud**, copied from aidimag OSS `src/sync/server.ts` with an upstream comment. Do **not** require changes to the aidimag repo for MVP. Optional later: export shared module from OSS npm package.

---

## Pages copy guidance (match aidimag voice)

**Homepage hero:** “Your team’s codebase memory — synced, verified, local-first.”

**Subhead:** “aiDimag Cloud hosts the sync layer. Your agents still read local memory instantly. Connect with `dim cloud link` in minutes.”

**Pricing FAQ bullets:**
- Billed per active API key (each laptop, CI job, or agent slot).
- Revoked keys stop billing immediately.
- Self-hosting remains free for small teams (link to OSS license).

**Project setup snippet (generate in UI):**
```sh
dim init
dim cloud link --server https://YOUR_CLOUD_URL --brain BRAIN_ID --token YOUR_KEY
dim sync
```

---

## Libraries (approved OSS)

| Purpose | Library |
|---------|---------|
| HTTP | `fastify`, `@fastify/static`, `@fastify/cookie` |
| DB | `drizzle-orm`, `mysql2` (Hostinger MySQL) |
| Auth | `lucia` + `@lucia-auth/adapter-drizzle` OR `@auth/core` |
| OAuth | GitHub via auth library |
| Payments | `stripe` |
| Frontend | `vite`, `react`, `react-router-dom` |
| UI | **shadcn/ui** (Radix primitives), `class-variance-authority`, `clsx`, `tailwind-merge` |
| Styling | `tailwindcss`, `tailwindcss-animate`, `@tailwindcss/typography` (optional, marketing prose) |
| Icons | `lucide-react` |
| Toasts | `sonner` |
| Theming | `next-themes` (works outside Next.js — shadcn dark mode pattern) |
| Forms | `react-hook-form`, `@hookform/resolvers`, `zod` |
| IDs | `uuid` or `nanoid` |
| Hashing | Node `crypto` scrypt/sha256 |

Avoid: heavy Next.js SSR on Hostinger, Kubernetes, Redis (use MySQL for sessions MVP).

---

## Environment bootstrap checklist

```sh
# Hostinger MySQL (hPanel → Databases → MySQL Databases)
# Create database + user; note host (usually localhost from Node app on same server)

# Local dev — point at Hostinger MySQL remotely OR run local MySQL 8 with same schema:
DATABASE_URL=mysql://user:pass@localhost:3306/aidimag_cloud

# Run migrations
npm run db:migrate

# Stripe (test mode)
# Products: Starter (1 key), Developer (3), Team (10), Business (25)
# Prices: monthly + yearly each

# Hostinger Node app — connect GitHub: anupkhanal/aidimag-cloud (repo root)
# git@github.com:anup-khanal/aidimag-cloud.git
# Entry: dist/server.js
# Node 20, production env vars set
```

---

## Definition of done

The MVP is complete when a new user can:

1. Visit homepage → sign up → pay (Stripe test card).
2. Create project → mint API key.
3. Run `dim cloud link` + `dim sync` from a real aidimag repo and see memories sync.
4. Create a second key (quota permitting) for a teammate.
5. Revoke a key and confirm sync fails for that key.
6. Super-admin can view and suspend the user in `/admin`.
7. App deploy instructions in `README.md` fit Hostinger Node + Hostinger MySQL + Stripe (aidimag-cloud repo).
8. UI feels like a modern SaaS product (shadcn components, responsive, dark mode) — not a bare admin panel.

---

## Out of scope for this agent session

- Changing the **aidimag OSS repo** (except optional type-export PR on a separate branch)
- IDE plugin changes (VS Code / IntelliJ already work via CLI)
- Server-side memory search / embeddings
- Event-sourced replication replacing LWW
- Legal pages content (stub routes OK; flag for human review)
- **aidimag docs site redesign** (`docs/` VitePress) — future work per requirements §20; cloud may link to docs but must not refactor VitePress in this session

---

## First command to run

```sh
cd aidimag-cloud
npm install
# Scaffold per Step 1 above
```

When MVP is ready, migrate to `git@github.com:anup-khanal/aidimag-cloud.git` (see requirements §4).

Work incrementally; commit logical chunks; keep `README.md` updated as you go.
