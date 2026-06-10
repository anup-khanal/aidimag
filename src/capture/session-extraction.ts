/**
 * Session-end extraction (Phase 2 capture pipeline).
 *
 * The agent does the summarizing — we provide a tight, structured prompt
 * (exposed as an MCP prompt) and a `memory_propose` tool that routes the
 * agent's structured proposals into the human review queue.
 */

export const SESSION_END_PROMPT = `You are finishing a coding session. Before you stop, extract durable knowledge about this codebase so future sessions don't have to re-discover it.

Review what you learned this session and propose memories using the \`memory_propose\` tool. Rules:

1. Only propose things that are DURABLE (true beyond this session) and NON-OBVIOUS (not derivable from a quick file read).
2. Write each claim as a FALSIFIABLE statement — something a checker could verify against the code. Bad: "the auth code is tricky". Good: "JWT refresh in src/auth/refresh.ts must run before middleware chain; reordering breaks session renewal (see commit abc123)".
3. Pick the right kind:
   - DECISION: a choice made and why (alternatives rejected)
   - CONVENTION: a rule consistently followed in this repo
   - GOTCHA: surprising behavior that cost you time
   - FAILED_APPROACH: something you tried that did NOT work, and why
   - ARCHITECTURE: how components fit together
   - INVARIANT: something that must always/never hold
   - TODO_CONTEXT: unfinished work + the context needed to resume it
4. Scope each memory to the paths/symbols it applies to. Repo-wide only if truly global.
5. Attach evidence whenever possible: COMMIT_REF (a sha), STATIC_CHECK (a grep/assertion command that passes iff the claim holds), TEST_RESULT (a test command), or HUMAN_ATTESTED as last resort.
6. FAILED_APPROACH memories are especially valuable — they prevent future sessions from repeating dead ends.
7. Propose 0–7 memories. Zero is fine if nothing durable was learned. Do NOT pad.

Your proposals enter a human review queue (\`dim review\`); they do not become active memory until approved.`;

/** One-line summary of a proposal for human review UIs. */
export function proposalSummaryLine(p: {
  id: string;
  kind: string;
  claim: string;
  source: string;
  rationale?: string;
}): string {
  return `[${p.id.slice(0, 8)}] (${p.kind}, via ${p.source}) ${p.claim}`;
}

