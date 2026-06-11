/**
 * aidimag sync server — `dim serve` (Phase 6, self-hostable team mode).
 *
 * Zero extra dependencies: node:http + better-sqlite3. The hosted SaaS later
 * wraps this same protocol with OAuth/billing; teams can always self-host.
 *
 * Protocol (all JSON, Bearer token auth):
 *   POST /v1/push?brain=<id>   { items: SyncItem[] }      → { accepted, seq }
 *   GET  /v1/pull?brain=<id>&since=<seq>                  → { items, seq }
 *   GET  /v1/health                                       → { ok, brains }
 *
 * SyncItem = { tbl: "memories"|"proposals", id, updatedAt, deleted, payload }
 * The server is a dumb ordered log + latest-state index per brain. All merge
 * logic (LWW, verification arbitration) lives in clients.
 */

import { createServer } from "node:http";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";

export interface SyncItem {
  tbl: "memories" | "proposals";
  id: string;
  updatedAt: string;
  deleted: boolean;
  /** full row snapshot (MemoryEntry / Proposal JSON); null when deleted */
  payload: unknown | null;
}

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
`;

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

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

  const port = opts.port ?? 8787;
  const host = opts.host ?? "0.0.0.0";

  const server = createServer((req, res) => {
    const respond = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/v1/health") {
      const brains = (db.prepare("SELECT COUNT(DISTINCT brain) AS n FROM items").get() as { n: number }).n;
      return respond(200, { ok: true, brains });
    }

    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ") || !safeEqual(auth.slice(7), opts.token)) {
      return respond(401, { error: "unauthorized" });
    }

    const brain = url.searchParams.get("brain");
    if (!brain) return respond(400, { error: "missing ?brain=" });

    if (req.method === "POST" && url.pathname === "/v1/push") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        try {
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
          respond(200, { accepted, seq });
        } catch (err) {
          respond(400, { error: err instanceof Error ? err.message : String(err) });
        }
      });
      return;
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

    respond(404, { error: "not found" });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => resolve(`http://${host === "0.0.0.0" ? "localhost" : host}:${port}`));
  });
}

