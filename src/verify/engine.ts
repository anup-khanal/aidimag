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

import { execFileSync } from "node:child_process";
import { runEvidence, type RunOptions, type RunOutcome } from "./runners.js";
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
  decayed?: boolean;
}

export interface VerifyReport {
  checked: number;
  verified: number;
  stale: number;
  unchanged: number;
  decayed: number;
  results: MemoryVerification[];
}

const CONFIDENCE_BOOST = 0.1;
const CONFIDENCE_CAP = 0.95;
const CONFIDENCE_FLOOR_ON_FAIL = 0.2;

// ---- confidence decay (Phase 5) -------------------------------------------
// Memories that can't be re-verified this run decay exponentially with age.
// HUMAN_ATTESTED-only memories decay fastest (weakest evidence per DESIGN.md).
const DECAY_HALF_LIFE_DAYS = 45;
const DECAY_HALF_LIFE_HUMAN_DAYS = 14;
/** VERIFIED memories whose confidence decays below this demote to UNVERIFIED. */
const DEMOTION_THRESHOLD = 0.35;
const MIN_CONFIDENCE = 0.05;
/** Ignore decay smaller than this — avoids noisy sub-percent updates on every run. */
const DECAY_EPSILON = 0.01;

export function decayedConfidence(
  confidence: number,
  lastAnchorIso: string,
  halfLifeDays: number,
  now: Date = new Date()
): number {
  const ageDays = (now.getTime() - new Date(lastAnchorIso).getTime()) / 86_400_000;
  if (ageDays <= 0) return confidence;
  return Math.max(MIN_CONFIDENCE, confidence * Math.pow(0.5, ageDays / halfLifeDays));
}

function isHumanOnly(memory: MemoryEntry): boolean {
  return memory.grounding.length > 0 && memory.grounding.every((e) => e.type === "HUMAN_ATTESTED");
}

export function verifyMemory(
  store: MemoryStore,
  memory: MemoryEntry,
  repoRoot: string,
  opts: RunOptions = {}
): MemoryVerification {
  const outcomes: RunOutcome[] = [];
  const now = new Date().toISOString();

  for (const ev of memory.grounding) {
    const outcome = runEvidence(ev, repoRoot, opts);
    outcomes.push(outcome);
    if (outcome.result !== "SKIPPED") {
      store.updateEvidenceResult(ev.id, outcome.result, now);
    }
  }

  // HUMAN_ATTESTED passes trivially; it re-anchors status but must NOT block
  // decay, otherwise human-only memories would never age.
  const machineRunnable = outcomes.filter(
    (o) => (o.result === "PASS" || o.result === "FAIL") && o.type !== "HUMAN_ATTESTED"
  );
  const runnable = outcomes.filter((o) => o.result === "PASS" || o.result === "FAIL");
  const anyFail = runnable.some((o) => o.result === "FAIL");
  const allPass = runnable.length > 0 && runnable.every((o) => o.result === "PASS");

  let after: MemoryStatus = memory.status;
  let confidenceAfter = memory.confidence;
  let decayed = false;

  if (anyFail) {
    after = "STALE";
    confidenceAfter = Math.min(memory.confidence, CONFIDENCE_FLOOR_ON_FAIL);
  } else if (allPass && machineRunnable.length > 0) {
    after = "VERIFIED";
    confidenceAfter = Math.min(CONFIDENCE_CAP, memory.confidence + CONFIDENCE_BOOST);
  } else if (allPass && runnable.length > 0) {
    // human-attested only: VERIFIED on first attestation, then decays from
    // verified_at — re-running verify must not refresh human trust.
    if (memory.verifiedAt === null && memory.status === "UNVERIFIED") {
      after = "VERIFIED";
    } else {
      const next = decayedConfidence(
        memory.confidence,
        memory.verifiedAt ?? memory.createdAt,
        DECAY_HALF_LIFE_HUMAN_DAYS
      );
      if (memory.confidence - next >= DECAY_EPSILON) {
        confidenceAfter = next;
        decayed = true;
        if (memory.status === "VERIFIED" && next < DEMOTION_THRESHOLD) after = "UNVERIFIED";
      }
    }
  } else {
    // nothing machine-checkable ran this round → decay with age
    const halfLife = isHumanOnly(memory) ? DECAY_HALF_LIFE_HUMAN_DAYS : DECAY_HALF_LIFE_DAYS;
    const anchor = memory.verifiedAt ?? memory.createdAt;
    const next = decayedConfidence(memory.confidence, anchor, halfLife);
    if (memory.confidence - next >= DECAY_EPSILON) {
      confidenceAfter = next;
      decayed = true;
      if (memory.status === "VERIFIED" && next < DEMOTION_THRESHOLD) {
        after = "UNVERIFIED"; // trust expired without re-confirmation
      }
    }
  }

  if (after !== memory.status) store.setStatus(memory.id, after);
  if (confidenceAfter !== memory.confidence) store.setConfidence(memory.id, confidenceAfter);
  if (after === "VERIFIED" && allPass && machineRunnable.length > 0) store.touchVerified(memory.id);

  return {
    memoryId: memory.id,
    claim: memory.claim,
    before: memory.status,
    after,
    confidenceBefore: memory.confidence,
    confidenceAfter,
    outcomes,
    decayed,
  };
}

export function verifyAll(
  store: MemoryStore,
  repoRoot: string,
  opts: { ids?: string[]; deep?: boolean } = {}
): VerifyReport {
  let memories = store.list(10_000).filter((m) => m.status !== "REFUTED");
  if (opts.ids?.length) {
    memories = memories.filter((m) => opts.ids!.some((id) => m.id === id || m.id.startsWith(id)));
  }

  const results = memories.map((m) => verifyMemory(store, m, repoRoot, { deep: opts.deep }));

  // CLOUD_DESIGN consensus input: one verification_report event per run,
  // anchored to the repo HEAD so the server can aggregate "N machines
  // confirm memory X PASSes at sha Y".
  let head: string | null = null;
  try {
    head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    // not a git repo — report without an anchor
  }
  for (const r of results) {
    const ran = r.outcomes.filter((o) => o.result === "PASS" || o.result === "FAIL");
    if (!ran.length) continue; // nothing machine-checkable ran; no report
    store.recordEvent("verification_report", r.memoryId, {
      head,
      status: r.after,
      confidence: r.confidenceAfter,
      pass: ran.every((o) => o.result === "PASS"),
      deep: Boolean(opts.deep),
    });
  }

  return {
    checked: results.length,
    verified: results.filter((r) => r.after === "VERIFIED").length,
    stale: results.filter((r) => r.after === "STALE").length,
    unchanged: results.filter((r) => r.after === r.before).length,
    decayed: results.filter((r) => r.decayed).length,
    results,
  };
}

