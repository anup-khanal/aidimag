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
   - GUARDRAIL: a behavioral rule for future agents — pass guardrail_level: 'never' (refuse + explain), 'always' (do without asking), or 'ask-first' (confirm with the user first)
   - SKILL: a reusable step-by-step procedure (e.g. "Deploy: 1) … 2) … 3) …") that the team runs repeatedly
   - TODO_CONTEXT: unfinished work + the context needed to resume it
4. Scope each memory to the paths/symbols it applies to. Repo-wide only if truly global.
5. Attach evidence whenever possible: COMMIT_REF (a sha), STATIC_CHECK (a grep/assertion command that passes iff the claim holds), TEST_RESULT (a test command), or HUMAN_ATTESTED as last resort.
6. FAILED_APPROACH memories are especially valuable — they prevent future sessions from repeating dead ends.
7. Propose 0–7 memories. Zero is fine if nothing durable was learned. Do NOT pad.
8. Before proposing, call \`memory_critique\` with a short summary of what you did and the files you touched. It checks your work against the project's existing memory and guardrails — resolve any contradictions or guardrail concerns it raises first.

Respect all GUARDRAIL memories you've seen this session: 'never' = refuse and explain why, 'always' = do without asking, 'ask-first' = ask the user before proceeding.

Your proposals enter a human review queue (\`dim review\`); they do not become active memory until approved.`;

/**
 * Ticket-aware variant (TICKETS_DESIGN T5): when the current branch carries a
 * ticket id, teach the agent to pull the ticket's WHY into its proposals —
 * "you fixed the race — should I remember that token refresh must never run
 * concurrently?" The MCP agent is often the better prompting surface.
 */
export function sessionEndPromptFor(ticketId: string | null): string {
  if (!ticketId) return SESSION_END_PROMPT;
  return (
    SESSION_END_PROMPT +
    `

This session's branch is tied to ticket ${ticketId}. Additionally:
8. Call \`ticket_get\` first — the ticket usually carries the WHY (root cause, rejected alternatives, acceptance criteria) that the code alone doesn't.
9. Combine sources: claim from what you did + ticket title/description for the rationale. A bug ticket's root cause is usually a GOTCHA; what didn't fix it is a FAILED_APPROACH; acceptance criteria are INVARIANT candidates.
10. Proposals are tagged with ${ticketId} automatically (ticket_ref); you don't need to mention the id in claims.`
  );
}

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

