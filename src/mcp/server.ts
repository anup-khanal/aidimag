#!/usr/bin/env node
/**
 * aidimag MCP server — exposes repo memory to any MCP-compatible agent
 * (Claude Code, Cursor, Copilot, ...) over stdio.
 *
 * Tools: memory_search, memory_get_for_files, memory_write, memory_refute, memory_status
 * Resource: aidimag://digest — repo memory digest for session bootstrapping.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MemoryStore, findRepoRoot } from "../db/store.js";
import { SESSION_END_PROMPT, proposalSummaryLine } from "../capture/session-extraction.js";
import { verifyAll } from "../verify/engine.js";
import type { MemoryEntry } from "../types.js";

const KINDS = [
  "DECISION",
  "CONVENTION",
  "GOTCHA",
  "FAILED_APPROACH",
  "ARCHITECTURE",
  "INVARIANT",
  "TODO_CONTEXT",
] as const;

const STATUSES = ["VERIFIED", "UNVERIFIED", "STALE", "REFUTED"] as const;

const EVIDENCE_TYPES = [
  "COMMIT_REF",
  "TEST_RESULT",
  "EXEC_TRACE",
  "STATIC_CHECK",
  "HUMAN_ATTESTED",
] as const;

function renderMemory(m: MemoryEntry): string {
  const scope =
    m.scope.paths.length || m.scope.symbols.length
      ? ` [scope: ${[...m.scope.paths, ...m.scope.symbols].join(", ")}]`
      : " [scope: repo-wide]";
  const evidence = m.grounding.length
    ? `\n  evidence: ${m.grounding.map((e) => `${e.type}(${e.result})`).join(", ")}`
    : "";
  return `- (${m.status}, ${m.kind}, conf=${m.confidence.toFixed(2)}, id=${m.id})${scope}\n  ${m.claim}${evidence}`;
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
  const server = new McpServer({ name: "aidimag", version: "0.1.0" });
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
      const results = store.search({
        query: args.query,
        kind: args.kind,
        status: args.status,
        paths: args.paths,
        limit: args.limit,
      });
      return { content: [{ type: "text", text: renderList(results) }] };
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
    "Persist a new memory about this codebase. Write the claim as a FALSIFIABLE statement (something that could be checked against the code). Attach evidence whenever possible.",
    {
      kind: z.enum(KINDS),
      claim: z.string().min(10).describe("Falsifiable statement, e.g. 'All DB access goes through src/db/store.ts; nothing else imports better-sqlite3'"),
      paths: z.array(z.string()).optional().describe("Paths this memory applies to (omit for repo-wide)"),
      symbols: z.array(z.string()).optional().describe("Symbols (functions/classes) this applies to"),
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
      });
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
      evidence: z
        .array(z.object({ type: z.enum(EVIDENCE_TYPES), payload: z.string() }))
        .optional(),
      rationale: z.string().optional().describe("Why this is worth remembering (helps the reviewer)"),
      agent_id: z.string().optional().describe("Your agent identifier, e.g. 'claude-code'"),
    },
    async (args) => {
      const p = store.propose({
        kind: args.kind,
        claim: args.claim,
        paths: args.paths,
        symbols: args.symbols,
        evidence: args.evidence,
        rationale: args.rationale,
        source: `session:${args.agent_id ?? "agent"}`,
      });
      if (!p) {
        return { content: [{ type: "text", text: "Duplicate — an identical proposal already exists." }] };
      }
      return {
        content: [
          {
            type: "text",
            text: `Proposal queued for human review (id=${p.id}). It becomes active memory only after \`dim review\` approval.`,
          },
        ],
      };
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

  server.prompt(
    "session_end_extraction",
    "Run at the end of a coding session to extract durable codebase knowledge into the memory proposal queue.",
    () => ({
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: SESSION_END_PROMPT },
        },
      ],
    })
  );

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

