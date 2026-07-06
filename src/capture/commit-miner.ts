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
import { extractTicketId, readTicketsConfig, DEFAULT_TICKET_PATTERN } from "../tickets/provider.js";
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

  // T1 ticket extraction (offline): per-commit from the message; for
  // incremental mining (the post-commit hook path) the current branch name is
  // a trustworthy fallback — for full-history scans it would mislabel.
  const ticketPattern = readTicketsConfig(repoRoot).pattern ?? DEFAULT_TICKET_PATTERN;
  let branchTicket: string | null = null;
  if (sinceSha) {
    try {
      const branch = git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
      branchTicket = extractTicketId(branch, ticketPattern);
    } catch {
      // detached HEAD etc — message extraction still applies
    }
  }

  const proposed: Proposal[] = [];
  let skippedDuplicates = 0;

  for (const c of commits) {
    const hit = classifyCommit(c);
    if (!hit) continue;
    const ticketRef = extractTicketId(`${c.subject}\n${c.body}`, ticketPattern) ?? branchTicket ?? undefined;
    const input: ProposalInput = {
      kind: hit.kind,
      claim: buildClaim(c, hit.kind),
      paths: scopeFromFiles(c.files),
      evidence: [
        { type: "COMMIT_REF", payload: c.sha },
        ...(ticketRef ? [{ type: "TICKET_REF" as const, payload: ticketRef }] : []),
      ],
      source: "commit-miner",
      sourceRef: c.sha,
      rationale: `Matched signal "${hit.matched}" in commit ${c.sha.slice(0, 8)}: ${c.subject}`,
      ticketRef,
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

// ---------------------------------------------------------------- LLM mining (deep tier)

const LLM_DIFF_CHARS = 6_000;
const LLM_MAX_COMMITS = 40; // per run — LLM mining is the deep tier

export const COMMIT_EXTRACT_INSTRUCTIONS = `You are mining a git commit for durable, project-specific knowledge worth remembering across AI coding sessions: decisions (and rejected alternatives), conventions, gotchas, failed approaches, invariants, architecture facts.

Rules:
1. Most commits contain NOTHING durable — routine features/fixes/refactors. Return zero claims for those. Do NOT invent.
2. When there IS signal, SYNTHESIZE a falsifiable claim about the codebase — do not parrot the commit message. Bad: "A decision was made: use Redis". Good: "Rate limiting uses Redis (src/limits); the in-memory limiter was abandoned because multi-instance deploys need shared counters".
3. Use the DIFF, not just the message — renamed modules, deleted approaches, and added config tell the real story.
4. kinds: DECISION, CONVENTION, GOTCHA, FAILED_APPROACH, ARCHITECTURE, INVARIANT, GUARDRAIL (guardrail_level never|ask-first|always), SKILL, TODO_CONTEXT.
5. Scope with the touched paths; add "static_check" (cheap shell command, exit 0 iff true) when an honest one exists.
6. 0–2 claims per commit. Zero is the common case.

Respond with ONLY: {"claims":[{"kind":"DECISION","claim":"...","paths":["src/x"],"symbols":[],"guardrail_level":null,"rationale":"...","static_check":null}]}`;

function commitDiff(repoRoot: string, sha: string): string {
  try {
    return git(repoRoot, ["show", sha, "--stat", "--patch", "--format="]).slice(0, LLM_DIFF_CHARS);
  } catch {
    return "";
  }
}

/**
 * LLM-powered deep mining: reads message + diff, synthesizes claims with
 * suggested STATIC_CHECKs. Requires a text provider (OpenAI/Ollama); the
 * caller falls back to regex mining when none is available. Same cursor as
 * regex mining — the two modes are alternatives over the same history.
 */
export async function mineCommitsLlm(
  store: MemoryStore,
  repoRoot: string,
  opts: { maxCommits?: number; full?: boolean } = {}
): Promise<MineResult & { provider: string | null }> {
  const { getTextProvider } = await import("../knowledge/llm.js");
  const { parseClaims } = await import("../knowledge/extract.js");
  const provider = await getTextProvider();
  if (!provider) {
    const r = mineCommits(store, repoRoot, opts);
    return { ...r, provider: null };
  }

  const sinceSha = opts.full ? null : store.getMeta(MINER_CURSOR_KEY);
  const commits = readCommits(repoRoot, sinceSha, Math.min(opts.maxCommits ?? LLM_MAX_COMMITS, LLM_MAX_COMMITS));
  const ticketPattern = readTicketsConfig(repoRoot).pattern ?? DEFAULT_TICKET_PATTERN;

  const proposed: Proposal[] = [];
  let skippedDuplicates = 0;

  for (const c of commits) {
    // Pure merge noise never carries signal — skip the LLM call entirely.
    if (/^Merge branch /i.test(c.subject) && !c.body.trim()) continue;
    const user =
      `Commit ${c.sha.slice(0, 12)}\nSubject: ${c.subject}\nBody:\n${c.body || "(none)"}\n\n` +
      `Diff (truncated):\n${commitDiff(repoRoot, c.sha)}`;
    let claims;
    try {
      claims = parseClaims(await provider.generate(COMMIT_EXTRACT_INSTRUCTIONS, user));
    } catch {
      continue; // provider hiccup on one commit shouldn't kill the run
    }
    const ticketRef = extractTicketId(`${c.subject}\n${c.body}`, ticketPattern) ?? undefined;
    for (const cl of claims.slice(0, 2)) {
      const evidence: ProposalInput["evidence"] = [{ type: "COMMIT_REF", payload: c.sha }];
      if (cl.staticCheck) evidence.push({ type: "STATIC_CHECK", payload: cl.staticCheck });
      if (ticketRef) evidence.push({ type: "TICKET_REF", payload: ticketRef });
      const p = store.propose({
        kind: cl.kind,
        claim: cl.claim,
        paths: cl.paths ?? scopeFromFiles(c.files),
        symbols: cl.symbols,
        guardrailLevel: cl.guardrailLevel,
        evidence,
        source: "commit-miner",
        sourceRef: c.sha,
        rationale: cl.rationale ?? `LLM-mined from commit ${c.sha.slice(0, 8)}: ${c.subject}`,
        ticketRef,
      });
      if (p) proposed.push(p);
      else skippedDuplicates++;
    }
  }

  const head = commits.length > 0 ? commits[0].sha : sinceSha;
  if (head) store.setMeta(MINER_CURSOR_KEY, head);

  return {
    scanned: commits.length,
    proposed,
    skippedDuplicates,
    lastSha: head ?? null,
    provider: `${provider.name}/${provider.model}`,
  };
}

