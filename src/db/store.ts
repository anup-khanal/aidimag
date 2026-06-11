/**
 * MemoryStore — all persistence for aidimag.
 * Local-first: a single SQLite file at <repo>/.aidimag/memory.db
 */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { SCHEMA_SQL, SCHEMA_VERSION, MIGRATIONS } from "./schema.js";
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

/**
 * Stable per-machine id (CLOUD_DESIGN: "3 of 4 machines confirm…").
 * Persisted once in ~/.aidimag/machine-id; hostname-prefixed for readability.
 */
export function machineId(): string {
  const p = path.join(homedir(), ".aidimag", "machine-id");
  try {
    const existing = readFileSync(p, "utf8").trim();
    if (existing) return existing;
  } catch {
    // first run
  }
  const id = `${hostname()}-${randomUUID().slice(0, 8)}`;
  try {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, id + "\n", { mode: 0o600 });
  } catch {
    // unwritable home — fall back to a session-stable value
  }
  return id;
}

/** Event types shipped to the sync server (see schema.ts events table). */
export type MemoryEventType =
  | "memory_created"
  | "status_changed"
  | "evidence_result"
  | "refuted"
  | "superseded"
  | "forgotten"
  | "proposal_created"
  | "proposal_approved"
  | "proposal_rejected"
  | "verification_report";

export interface MemoryEvent {
  seq: number;
  id: string;
  type: MemoryEventType;
  memoryId: string | null;
  payload: Record<string, unknown>;
  machine: string;
  schemaVersion: number;
  createdAt: string;
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
  updated_at?: string | null;
}

export class MemoryStore {
  private db: Database.Database;
  readonly dbPath: string;
  /** true if the sqlite-vec extension loaded (vector search available) */
  readonly vecAvailable: boolean;
  private readonly machine: string = machineId();

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    let vecOk = false;
    try {
      sqliteVec.load(this.db);
      vecOk = true;
    } catch {
      // vector search unavailable on this platform — FTS-only mode
    }
    this.vecAvailable = vecOk;
    this.db.exec(SCHEMA_SQL);
    for (const m of MIGRATIONS) {
      try {
        this.db.exec(m);
      } catch {
        // already applied
      }
    }
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

  // ---------------------------------------------------------------- event log (SaaS sync model)

