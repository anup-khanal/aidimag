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
import { timingSafeEqual, randomBytes } from "node:crypto";

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
`;

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (d) => (body += d));
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

const APPROVE_PAGE = (msg = "", code = "") => `<!doctype html>
<html><head><meta charset="utf-8"><title>aidimag — approve device</title>
<style>body{font:16px system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem}
input{width:100%;padding:.5rem;margin:.25rem 0 1rem;font:inherit}button{padding:.5rem 1.5rem;font:inherit}
.msg{padding:.75rem;border-radius:.5rem;background:#eef;margin-bottom:1rem}</style></head>
<body><h1>🧠 aidimag</h1><h2>Approve a device login</h2>
${msg ? `<div class="msg">${msg}</div>` : ""}
<form method="POST" action="/v1/auth/approve">
<label>Code shown in your terminal</label>
<input name="user_code" placeholder="XXXX-XXXX" value="${code}" required>
<label>Your credential (admin token or aidimag_sk_… member key)</label>
<input name="credential" type="password" required>
<label>Device label (optional)</label>
<input name="label" placeholder="alice-laptop">
<button type="submit">Approve device</button>
</form></body></html>`;

export function startSyncServer(opts: {
  dbPath: string;
  token: string;
  port?: number;
  host?: string;
}): Promise<string> {
  mkdirSync(path.dirname(path.resolve(opts.dbPath)), { recursive: true });
  const db = new Database(opts.dbPath);
  db.exec(SERVER_SCHEMA);

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
  const host = opts.host ?? "0.0.0.0";

  /** Resolve the brain scope of a presented credential: '*' admin, brain name, or null (invalid). */
  function credentialScope(presented: string): string | null {
    if (safeEqual(presented, opts.token)) return "*";
    const key = db
      .prepare("SELECT brain FROM api_keys WHERE key = ? AND revoked_at IS NULL")
      .get(presented) as { brain: string } | undefined;
    if (key) return key.brain;
    const at = db
      .prepare("SELECT brain FROM account_tokens WHERE token = ? AND revoked_at IS NULL")
      .get(presented) as { brain: string | null } | undefined;
    if (at) return at.brain ?? "*";
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
          db.prepare("INSERT INTO account_tokens (token, brain, label, created_at) VALUES (?, ?, ?, ?)").run(
            token,
            scope === "*" ? null : scope,
            label,
            new Date().toISOString()
          );
          db.prepare("UPDATE device_codes SET status = 'APPROVED', token = ? WHERE device_code = ?").run(
            token,
            row.device_code
          );
        });
        tx();
        return respondHtml(
          200,
          `<!doctype html><html><body style="font:16px system-ui;max-width:28rem;margin:4rem auto">
           <h1>✅ Device approved</h1><p>Scope: <b>${scope === "*" ? "all brains" : scope}</b>.
           Return to your terminal — <code>dim login</code> finishes automatically.</p></body></html>`
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
        const scope = db
          .prepare("SELECT brain FROM account_tokens WHERE token = ?")
          .get(row.token) as { brain: string | null } | undefined;
        // device codes are single-use: scrub after handoff
        db.prepare("DELETE FROM device_codes WHERE device_code = ?").run(deviceCode);
        return respond(200, { token: row.token, brain: scope?.brain ?? null });
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
            db.prepare("INSERT INTO api_keys (key, brain, label, created_at) VALUES (?, ?, ?, ?)").run(
              key,
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
          // redact key bodies in listings
          return respond(200, {
            keys: keys.map((k) => ({ ...k, key: `${k.key.slice(0, 14)}…${k.key.slice(-4)}` })),
          });
        }
        if (req.method === "DELETE") {
          const target = url.searchParams.get("key");
          if (!target) return respond(400, { error: "missing ?key=" });
          // revoke in whichever table holds it (member key or account token)
          const r1 = db
            .prepare("UPDATE api_keys SET revoked_at = ? WHERE key = ? AND revoked_at IS NULL")
            .run(new Date().toISOString(), target);
          const r2 = db
            .prepare("UPDATE account_tokens SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL")
            .run(new Date().toISOString(), target);
          return respond(200, { revoked: r1.changes + r2.changes > 0 });
        }
        return respond(405, { error: "method not allowed" });
      }

      // ---- sync endpoints: admin token OR a live credential scoped to brain -
      const brain = url.searchParams.get("brain");
      if (!brain) return respond(400, { error: "missing ?brain=" });
      if (!isAdmin) {
        const scope = credentialScope(presented);
        if (scope === null || (scope !== "*" && scope !== brain)) {
          return respond(401, { error: "unauthorized for this brain" });
        }
      }

      if (req.method === "POST" && url.pathname === "/v1/push") {
        const body = await readBody(req);
        const { items } = JSON.parse(body) as { items: SyncItem[] };
        let accepted = 0;
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
          }
        });
        tx();
        const seq = (db.prepare("SELECT COALESCE(MAX(seq),0) AS s FROM items WHERE brain = ?").get(brain) as { s: number }).s;
        return respond(200, { accepted, seq });
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

      respond(404, { error: "not found" });
    } catch (err) {
      respond(400, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => resolve(`http://${host === "0.0.0.0" ? "localhost" : host}:${port}`));
  });
}

