/**
 * PR miner (Part 2 idea #4 — PR/review-comment capture).
 *
 * Mines merged GitHub pull requests — title, description, and crucially the
 * REVIEW COMMENTS (where humans say "don't do X here", "we always Y", "this
 * broke prod last time") — into memory proposals via the same LLM extraction
 * contract as `dim mine --llm` and `dim harvest`.
 *
 * Uses the `gh` CLI (already authenticated on the developer's machine), so no
 * token handling here. Cursor-tracked by merge time; every proposal is
 * anchored to the PR's merge commit (COMMIT_REF) so verification can re-check
 * it, and carries the reviewer's verbatim words in the rationale.
 *
 * Proposals land in the review queue (source `pr-miner`) — never directly in
 * memory.
 */

import { execFileSync } from "node:child_process";
import { extractTicketId, readTicketsConfig, DEFAULT_TICKET_PATTERN } from "../tickets/provider.js";
import { scopeFromFiles } from "./commit-miner.js";
import { debugLog } from "../debug.js";
import type { Proposal, ProposalInput } from "../types.js";
import type { MemoryStore } from "../db/store.js";

const PR_CURSOR_KEY = "pr_miner_last_merged_at";
const MAX_PRS_PER_RUN = 20; // LLM deep tier — keep runs bounded
const MAX_COMMENT_CHARS = 800; // per comment, keeps the prompt honest
const MAX_PROMPT_CHARS = 12_000;

export interface MinedPr {
  number: number;
  title: string;
  body: string;
  mergedAt: string;
  mergeCommitSha: string | null;
  headRefName: string;
  files: string[];
  /** review comments + top-level reviews, oldest first */
  comments: Array<{ author: string; path: string | null; body: string }>;
}

export interface PrMineResult {
  scanned: number;
  proposed: Proposal[];
  skippedDuplicates: number;
  provider: string | null;
}