  /** Append an event to the local log (shipped to the sync server on `dim sync`). */
  recordEvent(type: MemoryEventType, memoryId: string | null, payload: Record<string, unknown> = {}): void {
    this.db
      .prepare(
        `INSERT INTO events (id, type, memory_id, payload, machine, schema_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(randomUUID(), type, memoryId, JSON.stringify(payload), this.machine, SCHEMA_VERSION, new Date().toISOString());
  }

  /** Events not yet pushed to the sync server, oldest first. */
  unsyncedEvents(limit = 500): MemoryEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE synced = 0 ORDER BY seq ASC LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      seq: r.seq as number,
      id: r.id as string,
      type: r.type as MemoryEventType,
      memoryId: (r.memory_id as string | null) ?? null,
      payload: JSON.parse((r.payload as string) || "{}"),
      machine: r.machine as string,
      schemaVersion: r.schema_version as number,
      createdAt: r.created_at as string,
    }));
  }

  markEventsSynced(seqs: number[]): void {
    if (!seqs.length) return;
    const stmt = this.db.prepare("UPDATE events SET synced = 1 WHERE seq = ?");
    const tx = this.db.transaction(() => seqs.forEach((s) => stmt.run(s)));
    tx();
  }

  // ---------------------------------------------------------------- write

  write(input: MemoryWriteInput): MemoryEntry {
    const id = randomUUID();
    const now = new Date().toISOString();
    const hasEvidence = (input.evidence?.length ?? 0) > 0;

    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO memories (id, kind, claim, confidence, status, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.kind,
          input.claim,
          hasEvidence ? 0.7 : 0.5,
          "UNVERIFIED",
          input.createdBy ?? "human",
          now,
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
      this.recordEvent("memory_created", id, {
        kind: input.kind,
        claim: input.claim,
        createdBy: input.createdBy ?? "human",
      });
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
    // Status-aware ranking (Phase 4 pilot tuning): trust dominates relevance.
    // FTS bm25 rank is negative (more relevant = more negative), so we add a
    // status penalty: VERIFIED +0, UNVERIFIED +2, STALE +10 — a stale memory
    // only surfaces when nothing trustworthy matches.
    const statusPenalty =
      "(CASE m.status WHEN 'VERIFIED' THEN 0 WHEN 'UNVERIFIED' THEN 2 WHEN 'STALE' THEN 10 ELSE 20 END)";
    let rows: MemoryRow[];
    if (ftsQuery) {
      rows = this.db
        .prepare(
          `SELECT m.* FROM memories_fts f
           JOIN memories m ON m.rowid = f.rowid
           WHERE memories_fts MATCH ? ${where}
           ORDER BY (rank + ${statusPenalty}) ASC, m.confidence DESC
           LIMIT ?`
        )
        .all(ftsQuery, ...params, limit) as MemoryRow[];
    } else {
      rows = this.db
        .prepare(
          `SELECT m.* FROM memories m WHERE 1=1 ${where}
           ORDER BY ${statusPenalty} ASC, m.confidence DESC, m.created_at DESC LIMIT ?`
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

  // ---------------------------------------------------------------- embeddings (semantic recall)

  /**
   * Ensure the vec0 table exists for the given model+dimension.
   * If the model changed since last index, drops and requires reindex.
   * Returns false if vector search is unavailable.
   */
  ensureVecTable(model: string, dim: number): boolean {
    if (!this.vecAvailable) return false;
    const current = this.getMeta("embedding_model");
    if (current && current !== `${model}:${dim}`) {
      this.db.exec("DROP TABLE IF EXISTS vec_memories");
    }
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(memory_rowid integer primary key, embedding float[${dim}])`
    );
    this.setMeta("embedding_model", `${model}:${dim}`);
    return true;
  }

  upsertEmbedding(memoryId: string, vector: number[]): void {
    if (!this.vecAvailable) return;
    const row = this.db.prepare("SELECT rowid FROM memories WHERE id = ?").get(memoryId) as
      | { rowid: number }
      | undefined;
    if (!row) return;
    this.db.prepare("DELETE FROM vec_memories WHERE memory_rowid = ?").run(BigInt(row.rowid));
    this.db
      .prepare("INSERT INTO vec_memories (memory_rowid, embedding) VALUES (?, ?)")
      .run(BigInt(row.rowid), new Float32Array(vector));
  }

  /** Memory ids missing an embedding (for reindex/backfill). */
  unembeddedIds(): string[] {
    if (!this.vecAvailable) return [];
    try {
      return (
        this.db
          .prepare(
            `SELECT m.id FROM memories m
             WHERE m.rowid NOT IN (SELECT memory_rowid FROM vec_memories)`
          )
          .all() as Array<{ id: string }>
      ).map((r) => r.id);
    } catch {
      return this.list(10_000).map((m) => m.id); // vec table doesn't exist yet
    }
  }

