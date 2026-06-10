#!/usr/bin/env node
/**
 * dim — the aidimag CLI (dimag = brain).
 *
 *   dim init                 initialize .aidimag/ in the current repo
 *   dim remember "<claim>"   store a memory
 *   dim recall <query|path>  search memories
 *   dim status               memory store summary
 *   dim verify               re-run evidence (Phase 3 — stub)
 *   dim log                  recent memories
 *   dim forget <id>          delete a memory
 */

import { Command } from "commander";
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { MemoryStore, findRepoRoot, dbPathFor, AIDIMAG_DIR } from "../db/store.js";
import { mineCommits } from "../capture/commit-miner.js";
import type { EvidenceType, MemoryEntry, MemoryKind, Proposal } from "../types.js";

const program = new Command();

const KINDS: MemoryKind[] = [
  "DECISION", "CONVENTION", "GOTCHA", "FAILED_APPROACH",
  "ARCHITECTURE", "INVARIANT", "TODO_CONTEXT",
];

function fail(msg: string): never {
  console.error(`dim: ${msg}`);
  process.exit(1);
}

function printMemory(m: MemoryEntry, verbose = false): void {
  const statusIcon =
    m.status === "VERIFIED" ? "✓" : m.status === "REFUTED" ? "✗" : m.status === "STALE" ? "~" : "?";
  console.log(`${statusIcon} [${m.kind}] ${m.claim}`);
  const scope = [...m.scope.paths, ...m.scope.symbols];
  console.log(
    `    id=${m.id.slice(0, 8)} status=${m.status} conf=${m.confidence.toFixed(2)}` +
      (scope.length ? ` scope=${scope.join(",")}` : "")
  );
  if (verbose && m.grounding.length) {
    for (const e of m.grounding) {
      console.log(`    evidence: ${e.type}(${e.result}) ${e.payload}`);
    }
  }
}

program
  .name("dim")
  .description("aidimag — persistent, verified memory for AI coding agents")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize aidimag in the current repo")
  .action(() => {
    const root = findRepoRoot() ?? process.cwd();
    const dir = path.join(root, AIDIMAG_DIR);
    const fresh = !existsSync(dbPathFor(root));
    mkdirSync(dir, { recursive: true });
    const store = new MemoryStore(dbPathFor(root));
    store.close();
    // keep the DB out of git by default (team-sync mode comes later)
    const gitignore = path.join(dir, ".gitignore");
    if (!existsSync(gitignore)) {
      writeFileSync(gitignore, "memory.db\nmemory.db-wal\nmemory.db-shm\n");
    }
    // suggest MCP wiring
    console.log(fresh ? `Initialized aidimag in ${dir}` : `aidimag already initialized in ${dir}`);
    console.log(`\nAdd the MCP server to your agent config, e.g. for Claude Code (.mcp.json):`);
    console.log(
      JSON.stringify(
        { mcpServers: { aidimag: { command: "npx", args: ["-y", "aidimag", "mcp"], env: { AIDIMAG_REPO: root } } } },
        null,
        2
      )
    );
    // append .aidimag DB files to repo .gitignore if a git repo
    const rootIgnore = path.join(root, ".gitignore");
    if (existsSync(path.join(root, ".git"))) {
      const current = existsSync(rootIgnore) ? readFileSync(rootIgnore, "utf8") : "";
      if (!current.includes(".aidimag/memory.db")) {
        appendFileSync(rootIgnore, `${current.endsWith("\n") || current === "" ? "" : "\n"}.aidimag/memory.db*\n`);
        console.log(`\nAdded .aidimag/memory.db* to ${rootIgnore}`);
      }
    }
  });

program
  .command("remember")
  .description("Store a memory (write the claim as a falsifiable statement)")
  .argument("<claim>", "The claim to remember")
  .option("-k, --kind <kind>", `Memory kind: ${KINDS.join("|")}`, "GOTCHA")
  .option("-p, --path <paths...>", "Paths this memory applies to")
  .option("-s, --symbol <symbols...>", "Symbols this memory applies to")
  .option(
    "-e, --evidence <spec...>",
    "Evidence as TYPE:payload, e.g. COMMIT_REF:abc123 or STATIC_CHECK:'grep ...'"
  )
  .action((claim: string, opts) => {
    const kind = String(opts.kind).toUpperCase() as MemoryKind;
    if (!KINDS.includes(kind)) fail(`invalid kind '${opts.kind}'. Use one of: ${KINDS.join(", ")}`);
    const evidence = (opts.evidence as string[] | undefined)?.map((spec) => {
      const idx = spec.indexOf(":");
      if (idx < 1) fail(`invalid evidence '${spec}'. Format: TYPE:payload`);
      const type = spec.slice(0, idx).toUpperCase() as EvidenceType;
      return { type, payload: spec.slice(idx + 1) };
    });
    const store = MemoryStore.open(process.cwd(), { create: true });
    const entry = store.write({ kind, claim, paths: opts.path, symbols: opts.symbol, evidence, createdBy: "human" });
    printMemory(entry, true);
    store.close();
  });

program
  .command("recall")
  .description("Search memories by keywords; use --path to scope to files")
  .argument("[query...]", "Keywords to search")
  .option("-p, --path <paths...>", "Restrict to memories scoped to these paths")
  .option("-k, --kind <kind>", "Filter by kind")
  .option("-n, --limit <n>", "Max results", "10")
  .option("--all", "Include refuted memories")
  .action((query: string[], opts) => {
    const store = MemoryStore.open();
    const results = store.search({
      query: query.join(" "),
      paths: opts.path,
      kind: opts.kind ? (String(opts.kind).toUpperCase() as MemoryKind) : undefined,
      limit: parseInt(opts.limit, 10),
      includeRefuted: Boolean(opts.all),
    });
    if (results.length === 0) console.log("No matching memories.");
    for (const m of results) printMemory(m, true);
    store.close();
  });

