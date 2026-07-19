/**
 * aidimag sync server — `dim serve` (Phase 6, self-hostable team mode).
 *
 * Zero extra dependencies: node:http + better-sqlite3. The hosted SaaS later
 * wraps this same protocol with OAuth/billing; teams can always self-host.
 *
 * Protocol (all JSON, Bearer token auth):
 *   POST /v1/push?brain=<id>   { items: SyncItem[] }      → { accepted, seq }
 *   GET  /v1/pull?brain=<id>&since=<seq>                  → { items, seq }
 *   POST /v1/events?brain=<id> { events: EventItem[] }    → { accepted }
 *   GET  /v1/consensus?brain=<id>[&memory=<id>]           → { consensus }
 *   GET  /v1/snapshot?brain=<id>[&id=][&list=0][&limit=] → { seq, counts, items? }
 *   GET  /v1/health                                       → { ok, brains }
 *
 * Device auth (SaaS groundwork — RFC 8628-style device flow, no external IdP):
 *   POST /v1/auth/device                                  → { device_code, user_code, verification_uri, interval, expires_in }
 *   GET  /v1/auth/approve                                 → browser approval page
 *   POST /v1/auth/approve   (form)                        → approve a user code with an existing credential
 *   POST /v1/auth/token     { device_code }               → pending | { token, brain }
 * The minted account token (aidimag_at_…) inherits the scope of the approving
 * credential: admin token → all brains; member key → that key's brain. The
 * hosted SaaS swaps the approval page for GitHub OAuth — same endpoints.
 *
 * SyncItem = { tbl: "memories"|"proposals", id, updatedAt, deleted, payload }
 * The server is a dumb ordered log + latest-state index per brain. All merge
 * logic (LWW, verification arbitration) lives in clients. Events are an
 * append-only ingest used for cross-machine verification consensus.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { timingSafeEqual, randomBytes, createHash } from "node:crypto";
import { buildDirectProvider } from "../tickets/provider.js";
import { validateSyncPushItems } from "../security/sync-push.js";
import { sealDeviceToken, unsealDeviceToken } from "../security/seal.js";
import { isAllowedTicketBaseUrl } from "../security/url.js";

export interface SyncItem {
  tbl: "memories" | "proposals";
  id: string;
  updatedAt: string;
  deleted: boolean;
  /** full row snapshot (MemoryEntry / Proposal JSON); null when deleted */
  payload: unknown | null;
}

export interface EventItem {
  id: string;
  type: string;
  memoryId: string | null;
  payload: Record<string, unknown>;
  machine: string;
  schemaVersion: number;
  createdAt: string;
}

/** Current remote state for a brain (GET /v1/snapshot). */
export interface RemoteSnapshotItem {
  id: string;
  tbl: "memories" | "proposals";
  updatedAt: string;
  deleted: boolean;
  claim?: string;
  status?: string;
  kind?: string;
  payload?: unknown;
}

export interface RemoteSnapshot {
  brain: string;
  seq: number;
  counts: {
    memories: number;
    proposals: number;
    tombstones: number;
  };
  items?: RemoteSnapshotItem[];
  item?: RemoteSnapshotItem;
}

const DEVICE_CODE_TTL_MS = 15 * 60 * 1000;
const DEVICE_POLL_INTERVAL_S = 5;

