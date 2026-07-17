/**
 * Session-start briefing (KARPATHY_LAYERS Feature 6) — Spec layer.
 *
 * "Agile speccing" applied to each coding session. Before an agent starts work,
 * this gathers what aidimag already knows about the area it's about to touch:
 * relevant memories, stale warnings, in-scope guardrails, coverage gaps, and a
 * few clarifying questions the agent should ask the human instead of guessing.
 *
 * Exposed as the MCP resource aidimag://session-briefing and the session_start
 * prompt.
 */

import { execFileSync } from "node:child_process";
import type { MemoryStore } from "../db/store.js";
import type { GuardrailLevel, MemoryEntry } from "../types.js";
import { detectBranchTicket } from "../tickets/provider.js";

export interface SessionBriefing {
  branch: string | null;
  ticket: string | null;
  changedFiles: string[];
  relevantMemories: MemoryEntry[];
  staleWarnings: MemoryEntry[];
  guardrailsInScope: Array<{ memory: MemoryEntry; level: GuardrailLevel }>;
  coverageGaps: string[];
  /** recent searches (agent or human) that found NOTHING — questions memory couldn't answer */
  unansweredSearches: Array<{ query: string; misses: number }>;
  suggestedQuestions: string[];
}

function currentBranch(root: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/** Files changed on this branch vs its merge-base with the default branch, plus uncommitted work. */
function branchChangedFiles(root: string): string[] {
  const tryGit = (args: string[]): string => {
    try {
      return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return "";
    }
  };
  const files = new Set<string>();
  for (const base of ["origin/main", "origin/master", "main", "master"]) {
    const mb = tryGit(["merge-base", base, "HEAD"]).trim();
    if (mb) {
      tryGit(["diff", "--name-only", `${mb}..HEAD`]).split("\n").filter(Boolean).forEach((f) => files.add(f));
      break;
    }
  }
  // include staged + unstaged working changes
  tryGit(["diff", "--name-only", "HEAD"]).split("\n").filter(Boolean).forEach((f) => files.add(f));
  return [...files];
}

export function buildSessionBriefing(store: MemoryStore, root: string): SessionBriefing {
  const branch = currentBranch(root);
  const ticket = detectBranchTicket(root);
  const changedFiles = branchChangedFiles(root);

  const scoped = changedFiles.length ? store.getForFiles(changedFiles, 100) : store.list(20).filter((m) => m.status !== "REFUTED");

  const relevantMemories = scoped
    .filter((m) => m.kind !== "GUARDRAIL" && m.status !== "REFUTED")
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 8);
  const staleWarnings = scoped.filter((m) => m.status === "STALE");
  const guardrailsInScope = scoped
    .filter((m) => m.kind === "GUARDRAIL" && m.status !== "REFUTED")
    .map((m) => ({ memory: m, level: m.guardrailLevel ?? ("ask-first" as GuardrailLevel) }));

  // coverage gaps: changed files no memory is scoped to
  const covered = new Set<string>();
  for (const m of scoped) for (const sp of m.scope.paths) for (const f of changedFiles) if (f.startsWith(sp) || sp.startsWith(f)) covered.add(f);
  const coverageGaps = changedFiles.filter((f) => !covered.has(f));

  // knowledge gaps: recent zero-hit searches (see store.searchGaps / `dim gaps`)
  let unansweredSearches: Array<{ query: string; misses: number }> = [];
  try {
    unansweredSearches = store.searchGaps({ sinceDays: 14, limit: 5 }).map((g) => ({ query: g.query, misses: g.misses }));
  } catch {
    /* pre-migration DB — gaps are advisory */
  }

  const suggestedQuestions: string[] = [];
  for (const s of staleWarnings.slice(0, 2)) {
    suggestedQuestions.push(`A ${s.kind} for ${s.scope.paths.join(", ") || "the repo"} is STALE — has it changed? ("${s.claim.slice(0, 80)}")`);
  }
  for (const f of coverageGaps.slice(0, 2)) {
    suggestedQuestions.push(`No memory covers ${f} — want me to explore it before changing it?`);
  }
  if (unansweredSearches.length) {
    suggestedQuestions.push(
      `Past sessions searched for "${unansweredSearches[0].query}" and found nothing — do you know the answer? (I'll save it with context_note.)`
    );
  }
  if (guardrailsInScope.some((g) => g.level === "ask-first")) {
    suggestedQuestions.push("An ASK-FIRST guardrail applies to these files — confirm the intended scope before I proceed.");
  }

  return { branch, ticket, changedFiles, relevantMemories, staleWarnings, guardrailsInScope, coverageGaps, unansweredSearches, suggestedQuestions };
}

