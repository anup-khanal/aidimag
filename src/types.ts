/**
 * aidimag core types — mirrors the data model in DESIGN.md.
 */

export type MemoryKind =
  | "DECISION"
  | "CONVENTION"
  | "GOTCHA"
  | "FAILED_APPROACH"
  | "ARCHITECTURE"
  | "INVARIANT"
  | "TODO_CONTEXT";

export type MemoryStatus = "VERIFIED" | "UNVERIFIED" | "STALE" | "REFUTED";

export type EvidenceType =
  | "COMMIT_REF"
  | "TEST_RESULT"
  | "EXEC_TRACE"
  | "STATIC_CHECK"
  | "HUMAN_ATTESTED";

export type EvidenceResult = "PASS" | "FAIL" | "UNKNOWN";

export interface Evidence {
  id: string;
  memoryId: string;
  type: EvidenceType;
  /** ref / script / assertion — interpretation depends on `type` */
  payload: string;
  lastRun: string | null; // ISO timestamp
  result: EvidenceResult;
}

export type LinkRelation = "supports" | "contradicts" | "refines";

export interface MemoryLink {
  fromId: string;
  toId: string;
  relation: LinkRelation;
}

export interface MemoryScope {
  /** glob-ish path patterns this memory applies to; empty = whole repo */
  paths: string[];
  /** optional symbol names (functions, classes) */
  symbols: string[];
}

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  /** written as a falsifiable statement */
  claim: string;
  scope: MemoryScope;
  confidence: number; // 0..1, decays without re-verification
  status: MemoryStatus;
  createdBy: string; // agent-id | "human"
  createdAt: string;
  verifiedAt: string | null;
  supersededBy: string | null;
  grounding: Evidence[];
  links: MemoryLink[];
}

export interface MemoryWriteInput {
  kind: MemoryKind;
  claim: string;
  paths?: string[];
  symbols?: string[];
  createdBy?: string;
  evidence?: Array<{ type: EvidenceType; payload: string }>;
}

export interface MemorySearchOptions {
  query: string;
  kind?: MemoryKind;
  status?: MemoryStatus;
  /** restrict to memories scoped to (or overlapping) these paths */
  paths?: string[];
  limit?: number;
  includeRefuted?: boolean;
}

export interface MemoryStatusSummary {
  total: number;
  byStatus: Record<MemoryStatus, number>;
  byKind: Partial<Record<MemoryKind, number>>;
  dbPath: string;
  pendingProposals?: number;
}

// ---------------------------------------------------------------- Phase 2: capture

export type ProposalStatus = "PENDING" | "APPROVED" | "REJECTED";

export interface ProposalInput {
  kind: MemoryKind;
  claim: string;
  paths?: string[];
  symbols?: string[];
  evidence?: Array<{ type: EvidenceType; payload: string }>;
  /** where this proposal came from: 'commit-miner' | 'session:<agent-id>' | 'human' */
  source: string;
  /** e.g. commit sha the proposal was mined from */
  sourceRef?: string;
  /** why the source thinks this is worth remembering */
  rationale?: string;
}

export interface Proposal extends ProposalInput {
  id: string;
  createdAt: string;
  status: ProposalStatus;
  /** memory id, set when approved */
  memoryId: string | null;
  paths: string[];
  symbols: string[];
  evidence: Array<{ type: EvidenceType; payload: string }>;
}