const SERVER_SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS items (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  brain      TEXT NOT NULL,
  tbl        TEXT NOT NULL,
  id         TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  payload    TEXT
);
-- latest-state index: one row per (brain, tbl, id)
CREATE TABLE IF NOT EXISTS latest (
  brain      TEXT NOT NULL,
  tbl        TEXT NOT NULL,
  id         TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (brain, tbl, id)
);
CREATE INDEX IF NOT EXISTS idx_items_brain_seq ON items(brain, seq);
-- multi-tenant: brain-scoped API keys minted by the admin token
CREATE TABLE IF NOT EXISTS api_keys (
  key        TEXT PRIMARY KEY,           -- aidimag_sk_...
  brain      TEXT NOT NULL,
  label      TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
-- SaaS groundwork: device-flow login (dim login)
CREATE TABLE IF NOT EXISTS device_codes (
  device_code TEXT PRIMARY KEY,          -- secret, polled by the CLI
  user_code   TEXT NOT NULL UNIQUE,      -- short code typed/shown in the browser
  status      TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','DENIED')),
  token       TEXT,                      -- account token once approved
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
-- account tokens minted via device flow (aidimag_at_...)
CREATE TABLE IF NOT EXISTS account_tokens (
  token      TEXT PRIMARY KEY,
  brain      TEXT,                       -- NULL = all brains (approved by admin)
  label      TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
-- append-only event ingest (CLOUD_DESIGN sync model; consensus aggregation)
CREATE TABLE IF NOT EXISTS events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  brain          TEXT NOT NULL,
  id             TEXT NOT NULL UNIQUE,   -- client uuid → idempotent ingest
  type           TEXT NOT NULL,
  memory_id      TEXT,
  payload        TEXT NOT NULL DEFAULT '{}',
  machine        TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_brain ON events(brain, seq);
CREATE INDEX IF NOT EXISTS idx_events_memory ON events(brain, memory_id, type);
-- T3 tickets: team-shared ticketing credentials — members never hold them
CREATE TABLE IF NOT EXISTS ticket_configs (
  brain      TEXT PRIMARY KEY,
  provider   TEXT NOT NULL,              -- jira | github | linear | http
  base_url   TEXT NOT NULL DEFAULT '',
  credential TEXT,                       -- team token, server-side only
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ticket_cache (
  brain      TEXT NOT NULL,
  id         TEXT NOT NULL,
  payload    TEXT NOT NULL,              -- normalized Ticket JSON ('' = miss)
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (brain, id)
);
-- server-side flags (e.g. one-time credential-hash migration)
CREATE TABLE IF NOT EXISTS server_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const TICKET_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Credentials at rest: api_keys.key, account_tokens.token, and pending
 * device_codes.token store SHA-256 hashes, never plaintext — a leaked server
 * DB no longer leaks live credentials. Lookups hash the presented value.
 * (ticket_configs.credential must stay recoverable to call provider APIs.)
 */
function hashCred(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Fixed-window per-IP rate limiter for the unauthenticated auth endpoints. */
function makeRateLimiter(maxPerWindow: number, windowMs: number) {
  const hits = new Map<string, { count: number; windowStart: number }>();
  return (ip: string): boolean => {
    const now = Date.now();
    const cur = hits.get(ip);
    if (!cur || now - cur.windowStart > windowMs) {
      hits.set(ip, { count: 1, windowStart: now });
      if (hits.size > 10_000) hits.clear(); // memory bound
      return true;
    }
    cur.count++;
    return cur.count <= maxPerWindow;
  };
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Escape untrusted text before interpolating into the HTML approval page (XSS guard). */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}

/** Cap inbound request bodies to bound memory use (DoS guard on an internet-exposed server). */
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MiB

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (d: Buffer) => {
      size += d.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      body += d;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function userCode(): string {
  // unambiguous alphabet, XXXX-XXXX
  const alpha = "BCDFGHJKLMNPQRSTVWXZ23456789";
  const pick = () => alpha[randomBytes(1)[0] % alpha.length];
  return `${pick()}${pick()}${pick()}${pick()}-${pick()}${pick()}${pick()}${pick()}`;
}

const AUTH_PAGE_STYLES = `<style>
@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap");
:root{--bg:hsl(222,47%,6%);--card:hsl(222,47%,8%);--border:hsl(217,33%,16%);--text:hsl(210,40%,98%);--dim:hsl(215,20%,65%);--primary:linear-gradient(120deg,#2563eb,#0ea5e9);--radius:12px}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;font:16px/1.5 "Inter",ui-sans-serif,system-ui,sans-serif;color:var(--text);background:var(--bg);background-image:radial-gradient(at 0% 0%,rgba(37,99,235,.18) 0,transparent 50%),radial-gradient(at 100% 0%,rgba(14,165,233,.12) 0,transparent 50%)}
.card{width:100%;max-width:28rem;padding:28px;border:1px solid color-mix(in srgb,var(--border) 60%,transparent);border-radius:calc(var(--radius)+4px);background:color-mix(in srgb,var(--card) 90%,transparent);box-shadow:0 0 0 1px rgba(96,165,250,.12),0 8px 32px rgba(0,0,0,.35)}
h1{margin:0 0 4px;font-size:1.5rem;font-weight:700;letter-spacing:-.02em}h2{margin:0 0 20px;font-size:.95rem;font-weight:500;color:var(--dim)}
label{display:block;margin:14px 0 6px;font-size:.8rem;font-weight:600;color:var(--dim);text-transform:uppercase;letter-spacing:.06em}
input{width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font:inherit}
input:focus{outline:2px solid hsl(199,89%,48%);outline-offset:1px;border-color:transparent}
button{margin-top:18px;width:100%;padding:11px 16px;border:none;border-radius:8px;background:var(--primary);color:#fff;font:inherit;font-weight:600;cursor:pointer;box-shadow:0 8px 24px rgba(37,99,235,.3)}
.msg{padding:12px 14px;border-radius:8px;background:hsl(213,94%,68%,.12);border:1px solid hsl(213,94%,68%,.25);margin-bottom:16px;font-size:.9rem}
.success-icon{font-size:2.5rem;margin-bottom:12px}
code{background:hsl(217,33%,14%);padding:2px 6px;border-radius:4px;font-size:.875em}
</style>`;

const APPROVE_PAGE = (msg = "", code = "") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>aidimag — approve device</title>
${AUTH_PAGE_STYLES}</head>
<body><div class="card"><h1>🧠 aidimag</h1><h2>Approve a device login</h2>
${msg ? `<div class="msg">${escapeHtml(msg)}</div>` : ""}
<form method="POST" action="/v1/auth/approve">
<label for="user_code">Code shown in your terminal</label>
<input id="user_code" name="user_code" placeholder="XXXX-XXXX" value="${escapeHtml(code)}" required autocomplete="off">
<label for="credential">Your credential (admin token or aidimag_sk_… member key)</label>
<input id="credential" name="credential" type="password" required autocomplete="off">
<label for="label">Device label (optional)</label>
<input id="label" name="label" placeholder="alice-laptop">
<button type="submit">Approve device</button>
</form></div></body></html>`;

export function startSyncServer(opts: {
  dbPath: string;
  token: string;
  port?: number;
  host?: string;
}): Promise<string> {
  mkdirSync(path.dirname(path.resolve(opts.dbPath)), { recursive: true });
  const db = new Database(opts.dbPath);
  db.exec(SERVER_SCHEMA);

  // One-time migration: hash any plaintext credentials from pre-hardening DBs.
  const migrated = db.prepare("SELECT value FROM server_meta WHERE key = 'creds_hashed'").get();
  if (!migrated) {
    const tx = db.transaction(() => {
      const isHex64 = (s: string) => /^[0-9a-f]{64}$/.test(s);
      for (const r of db.prepare("SELECT key FROM api_keys").all() as Array<{ key: string }>) {
        if (!isHex64(r.key)) db.prepare("UPDATE api_keys SET key = ? WHERE key = ?").run(hashCred(r.key), r.key);
      }
      for (const r of db.prepare("SELECT token FROM account_tokens").all() as Array<{ token: string }>) {
        if (!isHex64(r.token)) db.prepare("UPDATE account_tokens SET token = ? WHERE token = ?").run(hashCred(r.token), r.token);
      }
      db.prepare("INSERT INTO server_meta (key, value) VALUES ('creds_hashed', ?)").run(new Date().toISOString());
    });
    tx();
  }

  const authLimiter = makeRateLimiter(20, 60_000); // 20 req/min/IP on /v1/auth/*
  const syncLimiter = makeRateLimiter(120, 60_000); // 120 req/min/IP on authenticated sync

  const insertItem = db.prepare(
    "INSERT INTO items (brain, tbl, id, updated_at, deleted, payload) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const getLatest = db.prepare("SELECT updated_at FROM latest WHERE brain = ? AND tbl = ? AND id = ?");
  const setLatest = db.prepare(
    `INSERT INTO latest (brain, tbl, id, seq, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(brain, tbl, id) DO UPDATE SET seq = excluded.seq, updated_at = excluded.updated_at`
  );
  const insertEvent = db.prepare(
    `INSERT OR IGNORE INTO events (brain, id, type, memory_id, payload, machine, schema_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const port = opts.port ?? 8787;
  const host = opts.host ?? "127.0.0.1";

  /** Resolve the brain scope of a presented credential: '*' admin, brain name, or null (invalid). */
  function credentialScope(presented: string): string | null {
    if (safeEqual(presented, opts.token)) return "*";
    const hashed = hashCred(presented);
    const key = db
      .prepare("SELECT brain FROM api_keys WHERE key = ? AND revoked_at IS NULL")
      .get(hashed) as { brain: string } | undefined;
    if (key) return key.brain;
    const at = db
      .prepare("SELECT brain FROM account_tokens WHERE token = ? AND revoked_at IS NULL")
      .get(hashed) as { brain: string | null } | undefined;
    if (at?.brain) return at.brain;
    return null;
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const respond = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const respondHtml = (code: number, html: string) => {
      res.writeHead(code, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    };

    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (req.method === "GET" && url.pathname === "/v1/health") {
        const brains = (db.prepare("SELECT COUNT(DISTINCT brain) AS n FROM items").get() as { n: number }).n;
        return respond(200, { ok: true, brains });
      }

      // ---- device auth (no Bearer auth on these endpoints) ------------------
      // Unauthenticated → rate-limited per IP (user codes are short; without a
      // limit they'd be brute-forceable within the 15-minute TTL).
      if (url.pathname.startsWith("/v1/auth/")) {
        const ip = req.socket.remoteAddress ?? "unknown";
        if (!authLimiter(ip)) return respond(429, { error: "rate limited — try again in a minute" });
      }

      if (req.method === "POST" && url.pathname === "/v1/auth/device") {
        const deviceCode = `aidimag_dc_${randomBytes(24).toString("base64url")}`;
        const code = userCode();
        const now = Date.now();
        db.prepare(
          "INSERT INTO device_codes (device_code, user_code, created_at, expires_at) VALUES (?, ?, ?, ?)"
        ).run(deviceCode, code, new Date(now).toISOString(), new Date(now + DEVICE_CODE_TTL_MS).toISOString());
        return respond(200, {
          device_code: deviceCode,
          user_code: code,
          verification_uri: `${url.origin}/v1/auth/approve`,
          interval: DEVICE_POLL_INTERVAL_S,
          expires_in: DEVICE_CODE_TTL_MS / 1000,
        });
      }

      if (req.method === "GET" && url.pathname === "/v1/auth/approve") {
        return respondHtml(200, APPROVE_PAGE("", url.searchParams.get("code") ?? ""));
      }

      if (req.method === "POST" && url.pathname === "/v1/auth/approve") {
        const body = await readBody(req);
        const form = new URLSearchParams(body);
        const code = (form.get("user_code") ?? "").trim().toUpperCase();
        const credential = (form.get("credential") ?? "").trim();
        const label = (form.get("label") ?? "").trim() || null;
        const row = db
          .prepare("SELECT device_code, status, expires_at FROM device_codes WHERE user_code = ?")
          .get(code) as { device_code: string; status: string; expires_at: string } | undefined;
        if (!row || row.status !== "PENDING") return respondHtml(400, APPROVE_PAGE("❌ Unknown or already-used code."));
        if (row.expires_at < new Date().toISOString()) {
          return respondHtml(400, APPROVE_PAGE("❌ Code expired — run `dim login` again."));
        }
        const scope = credentialScope(credential);
        if (scope === null) return respondHtml(403, APPROVE_PAGE("❌ Invalid credential.", code));
        const token = `aidimag_at_${randomBytes(24).toString("base64url")}`;
        const tx = db.transaction(() => {
          // account_tokens stores the HASH; the plaintext lives only in
          // device_codes for the single-use poll handoff, then is deleted.
          db.prepare("INSERT INTO account_tokens (token, brain, label, created_at) VALUES (?, ?, ?, ?)").run(
            hashCred(token),
            scope === "*" ? null : scope,
            label,
            new Date().toISOString()
          );
          db.prepare("UPDATE device_codes SET status = 'APPROVED', token = ? WHERE device_code = ?").run(
            sealDeviceToken(token, opts.token),
            row.device_code
          );
        });
        tx();
        return respondHtml(
          200,
          `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>aidimag — device approved</title>${AUTH_PAGE_STYLES}</head>
           <body><div class="card"><div class="success-icon">✅</div><h1>Device approved</h1>
           <p style="color:var(--dim);margin:12px 0 0">Scope: <strong style="color:var(--text)">${escapeHtml(scope === "*" ? "all brains" : scope)}</strong>.
           Return to your terminal — <code>dim login</code> finishes automatically.</p></div></body></html>`
        );
      }

      if (req.method === "POST" && url.pathname === "/v1/auth/token") {
        const body = await readBody(req);
        let deviceCode = "";
        try {
          deviceCode = (JSON.parse(body || "{}") as { device_code?: string }).device_code ?? "";
        } catch {
          return respond(400, { error: "bad json" });
        }
        const row = db
          .prepare("SELECT status, token, expires_at FROM device_codes WHERE device_code = ?")
          .get(deviceCode) as { status: string; token: string | null; expires_at: string } | undefined;
        if (!row) return respond(404, { error: "unknown device_code" });
        if (row.expires_at < new Date().toISOString()) return respond(410, { error: "expired" });
        if (row.status === "DENIED") return respond(410, { error: "denied" });
        if (row.status !== "APPROVED" || !row.token) return respond(428, { error: "authorization_pending" });
        const plainToken = unsealDeviceToken(row.token, opts.token);
        if (!plainToken) return respond(500, { error: "token handoff failed" });
        const scope = db
          .prepare("SELECT brain FROM account_tokens WHERE token = ?")
          .get(hashCred(plainToken)) as { brain: string | null } | undefined;
        // device codes are single-use: scrub after handoff
        db.prepare("DELETE FROM device_codes WHERE device_code = ?").run(deviceCode);
        return respond(200, { token: plainToken, brain: scope?.brain ?? null });
      }

      // ---- everything below requires Bearer auth ----------------------------
      const auth = req.headers.authorization ?? "";
      if (!auth.startsWith("Bearer ")) return respond(401, { error: "unauthorized" });
      const presented = auth.slice(7);
      const isAdmin = safeEqual(presented, opts.token);

      // ---- key management (admin only) -------------------------------------
      if (url.pathname === "/v1/keys") {
        if (!isAdmin) return respond(403, { error: "admin token required" });
        if (req.method === "POST") {
          try {
            const body = await readBody(req);
            const { brain: keyBrain, label } = JSON.parse(body || "{}") as { brain?: string; label?: string };
            if (!keyBrain) return respond(400, { error: "missing brain" });
            const key = `aidimag_sk_${randomBytes(24).toString("base64url")}`;
            // stored hashed — shown in full exactly once, right here
            db.prepare("INSERT INTO api_keys (key, brain, label, created_at) VALUES (?, ?, ?, ?)").run(
              hashCred(key),
              keyBrain,
              label ?? null,
              new Date().toISOString()
            );
            return respond(201, { key, brain: keyBrain, label: label ?? null });
          } catch (err) {
            return respond(400, { error: err instanceof Error ? err.message : String(err) });
          }
        }
        if (req.method === "GET") {
          const keys = db
            .prepare("SELECT key, brain, label, created_at, revoked_at FROM api_keys ORDER BY created_at")
            .all() as Array<{ key: string }>;
          // keys are stored hashed; show a short fingerprint for identification
          return respond(200, {
            keys: keys.map((k) => ({ ...k, key: `sha256:${k.key.slice(0, 12)}…` })),
          });
        }
        if (req.method === "DELETE") {
          const target = url.searchParams.get("key");
          if (!target) return respond(400, { error: "missing ?key=" });
          // the admin pastes the plaintext credential; match on its hash
          // (a raw stored hash also works, for revoking from a leaked-DB audit)
          const hashes = [hashCred(target), target];
          let changes = 0;
          for (const h of hashes) {
            changes += db
              .prepare("UPDATE api_keys SET revoked_at = ? WHERE key = ? AND revoked_at IS NULL")
              .run(new Date().toISOString(), h).changes;
            changes += db
              .prepare("UPDATE account_tokens SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL")
              .run(new Date().toISOString(), h).changes;
          }
          return respond(200, { revoked: changes > 0 });
        }
        return respond(405, { error: "method not allowed" });
      }

      // ---- sync endpoints: admin token OR a live credential scoped to brain -
      const brain = url.searchParams.get("brain");
      if (!brain) return respond(400, { error: "missing ?brain=" });
      if (!isAdmin) {
        const syncIp = req.socket.remoteAddress ?? "unknown";
        if (!syncLimiter(syncIp)) return respond(429, { error: "rate limited — try again in a minute" });
        const scope = credentialScope(presented);
        if (scope === null || scope !== brain) {
          return respond(401, { error: "unauthorized for this brain" });
        }
      }

      if (req.method === "POST" && url.pathname === "/v1/push") {
        const body = await readBody(req);
        const parsed = JSON.parse(body) as { items: SyncItem[] };
        const items = validateSyncPushItems(parsed.items ?? []);
        let accepted = 0;
        let memoriesAccepted = 0;
        const tx = db.transaction(() => {
          for (const it of items) {
            if (!it.id || !it.tbl || !it.updatedAt) continue;
            // server-side LWW guard: ignore pushes older than what we have
            const cur = getLatest.get(brain, it.tbl, it.id) as { updated_at: string } | undefined;
            if (cur && cur.updated_at >= it.updatedAt) continue;
            const info = insertItem.run(
              brain,
              it.tbl,
              it.id,
              it.updatedAt,
              it.deleted ? 1 : 0,
              it.payload === null ? null : JSON.stringify(it.payload)
            );
            setLatest.run(brain, it.tbl, it.id, info.lastInsertRowid as number, it.updatedAt);
            accepted++;
            if (it.tbl === "memories" && !it.deleted) memoriesAccepted++;
          }
        });
        tx();
        const seq = (db.prepare("SELECT COALESCE(MAX(seq),0) AS s FROM items WHERE brain = ?").get(brain) as { s: number }).s;
        return respond(200, { accepted, memoriesAccepted, seq });
      }

      if (req.method === "GET" && url.pathname === "/v1/pull") {
        const since = parseInt(url.searchParams.get("since") ?? "0", 10);
        // only the latest version of each row, newer than the cursor
        const rows = db
          .prepare(
            `SELECT i.tbl, i.id, i.updated_at, i.deleted, i.payload, i.seq
             FROM items i JOIN latest l ON l.brain = i.brain AND l.tbl = i.tbl AND l.id = i.id AND l.seq = i.seq
             WHERE i.brain = ? AND i.seq > ? ORDER BY i.seq LIMIT 1000`
          )
          .all(brain, since) as Array<{ tbl: string; id: string; updated_at: string; deleted: number; payload: string | null; seq: number }>;
        const items: SyncItem[] = rows.map((r) => ({
          tbl: r.tbl as SyncItem["tbl"],
          id: r.id,
          updatedAt: r.updated_at,
          deleted: !!r.deleted,
          payload: r.payload ? JSON.parse(r.payload) : null,
        }));
        const seq = rows.length ? rows[rows.length - 1].seq : since;
        return respond(200, { items, seq });
      }

      // ---- event ingest (append-only; idempotent on event id) ---------------
      if (req.method === "POST" && url.pathname === "/v1/events") {
        const body = await readBody(req);
        const { events } = JSON.parse(body) as { events: EventItem[] };
        let accepted = 0;
        const tx = db.transaction(() => {
          for (const e of events) {
            if (!e.id || !e.type || !e.machine || !e.createdAt) continue;
            const info = insertEvent.run(
              brain,
              e.id,
              e.type,
              e.memoryId ?? null,
              JSON.stringify(e.payload ?? {}),
              e.machine,
              e.schemaVersion ?? 0,
              e.createdAt
            );
            if (info.changes > 0) accepted++;
          }
        });
        tx();
        return respond(200, { accepted });
      }

      // ---- snapshot: read-only latest state (no sync cursor) ----------------
      if (req.method === "GET" && url.pathname === "/v1/snapshot") {
        const idFilter = url.searchParams.get("id");
        const tblFilter = url.searchParams.get("tbl") === "proposals" ? "proposals" : "memories";
        const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "20", 10), 1), 200);
        const list = !(url.searchParams.get("list") === "0" || url.searchParams.get("list") === "false");
        const full = url.searchParams.get("full") === "1" || url.searchParams.get("full") === "true";
        const includeAllProposals =
          url.searchParams.get("all") === "1" || url.searchParams.get("all") === "true";
        const pendingProposalSql = `(json_extract(i.payload, '$.status') IS NULL OR json_extract(i.payload, '$.status') = 'PENDING')`;
        const seq = (db.prepare("SELECT COALESCE(MAX(seq),0) AS s FROM items WHERE brain = ?").get(brain) as { s: number }).s;
        const countRows = db
          .prepare(
            `SELECT i.tbl, i.deleted, COUNT(*) AS n
             FROM latest l JOIN items i ON l.brain = i.brain AND l.tbl = i.tbl AND l.id = i.id AND l.seq = i.seq
             WHERE l.brain = ? GROUP BY i.tbl, i.deleted`
          )
          .all(brain) as Array<{ tbl: string; deleted: number; n: number }>;
        const pendingRow = db
          .prepare(
            `SELECT COUNT(*) AS n
             FROM latest l JOIN items i ON l.brain = i.brain AND l.tbl = i.tbl AND l.id = i.id AND l.seq = i.seq
             WHERE l.brain = ? AND i.tbl = 'proposals' AND i.deleted = 0 AND ${pendingProposalSql}`
          )
          .get(brain) as { n: number };
        let memories = 0;
        let tombstones = 0;
        for (const row of countRows) {
          if (row.deleted) tombstones += row.n;
          else if (row.tbl === "memories") memories += row.n;
        }
        const proposals = pendingRow.n;
        const summarize = (tbl: string, payload: string | null, deleted: boolean) => {
          if (deleted || !payload) return {};
          const row = JSON.parse(payload) as Record<string, unknown>;
          if (tbl === "memories") {
            return {
              claim: typeof row.claim === "string" ? row.claim : undefined,
              status: typeof row.status === "string" ? row.status : undefined,
              kind: typeof row.kind === "string" ? row.kind : undefined,
            };
          }
          return {
            claim: typeof row.claim === "string" ? row.claim : typeof row.summary === "string" ? row.summary : undefined,
            status: typeof row.status === "string" ? row.status : undefined,
          };
        };
        const mapRow = (r: { tbl: string; id: string; updated_at: string; deleted: number; payload: string | null }) => ({
          id: r.id,
          tbl: r.tbl as SyncItem["tbl"],
          updatedAt: r.updated_at,
          deleted: !!r.deleted,
          ...summarize(r.tbl, r.payload, !!r.deleted),
          ...(full && r.payload && !r.deleted ? { payload: JSON.parse(r.payload) } : {}),
        });
        if (idFilter) {
          const row = db
            .prepare(
              `SELECT i.tbl, i.id, i.updated_at, i.deleted, i.payload
               FROM latest l JOIN items i ON l.brain = i.brain AND l.tbl = i.tbl AND l.id = i.id AND l.seq = i.seq
               WHERE l.brain = ? AND i.id = ?`
            )
            .get(brain, idFilter) as { tbl: string; id: string; updated_at: string; deleted: number; payload: string | null } | undefined;
          return respond(200, {
            brain,
            seq,
            counts: { memories, proposals, tombstones },
            ...(row ? { item: mapRow(row) } : {}),
          });
        }
        const items = list
          ? (db
              .prepare(
                tblFilter === "proposals" && !includeAllProposals
                  ? `SELECT i.tbl, i.id, i.updated_at, i.deleted, i.payload
                     FROM latest l JOIN items i ON l.brain = i.brain AND l.tbl = i.tbl AND l.id = i.id AND l.seq = i.seq
                     WHERE l.brain = ? AND i.tbl = ? AND i.deleted = 0 AND ${pendingProposalSql}
                     ORDER BY i.updated_at DESC LIMIT ?`
                  : `SELECT i.tbl, i.id, i.updated_at, i.deleted, i.payload
                     FROM latest l JOIN items i ON l.brain = i.brain AND l.tbl = i.tbl AND l.id = i.id AND l.seq = i.seq
                     WHERE l.brain = ? AND i.tbl = ? AND i.deleted = 0
                     ORDER BY i.updated_at DESC LIMIT ?`
              )
              .all(brain, tblFilter, limit) as Array<{ tbl: string; id: string; updated_at: string; deleted: number; payload: string | null }>).map(mapRow)
          : undefined;
        return respond(200, { brain, seq, counts: { memories, proposals, tombstones }, ...(items ? { items } : {}) });
      }

      // ---- consensus: latest verification_report per (memory, machine) ------
      if (req.method === "GET" && url.pathname === "/v1/consensus") {
        const memoryFilter = url.searchParams.get("memory");
        const rows = db
          .prepare(
            `SELECT e.memory_id, e.machine, e.payload, e.created_at FROM events e
             JOIN (
               SELECT memory_id, machine, MAX(seq) AS seq FROM events
               WHERE brain = ? AND type = 'verification_report' ${memoryFilter ? "AND memory_id = ?" : ""}
               GROUP BY memory_id, machine
             ) latest ON latest.seq = e.seq`
          )
          .all(...(memoryFilter ? [brain, memoryFilter] : [brain])) as Array<{
          memory_id: string;
          machine: string;
          payload: string;
          created_at: string;
        }>;
        const byMemory = new Map<string, Array<{ machine: string; pass: boolean; head: string | null; at: string }>>();
        for (const r of rows) {
          const p = JSON.parse(r.payload) as { pass?: boolean; head?: string | null };
          const list = byMemory.get(r.memory_id) ?? [];
          list.push({ machine: r.machine, pass: Boolean(p.pass), head: p.head ?? null, at: r.created_at });
          byMemory.set(r.memory_id, list);
        }
        const consensus = [...byMemory.entries()].map(([memoryId, reports]) => ({
          memoryId,
          machines: reports.length,
          passing: reports.filter((r) => r.pass).length,
          reports,
        }));
        return respond(200, { consensus });
      }

      // ---- T3 tickets: team-shared credentials, server-side fetch + cache ---
      if (url.pathname === "/v1/ticket-config") {
        if (!isAdmin) return respond(403, { error: "admin token required" });
        if (req.method === "PUT" || req.method === "POST") {
          const body = await readBody(req);
          const cfg = JSON.parse(body || "{}") as { provider?: string; baseUrl?: string; credential?: string };
          if (!cfg.provider) return respond(400, { error: "missing provider" });
          if (cfg.provider === "http" && cfg.baseUrl && !isAllowedTicketBaseUrl(cfg.baseUrl)) {
            return respond(400, { error: "ticket baseUrl not allowed" });
          }
          db.prepare(
            `INSERT INTO ticket_configs (brain, provider, base_url, credential, updated_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(brain) DO UPDATE SET provider=excluded.provider, base_url=excluded.base_url,
               credential=COALESCE(excluded.credential, ticket_configs.credential), updated_at=excluded.updated_at`
          ).run(brain, cfg.provider, cfg.baseUrl ?? "", cfg.credential ?? null, new Date().toISOString());
          db.prepare("DELETE FROM ticket_cache WHERE brain = ?").run(brain);
          return respond(200, { ok: true, brain, provider: cfg.provider });
        }
        if (req.method === "GET") {
          const row = db
            .prepare("SELECT provider, base_url, credential IS NOT NULL AS has_credential, updated_at FROM ticket_configs WHERE brain = ?")
            .get(brain) as Record<string, unknown> | undefined;
          return respond(200, { config: row ?? null });
        }
        if (req.method === "DELETE") {
          const r = db.prepare("DELETE FROM ticket_configs WHERE brain = ?").run(brain);
          db.prepare("DELETE FROM ticket_cache WHERE brain = ?").run(brain);
          return respond(200, { removed: r.changes > 0 });
        }
        return respond(405, { error: "method not allowed" });
      }

      if (req.method === "GET" && url.pathname === "/v1/ticket") {
        const ticketId = url.searchParams.get("id");
        if (!ticketId) return respond(400, { error: "missing ?id=" });
        const cached = db
          .prepare("SELECT payload, fetched_at FROM ticket_cache WHERE brain = ? AND id = ?")
          .get(brain, ticketId) as { payload: string; fetched_at: string } | undefined;
        if (cached && Date.now() - new Date(cached.fetched_at).getTime() < TICKET_CACHE_TTL_MS) {
          if (!cached.payload) return respond(404, { error: "ticket not found" });
          return respond(200, JSON.parse(cached.payload));
        }
        const cfgRow = db
          .prepare("SELECT provider, base_url, credential FROM ticket_configs WHERE brain = ?")
          .get(brain) as { provider: string; base_url: string; credential: string | null } | undefined;
        if (!cfgRow) return respond(404, { error: "no ticket provider configured for this brain (admin: dim ticket share)" });
        const provider = buildDirectProvider(cfgRow.provider, cfgRow.base_url, cfgRow.credential);
        if (!provider) return respond(502, { error: "ticket provider misconfigured (missing credential?)" });
        const ticket = await provider.getTicket(ticketId);
        db.prepare(
          "INSERT OR REPLACE INTO ticket_cache (brain, id, payload, fetched_at) VALUES (?, ?, ?, ?)"
        ).run(brain, ticketId, ticket ? JSON.stringify(ticket) : "", new Date().toISOString());
        if (!ticket) return respond(404, { error: "ticket not found" });
        return respond(200, ticket);
      }

      respond(404, { error: "not found" });
    } catch (err) {
      // never echo internals to clients (info-leak guard); log server-side
      console.error(`[aidimag serve] ${req.method} ${req.url}:`, err instanceof Error ? err.message : err);
      respond(400, { error: "bad request" });
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => resolve(`http://${host === "0.0.0.0" ? "localhost" : host}:${port}`));
  });
}