function gh(repoRoot: string, args: string[]): string {
  return execFileSync("gh", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

/** True if the `gh` CLI is installed and authenticated for this repo's host. */
export function ghAvailable(repoRoot: string): boolean {
  try {
    gh(repoRoot, ["auth", "status"]);
    return true;
  } catch {
    return false;
  }
}

/** List merged PRs (newest first), stopping at the cursor. */
export function listMergedPrs(repoRoot: string, sinceMergedAt: string | null, limit = MAX_PRS_PER_RUN): MinedPr[] {
  const raw = gh(repoRoot, [
    "pr", "list",
    "--state", "merged",
    "--limit", String(limit),
    "--json", "number,title,body,mergedAt,mergeCommit,headRefName,files",
  ]);
  const rows = JSON.parse(raw) as Array<{
    number: number; title: string; body: string; mergedAt: string;
    mergeCommit: { oid: string } | null; headRefName: string;
    files: Array<{ path: string }>;
  }>;
  return rows
    .filter((r) => !sinceMergedAt || r.mergedAt > sinceMergedAt)
    .map((r) => ({
      number: r.number,
      title: r.title ?? "",
      body: r.body ?? "",
      mergedAt: r.mergedAt,
      mergeCommitSha: r.mergeCommit?.oid ?? null,
      headRefName: r.headRefName ?? "",
      files: (r.files ?? []).map((f) => f.path),
      comments: [],
    }));
}

/** Fetch review comments (inline, with file paths) + review bodies for one PR. */
export function fetchPrComments(repoRoot: string, prNumber: number): MinedPr["comments"] {
  const comments: MinedPr["comments"] = [];
  // inline review comments carry the file path — the highest-signal source
  try {
    const raw = gh(repoRoot, ["api", `repos/{owner}/{repo}/pulls/${prNumber}/comments`, "--paginate"]);
    for (const c of JSON.parse(raw) as Array<{ user?: { login?: string }; path?: string; body?: string }>) {
      if (c.body?.trim()) {
        comments.push({ author: c.user?.login ?? "reviewer", path: c.path ?? null, body: c.body.trim() });
      }
    }
  } catch (err) {
    // comments endpoint unavailable — reviews below still apply
    debugLog(`pr #${prNumber} review comments fetch`, err);
  }
  // top-level review bodies ("Approving, but note that …")
  try {
    const raw = gh(repoRoot, ["pr", "view", String(prNumber), "--json", "reviews"]);
    const { reviews } = JSON.parse(raw) as { reviews?: Array<{ author?: { login?: string }; body?: string }> };
    for (const r of reviews ?? []) {
      if (r.body?.trim()) comments.push({ author: r.author?.login ?? "reviewer", path: null, body: r.body.trim() });
    }
  } catch (err) {
    // review list unavailable — PR body alone still has signal
    debugLog(`pr #${prNumber} reviews fetch`, err);
  }
  return comments;
}

export const PR_EXTRACT_INSTRUCTIONS = `You are mining a merged GitHub pull request — its description and especially its REVIEW COMMENTS — for durable, project-specific knowledge worth remembering across AI coding sessions.

Review comments are where senior engineers state the unwritten rules: "we never call the DB from controllers", "this exact retry pattern caused the March outage", "always use the factory here". Those are the claims to extract.

Rules:
1. Most PRs contain NOTHING durable — routine reviews ("nit", "LGTM", style back-and-forth). Return zero claims for those. Do NOT invent.
2. SYNTHESIZE falsifiable claims about the codebase — do not parrot the comment. Include the WHY when a reviewer gives one.
3. Prefer claims grounded in review comments over the PR description; keep the reviewer's key phrase in the rationale.
4. kinds: DECISION, CONVENTION, GOTCHA, FAILED_APPROACH, ARCHITECTURE, INVARIANT, GUARDRAIL (guardrail_level never|ask-first|always), SKILL, TODO_CONTEXT.
5. Scope with the commented file paths; add "static_check" (cheap shell command, exit 0 iff true) when an honest one exists.
6. 0–3 claims per PR. Zero is the common case.

Respond with ONLY: {"claims":[{"kind":"CONVENTION","claim":"...","paths":["src/x"],"symbols":[],"guardrail_level":null,"rationale":"...","static_check":null}]}`;

export function buildPrPrompt(pr: MinedPr): string {
  const lines: string[] = [
    `PR #${pr.number}: ${pr.title}`,
    `Branch: ${pr.headRefName}`,
    `Description:\n${pr.body?.trim() || "(none)"}`,
    `Files touched: ${pr.files.slice(0, 30).join(", ") || "(unknown)"}`,
    "",
    `Review comments (${pr.comments.length}):`,
  ];
  for (const c of pr.comments) {
    lines.push(`- @${c.author}${c.path ? ` on ${c.path}` : ""}: ${c.body.slice(0, MAX_COMMENT_CHARS)}`);
  }
  return lines.join("\n").slice(0, MAX_PROMPT_CHARS);
}

/**
 * Mine merged PRs since the cursor. Requires the `gh` CLI and an LLM
 * provider; returns provider:null when no provider is available (the CLI
 * explains how to get one — there is no regex fallback here because review
 * threads need synthesis, and `dim mine` already covers merge-commit bodies).
 */
export async function minePrs(
  store: MemoryStore,
  repoRoot: string,
  opts: { max?: number; all?: boolean } = {}
): Promise<PrMineResult> {
  const { getTextProvider } = await import("../knowledge/llm.js");
  const { parseClaims } = await import("../knowledge/extract.js");
  const provider = await getTextProvider();
  if (!provider) return { scanned: 0, proposed: [], skippedDuplicates: 0, provider: null };

  const cursor = opts.all ? null : store.getMeta(PR_CURSOR_KEY);
  const prs = listMergedPrs(repoRoot, cursor, Math.min(opts.max ?? MAX_PRS_PER_RUN, MAX_PRS_PER_RUN));
  const ticketPattern = readTicketsConfig(repoRoot).pattern ?? DEFAULT_TICKET_PATTERN;

  const proposed: Proposal[] = [];
  let skippedDuplicates = 0;

  for (const pr of prs) {
    pr.comments = fetchPrComments(repoRoot, pr.number);
    // description-less PRs with no review discussion carry no reviewable signal
    if (!pr.body.trim() && pr.comments.length === 0) continue;

    let claims;
    try {
      claims = parseClaims(await provider.generate(PR_EXTRACT_INSTRUCTIONS, buildPrPrompt(pr)));
    } catch (err) {
      debugLog(`llm mining pr #${pr.number} (skipped)`, err);
      continue; // provider hiccup on one PR shouldn't kill the run
    }
    const ticketRef =
      extractTicketId(`${pr.title}\n${pr.body}\n${pr.headRefName}`, ticketPattern) ?? undefined;

    for (const cl of claims.slice(0, 3)) {
      const evidence: ProposalInput["evidence"] = [];
      if (pr.mergeCommitSha) evidence.push({ type: "COMMIT_REF", payload: pr.mergeCommitSha });
      if (cl.staticCheck) evidence.push({ type: "STATIC_CHECK", payload: cl.staticCheck });
      if (ticketRef) evidence.push({ type: "TICKET_REF", payload: ticketRef });
      const p = store.propose({
        kind: cl.kind,
        claim: cl.claim,
        paths: cl.paths ?? scopeFromFiles(pr.files),
        symbols: cl.symbols,
        guardrailLevel: cl.guardrailLevel,
        evidence: evidence.length ? evidence : undefined,
        source: "pr-miner",
        sourceRef: `pr:${pr.number}`,
        rationale: cl.rationale ?? `Mined from PR #${pr.number}: ${pr.title}`,
        ticketRef,
      });
      if (p) proposed.push(p);
      else skippedDuplicates++;
    }
  }

  // advance cursor to the newest merge time seen (list is newest-first)
  if (prs.length > 0) store.setMeta(PR_CURSOR_KEY, prs[0].mergedAt);

  return {
    scanned: prs.length,
    proposed,
    skippedDuplicates,
    provider: `${provider.name}/${provider.model}`,
  };
}

