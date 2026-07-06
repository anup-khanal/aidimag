#!/usr/bin/env node
/**
 * aidimag MCP server — exposes repo memory to any MCP-compatible agent
 * (Claude Code, Cursor, Copilot, ...) over stdio.
 *
 * Tools: memory_search, memory_get_for_files, memory_write, memory_refute, memory_status,
 *        context_note (passive in-chat fact capture), … — searches are logged so zero-hit
 *        queries surface as coverage gaps (`dim gaps`).
 * Resource: aidimag://digest — repo memory digest for session bootstrapping.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryStore, findRepoRoot } from "../db/store.js";
import { sessionEndPromptFor, proposalSummaryLine } from "../capture/session-extraction.js";
import { buildSessionBriefing, renderBriefing, sessionStartPrompt } from "../capture/session-briefing.js";
import { critique } from "../critique/critique.js";
import { ticketProviderFor, detectBranchTicket } from "../tickets/provider.js";
import { verifyAll } from "../verify/engine.js";
import { hybridSearch, indexMemory } from "../embeddings/search.js";
import { resolveKnowledgeConfig } from "../config.js";
import { classifyInbox, finalizeDoc } from "../knowledge/ingest.js";
import { KNOWLEDGE_EXTRACT_INSTRUCTIONS, buildExtractionUser, parseClaims } from "../knowledge/extract.js";
import type { GuardrailLevel, MemoryEntry } from "../types.js";

const PKG_VERSION: string = JSON.parse(
  readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8")
).version;

const KINDS = [
  "DECISION",
  "CONVENTION",
  "GOTCHA",
  "FAILED_APPROACH",
  "ARCHITECTURE",
  "INVARIANT",
  "TODO_CONTEXT",
  "GUARDRAIL",
  "SKILL",
] as const;

const GUARDRAIL_LEVELS = ["always", "ask-first", "never"] as const;

const GUARDRAIL_ICON: Record<GuardrailLevel, string> = { never: "🚫", always: "✅", "ask-first": "🤚" };

const STATUSES = ["VERIFIED", "UNVERIFIED", "STALE", "REFUTED"] as const;

const EVIDENCE_TYPES = [
  "COMMIT_REF",
  "TEST_RESULT",
  "EXEC_TRACE",
  "STATIC_CHECK",
  "HUMAN_ATTESTED",
  "TICKET_REF",
] as const;

function renderMemory(m: MemoryEntry): string {
  const scope =
    m.scope.paths.length || m.scope.symbols.length
      ? ` [scope: ${[...m.scope.paths, ...m.scope.symbols].join(", ")}]`
      : " [scope: repo-wide]";
  const evidence = m.grounding.length
    ? `\n  evidence: ${m.grounding.map((e) => `${e.type}(${e.result})`).join(", ")}`
    : "";
  const guard =
    m.kind === "GUARDRAIL" && m.guardrailLevel
      ? ` ${GUARDRAIL_ICON[m.guardrailLevel]} ${m.guardrailLevel.toUpperCase()}`
      : "";
  return `- (${m.status}${m.pinned ? ", PINNED" : ""}, ${m.kind}${guard}, conf=${m.confidence.toFixed(2)}, id=${m.id})${scope}\n  ${m.claim}${evidence}`;
}

function renderList(memories: MemoryEntry[]): string {
  if (memories.length === 0) return "No matching memories.";
  return memories.map(renderMemory).join("\n");
}

function openStore(): MemoryStore {
  // Repo root resolution: AIDIMAG_REPO env var wins, else walk up from cwd.
  const start = process.env.AIDIMAG_REPO ?? process.cwd();
  return MemoryStore.open(start, { create: true });
}

async function main() {
  const server = new McpServer({ name: "aidimag", version: PKG_VERSION });
  const store = openStore();

  server.tool(
    "memory_search",
    "Search the repo's verified memory for decisions, conventions, gotchas, failed approaches, and invariants. Use BEFORE exploring the codebase — past sessions may already know the answer.",
    {
      query: z.string().describe("Keywords to search for (e.g. 'auth token refresh')"),
      kind: z.enum(KINDS).optional().describe("Filter by memory kind"),
      status: z.enum(STATUSES).optional().describe("Filter by verification status"),
      paths: z.array(z.string()).optional().describe("Restrict to memories scoped to these paths"),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async (args) => {
      const { results } = await hybridSearch(store, {
        query: args.query,
        kind: args.kind,
        status: args.status,
        paths: args.paths,
        limit: args.limit,
      });
      try {
        store.logSearch(args.query, args.paths ?? [], results.length, "mcp");
      } catch {
        /* logging is best-effort; never break search */
      }
      let text = renderList(results);
      if (results.length === 0) {
        text +=
          "\n(Coverage gap logged. If you learn the answer this session — from the code or the user — persist it with context_note or memory_propose so future sessions don't hit this gap.)";
      }
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "memory_get_for_files",
    "Get all memories relevant to specific files before editing them — conventions, gotchas, and invariants that apply to those paths.",
    {
      paths: z.array(z.string()).min(1).describe("Repo-relative file paths you are about to read or edit"),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async (args) => {
      const results = store.getForFiles(args.paths, args.limit ?? 20);
      return { content: [{ type: "text", text: renderList(results) }] };
    }
  );

  server.tool(
    "memory_write",
    "Persist a new memory about this codebase. Write the claim as a FALSIFIABLE statement (something that could be checked against the code). Attach evidence whenever possible. For kind=GUARDRAIL, set guardrail_level (never|always|ask-first).",
    {
      kind: z.enum(KINDS),
      claim: z.string().min(10).describe("Falsifiable statement, e.g. 'All DB access goes through src/db/store.ts; nothing else imports better-sqlite3'"),
      paths: z.array(z.string()).optional().describe("Paths this memory applies to (omit for repo-wide)"),
      symbols: z.array(z.string()).optional().describe("Symbols (functions/classes) this applies to"),
      guardrail_level: z
        .enum(GUARDRAIL_LEVELS)
        .optional()
        .describe("Required for kind=GUARDRAIL: 'never' (refuse), 'always' (do without asking), 'ask-first' (confirm with user)"),
      evidence: z
        .array(z.object({ type: z.enum(EVIDENCE_TYPES), payload: z.string() }))
        .optional()
        .describe("Grounding evidence, e.g. {type:'COMMIT_REF', payload:'abc123'} or {type:'STATIC_CHECK', payload:'grep -rL better-sqlite3 src --include=*.ts'}"),
      created_by: z.string().optional().describe("Agent identifier, e.g. 'claude-code'"),
    },
    async (args) => {
      const entry = store.write({
        kind: args.kind,
        claim: args.claim,
        paths: args.paths,
        symbols: args.symbols,
        evidence: args.evidence,
        createdBy: args.created_by ?? "agent",
        guardrailLevel: args.guardrail_level,
      });
      await indexMemory(store, entry).catch(() => false);
      return {
        content: [{ type: "text", text: `Memory saved (id=${entry.id}, status=${entry.status}).\n${renderMemory(entry)}` }],
      };
    }
  );

  server.tool(
    "memory_refute",
    "Mark a memory as REFUTED when you discover it no longer holds. Optionally provide the id of a new memory that supersedes it. Refuted memories are kept as negative knowledge.",
    {
      id: z.string().describe("Memory id to refute"),
      superseded_by: z.string().optional().describe("Id of a newer memory replacing it"),
    },
    async (args) => {
      store.refute(args.id, args.superseded_by);
      return { content: [{ type: "text", text: `Memory ${args.id} marked REFUTED.` }] };
    }
  );

  server.tool(
    "memory_status",
    "Get a summary of the repo's memory store: counts by verification status and kind.",
    {},
    async () => {
      const s = store.statusSummary();
      const lines = [
        `aidimag memory @ ${s.dbPath}`,
        `total: ${s.total}`,
        `by status: ${Object.entries(s.byStatus).map(([k, v]) => `${k}=${v}`).join(", ")}`,
        `by kind: ${Object.entries(s.byKind).map(([k, v]) => `${k}=${v}`).join(", ") || "(none)"}`,
        `pending proposals: ${s.pendingProposals ?? 0}`,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "memory_verify",
    "Re-run cheap evidence checks (STATIC_CHECK, COMMIT_REF) and update memory statuses. Use before relying on VERIFIED memories if the repo may have changed, or to verify specific memories by id.",
    {
      ids: z.array(z.string()).optional().describe("Specific memory ids to verify (prefix ok); omit for all"),
      deep: z.boolean().optional().describe("Also run expensive evidence (TEST_RESULT, EXEC_TRACE). Slower; use when cheap checks aren't enough."),
    },
    async (args) => {
      const root = process.env.AIDIMAG_REPO ?? findRepoRoot() ?? process.cwd();
      const report = verifyAll(store, root, { ids: args.ids, deep: args.deep });
      const changes = report.results.filter((r) => r.after !== r.before || r.decayed);
      const lines = [
        `checked ${report.checked}: ${report.verified} verified, ${report.stale} stale, ${report.decayed} decayed, ${report.unchanged} unchanged`,
        ...changes.map(
          (r) =>
            `${r.before} → ${r.after}${r.decayed ? " (decayed)" : ""} (conf ${r.confidenceBefore.toFixed(2)}→${r.confidenceAfter.toFixed(2)}): ${r.claim}`
        ),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "memory_propose",
    "Propose a memory for the human review queue. Use at SESSION END for learnings that should persist but warrant review before becoming active memory. Prefer this over memory_write for inferred/uncertain knowledge.",
    {
      kind: z.enum(KINDS),
      claim: z.string().min(10).describe("Falsifiable statement about the codebase"),
      paths: z.array(z.string()).optional(),
      symbols: z.array(z.string()).optional(),
      guardrail_level: z
        .enum(GUARDRAIL_LEVELS)
        .optional()
        .describe("For kind=GUARDRAIL: never | always | ask-first"),
      evidence: z
        .array(z.object({ type: z.enum(EVIDENCE_TYPES), payload: z.string() }))
        .optional(),
      rationale: z.string().optional().describe("Why this is worth remembering (helps the reviewer)"),
      ticket_ref: z
        .string()
        .optional()
        .describe("Ticket id this work belongs to (e.g. XXX-2100). Omit to auto-detect from the current branch."),
      agent_id: z.string().optional().describe("Your agent identifier, e.g. 'claude-code'"),
    },
    async (args) => {
      const root = process.env.AIDIMAG_REPO ?? findRepoRoot() ?? process.cwd();
      // the best prompt is the one the branch name already answered
      const ticketRef = args.ticket_ref ?? detectBranchTicket(root) ?? undefined;
      const evidence = [...(args.evidence ?? [])];
      if (ticketRef && !evidence.some((e) => e.type === "TICKET_REF")) {
        evidence.push({ type: "TICKET_REF", payload: ticketRef });
      }
      const p = store.propose({
        kind: args.kind,
        claim: args.claim,
        paths: args.paths,
        symbols: args.symbols,
        evidence: evidence.length ? evidence : undefined,
        rationale: args.rationale,
        ticketRef,
        guardrailLevel: args.guardrail_level,
        source: `session:${args.agent_id ?? "agent"}`,
      });
      if (!p) {
        return { content: [{ type: "text", text: "Duplicate — an identical proposal already exists." }] };
      }
      return {
        content: [
          {
            type: "text",
            text:
              `Proposal queued for human review (id=${p.id}${ticketRef ? `, ticket=${ticketRef}` : ""}). ` +
              `It becomes active memory only after \`dim review\` approval.`,
          },
        ],
      };
    }
  );

  server.tool(
    "context_note",
    "Capture a durable fact the USER just stated in chat, IMMEDIATELY when they say it — don't wait for session end. Trigger on statements like 'we use X because Y', 'never touch Z', 'the deploy flow is …', 'we tried A and it failed'. Only durable, codebase-relevant facts (skip task-specific chatter). The note is queued for human review; user-stated facts carry high trust.",
    {
      statement: z
        .string()
        .min(10)
        .describe("The fact, rephrased as a falsifiable claim about the codebase (e.g. 'Payments retries are handled in src/queue; handlers must be idempotent')"),
      kind: z.enum(KINDS).describe("Best-fit memory kind (e.g. user says 'never do X' → GUARDRAIL, 'we tried X, failed' → FAILED_APPROACH, 'we always X' → CONVENTION)"),
      quote: z.string().optional().describe("The user's own words, verbatim (preserves nuance for the reviewer)"),
      paths: z.array(z.string()).optional().describe("Repo-relative paths the fact applies to (omit for repo-wide)"),
      symbols: z.array(z.string()).optional().describe("Symbols (functions/classes) it applies to"),
      guardrail_level: z
        .enum(GUARDRAIL_LEVELS)
        .optional()
        .describe("For kind=GUARDRAIL: never | always | ask-first"),
      agent_id: z.string().optional().describe("Your agent identifier, e.g. 'claude-code'"),
    },
    async (args) => {
      const root = process.env.AIDIMAG_REPO ?? findRepoRoot() ?? process.cwd();
      const ticketRef = detectBranchTicket(root) ?? undefined;
      // User-stated facts are attestations: HUMAN_ATTESTED evidence verifies once
      // on approval (then decays fastest), giving them a higher-trust start than
      // agent-inferred proposals without pretending they're machine-checkable.
      const evidence: Array<{ type: (typeof EVIDENCE_TYPES)[number]; payload: string }> = [
        { type: "HUMAN_ATTESTED", payload: args.quote?.trim() || `stated by user in chat, ${new Date().toISOString().slice(0, 10)}` },
      ];
      if (ticketRef) evidence.push({ type: "TICKET_REF", payload: ticketRef });
      const p = store.propose({
        kind: args.kind,
        claim: args.statement,
        paths: args.paths,
        symbols: args.symbols,
        evidence,
        rationale: args.quote
          ? `User said (verbatim): "${args.quote.trim()}"`
          : "Stated directly by the user in an AI chat session.",
        ticketRef,
        guardrailLevel: args.guardrail_level,
        source: `context:${args.agent_id ?? "agent"}`,
      });
      if (!p) {
        return { content: [{ type: "text", text: "Already captured — an identical note is in the review queue." }] };
      }
      return {
        content: [
          {
            type: "text",
            text: `Noted (proposal id=${p.id}). Queued for \`dim review\`; continue the conversation — no need to mention this unless asked.`,
          },
        ],
      };
    }
  );

  server.tool(
    "memory_critique",
    "Review what you just did (or plan to do) against the project's VERIFIED memory and guardrails — a 'second critic' grounded in real, falsifiable beliefs rather than another model's opinion. Call BEFORE committing or proposing memories. Resolve guardrail violations and contradictions first.",
    {
      summary: z.string().min(10).describe("What you did or plan to do, in a sentence or two"),
      files_changed: z.array(z.string()).optional().describe("Repo-relative paths you touched (improves scoping)"),
    },
    async (args) => {
      const result = await critique(store, { summary: args.summary, filesChanged: args.files_changed ?? [] });
      const lines: string[] = [];
      if (result.guardrailsViolated.length) {
        lines.push("⚠️ GUARDRAILS — resolve before proceeding:");
        for (const g of result.guardrailsViolated) {
          lines.push(`  ${GUARDRAIL_ICON[g.level]} ${g.level.toUpperCase()} — ${g.memory.claim}\n     ${g.concern}`);
        }
      }
      if (result.contradictions.length) {
        lines.push("", "Possible contradictions (in-scope rules you didn't confirm):");
        for (const c of result.contradictions) lines.push(`  • ${c.memory.claim}\n     ${c.concern}`);
      }
      if (result.confirmations.length) {
        lines.push("", "Consistent with existing memory:");
        for (const c of result.confirmations.slice(0, 8)) lines.push(`  ✓ (${c.memory.kind}) ${c.memory.claim}`);
      }
      if (result.missingCoverage.length) {
        lines.push("", `No memory covers: ${result.missingCoverage.slice(0, 10).join(", ")} — consider asking the user or writing a memory.`);
      }
      const text = lines.length
        ? lines.join("\n")
        : "No conflicts, guardrail issues, or relevant memory found for this change.";
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "ticket_get",
    "Fetch the ticket behind the current work (title, description, type, status) from the connected ticketing app. Use at session end: the ticket carries the WHY that commits lack. Omit the id to auto-detect it from the current branch name.",
    {
      id: z.string().optional().describe("Ticket id, e.g. XXX-2100 or #123; omit to use the current branch's ticket"),
    },
    async (args) => {
      const root = process.env.AIDIMAG_REPO ?? findRepoRoot() ?? process.cwd();
      const id = args.id ?? detectBranchTicket(root);
      if (!id) {
        return { content: [{ type: "text", text: "No ticket id given and none detectable from the current branch name." }] };
      }
      const provider = ticketProviderFor(root);
      if (!provider) {
        return {
          content: [
            { type: "text", text: `Ticket ${id} (no ticketing app connected — the human can run \`dim ticket connect\`). Use the id as ticket_ref anyway.` },
          ],
        };
      }
      try {
        const t = await provider.getTicket(id);
        if (!t) return { content: [{ type: "text", text: `Ticket ${id} not found.` }] };
        const lines = [
          `${t.id}: ${t.title}`,
          `type=${t.type} status=${t.status}${t.labels.length ? ` labels=${t.labels.join(",")}` : ""}`,
          ...(t.parent ? [`parent: ${t.parent.id} "${t.parent.title}"`] : []),
          t.url,
          ...(t.body ? ["", t.body] : []),
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Ticket ${id}: provider unreachable (${err instanceof Error ? err.message : err}). Proceed without it; still pass ticket_ref=${id} on proposals.` },
          ],
        };
      }
    }
  );

  server.tool(
    "proposals_pending",
    "List memory proposals awaiting human review.",
    {
      limit: z.number().int().min(1).max(100).optional(),
    },
    async (args) => {
      const pending = store.listProposals("PENDING", args.limit ?? 50);
      const text =
        pending.length === 0
          ? "No pending proposals."
          : pending.map(proposalSummaryLine).join("\n");
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "knowledge_pending",
    "List documents waiting in the knowledge inbox to be summarized into pinned-on-approve memory proposals. Use with the knowledge_ingest prompt to process them in-session.",
    {},
    async () => {
      const root = process.env.AIDIMAG_REPO ?? findRepoRoot() ?? process.cwd();
      const cfg = resolveKnowledgeConfig(root);
      const { pending, toSkip } = await classifyInbox(root, cfg);
      const lines: string[] = [];
      lines.push(pending.length ? `${pending.length} doc(s) pending in ${cfg.folder}/:` : `No docs pending in ${cfg.folder}/.`);
      for (const d of pending) lines.push(`  • ${d.file} (${d.bytes} bytes, sha256 ${d.hash.slice(0, 12)})`);
      if (toSkip.length) {
        lines.push(`${toSkip.length} unsupported file(s) (will move to skipped/ on next sync):`);
        for (const s of toSkip) lines.push(`  • ${s.file} — ${s.reason}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "knowledge_ingest_submit",
    "Submit the FALSIFIABLE claims you extracted from a pending knowledge doc (see the knowledge_ingest prompt). Queues them as proposals (source knowledge:<doc>), writes the durable summary, backs up the original, and clears the inbox copy. Claims become PINNED memory only after `dim review` (unless the repo opted out).",
    {
      file: z.string().describe("The pending doc's filename, exactly as shown by knowledge_pending"),
      claims: z
        .string()
        .describe(
          'JSON: {"claims":[{"kind":"CONVENTION","claim":"...","paths":["src/x"],"symbols":[],"guardrail_level":null,"rationale":"..."}]} — 0–12 durable, scoped, falsifiable claims'
        ),
    },
    async (args) => {
      const root = process.env.AIDIMAG_REPO ?? findRepoRoot() ?? process.cwd();
      const cfg = resolveKnowledgeConfig(root);
      const { pending } = await classifyInbox(root, cfg);
      const doc = pending.find((d) => d.file === args.file);
      if (!doc) {
        return {
          isError: true,
          content: [{ type: "text", text: `No pending doc named '${args.file}' in ${cfg.folder}/ (already processed, or check knowledge_pending).` }],
        };
      }
      const claims = parseClaims(args.claims);
      const result = finalizeDoc(store, root, cfg, { file: doc.file, hash: doc.hash, abs: doc.abs }, claims, "agent:mcp");
      const tail = result.pinned
        ? `auto-approved as ${result.memoryIds.length} ACTIVE (unpinned) memory(ies) — requireReview is off; no human reviewed them.`
        : `queued as ${result.proposalIds.length} proposal(s) — approve with \`dim review\`.`;
      return { content: [{ type: "text", text: `Ingested ${doc.file}: ${result.claimCount} claim(s) ${tail}` }] };
    }
  );

  server.prompt(
    "knowledge_ingest",
    "Process the knowledge inbox in-session: read each pending doc, extract durable falsifiable claims, and submit them with knowledge_ingest_submit (queued for `dim review`).",
    async () => {
      const root = process.env.AIDIMAG_REPO ?? findRepoRoot() ?? process.cwd();
      const cfg = resolveKnowledgeConfig(root);
      const { pending, toSkip } = await classifyInbox(root, cfg);
      let text: string;
      if (pending.length === 0) {
        text =
          `The knowledge inbox (${cfg.folder}/) has no documents to summarize.` +
          (toSkip.length ? ` ${toSkip.length} unsupported file(s) will be moved to skipped/ on the next \`dim knowledge sync\`.` : "");
      } else {
        const docs = pending
          .map((d) => `### ${d.file}\n${buildExtractionUser(d.file, d.content)}`)
          .join("\n\n");
        text =
          `${KNOWLEDGE_EXTRACT_INSTRUCTIONS}\n\n` +
          `Process EACH document below independently. For each one, extract its claims and call the \`knowledge_ingest_submit\` tool with that doc's exact \`file\` name and a JSON \`claims\` payload of the shape shown above. Do not skip any document; submit an empty claims array if a doc has no durable facts.\n\n` +
          `Pending documents (${pending.length}):\n\n${docs}`;
      }
      return {
        messages: [
          { role: "user" as const, content: { type: "text" as const, text } },
        ],
      };
    }
  );

  server.prompt(
    "session_end_extraction",
    "Run at the end of a coding session to extract durable codebase knowledge into the memory proposal queue.",
    () => {
      const root = process.env.AIDIMAG_REPO ?? findRepoRoot() ?? process.cwd();
      return {
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: sessionEndPromptFor(detectBranchTicket(root)) },
          },
        ],
      };
    }
  );

  server.prompt(
    "session_start",
    "Run at the START of a coding session: surfaces in-scope memory, guardrails, stale warnings, and clarifying questions to ask the user before writing any code.",
    async () => {
      const root = process.env.AIDIMAG_REPO ?? findRepoRoot() ?? process.cwd();
      const briefing = buildSessionBriefing(store, root);
      let text = sessionStartPrompt(briefing);
      // Catch-up trigger: nudge the agent to drain any docs sitting in the knowledge inbox.
      const { pending } = await classifyInbox(root, resolveKnowledgeConfig(root));
      if (pending.length) {
        text +=
          `\n\n---\n📚 ${pending.length} document(s) are waiting in the knowledge inbox ` +
          `(${pending.map((d) => d.file).join(", ")}). Run the \`knowledge_ingest\` prompt to summarize them into reviewable, pinned-on-approve memories.`;
      }
      return {
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text },
          },
        ],
      };
    }
  );

  server.resource("session-briefing", "aidimag://session-briefing", async () => {
    const root = process.env.AIDIMAG_REPO ?? findRepoRoot() ?? process.cwd();
    const briefing = buildSessionBriefing(store, root);
    return {
      contents: [
        { uri: "aidimag://session-briefing", mimeType: "text/markdown", text: renderBriefing(briefing) },
      ],
    };
  });

  server.resource("digest", "aidimag://digest", async () => {
    const memories = store.list(50).filter((m) => m.status !== "REFUTED");
    const text =
      memories.length === 0
        ? "No memories recorded for this repo yet."
        : `# Repo memory digest (${memories.length} entries)\n\n${renderList(memories)}`;
    return { contents: [{ uri: "aidimag://digest", mimeType: "text/markdown", text }] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`aidimag MCP server running (db: ${store.dbPath})`);
}

main().catch((err) => {
  console.error("aidimag MCP server failed:", err);
  process.exit(1);
});