const GUARDRAIL_ICON: Record<GuardrailLevel, string> = { never: "🚫", always: "✅", "ask-first": "🤚" };

/** Human/agent-readable rendering of the briefing for the MCP resource + prompt. */
export function renderBriefing(b: SessionBriefing): string {
  const lines: string[] = ["# Session briefing"];
  lines.push(`branch: ${b.branch ?? "(unknown)"}${b.ticket ? ` · ticket: ${b.ticket}` : ""}`);
  lines.push(b.changedFiles.length ? `in scope: ${b.changedFiles.length} changed file(s)` : "no branch diff detected — showing recent memory");
  lines.push("");

  if (b.guardrailsInScope.length) {
    lines.push("## Guardrails in scope ⚠️");
    for (const g of b.guardrailsInScope) lines.push(`- ${GUARDRAIL_ICON[g.level]} ${g.level.toUpperCase()}: ${g.memory.claim}`);
    lines.push("");
  }
  if (b.relevantMemories.length) {
    lines.push("## Relevant memory");
    for (const m of b.relevantMemories) lines.push(`- (${m.status}, ${m.kind}) ${m.claim}`);
    lines.push("");
  }
  if (b.staleWarnings.length) {
    lines.push("## Stale — do NOT trust without re-verifying");
    for (const m of b.staleWarnings) lines.push(`- (${m.kind}) ${m.claim}`);
    lines.push("");
  }
  if (b.coverageGaps.length) {
    lines.push("## No memory coverage");
    for (const f of b.coverageGaps.slice(0, 10)) lines.push(`- ${f}`);
    lines.push("");
  }
  if (b.unansweredSearches.length) {
    lines.push("## Unanswered questions (searches that found nothing)");
    for (const g of b.unansweredSearches) lines.push(`- "${g.query}"${g.misses > 1 ? ` (asked ${g.misses}×)` : ""}`);
    lines.push("If this session answers one of these, persist it (context_note / memory_propose).");
    lines.push("");
  }
  if (b.suggestedQuestions.length) {
    lines.push("## Ask the user before guessing");
    for (const q of b.suggestedQuestions) lines.push(`- ${q}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/** Prompt that tells the agent to interview the user using the briefing (Karpathy: extract the true goal). */
export function sessionStartPrompt(b: SessionBriefing): string {
  return (
    `You're starting a coding session. Before writing any code, ground yourself in what this project already knows.\n\n` +
    renderBriefing(b) +
    `\nNow:\n` +
    `1. Treat the guardrails above as binding (never = refuse, ask-first = confirm, always = do).\n` +
    `2. Trust VERIFIED memory; re-verify anything STALE before relying on it (\`memory_verify\`).\n` +
    `3. Ask the user the clarifying questions above instead of guessing — extract the true goal first.\n` +
    `4. Use \`memory_search\` / \`memory_get_for_files\` as you go, and \`memory_critique\` before you finish.\n` +
    `5. IMPORTANT: When the user states durable facts about the codebase (decisions, conventions, guardrails, architecture), IMMEDIATELY capture them with \`context_note\`. Examples:\n` +
    `   • "We use X because Y" → capture as DECISION\n` +
    `   • "Never do X" → capture as GUARDRAIL\n` +
    `   • "We always do X" → capture as CONVENTION\n` +
    `   • "We tried X and it failed" → capture as FAILED_APPROACH\n` +
    `   Don't wait for session end. Capture facts as they're stated, then continue the conversation naturally.`
  );
}