  /** KNN over memory embeddings → [memoryId, distance] pairs, nearest first. */
  knn(queryVector: number[], k = 10): Array<{ id: string; distance: number }> {
    if (!this.vecAvailable) return [];
    try {
      return this.db
        .prepare(
          `SELECT m.id, v.distance FROM vec_memories v
           JOIN memories m ON m.rowid = v.memory_rowid
           WHERE v.embedding MATCH ? AND k = ?
           ORDER BY v.distance`
        )
        .all(new Float32Array(queryVector), BigInt(k)) as Array<{ id: string; distance: number }>;
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------- proposals (Phase 2)

  /** Queue a proposed memory for human review. Returns null if a duplicate already exists. */
  propose(input: ProposalInput): Proposal | null {
    const id = randomUUID();
    const now = new Date().toISOString();
    try {
      this.db
        .prepare(
          `INSERT INTO proposals (id, kind, claim, paths, symbols, evidence, source, source_ref, rationale, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          now,
          now
        );
    } catch (err) {
      // UNIQUE(source, source_ref, claim) — already proposed
      if (err instanceof Error && /UNIQUE constraint/.test(err.message)) return null;
      throw err;
    }
    this.recordEvent("proposal_created", id, { kind: input.kind, claim: input.claim, source: input.source });
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

  /**
   * Approve a proposal: creates the real MemoryEntry and marks the proposal APPROVED.
   * `overrides.claim` lets the reviewer reword the claim before it becomes memory
   * (conversational review) — provenance still points at the original proposal.
   */
  approveProposal(id: string, overrides?: { claim?: string }): MemoryEntry {
    const p = this.findProposalByPrefix(id);
    if (!p) throw new Error(`No proposal matching id '${id}'`);
    if (p.status !== "PENDING") throw new Error(`Proposal ${p.id} is already ${p.status}`);
    const entry = this.write({
      kind: p.kind,
      claim: overrides?.claim?.trim() || p.claim,
      paths: p.paths,
      symbols: p.symbols,
      evidence: p.evidence,
      createdBy: p.source,
    });
    this.db
      .prepare("UPDATE proposals SET status = 'APPROVED', memory_id = ?, updated_at = ? WHERE id = ?")
      .run(entry.id, new Date().toISOString(), p.id);
    this.recordEvent("proposal_approved", p.id, { memoryId: entry.id });
    return entry;
  }

  rejectProposal(id: string): Proposal {
    const p = this.findProposalByPrefix(id);
    if (!p) throw new Error(`No proposal matching id '${id}'`);
    if (p.status !== "PENDING") throw new Error(`Proposal ${p.id} is already ${p.status}`);
    this.db
      .prepare("UPDATE proposals SET status = 'REJECTED', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), p.id);
    this.recordEvent("proposal_rejected", p.id);
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
      updatedAt: (row.updated_at as string | null) ?? null,
    };
  }

  // ---------------------------------------------------------------- mutate

  setStatus(id: string, status: MemoryStatus): void {
    const now = new Date().toISOString();
    const verifiedAt = status === "VERIFIED" ? now : null;
    const res = this.db
      .prepare("UPDATE memories SET status = ?, verified_at = COALESCE(?, verified_at), updated_at = ? WHERE id = ?")
      .run(status, verifiedAt, now, id);
    if (res.changes === 0) throw new Error(`No memory with id ${id}`);
    this.recordEvent("status_changed", id, { status });
  }

  setConfidence(id: string, confidence: number): void {
    this.db
      .prepare("UPDATE memories SET confidence = ?, updated_at = ? WHERE id = ?")
      .run(Math.max(0, Math.min(1, confidence)), new Date().toISOString(), id);
  }

  touchVerified(id: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE memories SET verified_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, id);
  }

  updateEvidenceResult(evidenceId: string, result: Evidence["result"], lastRun: string): void {
    this.db
      .prepare("UPDATE evidence SET result = ?, last_run = ? WHERE id = ?")
      .run(result, lastRun, evidenceId);
    this.db
      .prepare("UPDATE memories SET updated_at = ? WHERE id = (SELECT memory_id FROM evidence WHERE id = ?)")
      .run(lastRun, evidenceId);
    const owner = this.db
      .prepare("SELECT memory_id, type FROM evidence WHERE id = ?")
      .get(evidenceId) as { memory_id: string; type: string } | undefined;
    if (owner) {
      this.recordEvent("evidence_result", owner.memory_id, {
        evidenceId,
        evidenceType: owner.type,
        result,
        at: lastRun,
      });
    }
  }

  refute(id: string, supersededBy?: string): void {
    const res = this.db
      .prepare("UPDATE memories SET status = 'REFUTED', superseded_by = ?, updated_at = ? WHERE id = ?")
      .run(supersededBy ?? null, new Date().toISOString(), id);
    if (res.changes === 0) throw new Error(`No memory with id ${id}`);
    this.recordEvent("refuted", id, supersededBy ? { supersededBy } : {});
    if (supersededBy) this.recordEvent("superseded", id, { by: supersededBy });
  }

  forget(id: string): void {
    const tx = this.db.transaction(() => {
      // clear proposal back-references (older DBs lack ON DELETE SET NULL)
      this.db.prepare("UPDATE proposals SET memory_id = NULL WHERE memory_id = ?").run(id);
      this.db.prepare("UPDATE memories SET superseded_by = NULL WHERE superseded_by = ?").run(id);
      const res = this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
      if (res.changes === 0) throw new Error(`No memory with id ${id}`);
      this.db
        .prepare("INSERT OR REPLACE INTO tombstones (id, tbl, deleted_at) VALUES (?, 'memories', ?)")
        .run(id, new Date().toISOString());
      this.recordEvent("forgotten", id);
    });
    tx();
  }

  link(fromId: string, toId: string, relation: MemoryLink["relation"]): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO memory_links (from_id, to_id, relation) VALUES (?, ?, ?)"
      )
      .run(fromId, toId, relation);
  }

  // ---------------------------------------------------------------- sync (Phase 6)
  // State-based LWW sync support consumed by src/sync/client.ts.

  /** Local changes since `sinceIso` (null = everything), for pushing to a sync server. */
  changedSince(sinceIso: string | null): {
    memories: MemoryEntry[];
    proposals: Proposal[];
    tombstones: Array<{ id: string; tbl: string; deletedAt: string }>;
  } {
    const since = sinceIso ?? "";
    const memRows = this.db
      .prepare("SELECT * FROM memories WHERE COALESCE(updated_at, created_at) > ?")
      .all(since) as MemoryRow[];
    const propRows = this.db
      .prepare("SELECT * FROM proposals WHERE COALESCE(updated_at, created_at) > ?")
      .all(since) as Array<Record<string, unknown>>;
    const tombs = this.db
      .prepare("SELECT id, tbl, deleted_at FROM tombstones WHERE deleted_at > ?")
      .all(since) as Array<{ id: string; tbl: string; deleted_at: string }>;
    return {
      memories: memRows.map((r) => this.hydrate(r)),
      proposals: propRows.map((r) => this.hydrateProposal(r)),
      tombstones: tombs.map((t) => ({ id: t.id, tbl: t.tbl, deletedAt: t.deleted_at })),
    };
  }

  /** Per-memory updated_at (for LWW comparisons). */
  memoryUpdatedAt(id: string): string | null {
    const row = this.db
      .prepare("SELECT COALESCE(updated_at, created_at) AS u FROM memories WHERE id = ?")
      .get(id) as { u: string } | undefined;
    return row?.u ?? null;
  }

  isTombstoned(id: string, tbl: "memories" | "proposals"): boolean {
    return !!this.db.prepare("SELECT 1 FROM tombstones WHERE id = ? AND tbl = ?").get(id, tbl);
  }

  /** Upsert a remote memory snapshot (caller already did the LWW check). */
  applyRemoteMemory(m: MemoryEntry & { updatedAt?: string | null }): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO memories (id, kind, claim, confidence, status, created_by, created_at, verified_at, superseded_by, updated_at)
           VALUES (@id, @kind, @claim, @confidence, @status, @created_by, @created_at, @verified_at, @superseded_by, @updated_at)
           ON CONFLICT(id) DO UPDATE SET
             kind=excluded.kind, claim=excluded.claim, confidence=excluded.confidence,
             status=excluded.status, verified_at=excluded.verified_at,
             superseded_by=excluded.superseded_by, updated_at=excluded.updated_at`
        )
        .run({
          id: m.id,
          kind: m.kind,
          claim: m.claim,
          confidence: m.confidence,
          status: m.status,
          created_by: m.createdBy,
          created_at: m.createdAt,
          verified_at: m.verifiedAt,
          superseded_by: null, // applied without FK risk; relinked below if target exists
          updated_at: m.updatedAt ?? m.createdAt,
        });
      if (m.supersededBy) {
        this.db
          .prepare(
            "UPDATE memories SET superseded_by = ? WHERE id = ? AND EXISTS (SELECT 1 FROM memories WHERE id = ?)"
          )
          .run(m.supersededBy, m.id, m.supersededBy);
      }
      this.db.prepare("DELETE FROM memory_scopes WHERE memory_id = ?").run(m.id);
      const scopeStmt = this.db.prepare(
        "INSERT OR IGNORE INTO memory_scopes (memory_id, scope_type, value) VALUES (?, ?, ?)"
      );
      for (const p of m.scope.paths) scopeStmt.run(m.id, "path", p);
      for (const s of m.scope.symbols) scopeStmt.run(m.id, "symbol", s);
      this.db.prepare("DELETE FROM evidence WHERE memory_id = ?").run(m.id);
      const evStmt = this.db.prepare(
        "INSERT INTO evidence (id, memory_id, type, payload, last_run, result) VALUES (?, ?, ?, ?, ?, ?)"
      );
      for (const e of m.grounding) evStmt.run(e.id, m.id, e.type, e.payload, e.lastRun, e.result);
    });
    tx();
  }

  proposalUpdatedAt(id: string): string | null {
    const row = this.db
      .prepare("SELECT COALESCE(updated_at, created_at) AS u FROM proposals WHERE id = ?")
      .get(id) as { u: string } | undefined;
    return row?.u ?? null;
  }

  applyRemoteProposal(p: Proposal & { updatedAt?: string | null }): void {
    try {
      this.db
        .prepare(
          `INSERT INTO proposals (id, kind, claim, paths, symbols, evidence, source, source_ref, rationale, created_at, status, memory_id, updated_at)
           VALUES (@id, @kind, @claim, @paths, @symbols, @evidence, @source, @source_ref, @rationale, @created_at, @status, NULL, @updated_at)
           ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at`
        )
        .run({
          id: p.id,
          kind: p.kind,
          claim: p.claim,
          paths: JSON.stringify(p.paths),
          symbols: JSON.stringify(p.symbols),
          evidence: JSON.stringify(p.evidence),
          source: p.source,
          source_ref: p.sourceRef ?? "",
          rationale: p.rationale ?? null,
          created_at: p.createdAt,
          status: p.status,
          updated_at: p.updatedAt ?? p.createdAt,
        });
    } catch (err) {
      // (source, source_ref, claim) dedupe collision with a different id —
      // the claim is already represented locally; skip rather than fail sync.
      if (err instanceof Error && /UNIQUE constraint/.test(err.message)) return;
      throw err;
    }
  }

  /** Apply a remote tombstone: delete locally without creating a new tombstone loop. */
  applyRemoteTombstone(id: string, tbl: "memories" | "proposals", deletedAt: string): void {
    const tx = this.db.transaction(() => {
      if (tbl === "memories") {
        this.db.prepare("UPDATE proposals SET memory_id = NULL WHERE memory_id = ?").run(id);
        this.db.prepare("UPDATE memories SET superseded_by = NULL WHERE superseded_by = ?").run(id);
        this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
      } else {
        this.db.prepare("DELETE FROM proposals WHERE id = ?").run(id);
      }
      this.db
        .prepare("INSERT OR REPLACE INTO tombstones (id, tbl, deleted_at) VALUES (?, ?, ?)")
        .run(id, tbl, deletedAt);
    });
    tx();
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
      updatedAt: row.updated_at ?? null,
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