program
  .command("status")
  .description("Memory store summary")
  .action(() => {
    const store = MemoryStore.open();
    const s = store.statusSummary();
    console.log(`aidimag @ ${s.dbPath}`);
    console.log(`total memories: ${s.total}`);
    console.log(`  by status: ${Object.entries(s.byStatus).map(([k, v]) => `${k}=${v}`).join("  ")}`);
    if (Object.keys(s.byKind).length) {
      console.log(`  by kind:   ${Object.entries(s.byKind).map(([k, v]) => `${k}=${v}`).join("  ")}`);
    }
    if (s.pendingProposals) {
      console.log(`\n${s.pendingProposals} proposal(s) awaiting review — run \`dim review\``);
    }
    store.close();
  });

function printProposal(p: Proposal): void {
  console.log(`◆ [${p.id.slice(0, 8)}] ${p.kind} (via ${p.source}${p.sourceRef ? ` @ ${p.sourceRef.slice(0, 8)}` : ""})`);
  console.log(`    ${p.claim}`);
  if (p.paths.length || p.symbols.length) {
    console.log(`    scope: ${[...p.paths, ...p.symbols].join(", ")}`);
  }
  if (p.evidence.length) {
    console.log(`    evidence: ${p.evidence.map((e) => `${e.type}:${e.payload}`).join("  ")}`);
  }
  if (p.rationale) console.log(`    rationale: ${p.rationale}`);
}

program
  .command("mine")
  .description("Mine git history for memory candidates (queued for review, never auto-saved)")
  .option("-n, --max <n>", "Max commits to scan", "500")
  .option("--full", "Rescan from the beginning of history (ignore cursor)")
  .action((opts) => {
    const root = findRepoRoot() ?? fail("not inside a git repo");
    if (!existsSync(path.join(root, ".git"))) fail("commit mining requires a git repo");
    const store = MemoryStore.open(root, { create: true });
    const res = mineCommits(store, root, {
      maxCommits: parseInt(opts.max, 10),
      full: Boolean(opts.full),
    });
    console.log(
      `Scanned ${res.scanned} commit(s): ${res.proposed.length} proposal(s) queued` +
        (res.skippedDuplicates ? `, ${res.skippedDuplicates} duplicate(s) skipped` : "") +
        (res.lastSha ? ` (cursor @ ${res.lastSha.slice(0, 8)})` : "")
    );
    for (const p of res.proposed) printProposal(p);
    if (res.proposed.length) console.log(`\nReview with \`dim review\`.`);
    store.close();
  });

program
  .command("review")
  .description("Review pending memory proposals (approve/reject)")
  .argument("[action]", "list | approve | reject", "list")
  .argument("[id]", "Proposal id (8-char prefix ok); 'all' with approve/reject applies to every pending proposal")
  .option("-n, --limit <n>", "Max proposals to list", "50")
  .action((action: string, id: string | undefined, opts) => {
    const store = MemoryStore.open();
    switch (action) {
      case "list": {
        const pending = store.listProposals("PENDING", parseInt(opts.limit, 10));
        if (pending.length === 0) console.log("No pending proposals.");
        for (const p of pending) printProposal(p);
        if (pending.length) {
          console.log(`\nApprove: dim review approve <id> | Reject: dim review reject <id>`);
        }
        break;
      }
      case "approve": {
        if (!id) fail("usage: dim review approve <id|all>");
        const targets =
          id === "all" ? store.listProposals("PENDING", 1000).map((p) => p.id) : [id];
        for (const t of targets) {
          const entry = store.approveProposal(t);
          console.log(`✓ approved → memory ${entry.id.slice(0, 8)}: ${entry.claim}`);
        }
        break;
      }
      case "reject": {
        if (!id) fail("usage: dim review reject <id|all>");
        const targets =
          id === "all" ? store.listProposals("PENDING", 1000).map((p) => p.id) : [id];
        for (const t of targets) {
          const p = store.rejectProposal(t);
          console.log(`✗ rejected ${p.id.slice(0, 8)}: ${p.claim}`);
        }
        break;
      }
      default:
        fail(`unknown action '${action}'. Use: list | approve | reject`);
    }
    store.close();
  });

program
  .command("verify")
  .description("Re-run evidence and update memory statuses (Phase 3)")
  .action(() => {
    console.log("dim verify: evidence runners land in Phase 3 (STATIC_CHECK + COMMIT_REF first).");
  });

program
  .command("log")
  .description("Show recent memories")
  .option("-n, --limit <n>", "Max entries", "20")
  .action((opts) => {
    const store = MemoryStore.open();
    const memories = store.list(parseInt(opts.limit, 10));
    if (memories.length === 0) console.log("No memories yet. Try `dim remember \"...\"`.");
    for (const m of memories) printMemory(m);
    store.close();
  });

program
  .command("forget")
  .description("Delete a memory permanently (prefer refuting via agents)")
  .argument("<id>", "Memory id (full or 8-char prefix)")
  .action((id: string) => {
    const store = MemoryStore.open();
    // allow prefix match
    const match = store.list(1000).find((m) => m.id === id || m.id.startsWith(id));
    if (!match) fail(`no memory matching id '${id}'`);
    store.forget(match.id);
    console.log(`Forgot memory ${match.id}: "${match.claim}"`);
    store.close();
  });

program
  .command("mcp")
  .description("Run the aidimag MCP server (stdio)")
  .action(async () => {
    await import("../mcp/server.js");
  });

program.parseAsync().catch((err) => fail(err instanceof Error ? err.message : String(err)));

