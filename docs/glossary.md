# Glossary

Quick definitions of the terms used throughout these docs.

**aiDimag** — the project. A verified memory system for AI coding
agents.

**dim** — the command-line tool. `dim` and `aidimag` are the same command.

**Memory** — a single piece of knowledge about your codebase, written as a checkable claim.

**Claim** — the statement a memory makes. Should be *falsifiable* (checkable against code).

**Kind** — the category of a memory: decision, convention, gotcha, failed approach,
architecture, invariant, guardrail, skill, or todo context.

**Scope** — the files and/or symbols a memory applies to. Empty scope = repo-wide.

**Evidence** — how a claim proves itself: a shell check (STATIC_CHECK), a commit
(COMMIT_REF), a test (TEST_RESULT), an output match (EXEC_TRACE), a human attestation
(HUMAN_ATTESTED), or a ticket link (TICKET_REF).

**Status** — a memory's current trust state: **unverified**, **verified**, **stale**, or
**refuted**.

**Verified** — the memory's machine-checkable evidence currently passes.

**Stale** — evidence that used to pass now fails; the memory shouldn't be trusted until it
recovers.

**Refuted** — deliberately marked false, but kept as *negative knowledge*.

**Confidence** — a 0–1 score that rises with passing evidence and falls with failing evidence
or the passage of time.

**Decay** — the gradual loss of confidence for memories that can't be machine-re-verified, so
unchecked trust expires.

**Pinned** — exempt from time decay (but still falsifiable). For foundational knowledge.

**Proposal** — an *inferred* memory (from the commit miner or an agent) waiting in the review
queue for your approval.

**Review queue** — the list of proposals you approve, reword, or reject with `dim review`.

**Guardrail** — a behavioral rule for agents with an enforcement **level**: `never`,
`ask-first`, or `always`.

**Skill** — a reusable step-by-step procedure stored as memory.

**Commit miner** — the component that scans new commits for memory candidates.

**Knowledge inbox** — the `knowledge/` folder where you drop project docs; aiDimag summarizes
them into reviewed, pinned-on-approve memory proposals (`dim knowledge sync`).

**Generated context** — the `CLAUDE.md` / `.cursorrules` / `copilot-instructions.md` files
`dim generate-context` writes from trusted memory.

**MCP (Model Context Protocol)** — the standard aiDimag's server uses to expose tools,
prompts, and resources to AI agents.

**Tool / Prompt / Resource** — the three things an MCP server exposes. Tools are callable
(e.g. `memory_search`); prompts are reusable instructions (e.g. `session_start`); resources
are readable data (e.g. `aidimag://digest`).

**Session briefing** — the pre-work summary (`dim brief` / `session_start`) of in-scope
memory, guardrails, stale warnings, and questions to ask.

**`memory_critique`** — an MCP tool that reviews an agent's work against verified memory and
guardrails — a "second critic" grounded in real, checkable rules.

**Brain** — a named, shared memory store on a sync server that a team links their repos to.

**Sync server** — the self-hosted service (`dim serve`) that exchanges memory between team
members.

**Consensus** — the server's aggregation of verification results across machines ("N machines
confirm this passes at commit X").

**Spec / Verifier / Environment** — the three-layer framework aiDimag is organized around:
deliver understanding (Spec), let work be checked (Verifier), and keep a persistent improving
workspace (Environment).

