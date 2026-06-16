/**
 * memory_critique (KARPATHY_LAYERS Feature 3) — Verifier layer.
 *
 * The "second AI critic" Karpathy recommends, but grounded in *verified project
 * memory* rather than another model's opinions. Given a summary of what an agent
 * did (and the files it touched), it surfaces:
 *   - guardrail violations  (kind=GUARDRAIL, level never/ask-first)
 *   - confirmations         (memory the work is consistent with)
 *   - contradictions        (in-scope rules the summary doesn't appear to honor)
 *   - missing coverage      (changed files with no memory → ask the user)
 *
 * Matching is heuristic (keyword overlap + scope) layered on real retrieval —
 * deliberately conservative: it raises questions, the agent decides.
 */

import type { MemoryStore } from "../db/store.js";
import type { GuardrailLevel, MemoryEntry } from "../types.js";
import { hybridSearch } from "../embeddings/search.js";

export interface CritiqueInput {
  summary: string;
  filesChanged: string[];
}

export interface CritiqueResult {
  guardrailsViolated: Array<{ memory: MemoryEntry; level: GuardrailLevel; concern: string }>;
  contradictions: Array<{ memory: MemoryEntry; concern: string }>;
  confirmations: Array<{ memory: MemoryEntry }>;
  missingCoverage: string[];
}

const STOP = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with", "is", "are",
  "be", "this", "that", "it", "as", "at", "by", "from", "we", "i", "you", "should", "will",
  "add", "added", "adds", "use", "used", "uses", "change", "changed", "update", "updated",
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length > 2 && !STOP.has(t))
  );
}

/** Jaccard overlap between two token sets (0..1). */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function scopesFile(m: MemoryEntry, files: string[]): boolean {
  if (m.scope.paths.length === 0) return false; // repo-wide → not "specific to" a file
  return m.scope.paths.some((sp) => files.some((f) => f.startsWith(sp) || sp.startsWith(f)));
}

const CONFIRM_THRESHOLD = 0.1;
const GUARDRAIL_THRESHOLD = 0.06; // guardrails surface on weaker signal — better safe

/**
 * Critique a unit of work against project memory. Async because it folds in
 * semantic recall when embeddings are configured (degrades to keyword-only).
 */
export async function critique(store: MemoryStore, input: CritiqueInput): Promise<CritiqueResult> {
  const summaryTokens = tokenize(input.summary);
  const files = input.filesChanged ?? [];

  // 1) memories scoped to the touched files
  const scoped = files.length ? store.getForFiles(files, 50) : [];
  // 2) semantically/keyword-related memories beyond scope
  const { results: related } = await hybridSearch(store, { query: input.summary, limit: 20 }).catch(() => ({
    results: [] as MemoryEntry[],
    semantic: false,
  }));
  // 3) every guardrail, project-wide
  const guardrails = store.list(10_000).filter((m) => m.kind === "GUARDRAIL" && m.status !== "REFUTED");

  const pool = new Map<string, MemoryEntry>();
  for (const m of [...scoped, ...related]) {
    if (m.status === "REFUTED" || m.kind === "GUARDRAIL") continue;
    pool.set(m.id, m);
  }

  const result: CritiqueResult = {
    guardrailsViolated: [],
    contradictions: [],
    confirmations: [],
    missingCoverage: [],
  };

  for (const g of guardrails) {
    const score = overlap(summaryTokens, tokenize(g.claim));
    const inScope = scopesFile(g, files);
    if ((score >= GUARDRAIL_THRESHOLD || inScope) && g.guardrailLevel !== "always") {
      const level = g.guardrailLevel ?? "ask-first";
      result.guardrailsViolated.push({
        memory: g,
        level,
        concern:
          level === "never"
            ? "Your change appears to touch a NEVER guardrail. Refuse or justify explicitly before proceeding."
            : "An ASK-FIRST guardrail covers this area. Confirm with the user before continuing.",
      });
    }
  }

  for (const m of pool.values()) {
    const score = overlap(summaryTokens, tokenize(m.claim));
    const inScope = scopesFile(m, files);
    if (score >= CONFIRM_THRESHOLD) {
      result.confirmations.push({ memory: m });
    } else if (inScope && (m.kind === "INVARIANT" || m.kind === "CONVENTION" || m.kind === "DECISION")) {
      // in scope but the summary doesn't mention honoring it → worth a look
      result.contradictions.push({
        memory: m,
        concern: `This ${m.kind} governs ${m.scope.paths.join(", ")} which you changed, but your summary doesn't confirm it still holds. Re-check it.`,
      });
    }
  }

  // changed files with no scoped memory at all → suggest asking the user
  const covered = new Set<string>();
  for (const m of scoped) for (const sp of m.scope.paths) for (const f of files) if (f.startsWith(sp) || sp.startsWith(f)) covered.add(f);
  result.missingCoverage = files.filter((f) => !covered.has(f));

  return result;
}

