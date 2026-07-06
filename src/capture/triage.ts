/**
 * Proposal triage — keeps the review queue from becoming homework.
 *
 * Scores every pending proposal 0–1 from cheap, local signals:
 *   + machine-checkable evidence attached (falsifiable on arrival)
 *   + trusted source (human-stated context > knowledge docs > miners)
 *   + concrete scope (paths/symbols)
 *   − similarity to previously REJECTED claims (the correction loop:
 *     what you drop teaches the queue what not to surface first)
 *   − similarity to existing ACTIVE memory (likely duplicate knowledge)
 *
 * `dim review` walks the queue best-first and shows the score;
 * `dim review approve all --min-score <s>` batch-approves above a bar.
 */

import type { MemoryStore } from "../db/store.js";
import type { Proposal } from "../types.js";

export interface TriagedProposal {
  proposal: Proposal;
  score: number;
  reasons: string[];
}

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "in", "on", "of", "to", "and",
  "or", "for", "with", "that", "this", "it", "be", "as", "at", "by", "from",
  "not", "no", "all", "any", "into", "through", "must", "should", "never",
  "always", "made", "make", "makes", "was", "were",
]);

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s/._-]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t))
  );
}

/** Jaccard similarity over content tokens — cheap, offline, good enough for triage. */
export function claimSimilarity(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

const SOURCE_TRUST: Array<{ prefix: string; boost: number; label: string }> = [
  { prefix: "context:", boost: 0.25, label: "user-stated in chat" },
  { prefix: "harvest:", boost: 0.2, label: "user-typed (harvested)" },
  { prefix: "knowledge:", boost: 0.15, label: "from curated doc" },
  { prefix: "bootstrap", boost: 0.1, label: "repo survey" },
  { prefix: "session:", boost: 0.1, label: "agent session" },
  { prefix: "verify:stale", boost: 0.15, label: "stale-memory follow-up" },
  { prefix: "pr-miner", boost: 0.15, label: "from PR review threads" },
  { prefix: "commit-miner", boost: 0.05, label: "mined from commits" },
];

const SIMILARITY_THRESHOLD = 0.55;

export function scoreProposal(
  p: Proposal,
  rejectedClaims: string[],
  activeClaims: string[]
): { score: number; reasons: string[] } {
  let score = 0.4; // base
  const reasons: string[] = [];

  const machineEvidence = p.evidence.filter(
    (e) => e.type === "STATIC_CHECK" || e.type === "TEST_RESULT" || e.type === "EXEC_TRACE"
  );
  if (machineEvidence.length) {
    score += 0.2;
    reasons.push("machine-checkable evidence");
  } else if (p.evidence.some((e) => e.type === "COMMIT_REF")) {
    score += 0.08;
    reasons.push("commit-anchored");
  }
  if (p.evidence.some((e) => e.type === "HUMAN_ATTESTED")) {
    score += 0.08;
    reasons.push("human-attested");
  }

  const trust = SOURCE_TRUST.find((s) => p.source.startsWith(s.prefix));
  if (trust) {
    score += trust.boost;
    reasons.push(trust.label);
  }

  if (p.paths.length || p.symbols.length) {
    score += 0.07;
    reasons.push("concretely scoped");
  }

  // correction loop: proposals resembling past rejections start at the back
  let maxRejected = 0;
  for (const r of rejectedClaims) maxRejected = Math.max(maxRejected, claimSimilarity(p.claim, r));
  if (maxRejected >= SIMILARITY_THRESHOLD) {
    score -= 0.35;
    reasons.push(`similar to a claim you rejected (${(maxRejected * 100).toFixed(0)}%)`);
  }

  // near-duplicate of active memory → low urgency
  let maxActive = 0;
  for (const a of activeClaims) maxActive = Math.max(maxActive, claimSimilarity(p.claim, a));
  if (maxActive >= SIMILARITY_THRESHOLD) {
    score -= 0.25;
    reasons.push(`similar to existing memory (${(maxActive * 100).toFixed(0)}%)`);
  }

  return { score: Math.max(0, Math.min(1, score)), reasons };
}

/** Pending proposals, best-first, each with its score and the reasons behind it. */
export function triagePending(store: MemoryStore, limit = 1000): TriagedProposal[] {
  const pending = store.listProposals("PENDING", limit);
  if (!pending.length) return [];
  const rejectedClaims = store.listProposals("REJECTED", 500).map((p) => p.claim);
  const activeClaims = store
    .list(1000)
    .filter((m) => m.status !== "REFUTED")
    .map((m) => m.claim);
  return pending
    .map((proposal) => ({ proposal, ...scoreProposal(proposal, rejectedClaims, activeClaims) }))
    .sort((a, b) => b.score - a.score);
}

