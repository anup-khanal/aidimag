/**
 * Verification engine (Phase 3) — runs evidence and applies the
 * status lifecycle: UNVERIFIED/VERIFIED ↔ STALE. REFUTED stays a
 * deliberate human/agent action, never automatic.
 *
 * Transition rules per memory:
 *   - any runnable evidence FAILs            → STALE  (confidence floored)
 *   - all runnable evidence PASSes (≥1)      → VERIFIED (confidence boosted)
 *   - only skipped/unknown evidence, or none → status unchanged
 *   - REFUTED memories are never re-verified (negative knowledge is final
 *     until explicitly superseded)
 */

import { runEvidence, type RunOutcome } from "./runners.js";
import type { MemoryStore } from "../db/store.js";
import type { MemoryEntry, MemoryStatus } from "../types.js";

export interface MemoryVerification {
  memoryId: string;
  claim: string;
  before: MemoryStatus;
  after: MemoryStatus;
  confidenceBefore: number;
  confidenceAfter: number;
  outcomes: RunOutcome[];
}

export interface VerifyReport {
  checked: number;
  verified: number;
  stale: number;
  unchanged: number;
  results: MemoryVerification[];
}

const CONFIDENCE_BOOST = 0.1;
const CONFIDENCE_CAP = 0.95;
const CONFIDENCE_FLOOR_ON_FAIL = 0.2;

export function verifyMemory(store: MemoryStore, memory: MemoryEntry, repoRoot: string): MemoryVerification {
  const outcomes: RunOutcome[] = [];
  const now = new Date().toISOString();

  for (const ev of memory.grounding) {
    const outcome = runEvidence(ev, repoRoot);
    outcomes.push(outcome);
    if (outcome.result !== "SKIPPED") {
      store.updateEvidenceResult(ev.id, outcome.result, now);
    }
  }

  const runnable = outcomes.filter((o) => o.result === "PASS" || o.result === "FAIL");
  const anyFail = runnable.some((o) => o.result === "FAIL");
  const allPass = runnable.length > 0 && runnable.every((o) => o.result === "PASS");

  let after: MemoryStatus = memory.status;
  let confidenceAfter = memory.confidence;

  if (anyFail) {
    after = "STALE";
    confidenceAfter = Math.min(memory.confidence, CONFIDENCE_FLOOR_ON_FAIL);
  } else if (allPass) {
    after = "VERIFIED";
    confidenceAfter = Math.min(CONFIDENCE_CAP, memory.confidence + CONFIDENCE_BOOST);
  }

  if (after !== memory.status) store.setStatus(memory.id, after);
  if (confidenceAfter !== memory.confidence) store.setConfidence(memory.id, confidenceAfter);
  if (after === "VERIFIED") store.touchVerified(memory.id);

  return {
    memoryId: memory.id,
    claim: memory.claim,
    before: memory.status,
    after,
    confidenceBefore: memory.confidence,
    confidenceAfter,
    outcomes,
  };
}

export function verifyAll(
  store: MemoryStore,
  repoRoot: string,
  opts: { ids?: string[] } = {}
): VerifyReport {
  let memories = store.list(10_000).filter((m) => m.status !== "REFUTED");
  if (opts.ids?.length) {
    memories = memories.filter((m) => opts.ids!.some((id) => m.id === id || m.id.startsWith(id)));
  }

  const results = memories.map((m) => verifyMemory(store, m, repoRoot));
  return {
    checked: results.length,
    verified: results.filter((r) => r.after === "VERIFIED").length,
    stale: results.filter((r) => r.after === "STALE").length,
    unchanged: results.filter((r) => r.after === r.before).length,
    results,
  };
}

