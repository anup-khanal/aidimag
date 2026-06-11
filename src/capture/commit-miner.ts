/**
 * Commit miner (Phase 2 capture pipeline).
 *
 * Walks git history since the last mined commit and heuristically extracts
 * memory-worthy candidates from commit messages + touched files. Candidates
 * land in the proposal queue (human-in-the-loop) — never directly in memory.
 *
 * Each proposal is anchored with COMMIT_REF evidence so Phase 3 verification
 * can re-check it against history.
 */

import { execFileSync } from "node:child_process";
import type { MemoryKind, Proposal, ProposalInput } from "../types.js";
import type { MemoryStore } from "../db/store.js";

const MINER_CURSOR_KEY = "commit_miner_last_sha";
const COMMIT_SEP = "\x1e"; // record separator
const FIELD_SEP = "\x1f"; // unit separator

export interface MinedCommit {
  sha: string;
  subject: string;
  body: string;
  files: string[];
}

export interface MineResult {
  scanned: number;
  proposed: Proposal[];
  skippedDuplicates: number;
  lastSha: string | null;
}

/**
 * Heuristic signal patterns → memory kind.
 * Order matters: first match wins.
 */
const SIGNALS: Array<{ kind: MemoryKind; patterns: RegExp[] }> = [
  {
    kind: "FAILED_APPROACH",
    patterns: [
      /\brevert(s|ed|ing)?\b/i,
      /\bback(\s|-)?out\b/i,
      /\bdidn'?t work\b/i,
      /\babandon(s|ed|ing)?\b/i,
    ],
  },
  {
    kind: "GOTCHA",
    patterns: [
      /\bworkaround\b/i,
      /\bhack\b/i,
      /\bgotcha\b/i,
      /\bedge case\b/i,
      /\brace condition\b/i,
      /\bfoot(\s|-)?gun\b/i,
      /\bsubtle\b/i,
      /\bcareful\b/i,
      /\bdo not\b.*\bbecause\b/i,
    ],
  },
  {
    kind: "DECISION",
    patterns: [
      /\bdecid(e|ed|ing)\b/i,
      /\bswitch(ed|ing)? (from|to)\b/i,
      /\bmigrat(e|ed|ing) (from|to)\b/i,
      /\breplac(e|ed|ing) .+ with\b/i,
      /\binstead of\b/i,
      /\bchose\b/i,
      /\badopt(s|ed|ing)?\b/i,
      /\bADR\b/,
    ],
  },
  {
    kind: "CONVENTION",
    patterns: [
      /\bconvention\b/i,
      /\balways\b.+\b(use|go|import|call)\b/i,
      /\bnever\b.+\b(use|import|call)\b/i,
      /\bstandardiz(e|ed|ing)\b/i,
      /\benforce(s|d)?\b/i,
      /\blint rule\b/i,
    ],
  },
  {
    kind: "INVARIANT",
    patterns: [/\binvariant\b/i, /\bmust (always|never)\b/i, /\bguarantee(s|d)?\b/i],
  },
];

/** Why-markers: a commit explaining reasoning is more memory-worthy. */
const WHY_MARKERS = /\b(because|so that|otherwise|due to|the reason|to avoid|to prevent)\b/i;

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

export function readCommits(repoRoot: string, sinceSha: string | null, maxCommits = 500): MinedCommit[] {
  const range = sinceSha ? `${sinceSha}..HEAD` : "HEAD";
  let raw: string;
  try {
    // NOTE: merges are included on purpose — GitHub "merge pull request"
    // commits carry the PR title in the body, and squash-merges carry the
    // full PR description. Pure merge noise ("Merge branch 'x'") has no
    // signal words, so classifyCommit filters it naturally.
    raw = git(repoRoot, [
      "log",
      range,
      `--max-count=${maxCommits}`,
      `--pretty=format:${COMMIT_SEP}%H${FIELD_SEP}%s${FIELD_SEP}%b${FIELD_SEP}`,
      "--name-only",
    ]);
  } catch (err) {
    // sinceSha may no longer exist (rebase/gc) — fall back to full history
    if (sinceSha) return readCommits(repoRoot, null, maxCommits);
    throw err;
  }
  const commits: MinedCommit[] = [];
  for (const chunk of raw.split(COMMIT_SEP)) {
    if (!chunk.trim()) continue;
    const [sha, subject, body, fileBlock] = chunk.split(FIELD_SEP);
    if (!sha) continue;
    const files = (fileBlock ?? "")
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
    commits.push({ sha: sha.trim(), subject: subject ?? "", body: body ?? "", files });
  }
  return commits;
}

