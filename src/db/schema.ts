/**
 * SQLite schema for aidimag. Lives in <repo>/.aidimag/memory.db
 * FTS5 powers Phase 1 search; sqlite-vec embeddings arrive in Phase 2.
 */

export const SCHEMA_VERSION = 3;

/** Idempotent migrations for pre-existing DBs (failures = already applied). */
export const MIGRATIONS: string[] = [
  "ALTER TABLE memories ADD COLUMN updated_at TEXT",
  "ALTER TABLE proposals ADD COLUMN updated_at TEXT",
];

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
                  'ARCHITECTURE','INVARIANT','TODO_CONTEXT')),
  claim         TEXT NOT NULL,
  confidence    REAL NOT NULL DEFAULT 0.5,
  status        TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK (status IN (
                  'VERIFIED','UNVERIFIED','STALE','REFUTED')),
  created_by    TEXT NOT NULL DEFAULT 'human',
  created_at    TEXT NOT NULL,
  verified_at   TEXT,
  superseded_by TEXT REFERENCES memories(id),
  updated_at    TEXT
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
              'COMMIT_REF','TEST_RESULT','EXEC_TRACE','STATIC_CHECK','HUMAN_ATTESTED')),
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
               'ARCHITECTURE','INVARIANT','TODO_CONTEXT')),
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
  updated_at TEXT
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
`;

