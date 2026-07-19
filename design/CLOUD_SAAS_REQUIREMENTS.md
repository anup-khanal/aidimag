# aiDimag Cloud — MVP Requirements Document

> **Status:** draft for implementation planning (2026-07-17)  
> **Audience:** product owner, implementers, AI coding agents  
> **Related:** [CLOUD_DESIGN.md](./CLOUD_DESIGN.md), [deploy/README.md](../deploy/README.md), [docs/pricing.md](../docs/pricing.md)

---

## 1. Executive summary

Build **aiDimag Cloud** — a hosted sync and account service so developers can sign up, create cloud-backed **brains** (one per codebase/project), mint **API keys**, and sync local `.aidimag/memory.db` replicas from the CLI and IDE extensions.

The OSS product already ships a self-hostable sync server (`dim serve`), brain-scoped keys (`dim keys`), device login (`dim login`), and push/pull/event APIs. The cloud MVP wraps that protocol with **user accounts, billing, a marketing site, and an admin console** — without changing the local-first model (agents still read local SQLite; the cloud is sync + dashboard, not a remote query database).

**Repository:** Production home is **[anupkhanal/aidimag-cloud](https://github.com/anupkhanal/aidimag-cloud)** (`git@github.com:anup-khanal/aidimag-cloud.git`). **During development**, the app lives in **`aidimag-cloud/`** inside the aidimag repo for convenience; migrate to the separate repo before launch (see §4).

**Initial hosting target:** Hostinger Business Web Hosting (Node.js, ~3 GB RAM, **~200 GB disk**). The **included MySQL database** on the same account stores platform and sync data — recommended for multi-tenant architecture; no external DB vendor required for MVP.

---

## 2. Goals

| # | Goal |
|---|------|
| G1 | Users can sign up, subscribe, and create one or more **projects** (each maps to a sync **brain**). |
| G2 | Users can mint **multiple API keys per project**; each active key is a **billable unit**. |
| G3 | Existing aidimag clients connect unchanged: `dim cloud link`, `dim sync`, `dim login`, `AIDIMAG_API_KEY`. |
| G4 | Marketing homepage + secondary pages with a **modern SaaS UI** (shadcn/ui + Tailwind) that complements aidimag branding. |
| G5 | Authenticated **user admin**: projects, keys, billing, usage. |
| G6 | **Super-admin** (platform operator): manage all accounts, subscriptions, keys, suspension. |
| G7 | Lightweight Node.js deployable on Hostinger MVP plan (standalone repo, repo root = app root). |
| G8 | Monthly and yearly subscription options via a payment provider. |

---

## 3. Non-goals (MVP)

- Server-side `memory_search` / vector search (reads stay local per [CLOUD_DESIGN.md](./CLOUD_DESIGN.md)).
- Managed deep-verification runners (v2).
- E2E encryption mode.
- SSO/SAML, VPC, on-prem enterprise features.
- Mobile apps or native IDE plugin rewrites (reuse existing VS Code / IntelliJ + CLI).
- Event-sourced replication replacing LWW snapshots (future; snapshots remain sync truth for MVP).
- Multi-region HA (single region MVP is fine).
- **aidimag docs site UI/UX refresh** (`docs/` VitePress in the OSS repo) — defer to post-cloud MVP; see §20.
- Changes to **aidimag OSS core** beyond optional type exports — cloud app code stays in `aidimag-cloud/` (dev) / separate repo (prod).

---

## 4. Relationship to existing aidimag OSS

### Repository strategy (local dev → separate repo)

| Phase | Location | Notes |
|-------|----------|-------|
| **Development (now)** | `aidimag-cloud/` inside [anupkhanal/aidimag](https://github.com/anupkhanal/aidimag) | Local dev; use `"aidimag": "file:.."` in package.json; easy access to OSS sync source |
| **Production (launch)** | [anupkhanal/aidimag-cloud](https://github.com/anupkhanal/aidimag-cloud) | Move folder contents to separate repo; switch dependency to `"aidimag": "^1.0.0"` from npm; deploy repo root to Hostinger |

| Repo | Purpose |
|------|---------|
| **`anupkhanal/aidimag`** (OSS) | CLI, MCP, local memory, self-host `dim serve`, docs, IDE extensions; **`aidimag-cloud/` dev folder** |
| **`anupkhanal/aidimag-cloud`** | Production Git remote — `git@github.com:anup-khanal/aidimag-cloud.git` |

**Migration (when MVP is ready):**
```sh
cd aidimag-cloud
git init
git remote add origin git@github.com:anup-khanal/aidimag-cloud.git
# Update package.json: "aidimag": "^1.0.0" instead of "file:.."
git add . && git commit -m "Initial cloud MVP" && git push -u origin main
# Optionally remove aidimag-cloud/ from OSS repo or keep a stub README pointing to the new repo
```

- Cloud **depends on** `aidimag` — `file:..` while developing inside aidimag; npm version in production.
- Cloud **implements** the `/v1/*` sync protocol by porting logic from aidimag `src/sync/server.ts` — it does not embed or subprocess the OSS CLI.
- Brand assets (logo, hero SVG) may be **copied** into `aidimag-cloud/public/` — do not git-submodule the whole aidimag repo.
- OSS docs remain the technical reference; cloud marketing links out to [aidimag docs](https://github.com/anupkhanal/aidimag).

### What already exists in OSS (reference — do not reimplement in cloud)

| Component | OSS location (`aidimag` repo) | Cloud approach |
|-----------|-------------------------------|----------------|
| Sync protocol | `src/sync/server.ts` | Port handlers to MySQL in **aidimag-cloud** |
| Sync client | `src/sync/client.ts` | Unchanged — users run `dim` from npm |
| Key format | OSS server | Same: `aidimag_sk_…`, `aidimag_at_…` |
| Local memory store | `src/db/store.ts` | Stays on user machines only |
| Web dashboard | `src/ui/` | Optional later; MVP uses cloud's own shadcn UI |
| Self-host deploy | `deploy/` | Unrelated — cloud uses Hostinger Node + MySQL |

### Architectural invariant (must preserve)

```
CLI/IDE/MCP  →  reads/writes LOCAL memory.db  →  dim sync  →  Cloud (append log + latest state)
```

The cloud **never** becomes the hot path for agent recall. Violating this breaks aidimag’s core value (instant, offline, verified local memory).

### Client configuration after signup

Committed in repo (no secrets):

```json
// .aidimag/config.json
{
  "server": "https://cloud.aidimag.com",
  "brain": "<project-brain-id>"
}
```

Secrets in `~/.aidimag/credentials.json` or `AIDIMAG_API_KEY` env.

---

## 5. User personas

| Persona | Needs |
|---------|-------|
| **Solo developer** | 1 project, 1–2 keys (laptop + CI), easy signup, connect Cursor/CLI in minutes. |
| **Team lead** | Multiple projects, multiple keys per project (each teammate/CI slot), billing visibility. |
| **Platform operator (super-admin)** | User support, abuse control, revenue metrics, suspend bad actors. |

---

## 6. Hosting constraints (Hostinger MVP)

| Resource | Limit | Implication |
|----------|-------|-------------|
| Disk | ~200 GB | Plenty for Node app, static assets, logs, and backups. Confirm exact quota in hPanel (some plans split web vs Node app limits). |
| MySQL (included) | Plan quota (check hPanel) | Platform tables + all brain sync payloads — recommended over per-user SQLite files for multi-tenant ops. |
| RAM | 3072 MB | Sufficient for one Node process + MySQL on shared hosting. |
| CPU | 2 cores | Fine for MVP traffic. |
| Node | 18.x–24.x | Target **Node 20 LTS**. |
| Frameworks | Express, Fastify, Hono, NestJS, Next.js, etc. | Prefer **Fastify** or **Hono** (lightweight). Next.js is viable with 200 GB disk if preferred. |
| Web root | `public_html` | App entry via Hostinger Node.js Web App config. |

### Database: Hostinger MySQL (MVP default)

| Service | Purpose |
|---------|---------|
| **Hostinger MySQL** (included) | Platform DB + sync state — users, projects, keys, subscriptions, `sync_items`, `sync_events`, etc. |
| **Stripe** | Subscriptions (monthly/yearly), customer portal, webhooks |
| **Resend** or **Hostinger SMTP** | Transactional email (verify email, receipts) — optional MVP |
| **Cloudflare** (optional) | DNS, TLS, caching for static marketing pages |

**Critical decision:** Store sync payload data in **MySQL** (port schema from `src/sync/server.ts`) — each **brain** is a namespace (row filter on `brain_id`), not a separate file. MySQL is chosen for multi-tenant querying, backups, and key/quota enforcement — not because disk is tight (200 GB is ample).

**Alternative (not recommended for MVP):** per-brain SQLite files on disk would work with 200 GB storage, but complicates multi-tenant auth, backups, and connection handling.

**Why MySQL on Hostinger for MVP:**
- Same account as the Node app — no Neon cold starts, no second vendor
- Included in Business hosting — fits early user count
- Low latency (`localhost` or internal Hostinger DB host)

**Verify in hPanel before launch:** max database size, max connections, number of databases allowed. Monitor storage as sync payloads grow.

**Upgrade path (post-MVP):** migrate to managed Postgres (Neon, Supabase) if you outgrow shared MySQL limits or need HA. Design with Drizzle migrations so the ORM layer stays portable.

### Sync conflict model (unchanged by DB choice)

Clients use **last-writer-wins (LWW)** on `updated_at` for the same memory id. The cloud DB stores authoritative latest state; clients merge on pull. See [docs/guides/team-sync.md](../docs/guides/team-sync.md). Contradictory *claims* (different memory ids) are handled by **verification** (`dim verify`), not by the sync layer.

---

## 7. Product model

### Entities

```
Account (user)
  └── Subscription (Stripe)
  └── Project[]          ← maps 1:1 to sync "brain"
        └── ApiKey[]     ← aidimag_sk_* ; each ACTIVE key counts toward billing
        └── Usage stats  ← last sync, item count, storage bytes (approx)
```

### Billing unit: **per active API key**

- User’s subscription covers **N active keys** (or unlimited tier).
- Creating a key within quota → allowed immediately.
- Creating a key over quota → blocked until upgrade or another key is revoked.
- **Revoked keys** do not count toward billing.
- **Device login tokens** (`aidimag_at_…`) inherit scope from approving key; MVP can treat them as non-billable extensions of an existing key, or bill 1 account token per user — **default: non-billable** if minted via an already-paid key’s approval flow.

### Suggested MVP pricing (adjust before launch)

| Plan | Active keys | Monthly | Yearly (≈2 mo free) |
|------|-------------|---------|---------------------|
| **Starter** | 1 | $9 | $90 |
| **Developer** | 3 | $19 | $190 |
| **Team** | 10 | $49 | $490 |
| **Business** | 25 | $99 | $990 |

Add-ons (post-MVP): extra key packs (+5 keys for $15/mo).

OSS aidimag remains free for self-host / ≤10 users local-only per Elastic License 2.0; **cloud is a separate hosted product**.

---

## 8. Authentication & authorization

### End-user auth (web app)

| Method | MVP | Notes |
|--------|-----|-------|
| Email + password | ✅ | bcrypt/argon2; email verification recommended |
| GitHub OAuth | ✅ | Matches [CLOUD_DESIGN.md](./CLOUD_DESIGN.md); use **Auth.js** or **Lucia** |
| Magic link | optional | Nice-to-have |

Session: HTTP-only secure cookies (web) or JWT in cookie for API routes from same origin.

### CLI / IDE auth (unchanged protocol)

| Flow | Endpoint | MVP behavior |
|------|----------|--------------|
| API key | Bearer `aidimag_sk_…` | Minted in user admin; stored server-side as hash; scope = one project brain |
| Device login | `/v1/auth/device`, `/v1/auth/approve`, `/v1/auth/token` | Approval page requires **logged-in web session**; user selects which project/key scope to grant |
| Admin token | `AIDIMAG_SYNC_TOKEN` equivalent | **Platform super-admin only** — not issued to customers |

### Roles

| Role | Capabilities |
|------|--------------|
| `user` | Own projects, keys, billing, sync |
| `super_admin` | All users, impersonation (optional), suspend, platform metrics, manual comp subscriptions |

Enforce: every sync request resolves `brain` → `project` → `account` and verifies key belongs to that brain and account is active + within key quota.

---

## 9. API surface

### 9.1 Sync API (must stay compatible with aidimag clients)

Implement the existing v1 protocol (see `src/sync/server.ts` header comment):

| Method | Path | Auth |
|--------|------|------|
| POST | `/v1/push?brain=` | Bearer key/token |
| GET | `/v1/pull?brain=&since=` | Bearer |
| POST | `/v1/events?brain=` | Bearer |
| GET | `/v1/consensus?brain=` | Bearer |
| GET | `/v1/health` | public |
| POST | `/v1/auth/device` | public |
| GET/POST | `/v1/auth/approve` | web session for POST |
| POST | `/v1/auth/token` | device_code |
| POST | `/v1/keys` | admin or user session (cloud: user session) |
| GET | `/v1/keys` | admin or user session |
| DELETE | `/v1/keys?key=` | admin or user session |

**Change from self-host:** `/v1/keys` is no longer gated by a single `AIDIMAG_SYNC_TOKEN`; instead, authenticated users manage keys for their own projects via web UI **and** authenticated API (for automation).

### 9.2 Cloud account API (new)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/auth/signup` | Register |
| POST | `/api/auth/login` | Session |
| POST | `/api/auth/logout` | Session |
| GET | `/api/me` | Profile + subscription summary |
| GET/POST | `/api/projects` | List/create projects (creates brain id) |
| GET/PATCH/DELETE | `/api/projects/:id` | Project CRUD |
| GET/POST | `/api/projects/:id/keys` | List/create keys (enforce quota) |
| DELETE | `/api/projects/:id/keys/:keyId` | Revoke |
| GET | `/api/billing/portal` | Stripe customer portal redirect |
| POST | `/api/billing/checkout` | Start subscription |
| POST | `/api/webhooks/stripe` | Stripe events |
| GET | `/api/projects/:id/stats` | Last sync, memory count estimate |

### 9.3 Super-admin API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/admin/users` | Paginated user list |
| GET | `/api/admin/users/:id` | Detail + projects + keys |
| POST | `/api/admin/users/:id/suspend` | Block sync + login |
| POST | `/api/admin/users/:id/unsuspend` | Restore |
| GET | `/api/admin/metrics` | MRR, active keys, sync volume |
| PATCH | `/api/admin/users/:id/plan` | Manual comp / override |

Protect with `super_admin` role + separate env secret for bootstrap first admin.

---

## 10. Data model (Hostinger MySQL)

Target **MySQL 8.0+** (JSON column support). Use `CHAR(36)` for UUIDs or `BINARY(16)` if preferred. Timestamps as `DATETIME(3)`.

### Platform tables

```sql
users (
  id            CHAR(36) PRIMARY KEY,
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NULL,      -- null if OAuth-only
  github_id     VARCHAR(64) UNIQUE NULL,
  role          ENUM('user','super_admin') DEFAULT 'user',
  status        ENUM('active','suspended') DEFAULT 'active',
  stripe_customer_id VARCHAR(255) NULL,
  created_at    DATETIME(3) NOT NULL
)

subscriptions (
  id                      CHAR(36) PRIMARY KEY,
  user_id                 CHAR(36) NOT NULL,
  stripe_subscription_id  VARCHAR(255),
  plan_id                 VARCHAR(32),    -- 'starter' | 'developer' | ...
  status                  VARCHAR(32),  -- active | past_due | canceled
  key_quota               INT NOT NULL,
  interval                ENUM('month','year'),
  current_period_end      DATETIME(3),
  FOREIGN KEY (user_id) REFERENCES users(id)
)

projects (
  id         CHAR(36) PRIMARY KEY,
  user_id    CHAR(36) NOT NULL,
  name       VARCHAR(255) NOT NULL,
  brain_id   VARCHAR(128) UNIQUE NOT NULL,  -- sync namespace, e.g. 'acme-api-a1b2'
  created_at DATETIME(3) NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
)

api_keys (
  id         CHAR(36) PRIMARY KEY,
  project_id CHAR(36) NOT NULL,
  key_prefix VARCHAR(16) NOT NULL,     -- first 12 chars for display
  key_hash   VARCHAR(64) UNIQUE NOT NULL,
  label      VARCHAR(255),
  created_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
)
```

### Sync tables (ported from SQLite schema in `src/sync/server.ts`)

- `sync_items` — append log: `seq BIGINT AUTO_INCREMENT`, `brain`, `tbl`, `id`, `updated_at`, `deleted`, `payload JSON` (or `LONGTEXT` if payloads exceed JSON comfort zone)
- `sync_latest` — materialized latest per `(brain, tbl, id)`
- `sync_events` — append-only events for consensus
- `device_codes`, `account_tokens` — device login flow
- Optional: `ticket_configs` (defer to post-MVP)

Index heavily on `(brain, seq)`. Composite primary key on `sync_latest (brain, tbl, id)`.

**MySQL notes:**
- Use a **small connection pool** (5–10) — shared hosting caps concurrent connections.
- Store large memory snapshots in `LONGTEXT` if JSON size limits become an issue.
- Enable regular exports via hPanel backups or a cron mysqldump for MVP disaster recovery.

---

## 11. Web pages & UI design

### 11.0 Design system (required)

Build a **modern, polished SaaS UI** using:

| Tool | Role |
|------|------|
| **Tailwind CSS v4** (or v3) | Utility-first styling, responsive layout |
| **[shadcn/ui](https://ui.shadcn.com/)** | Accessible, composable components (copy into repo — not an npm black box) |
| **Vite + React 18+** | SPA for `/app`, `/admin`, auth pages; marketing can share the same shell |
| **react-router-dom** | Client routing |
| **lucide-react** | Icons (pairs with shadcn) |

**Do not** hand-roll raw HTML forms/tables for app pages — use shadcn primitives.

#### Brand alignment (aidimag × modern SaaS)

Extend shadcn’s default theme with aidimag tokens from `docs/.vitepress/theme/custom.css`:

```css
/* tailwind / shadcn CSS variables — map to aidimag brand */
--primary: 217 91% 53%;        /* #2563eb */
--primary-foreground: 0 0% 100%;
--ring: 199 89% 48%;           /* #0ea5e9 accent */
/* optional gradient hero: #2563eb → #0ea5e9 → #06b6d4 */
```

- **Typography:** clean sans-serif (Inter or Geist via `@fontsource` or Google Fonts)
- **Layout:** generous whitespace, max-width containers (`max-w-6xl`), sticky nav
- **Marketing:** gradient hero, feature cards, social proof strip, clear CTAs
- **App shell:** sidebar navigation (shadcn `Sidebar` or simple nav), breadcrumb, page headers
- **Dark mode:** support via shadcn `ThemeProvider` + toggle (matches developer audience)
- **Assets:** reuse `docs/public/logo.svg`, `hero-illustration.svg`, diagram SVGs

#### shadcn components to install (MVP)

| Area | Components |
|------|------------|
| Layout | `button`, `card`, `separator`, `badge`, `avatar`, `dropdown-menu`, `navigation-menu`, `sidebar` |
| Forms | `input`, `label`, `form` (react-hook-form + zod), `select`, `checkbox`, `dialog`, `alert` |
| Data | `table`, `tabs`, `tooltip`, `skeleton`, `progress` |
| Feedback | `toast` (sonner), `alert-dialog` |
| Marketing | `accordion` (FAQ), `switch` (pricing monthly/yearly toggle) |

#### UX quality bar

- Responsive mobile-first (marketing + app admin usable on phone)
- Loading skeletons on dashboard fetches
- Toast confirmations for key create/revoke, project create
- Copy-to-clipboard for `brain_id`, API key snippet, `dim cloud link` command
- Empty states with illustration + CTA (“Create your first project”)
- Consistent error states (shadcn `Alert` variant destructive)

### 11.1 Marketing (public)

| Page | Route | Content | UI notes |
|------|-------|---------|----------|
| **Home** | `/` | Hero, problem/solution, how cloud sync fits aidimag, CTA signup, link to OSS docs | Gradient hero, 3-column feature grid (shadcn `Card`), logo strip |
| **Pricing** | `/pricing` | Plans table (monthly/yearly toggle), per-key explanation, FAQ | Pricing cards with highlighted “Popular” tier, FAQ `Accordion` |
| **How it works** | `/how-it-works` | Local-first diagram, 3 steps: signup → link repo → sync | Numbered steps, code block with copy button |
| **Docs** | `/docs` | Link out to GitHub Pages / aidimag docs | Simple link page or embed |
| **Login** | `/login` | Email + GitHub OAuth | Centered `Card`, OAuth button + divider |
| **Signup** | `/signup` | Registration + plan selection | Multi-step or single card form |

### 11.2 App (authenticated)

Shared **app layout**: top nav or left sidebar, user menu (`DropdownMenu`), subscription badge.

| Page | Route | Content | UI notes |
|------|-------|---------|----------|
| **Dashboard** | `/app` | Projects list, subscription status, key usage `3/10` | Project cards or `Table`; usage `Progress` bar |
| **New project** | `/app/projects/new` | Name → creates brain id | Simple form in `Card` |
| **Project detail** | `/app/projects/:id` | Brain id, setup instructions, keys table, revoke, last sync | `Tabs`: Setup / Keys / Activity; key secret in `Dialog` shown once |
| **Create key** | modal on project detail | Label → show secret once | `Dialog` + copy button + warning alert |
| **Billing** | `/app/billing` | Current plan, upgrade, Stripe portal | Plan comparison cards, “Manage billing” button |
| **Settings** | `/app/settings` | Profile, password, GitHub, delete account | `Tabs` for Profile / Security / Danger zone |
| **Device approval** | `/approve` | Device login — user code, pick project scope | Standalone centered card (CLI flow) |

### 11.3 Super-admin

Separate `/admin` shell (same design system, distinct nav). Restrict by `super_admin` role.

| Page | Route | Content | UI notes |
|------|-------|---------|----------|
| **Admin home** | `/admin` | Metrics cards | shadcn `Card` grid: users, active keys, MRR |
| **Users** | `/admin/users` | Search, suspend, view keys/projects | `Table` with search `Input`, row actions |
| **User detail** | `/admin/users/:id` | Subscription override, activity | Detail layout with `Badge` status |

---

## 12. User flows

### 12.1 Signup → first sync

1. User signs up at `/signup`, picks plan, completes Stripe Checkout.
2. Creates project “my-app” → system assigns `brain_id` (e.g. `my-app-x7k2`).
3. User clicks **Create API key** → shown `aidimag_sk_…` once.
4. In repo:
   ```sh
   dim init
   dim cloud link --server https://cloud.aidimag.com --brain my-app-x7k2 --token aidimag_sk_...
   dim sync
   ```
5. IDE/MCP uses same local DB; auto-sync pushes changes every ~30s.

### 12.2 Add teammate key (billable)

1. User creates second key on same project → quota check.
2. Teammate runs `dim cloud link` with their key (config committed; token local).
3. Both machines sync same brain.

### 12.3 Device login (no paste)

1. Teammate runs `dim login` (repo already linked).
2. Browser opens `/approve?code=XXXX`.
3. Logged-in user approves → CLI receives `aidimag_at_…`.

### 12.4 Subscription lapse

1. Stripe webhook → `subscription.status = past_due|canceled`.
2. Cloud allows **read/pull** for 7-day grace (optional) then blocks **push** and key creation.
3. Local aidimag continues working offline; sync errors with clear message.

---

## 13. Security requirements

- TLS everywhere (Hostinger provides; enforce HTTPS redirect).
- Store only **hashed** API keys (bcrypt/sha256+hmac); show full key once at creation.
- Rate limit: auth endpoints, `/v1/push`, device token polling.
- Validate `brain` on every sync request matches key scope.
- CSRF protection on web forms; SameSite cookies.
- Stripe webhook signature verification.
- Audit log (super-admin): key created/revoked, login failures, suspend events.
- Privacy: memory payloads may contain code fragments — publish Data Processing terms; no training on customer data.
- Secrets never in repo config (already aidimag convention).

---

## 14. Tech stack recommendation (MVP)

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Runtime | Node 20 | Hostinger support |
| HTTP | **Fastify** | Lightweight, schema validation, good perf |
| DB | **MySQL 8** (Hostinger included) | Same account; platform + sync data; best fit for multi-tenant SaaS |
| DB driver | **`mysql2`** | Standard Node MySQL driver; works with Drizzle on Hostinger |
| ORM | **Drizzle** | Light, SQL-friendly, migrations; supports MySQL dialect |
| Auth | **Lucia** or **Auth.js** | Session + GitHub OAuth |
| Payments | **Stripe** Billing | Subscriptions + portal |
| Frontend | **Vite + React 18** | SPA for marketing + `/app` + `/admin` in one shell |
| UI components | **[shadcn/ui](https://ui.shadcn.com/)** | Copy into `web/components/ui/` in **aidimag-cloud** repo |
| Styling | **Tailwind CSS** + aidimag brand tokens | Customize shadcn `globals.css` CSS variables |
| Icons | **lucide-react** | Standard shadcn icon set |
| Toasts | **sonner** | shadcn-recommended toast library |
| Forms | **react-hook-form** + **zod** + shadcn `Form` | Validation parity with backend |
| Email | Resend (optional) | Verify + receipts |
| Repository | **[anupkhanal/aidimag-cloud](https://github.com/anupkhanal/aidimag-cloud)** | Standalone app; deploy repo root to Hostinger |
| OSS dependency | **`aidimag`** — `file:..` (dev) / `^1.0.0` npm (prod) | Local dev reads parent package; production uses published npm |

### Dependency on aidimag npm package

In **aidimag-cloud** `package.json`:

```json
"dependencies": {
  "aidimag": "file:.."
}
```

Switch to `"aidimag": "^1.0.0"` when migrating to the standalone repo.

Reuse from the published package where exported:

- Sync types (`SyncItem`, `EventItem`) — if not exported yet, add `src/types/sync.ts` copied from OSS and track upstream.

Optional separate PR to OSS repo to export types — **do not block cloud MVP on aidimag repo changes**. Port sync handler logic into aidimag-cloud (copy from `src/sync/server.ts` with upstream comment); do not require extracting a shared module in OSS for MVP.

---

## 15. Deployment (Hostinger)

### 15.1 MySQL setup (hPanel)

1. **Databases → MySQL Databases** — create database (e.g. `u123456789_aidimag`).
2. Create a dedicated user with full privileges on that database.
3. Note **host** (often `localhost` or `127.0.0.1` from the Node app on the same server), **port** (3306), database name, username, password.
4. Run Drizzle migrations against this database (from local dev first, then on deploy).

### 15.2 Node app setup (aidimag-cloud repo)

1. Build static marketing + server bundle (`npm run build`) in the **aidimag-cloud** repo root.
2. Configure Hostinger **Node.js Web App** connected to **`anupkhanal/aidimag-cloud`** on GitHub (not aidimag OSS).
3. **Root directory:** repo root (`.` ) — no subdirectory; the app lives at the top level.
4. Hostinger build settings:
   | Setting | Value |
   |---------|-------|
   | Node.js | **20.x** |
   | Framework | **Fastify** (or **Other** if not detected) |
   | Install | `npm ci` |
   | Build | `npm run build` |
   | Start | `npm start` |
   | Entry file | `dist/server.js` |

5. Environment variables:
```env
# Hostinger MySQL — use credentials from hPanel
DATABASE_URL=mysql://USER:PASSWORD@localhost:3306/DATABASE_NAME
# Or discrete vars if preferred:
# DB_HOST=localhost
# DB_PORT=3306
# DB_USER=...
# DB_PASSWORD=...
# DB_NAME=...

STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
APP_URL=https://cloud.aidimag.com
SESSION_SECRET=...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
SUPER_ADMIN_EMAIL=...
```

6. Point Stripe webhook to `https://cloud.aidimag.com/api/webhooks/stripe`.

**Disk budget:** 200 GB is more than sufficient. Still keep production `node_modules` lean (`npm ci --omit=dev`) and monitor MySQL storage growth as sync payloads accumulate.

**Connection pooling:** cap pool size at 5–10 to stay within Hostinger MySQL connection limits.

### 15.3 Hostinger hPanel checklist

| Step | hPanel selection |
|------|------------------|
| Database | **Databases → MySQL Databases → Create** |
| Web app | **Websites → Add Website → Deploy Web App** |
| Source | **Import Git Repository** → [anupkhanal/aidimag-cloud](https://github.com/anupkhanal/aidimag-cloud) |
| Node | **20.x** |
| Env vars | Node dashboard → **Environment Variables** |
| After deploy | **Restart** app; test `/v1/health` |

---

## 16. MVP acceptance criteria

- [ ] User can sign up, pay (Stripe test mode), create project, mint key, run `dim cloud link` + `dim sync` successfully against hosted URL.
- [ ] Second key on same project works; blocked when over quota with clear upgrade CTA.
- [ ] Revoked key fails sync with 401.
- [ ] `dim login` device flow works through web `/approve`.
- [ ] Marketing homepage + pricing + how-it-works live; **modern shadcn/ui + Tailwind** with aidimag brand colors.
- [ ] User admin: projects, keys, billing portal.
- [ ] Super-admin can list/suspend users.
- [ ] App runs on Hostinger Node + Hostinger MySQL with sync data in MySQL tables.
- [ ] Health check `/v1/health` returns OK.

---

## 17. Phased delivery

### Phase 0 — Foundation (week 1)
- Scaffold **aidimag-cloud** repo, Hostinger MySQL schema (Drizzle migrations), user auth, health route.

### Phase 1 — Sync API (week 1–2)
- Port `/v1/push|pull|events|consensus|keys|auth/*` to MySQL multi-tenant.

### Phase 2 — User admin UI (week 2–3)
- Projects, keys, setup snippets, quota enforcement.

### Phase 3 — Billing (week 3)
- Stripe products/prices, checkout, webhooks, portal.

### Phase 4 — Marketing site (week 3–4)
- Homepage, pricing, how-it-works.

### Phase 5 — Super-admin + hardening (week 4)
- Admin pages, rate limits, deploy Hostinger, end-to-end test with real `dim` CLI.

### Phase 6 — Docs site UI/UX (later, not cloud MVP)
- See §20. Ship cloud first; revisit docs when cloud design system is stable.

---

## 18. Open questions (resolve before build)

1. **Domain name** — `cloud.aidimag.com` vs separate brand?
2. **Exact key quotas** per plan — confirm pricing table.
3. **Free cloud tier?** — e.g. 1 key free forever (freemium) vs paid-only MVP.
4. **GitHub OAuth required** or email-only for MVP?
5. **Data retention** after account deletion — hard delete brains after 30 days?
6. **OSS type exports** — optional PR to `aidimag` to export `SyncItem`/`EventItem`; cloud can copy types for MVP.
7. **Legal** — Terms of Service, Privacy Policy, DPA for memory payload storage.
8. **MySQL quota** — confirm Hostinger plan DB size limit; define alert threshold (e.g. 80% full).

---

## 19. Success metrics (MVP)

- Time to first successful sync from signup: **< 10 minutes**
- Sync round-trip latency p95: **< 2s** for typical repo brain (< 5 MB)
- Paid conversion from signup: track via Stripe
- Support burden: suspend/ban rate, failed payment rate

---

## 20. Future work — aidimag docs site UI/UX (post-cloud MVP)

The OSS documentation site (`docs/`, VitePress) should get a **modern UI/UX pass** after aiDimag Cloud ships — not during cloud MVP.

**Current state:** functional VitePress docs with custom CSS (`docs/.vitepress/theme/custom.css`), brand colors, and SVG diagrams. Adequate for technical readers; not at the same polish level as the planned cloud SaaS (shadcn + Tailwind).

**Later goals:**
- Stronger visual hierarchy, navigation, and onboarding flow
- Align look-and-feel with the cloud product (shared brand tokens, typography, components where VitePress allows)
- Improved mobile experience and search/discoverability
- Optional: unify marketing narrative between cloud homepage and docs landing (`docs/index.md`)

**Approach when ready:**
- Stay on **VitePress** (don't rewrite docs into the cloud React app)
- Extend VitePress theme in `docs/.vitepress/theme/` — custom components, layout tweaks, CSS variables matching cloud shadcn theme
- Reuse assets from `docs/public/`; avoid duplicating content between cloud `/docs` route and GitHub Pages

**Explicitly out of scope for the cloud build agent** — link from cloud site to existing docs; do not block cloud MVP on docs redesign.

---

## 21. References

- [CLOUD_DESIGN.md](./CLOUD_DESIGN.md) — architecture north star
- [deploy/README.md](../deploy/README.md) — self-host baseline
- [docs/guides/team-sync.md](../docs/guides/team-sync.md) — user-facing sync guide (update with cloud URLs post-launch)
- [src/sync/server.ts](../src/sync/server.ts) — protocol source of truth
- [docs/pricing.md](../docs/pricing.md) — OSS licensing (cloud pricing is separate)