export function classifyCommit(c: MinedCommit): { kind: MemoryKind; matched: string } | null {
  const text = `${c.subject}\n${c.body}`;
  for (const { kind, patterns } of SIGNALS) {
    for (const re of patterns) {
      const m = text.match(re);
      if (m) return { kind, matched: m[0] };
    }
  }
  // a long explanatory body with why-markers is a DECISION candidate even without keywords
  if (c.body.length > 120 && WHY_MARKERS.test(c.body)) {
    return { kind: "DECISION", matched: "explanatory body" };
  }
  return null;
}

function buildClaim(c: MinedCommit, kind: MemoryKind): string {
  let subject = c.subject.trim().replace(/\.+$/, "");
  let bodyLines = c.body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("Co-authored-by") && !l.startsWith("Signed-off-by"));
  // merge commits: the subject is boilerplate ("Merge pull request #123 …");
  // the PR title is the first body line — promote it.
  if (/^Merge (pull request|branch)/i.test(subject) && bodyLines.length) {
    subject = bodyLines[0].replace(/\.+$/, "");
    bodyLines = bodyLines.slice(1);
  }
  const why = bodyLines.join(" ").slice(0, 300);
  const prefix =
    kind === "FAILED_APPROACH"
      ? "An approach was abandoned"
      : kind === "GOTCHA"
        ? "There is a gotcha"
        : kind === "DECISION"
          ? "A decision was made"
          : kind === "CONVENTION"
            ? "A convention applies"
            : "An invariant holds";
  return why ? `${prefix}: ${subject} — ${why}` : `${prefix}: ${subject}`;
}

/** Files that say nothing about the code — never useful as memory scope. */
const SCOPE_NOISE = /^(\.idea\/|\.vscode\/|\.aidimag\/|\.github\/workflows\/.*\.lock|\.gitignore$|\.DS_Store$|node_modules\/)/;

/** Reduce touched files to a few representative scope paths (common directories). */
export function scopeFromFiles(files: string[], maxPaths = 4): string[] {
  files = files.filter((f) => !SCOPE_NOISE.test(f));
  if (files.length === 0) return [];
  if (files.length <= maxPaths) return files;
  const dirs = new Map<string, number>();
  for (const f of files) {
    const dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ".";
    dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
  }
  return [...dirs.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxPaths)
    .map(([d]) => d);
}

export function mineCommits(
  store: MemoryStore,
  repoRoot: string,
  opts: { maxCommits?: number; full?: boolean } = {}
): MineResult {
  const sinceSha = opts.full ? null : store.getMeta(MINER_CURSOR_KEY);
  const commits = readCommits(repoRoot, sinceSha, opts.maxCommits ?? 500);

  const proposed: Proposal[] = [];
  let skippedDuplicates = 0;

  for (const c of commits) {
    const hit = classifyCommit(c);
    if (!hit) continue;
    const input: ProposalInput = {
      kind: hit.kind,
      claim: buildClaim(c, hit.kind),
      paths: scopeFromFiles(c.files),
      evidence: [{ type: "COMMIT_REF", payload: c.sha }],
      source: "commit-miner",
      sourceRef: c.sha,
      rationale: `Matched signal "${hit.matched}" in commit ${c.sha.slice(0, 8)}: ${c.subject}`,
    };
    const p = store.propose(input);
    if (p) proposed.push(p);
    else skippedDuplicates++;
  }

  // advance cursor to current HEAD (newest commit is first in `git log` output)
  const head = commits.length > 0 ? commits[0].sha : sinceSha;
  if (head) store.setMeta(MINER_CURSOR_KEY, head);

  return { scanned: commits.length, proposed, skippedDuplicates, lastSha: head ?? null };
}

