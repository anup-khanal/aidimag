/**
 * SQLite schema for aidimag. Lives in <repo>/.aidimag/memory.db
 * FTS5 powers Phase 1 search; sqlite-vec embeddings arrive in Phase 2.
 */

export const SCHEMA_VERSION = 8;

/** Idempotent migrations for pre-existing DBs (failures = already applied). */
export const MIGRATIONS: string[] = [
  "ALTER TABLE memories ADD COLUMN updated_at TEXT",
  "ALTER TABLE proposals ADD COLUMN updated_at TEXT",
  // T1 tickets: ticket id extracted from branch/commit message (offline)
  "ALTER TABLE proposals ADD COLUMN ticket_ref TEXT",
  // v7: pinned memories — exempt from time decay, still falsifiable by evidence
  "ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
  // v8: GUARDRAIL enforcement level (always | ask-first | never). The new kind
  // values themselves need a CHECK rebuild (MEMORIES_REBUILD_V8), but the
  // column adds cleanly on old DBs.
  "ALTER TABLE memories ADD COLUMN guardrail_level TEXT",
  "ALTER TABLE proposals ADD COLUMN guardrail_level TEXT",
];

/**
 * v6 guarded migration: SQLite can't ALTER a CHECK constraint, so adding the
 * TICKET_REF evidence type requires rebuilding the evidence table. Runs once,
 * gated on the stored schema_version (store.ts).
 */
export const EVIDENCE_REBUILD_V6 = `
ALTER TABLE evidence RENAME TO evidence_v5;
CREATE TABLE evidence (
  id        TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  type      TEXT NOT NULL CHECK (type IN (
              'COMMIT_REF','TEST_RESULT','EXEC_TRACE','STATIC_CHECK','HUMAN_ATTESTED','TICKET_REF')),
  payload   TEXT NOT NULL,
  last_run  TEXT,
  result    TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (result IN ('PASS','FAIL','UNKNOWN'))
);
INSERT INTO evidence SELECT * FROM evidence_v5;
DROP TABLE evidence_v5;
CREATE INDEX IF NOT EXISTS idx_evidence_memory ON evidence(memory_id);
`;

/**
 * v8 guarded rebuild: SQLite can't ALTER a CHECK constraint, so adding the
 * GUARDRAIL + SKILL memory kinds requires rebuilding the memories and proposals
 * tables. Rowids are preserved (FTS is a contentless mirror keyed on rowid) and
 * the FTS index is rebuilt afterwards. Runs once, gated on the stored
 * schema_version (store.ts), with foreign_keys disabled around it.
 */
export const MEMORIES_REBUILD_V8 = `
CREATE TABLE memories_v8 (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN (
                  'DECISION','CONVENTION','GOTCHA','FAILED_APPROACH',
                  'ARCHITECTURE','INVARIANT','TODO_CONTEXT','GUARDRAIL','SKILL')),
  claim         TEXT NOT NULL,
  confidence    REAL NOT NULL DEFAULT 0.5,
  status        TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK (status IN (
                  'VERIFIED','UNVERIFIED','STALE','REFUTED')),
  created_by    TEXT NOT NULL DEFAULT 'human',
  created_at    TEXT NOT NULL,
  verified_at   TEXT,
  superseded_by TEXT REFERENCES memories(id),
  updated_at    TEXT,
  pinned        INTEGER NOT NULL DEFAULT 0,
  guardrail_level TEXT CHECK (guardrail_level IN ('always','ask-first','never'))
);
INSERT INTO memories_v8 (rowid, id, kind, claim, confidence, status, created_by,
                         created_at, verified_at, superseded_by, updated_at, pinned, guardrail_level)
  SELECT rowid, id, kind, claim, confidence, status, created_by,
         created_at, verified_at, superseded_by, updated_at, pinned, guardrail_level FROM memories;
DROP TABLE memories;
ALTER TABLE memories_v8 RENAME TO memories;
INSERT INTO memories_fts(memories_fts) VALUES('rebuild');
`;

export const PROPOSALS_REBUILD_V8 = `
CREATE TABLE proposals_v8 (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN (
               'DECISION','CONVENTION','GOTCHA','FAILED_APPROACH',
               'ARCHITECTURE','INVARIANT','TODO_CONTEXT','GUARDRAIL','SKILL')),
  claim      TEXT NOT NULL,
  paths      TEXT NOT NULL DEFAULT '[]',
  symbols    TEXT NOT NULL DEFAULT '[]',
  evidence   TEXT NOT NULL DEFAULT '[]',
  source     TEXT NOT NULL,
  source_ref TEXT,
  rationale  TEXT,
  created_at TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  memory_id  TEXT REFERENCES memories(id) ON DELETE SET NULL,
  updated_at TEXT,
  ticket_ref TEXT,
  guardrail_level TEXT CHECK (guardrail_level IN ('always','ask-first','never'))
);
INSERT INTO proposals_v8 (id, kind, claim, paths, symbols, evidence, source, source_ref,
                          rationale, created_at, status, memory_id, updated_at, ticket_ref, guardrail_level)
  SELECT id, kind, claim, paths, symbols, evidence, source, source_ref,
         rationale, created_at, status, memory_id, updated_at, ticket_ref, guardrail_level FROM proposals;
DROP TABLE proposals;
ALTER TABLE proposals_v8 RENAME TO proposals;
`;

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN (
                  'DECISION','CONVENTION','GOTCHA','FAILED_APPROACH',
                  'ARCHITECTURE','INVARIANT','TODO_CONTEXT','GUARDRAIL','SKILL')),
  claim         TEXT NOT NULL,
  confidence    REAL NOT NULL DEFAULT 0.5,
  status        TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK (status IN (
                  'VERIFIED','UNVERIFIED','STALE','REFUTED')),
  created_by    TEXT NOT NULL DEFAULT 'human',
  created_at    TEXT NOT NULL,
  verified_at   TEXT,
  superseded_by TEXT REFERENCES memories(id),
  updated_at    TEXT,
  pinned        INTEGER NOT NULL DEFAULT 0,
  guardrail_level TEXT CHECK (guardrail_level IN ('always','ask-first','never'))
);

