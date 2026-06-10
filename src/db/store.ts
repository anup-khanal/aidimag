/**
 * MemoryStore — all persistence for aidimag.
 * Local-first: a single SQLite file at <repo>/.aidimag/memory.db
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";
import type {
  Evidence,
  MemoryEntry,
  MemoryKind,
  MemoryLink,
  MemorySearchOptions,
  MemoryStatus,
  MemoryStatusSummary,
  MemoryWriteInput,
  Proposal,
  ProposalInput,
  ProposalStatus,
} from "../types.js";

export const AIDIMAG_DIR = ".aidimag";
export const DB_FILE = "memory.db";

/** Walk up from `start` looking for an existing .aidimag dir (or .git as repo root). */
export function findRepoRoot(start: string = process.cwd()): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, AIDIMAG_DIR)) || existsSync(path.join(dir, ".git"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function dbPathFor(repoRoot: string): string {
  return path.join(repoRoot, AIDIMAG_DIR, DB_FILE);
}

interface MemoryRow {
  id: string;
  kind: MemoryKind;
  claim: string;
  confidence: number;
  status: MemoryStatus;
  created_by: string;
  created_at: string;
  verified_at: string | null;
  superseded_by: string | null;
}

export class MemoryStore {
  private db: Database.Database;
  readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(SCHEMA_SQL);
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(String(SCHEMA_VERSION));
  }

  /** Open the store for the repo containing `cwd`. Throws if not initialized and create=false. */
  static open(cwd: string = process.cwd(), opts: { create?: boolean } = {}): MemoryStore {
    const root = findRepoRoot(cwd);
    if (!root) {
      throw new Error(
        "Not inside a git repo or aidimag project. Run `dim init` at your repo root."
      );
    }
    const file = dbPathFor(root);
    if (!existsSync(file) && !opts.create) {
      throw new Error(`aidimag not initialized here. Run \`dim init\` in ${root}.`);
    }
    return new MemoryStore(file);
  }

  // ---------------------------------------------------------------- write

  write(input: MemoryWriteInput): MemoryEntry {
    const id = randomUUID();
    const now = new Date().toISOString();
    const hasEvidence = (input.evidence?.length ?? 0) > 0;

    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO memories (id, kind, claim, confidence, status, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.kind,
          input.claim,
          hasEvidence ? 0.7 : 0.5,
          "UNVERIFIED",
          input.createdBy ?? "human",
          now
        );

      const scopeStmt = this.db.prepare(
        "INSERT OR IGNORE INTO memory_scopes (memory_id, scope_type, value) VALUES (?, ?, ?)"
      );
      for (const p of input.paths ?? []) scopeStmt.run(id, "path", p);
      for (const s of input.symbols ?? []) scopeStmt.run(id, "symbol", s);

      const evStmt = this.db.prepare(
        "INSERT INTO evidence (id, memory_id, type, payload, result) VALUES (?, ?, ?, ?, 'UNKNOWN')"
      );
      for (const ev of input.evidence ?? []) {
        evStmt.run(randomUUID(), id, ev.type, ev.payload);
      }
    });
    insert();

    return this.get(id)!;
  }

  // ---------------------------------------------------------------- read

  get(id: string): MemoryEntry | null {
    const row = this.db
      .prepare("SELECT * FROM memories WHERE id = ?")
      .get(id) as MemoryRow | undefined;
    if (!row) return null;
    return this.hydrate(row);
  }

  search(opts: MemorySearchOptions): MemoryEntry[] {
    const limit = Math.min(opts.limit ?? 10, 50);
    const conditions: string[] = [];
    const params: unknown[] = [];

    // FTS match (sanitize: quote each term to avoid FTS syntax errors)
    const ftsQuery = opts.query
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replace(/"/g, '""')}"`)
      .join(" OR ");

    if (opts.kind) {
      conditions.push("m.kind = ?");
      params.push(opts.kind);
    }
    if (opts.status) {
      conditions.push("m.status = ?");
      params.push(opts.status);
    } else if (!opts.includeRefuted) {
      conditions.push("m.status != 'REFUTED'");
    }
    if (opts.paths?.length) {
      // memory matches if unscoped (repo-wide) or any scope path prefixes/equals a query path
      const pathClauses = opts.paths
        .map(() => "(? LIKE s.value || '%' OR s.value LIKE ? || '%')")
        .join(" OR ");
      conditions.push(`(
        NOT EXISTS (SELECT 1 FROM memory_scopes s WHERE s.memory_id = m.id AND s.scope_type = 'path')
        OR EXISTS (SELECT 1 FROM memory_scopes s WHERE s.memory_id = m.id AND s.scope_type = 'path' AND (${pathClauses}))
      )`);
      for (const p of opts.paths) params.push(p, p);
    }

    const where = conditions.length ? `AND ${conditions.join(" AND ")}` : "";
    let rows: MemoryRow[];
    if (ftsQuery) {
      rows = this.db
        .prepare(
          `SELECT m.* FROM memories_fts f
           JOIN memories m ON m.rowid = f.rowid
           WHERE memories_fts MATCH ? ${where}
           ORDER BY rank, m.confidence DESC
           LIMIT ?`
        )
        .all(ftsQuery, ...params, limit) as MemoryRow[];
    } else {
      rows = this.db
        .prepare(
          `SELECT m.* FROM memories m WHERE 1=1 ${where}
           ORDER BY m.confidence DESC, m.created_at DESC LIMIT ?`
        )
        .all(...params, limit) as MemoryRow[];
    }
    return rows.map((r) => this.hydrate(r));
  }

  /** All memories whose scope overlaps the given file paths (plus repo-wide memories). */
  getForFiles(paths: string[], limit = 20): MemoryEntry[] {
    return this.search({ query: "", paths, limit });
  }

  list(limit = 50): MemoryEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM memories ORDER BY created_at DESC LIMIT ?")
      .all(limit) as MemoryRow[];
    return rows.map((r) => this.hydrate(r));
  }

  statusSummary(): MemoryStatusSummary {
    const byStatus: Record<MemoryStatus, number> = {
      VERIFIED: 0,
      UNVERIFIED: 0,
      STALE: 0,
      REFUTED: 0,
    };
    for (const r of this.db
      .prepare("SELECT status, COUNT(*) AS n FROM memories GROUP BY status")
      .all() as Array<{ status: MemoryStatus; n: number }>) {
      byStatus[r.status] = r.n;
    }
    const byKind: Partial<Record<MemoryKind, number>> = {};
    for (const r of this.db
      .prepare("SELECT kind, COUNT(*) AS n FROM memories GROUP BY kind")
      .all() as Array<{ kind: MemoryKind; n: number }>) {
      byKind[r.kind] = r.n;
    }
    const total = (this.db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n;
    const pendingProposals = (
      this.db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status = 'PENDING'").get() as {
        n: number;
      }
    ).n;
    return { total, byStatus, byKind, dbPath: this.dbPath, pendingProposals };
  }

  // ---------------------------------------------------------------- proposals (Phase 2)

  /** Queue a proposed memory for human review. Returns null if a duplicate already exists. */
  propose(input: ProposalInput): Proposal | null {
    const id = randomUUID();
    const now = new Date().toISOString();
    try {
      this.db
        .prepare(
          `INSERT INTO proposals (id, kind, claim, paths, symbols, evidence, source, source_ref, rationale, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.kind,
          input.claim,
          JSON.stringify(input.paths ?? []),
          JSON.stringify(input.symbols ?? []),
          JSON.stringify(input.evidence ?? []),
          input.source,
          // NOTE: empty string, not NULL — SQLite treats NULLs as distinct in
          // unique indexes, which would break (source, source_ref, claim) dedupe.
          input.sourceRef ?? "",
          input.rationale ?? null,
          now
        );
    } catch (err) {
      // UNIQUE(source, source_ref, claim) — already proposed
      if (err instanceof Error && /UNIQUE constraint/.test(err.message)) return null;
      throw err;
    }
    return this.getProposal(id);
  }

  getProposal(id: string): Proposal | null {
    const row = this.db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.hydrateProposal(row) : null;
  }

  listProposals(status: ProposalStatus = "PENDING", limit = 50): Proposal[] {
    const rows = this.db
      .prepare("SELECT * FROM proposals WHERE status = ? ORDER BY created_at ASC LIMIT ?")
      .all(status, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.hydrateProposal(r));
  }

  /** Approve a proposal: creates the real MemoryEntry and marks the proposal APPROVED. */
  approveProposal(id: string): MemoryEntry {
    const p = this.findProposalByPrefix(id);
    if (!p) throw new Error(`No proposal matching id '${id}'`);
    if (p.status !== "PENDING") throw new Error(`Proposal ${p.id} is already ${p.status}`);
    const entry = this.write({
      kind: p.kind,
      claim: p.claim,
      paths: p.paths,
      symbols: p.symbols,
      evidence: p.evidence,
      createdBy: p.source,
    });
    this.db
      .prepare("UPDATE proposals SET status = 'APPROVED', memory_id = ? WHERE id = ?")
      .run(entry.id, p.id);
    return entry;
  }

  rejectProposal(id: string): Proposal {
    const p = this.findProposalByPrefix(id);
    if (!p) throw new Error(`No proposal matching id '${id}'`);
    if (p.status !== "PENDING") throw new Error(`Proposal ${p.id} is already ${p.status}`);
    this.db.prepare("UPDATE proposals SET status = 'REJECTED' WHERE id = ?").run(p.id);
    return { ...p, status: "REJECTED" };
  }

  findProposalByPrefix(idOrPrefix: string): Proposal | null {
    const row = this.db
      .prepare("SELECT * FROM proposals WHERE id = ? OR id LIKE ? || '%' LIMIT 1")
      .get(idOrPrefix, idOrPrefix) as Record<string, unknown> | undefined;
    return row ? this.hydrateProposal(row) : null;
  }

  /** Last mined commit sha (commit-miner cursor), or null. */
  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  private hydrateProposal(row: Record<string, unknown>): Proposal {
    return {
      id: row.id as string,
      kind: row.kind as Proposal["kind"],
      claim: row.claim as string,
      paths: JSON.parse(row.paths as string),
      symbols: JSON.parse(row.symbols as string),
      evidence: JSON.parse(row.evidence as string),
      source: row.source as string,
      sourceRef: (row.source_ref as string | null) || undefined,
      rationale: (row.rationale as string | null) ?? undefined,
      createdAt: row.created_at as string,
      status: row.status as ProposalStatus,
      memoryId: (row.memory_id as string | null) ?? null,
    };
  }

  // ---------------------------------------------------------------- mutate

  setStatus(id: string, status: MemoryStatus): void {
    const verifiedAt = status === "VERIFIED" ? new Date().toISOString() : null;
    const res = this.db
      .prepare("UPDATE memories SET status = ?, verified_at = COALESCE(?, verified_at) WHERE id = ?")
      .run(status, verifiedAt, id);
    if (res.changes === 0) throw new Error(`No memory with id ${id}`);
  }

  refute(id: string, supersededBy?: string): void {
    const res = this.db
      .prepare("UPDATE memories SET status = 'REFUTED', superseded_by = ? WHERE id = ?")
      .run(supersededBy ?? null, id);
    if (res.changes === 0) throw new Error(`No memory with id ${id}`);
  }

  forget(id: string): void {
    const res = this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    if (res.changes === 0) throw new Error(`No memory with id ${id}`);
  }

  link(fromId: string, toId: string, relation: MemoryLink["relation"]): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO memory_links (from_id, to_id, relation) VALUES (?, ?, ?)"
      )
      .run(fromId, toId, relation);
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- private

  private hydrate(row: MemoryRow): MemoryEntry {
    const scopes = this.db
      .prepare("SELECT scope_type, value FROM memory_scopes WHERE memory_id = ?")
      .all(row.id) as Array<{ scope_type: "path" | "symbol"; value: string }>;
    const evidence = this.db
      .prepare("SELECT * FROM evidence WHERE memory_id = ?")
      .all(row.id) as Array<{
      id: string;
      memory_id: string;
      type: Evidence["type"];
      payload: string;
      last_run: string | null;
      result: Evidence["result"];
    }>;
    const links = this.db
      .prepare("SELECT from_id, to_id, relation FROM memory_links WHERE from_id = ? OR to_id = ?")
      .all(row.id, row.id) as Array<{
      from_id: string;
      to_id: string;
      relation: MemoryLink["relation"];
    }>;

    return {
      id: row.id,
      kind: row.kind,
      claim: row.claim,
      scope: {
        paths: scopes.filter((s) => s.scope_type === "path").map((s) => s.value),
        symbols: scopes.filter((s) => s.scope_type === "symbol").map((s) => s.value),
      },
      confidence: row.confidence,
      status: row.status,
      createdBy: row.created_by,
      createdAt: row.created_at,
      verifiedAt: row.verified_at,
      supersededBy: row.superseded_by,
      grounding: evidence.map((e) => ({
        id: e.id,
        memoryId: e.memory_id,
        type: e.type,
        payload: e.payload,
        lastRun: e.last_run,
        result: e.result,
      })),
      links: links.map((l) => ({ fromId: l.from_id, toId: l.to_id, relation: l.relation })),
    };
  }
}

