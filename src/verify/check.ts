/**
 * `dim check` (KARPATHY_LAYERS Feature 4) — Verifier layer, shifted left.
 *
 * Verification today runs *after* code lands (post-merge hook). `dim check`
 * runs it against a diff BEFORE the commit, so contradictions are caught at
 * author time. It analyzes `git diff --staged` (or an arbitrary ref) against
 * the memories scoped to the changed files:
 *
 *   - STATIC_CHECK evidence → re-run; a FAIL means the change broke the claim
 *   - GUARDRAIL (never)     → keyword-match the added lines against the claim
 *   - INVARIANT / CONVENTION scoped to a changed file → advisory reminder
 *
 * Exit policy is the caller's: warn (exit 0) by default, block (exit 1) opt-in.
 */

import { execFileSync } from "node:child_process";
import type { MemoryStore } from "../db/store.js";
import type { MemoryEntry } from "../types.js";
import { runEvidence } from "./runners.js";

export interface DiffFile {
  path: string;
  addedLines: string[];
}

export type Severity = "fail" | "warn";

export interface CheckViolation {
  memory: MemoryEntry;
  severity: Severity;
  detail: string;
}

export interface CheckReport {
  changedFiles: string[];
  checked: number;
  violations: CheckViolation[];
}

/** Parse a unified diff (—U0) into per-file added lines. */
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  for (const line of diff.split("\n")) {
    const m = line.match(/^\+\+\+ b\/(.+)$/);
    if (m) {
      current = { path: m[1], addedLines: [] };
      if (m[1] !== "/dev/null") files.push(current);
      continue;
    }
    if (current && line.startsWith("+") && !line.startsWith("+++")) {
      current.addedLines.push(line.slice(1));
    }
  }
  return files;
}

/** Run `git diff` for staged changes (default) or against a ref. */
export function gitDiff(repoRoot: string, ref?: string): string {
  const args = ref
    ? ["diff", "--unified=0", `${ref}`, "--"]
    : ["diff", "--cached", "--unified=0", "--"];
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return "";
  }
}

const STOP = new Set(["the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with", "never", "always", "must", "only", "not", "use", "via"]);

function significantTokens(claim: string): string[] {
  return claim
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((t) => t.length > 3 && !STOP.has(t));
}

/** A guardrail-never is "tripped" when added code contains enough of its key terms. */
function guardrailTripped(claim: string, addedText: string): boolean {
  const tokens = significantTokens(claim);
  if (tokens.length === 0) return false;
  const hay = addedText.toLowerCase();
  const hits = tokens.filter((t) => hay.includes(t)).length;
  return hits / tokens.length >= 0.6;
}

export function checkDiff(store: MemoryStore, repoRoot: string, opts: { ref?: string } = {}): CheckReport {
  const diff = gitDiff(repoRoot, opts.ref);
  const diffFiles = parseDiff(diff);
  const changedFiles = diffFiles.map((f) => f.path);
  const addedByFile = new Map(diffFiles.map((f) => [f.path, f.addedLines.join("\n")]));

  if (changedFiles.length === 0) {
    return { changedFiles, checked: 0, violations: [] };
  }

  // Active memories scoped to the changed files (skip refuted/stale — only
  // currently-trusted beliefs gate a commit).
  const memories = store
    .getForFiles(changedFiles, 200)
    .filter((m) => m.status === "VERIFIED" || m.status === "UNVERIFIED" || m.pinned);

  const violations: CheckViolation[] = [];
  const seenIds = new Set<string>();

  for (const m of memories) {
    seenIds.add(m.id);

    // 1) re-run any STATIC_CHECK evidence against the working tree
    for (const ev of m.grounding) {
      if (ev.type !== "STATIC_CHECK") continue;
      const outcome = runEvidence(ev, repoRoot);
      if (outcome.result === "FAIL") {
        violations.push({
          memory: m,
          severity: "fail",
          detail: `STATIC_CHECK now fails (${outcome.detail}) — this change contradicts the claim`,
        });
      }
    }

    // 2) GUARDRAIL (never): pattern-match the added lines against the claim
    if (m.kind === "GUARDRAIL" && m.guardrailLevel === "never") {
      const added = m.scope.paths.length
        ? m.scope.paths.flatMap((sp) => changedFiles.filter((f) => f.startsWith(sp) || sp.startsWith(f)).map((f) => addedByFile.get(f) ?? "")).join("\n")
        : changedFiles.map((f) => addedByFile.get(f) ?? "").join("\n");
      if (guardrailTripped(m.claim, added)) {
        violations.push({
          memory: m,
          severity: "fail",
          detail: "🚫 NEVER guardrail: the staged change appears to do exactly what this forbids",
        });
      }
    }

    // 3) INVARIANT / CONVENTION scoped to a changed file → advisory reminder
    if ((m.kind === "INVARIANT" || m.kind === "CONVENTION") && m.scope.paths.length) {
      const touches = m.scope.paths.some((sp) => changedFiles.some((f) => f.startsWith(sp) || sp.startsWith(f)));
      const hasStaticCheck = m.grounding.some((e) => e.type === "STATIC_CHECK");
      if (touches && !hasStaticCheck) {
        violations.push({
          memory: m,
          severity: "warn",
          detail: `${m.kind} covers a file you changed — make sure it still holds (no automated check attached)`,
        });
      }
    }
  }

  return { changedFiles, checked: seenIds.size, violations };
}