-- scope: one row per path / symbol a memory applies to
CREATE TABLE IF NOT EXISTS memory_scopes (
  memory_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('path','symbol')),
  value      TEXT NOT NULL,
  PRIMARY KEY (memory_id, scope_type, value)
);

CREATE TABLE IF NOT EXISTS evidence (
  id        TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  type      TEXT NOT NULL CHECK (type IN (
              'COMMIT_REF','TEST_RESULT','EXEC_TRACE','STATIC_CHECK','HUMAN_ATTESTED','TICKET_REF')),
  payload   TEXT NOT NULL,
  last_run  TEXT,
  result    TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (result IN ('PASS','FAIL','UNKNOWN'))
);

CREATE TABLE IF NOT EXISTS memory_links (
  from_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  to_id    TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK (relation IN ('supports','contradicts','refines')),
  PRIMARY KEY (from_id, to_id, relation)
);

-- Full-text search over claims (Phase 1 retrieval)
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  claim,
  content='memories',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, claim) VALUES (new.rowid, new.claim);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, claim) VALUES ('delete', old.rowid, old.claim);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF claim ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, claim) VALUES ('delete', old.rowid, old.claim);
  INSERT INTO memories_fts(rowid, claim) VALUES (new.rowid, new.claim);
END;

-- Phase 2: capture pipeline — proposed memories awaiting human review
CREATE TABLE IF NOT EXISTS proposals (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN (
               'DECISION','CONVENTION','GOTCHA','FAILED_APPROACH',
               'ARCHITECTURE','INVARIANT','TODO_CONTEXT','GUARDRAIL','SKILL')),
  claim      TEXT NOT NULL,
  paths      TEXT NOT NULL DEFAULT '[]',    -- JSON string[]
  symbols    TEXT NOT NULL DEFAULT '[]',    -- JSON string[]
  evidence   TEXT NOT NULL DEFAULT '[]',    -- JSON {type,payload}[]
  source     TEXT NOT NULL,                 -- 'commit-miner' | 'session:<agent-id>' | ...
  source_ref TEXT,                          -- e.g. commit sha
  rationale  TEXT,                          -- why the source thinks this is worth remembering
  created_at TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  memory_id  TEXT REFERENCES memories(id) ON DELETE SET NULL,  -- set when approved
  updated_at TEXT,
  ticket_ref TEXT,                          -- ticket id (e.g. XXX-2100) when known
  guardrail_level TEXT                      -- always | ask-first | never (GUARDRAIL proposals)
);

CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_dedupe ON proposals(source, source_ref, claim);

-- Phase 6: sync — deletions must propagate, so deletes leave tombstones
CREATE TABLE IF NOT EXISTS tombstones (
  id         TEXT NOT NULL,                 -- deleted row id
  tbl        TEXT NOT NULL CHECK (tbl IN ('memories','proposals')),
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (id, tbl)
);

CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
CREATE INDEX IF NOT EXISTS idx_memories_kind   ON memories(kind);
CREATE INDEX IF NOT EXISTS idx_scopes_value    ON memory_scopes(value);
CREATE INDEX IF NOT EXISTS idx_evidence_memory ON evidence(memory_id);

-- SaaS groundwork: local append-only event log (CLOUD_DESIGN sync model).
-- Every memory-lifecycle change is recorded here and shipped to the sync
-- server on \`dim sync\`; the server aggregates evidence_result events from
-- multiple machines into consensus confidence.
CREATE TABLE IF NOT EXISTS events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT NOT NULL UNIQUE,          -- uuid (idempotent server ingest)
  type           TEXT NOT NULL CHECK (type IN (
                   'memory_created','status_changed','evidence_result',
                   'refuted','superseded','forgotten',
                   'proposal_created','proposal_approved','proposal_rejected',
                   'verification_report')),
  memory_id      TEXT,                          -- subject memory/proposal id
  payload        TEXT NOT NULL DEFAULT '{}',    -- JSON event body
  machine        TEXT NOT NULL,                 -- stable per-machine id
  schema_version INTEGER NOT NULL,
  created_at     TEXT NOT NULL,
  synced         INTEGER NOT NULL DEFAULT 0     -- 1 once pushed to the server
);
CREATE INDEX IF NOT EXISTS idx_events_synced ON events(synced, seq);
`;

