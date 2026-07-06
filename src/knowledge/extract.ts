/**
 * Shared claim-extraction contract for knowledge ingestion. Both summarizer paths
 * use this so they produce identical, reviewable output:
 *   - the LLM fallback (`dim knowledge sync`) feeds these instructions to a model;
 *   - the MCP `knowledge_ingest` prompt feeds them to the connected agent.
 *
 * The extractor turns a project document into typed, scoped, FALSIFIABLE claims —
 * never a single blob. Claims become proposals (source `knowledge:<doc>`) and, once
 * approved with `dim review`, PINNED memories.
 */

import type { GuardrailLevel, MemoryKind } from "../types.js";

export interface ExtractedClaim {
  kind: MemoryKind;
  claim: string;
  paths?: string[];
  symbols?: string[];
  /** only for kind === "GUARDRAIL" */
  guardrailLevel?: GuardrailLevel;
  /** short note on why this is durable / where in the doc it came from */
  rationale?: string;
  /** optional STATIC_CHECK shell command that passes iff the claim holds */
  staticCheck?: string;
}

const KINDS: MemoryKind[] = [
  "DECISION", "CONVENTION", "GOTCHA", "FAILED_APPROACH",
  "ARCHITECTURE", "INVARIANT", "TODO_CONTEXT", "GUARDRAIL", "SKILL",
];
const GUARDRAIL_LEVELS: GuardrailLevel[] = ["never", "ask-first", "always"];

export const KNOWLEDGE_EXTRACT_INSTRUCTIONS = `You are extracting durable, project-specific knowledge from a document a developer dropped into the knowledge inbox (a design doc, ADR, style guide, runbook, or notes).

Turn it into a small set of FALSIFIABLE claims. Rules:

1. Only DURABLE, NON-OBVIOUS facts about THIS project — rules, decisions, architecture, invariants, guardrails, procedures. Skip generic advice, tutorials, and anything a quick file read already shows.
2. Write each claim as a checkable statement. Bad: "auth is complex". Good: "JWT refresh in src/auth/refresh.ts must run before the middleware chain; reordering breaks session renewal".
3. Pick the right kind:
   - DECISION: a choice + the rejected alternative
   - CONVENTION: a rule the repo follows
   - GOTCHA: surprising behavior that costs time
   - FAILED_APPROACH: something tried that did NOT work
   - ARCHITECTURE: how components fit together
   - INVARIANT: something that must always/never hold
   - GUARDRAIL: a behavioral rule for future agents — set guardrail_level to "never" (refuse), "ask-first" (confirm), or "always" (do automatically)
   - SKILL: a reusable step-by-step procedure (write the steps as "1) ... 2) ...")
   - TODO_CONTEXT: unfinished work + the context to resume it
4. Scope each claim with paths/symbols it applies to when the document names them; otherwise leave them empty (repo-wide).
5. Extract 0–12 claims. Zero is fine. Do NOT pad, and do NOT invent rules the document doesn't support.

Respond with ONLY a JSON object of this exact shape:
{"claims":[{"kind":"CONVENTION","claim":"...","paths":["src/x"],"symbols":[],"guardrail_level":null,"rationale":"..."}]}`;

/** Build the user message for the LLM: instructions + the document. */
export function buildExtractionUser(filename: string, content: string): string {
  return `Document: ${filename}\n\n----- BEGIN DOCUMENT -----\n${content}\n----- END DOCUMENT -----`;
}

interface RawClaim {
  kind?: string;
  claim?: string;
  paths?: unknown;
  symbols?: unknown;
  guardrail_level?: unknown;
  guardrailLevel?: unknown;
  rationale?: unknown;
  static_check?: unknown;
  staticCheck?: unknown;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  return out.length ? out : undefined;
}

/**
 * Tolerantly parse a model/agent response into validated claims. Accepts a bare
 * array or an object with a `claims` array, and ignores anything malformed rather
 * than throwing — a bad doc should never crash ingestion.
 */
export function parseClaims(raw: string): ExtractedClaim[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    // last resort: pull the first {...} or [...] block out of chatty output
    const m = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!m) return [];
    try {
      data = JSON.parse(m[0]);
    } catch {
      return [];
    }
  }
  const list: unknown = Array.isArray(data)
    ? data
    : (data as { claims?: unknown })?.claims;
  if (!Array.isArray(list)) return [];

  const claims: ExtractedClaim[] = [];
  for (const item of list as RawClaim[]) {
    const kind = String(item?.kind ?? "").toUpperCase() as MemoryKind;
    const claim = typeof item?.claim === "string" ? item.claim.trim() : "";
    if (!claim || !KINDS.includes(kind)) continue;

    const out: ExtractedClaim = { kind, claim };
    const paths = asStringArray(item.paths);
    const symbols = asStringArray(item.symbols);
    if (paths) out.paths = paths;
    if (symbols) out.symbols = symbols;
    if (typeof item.rationale === "string" && item.rationale.trim()) out.rationale = item.rationale.trim();
    const sc = item.static_check ?? item.staticCheck;
    if (typeof sc === "string" && sc.trim()) out.staticCheck = sc.trim();

    if (kind === "GUARDRAIL") {
      const lvl = String(item.guardrail_level ?? item.guardrailLevel ?? "ask-first").toLowerCase() as GuardrailLevel;
      out.guardrailLevel = GUARDRAIL_LEVELS.includes(lvl) ? lvl : "ask-first";
    }
    claims.push(out);
  }
  return dedupeClaims(claims);
}

/** Collapse claims repeated across chunks (normalized text match). */
export function dedupeClaims(claims: ExtractedClaim[]): ExtractedClaim[] {
  const seen = new Set<string>();
  const out: ExtractedClaim[] = [];
  for (const c of claims) {
    const key = c.claim.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

