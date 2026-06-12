#!/usr/bin/env node
/**
 * dim — the aidimag CLI (dimag = brain).
 *
 *   dim init                 initialize .aidimag/ in the current repo
 *   dim remember "<claim>"   store a memory
 *   dim recall <query|path>  search memories
 *   dim status               memory store summary
 *   dim verify               re-run evidence, update statuses
 *   dim log                  recent memories
 *   dim forget <id>          delete a memory
 */

import { Command } from "commander";
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryStore, findRepoRoot, dbPathFor, AIDIMAG_DIR } from "../db/store.js";
import { mineCommits } from "../capture/commit-miner.js";
import { verifyAll } from "../verify/engine.js";
import { installGitHooks } from "../verify/hooks.js";
import { hybridSearch, indexMemory, reindexAll } from "../embeddings/search.js";
import type { EvidenceType, MemoryEntry, MemoryKind, Proposal } from "../types.js";

/** Version comes from package.json — single source of truth. */
const PKG_VERSION: string = JSON.parse(
  readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8")
).version;

const program = new Command();

const KINDS: MemoryKind[] = [
  "DECISION", "CONVENTION", "GOTCHA", "FAILED_APPROACH",
  "ARCHITECTURE", "INVARIANT", "TODO_CONTEXT",
];

function fail(msg: string): never {
  console.error(`dim: ${msg}`);
  process.exit(1);
}

/** Debounced best-effort sync after local mutations (no-op unless cloud-linked). */
async function autoSync(store: MemoryStore): Promise<void> {
  const root = findRepoRoot();
  if (!root) return;
  const { maybeAutoSync } = await import("../sync/client.js");
  const r = await maybeAutoSync(store, root);
  if (r) console.log(`(auto-synced: pushed ${r.pushed}, pulled ${r.pulled}, events ${r.eventsPushed})`);
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
  .version(PKG_VERSION, "-v, --version", "print the aidimag version");

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
    const hooks = installGitHooks(root);
    if (hooks.installed.length) {
      console.log(`Installed git hooks: ${hooks.installed.join(", ")} (re-verify on pull/checkout)`);
    } else if (hooks.alreadyPresent.length) {
      console.log(`Git hooks already installed: ${hooks.alreadyPresent.join(", ")}`);
    }
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
  .action(async (claim: string, opts) => {
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
    console.log("🧠 Got it — I'll remember:");
    printMemory(entry, true);
    if (!evidence?.length) {
      console.log(
        `\nTip: claims with evidence re-verify themselves as the code evolves —\n` +
          `     e.g. -e "STATIC_CHECK:grep -q something src/file.ts"`
      );
    }
    await indexMemory(store, entry).catch(() => false);
    await autoSync(store);
    store.close();
  });

program
  .command("recall")
  .description("Search memories — hybrid keyword + semantic when embeddings are configured")
  .argument("[query...]", "Keywords to search")
  .option("-p, --path <paths...>", "Restrict to memories scoped to these paths")
  .option("-k, --kind <kind>", "Filter by kind")
  .option("-n, --limit <n>", "Max results", "10")
  .option("--all", "Include refuted memories")
  .action(async (query: string[], opts) => {
    const store = MemoryStore.open();
    const { results, semantic } = await hybridSearch(store, {
      query: query.join(" "),
      paths: opts.path,
      kind: opts.kind ? (String(opts.kind).toUpperCase() as MemoryKind) : undefined,
      limit: parseInt(opts.limit, 10),
      includeRefuted: Boolean(opts.all),
    });
    if (results.length === 0) console.log("No matching memories.");
    for (const m of results) printMemory(m, true);
    if (query.length && !semantic) {
      console.log("\n(keyword search only — set up Ollama or OPENAI_API_KEY for semantic recall, then `dim reindex`)");
    }
    store.close();
  });

program
  .command("reindex")
  .description("Build/refresh semantic embeddings for all memories")
  .action(async () => {
    const store = MemoryStore.open();
    if (!store.vecAvailable) fail("sqlite-vec extension failed to load on this platform");
    const { indexed, provider } = await reindexAll(store);
    if (!provider) {
      fail("no embedding provider available — run Ollama locally or set OPENAI_API_KEY (see AIDIMAG_EMBEDDINGS)");
    }
    console.log(`Indexed ${indexed} memorie(s) with ${provider.name}/${provider.model} (${provider.dim}d).`);
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
  if (p.ticketRef) console.log(`    ticket: ${p.ticketRef}`);
  if (p.rationale) console.log(`    rationale: ${p.rationale}`);
}

/**
 * Conversational review: walk the queue one proposal at a time —
 * keep / reword / drop / skip. The human gate, made friendly.
 */
async function interactiveReview(store: MemoryStore): Promise<{ kept: number; rejected: number }> {
  const pending = store.listProposals("PENDING", 1000);
  if (pending.length === 0) {
    console.log("✨ Nothing waiting on you — the review queue is empty.");
    return { kept: 0, rejected: 0 };
  }
  const { createInterface } = await import("node:readline");
  // Line-buffering prompt instead of readline/promises: lines arriving between
  // questions (piped/scripted input) are queued, not dropped.
  const rl = createInterface({ input: process.stdin });
  const queued: string[] = [];
  const waiters: Array<(s: string) => void> = [];
  let closed = false;
  rl.on("line", (l) => {
    const w = waiters.shift();
    if (w) w(l);
    else queued.push(l);
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length) waiters.shift()!("q");
  });
  const ask = (prompt: string): Promise<string> => {
    process.stdout.write(prompt);
    if (queued.length) return Promise.resolve(queued.shift()!);
    if (closed) return Promise.resolve("q");
    return new Promise((resolve) => waiters.push(resolve));
  };
  let kept = 0;
  let rejected = 0;
  let skipped = 0;
  // T2: lazy ticket enrichment — fetched at review time, never at capture time
  const reviewRoot = findRepoRoot();
  const { ticketProviderFor } = await import("../tickets/provider.js");
  const provider = reviewRoot ? ticketProviderFor(reviewRoot) : null;
  const plural = pending.length === 1 ? "proposal is" : "proposals are";
  console.log(`🧠 ${pending.length} memory ${plural} waiting for your review.\n`);
  try {
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i];
      const src = p.source === "commit-miner" ? `mined from commit ${p.sourceRef?.slice(0, 8) ?? "?"}` : `proposed by ${p.source}`;
      console.log(`── ${i + 1} of ${pending.length} ── ${p.kind} · ${src}`);
      console.log(`\n   “${p.claim}”\n`);
      if (p.paths.length || p.symbols.length) console.log(`   applies to: ${[...p.paths, ...p.symbols].join(", ")}`);
      if (p.evidence.length)
        console.log(`   evidence:   ${p.evidence.map((e) => `${e.type}:${e.payload.slice(0, 60)}`).join("  ")}`);
      if (p.ticketRef) {
        let ticketLine = p.ticketRef;
        if (provider) {
          const t = await provider.getTicket(p.ticketRef).catch(() => null);
          if (t) {
            ticketLine = `${t.id} “${t.title}” (${t.type}, ${t.status}) — ${t.url}`;
            if (t.body) console.log(`   ticket:     ${ticketLine}\n               ${t.body.slice(0, 200).replace(/\s+/g, " ")}${t.body.length > 200 ? "…" : ""}`);
            else console.log(`   ticket:     ${ticketLine}`);
          } else {
            console.log(`   ticket:     ${ticketLine} (couldn't fetch — provider offline or ticket missing)`);
          }
        } else {
          console.log(`   ticket:     ${ticketLine}`);
        }
      }
      if (p.rationale) console.log(`   why:        ${p.rationale}`);

      const ans = (
        await ask("\n   Keep this? [y]es · [e]dit wording · [n]o, drop it · [s]kip · [q]uit  ")
      )
        .trim()
        .toLowerCase();

      if (ans === "q" || ans === "quit") {
        skipped += pending.length - i;
        break;
      } else if (ans === "y" || ans === "yes") {
        const m = store.approveProposal(p.id);
        kept++;
        console.log(`   ✓ Remembered (${m.id.slice(0, 8)}).\n`);
      } else if (ans === "e" || ans === "edit") {
        const claim = (await ask("   Your wording (enter keeps the original):\n   › ")).trim();
        const m = store.approveProposal(p.id, claim ? { claim } : undefined);
        kept++;
        console.log(claim ? `   ✓ Remembered with your wording (${m.id.slice(0, 8)}).\n` : `   ✓ Remembered as-is (${m.id.slice(0, 8)}).\n`);
      } else if (ans === "n" || ans === "no") {
        store.rejectProposal(p.id);
        rejected++;
        console.log("   ✗ Dropped — it won't be proposed again.\n");
      } else {
        skipped++;
        console.log("   ↷ Skipped — it'll be here next time.\n");
      }
    }
  } finally {
    rl.close();
  }
  const bits = [
    kept ? `${kept} remembered` : null,
    rejected ? `${rejected} dropped` : null,
    skipped ? `${skipped} left for later` : null,
  ].filter(Boolean);
  console.log(`Done — ${bits.length ? bits.join(", ") : "no changes"}.${kept ? " Run `dim verify` to put the new memories to the test." : ""}`);
  return { kept, rejected };
}

program
  .command("mine")
  .description("Mine git history for memory candidates (queued for review, never auto-saved)")
  .option("-n, --max <n>", "Max commits to scan", "500")
  .option("--full", "Rescan from the beginning of history (ignore cursor)")
  .option("-q, --quiet", "Only speak up when candidates are found (for the post-commit hook)")
  .action((opts) => {
    const root = findRepoRoot() ?? fail("not inside a git repo");
    if (!existsSync(path.join(root, ".git"))) fail("commit mining requires a git repo");
    const store = MemoryStore.open(root, { create: true });
    const res = mineCommits(store, root, {
      maxCommits: parseInt(opts.max, 10),
      full: Boolean(opts.full),
    });
    if (opts.quiet) {
      // post-commit hook mode: a single gentle nudge, nothing else
      if (res.proposed.length > 0) {
        const total = store.listProposals("PENDING", 1000).length;
        console.log(
          `🧠 aidimag: this commit looks memory-worthy — ${res.proposed.length} proposal(s) queued` +
            ` (${total} pending). Review with \`dim review\`.`
        );
      }
      store.close();
      return;
    }
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
  .description("Review pending memory proposals — interactive walkthrough by default (list | approve | reject for scripting)")
  .argument("[action]", "interactive (default in a terminal) | list | approve | reject")
  .argument("[id]", "Proposal id (8-char prefix ok); 'all' with approve/reject applies to every pending proposal")
  .option("-n, --limit <n>", "Max proposals to list", "50")
  .action(async (action: string | undefined, id: string | undefined, opts) => {
    const store = MemoryStore.open();
    const effective = action ?? (process.stdin.isTTY && process.stdout.isTTY ? "interactive" : "list");
    switch (effective) {
      case "interactive": {
        const { kept, rejected } = await interactiveReview(store);
        if (kept + rejected > 0) await autoSync(store);
        break;
      }
      case "list": {
        const pending = store.listProposals("PENDING", parseInt(opts.limit, 10));
        if (pending.length === 0) console.log("No pending proposals.");
        for (const p of pending) printProposal(p);
        if (pending.length) {
          console.log(`\nApprove: dim review approve <id> | Reject: dim review reject <id> | Walkthrough: dim review`);
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
        fail(`unknown action '${action}'. Use: list | approve | reject (or no action for the walkthrough)`);
    }
    if (effective === "approve" || effective === "reject") await autoSync(store);
    store.close();
  });

program
  .command("verify")
  .description("Re-run evidence and update memory statuses (cheap tier; --deep adds tests/exec)")
  .option("-i, --id <ids...>", "Only verify specific memory ids (prefix ok)")
  .option("-d, --deep", "Also run expensive evidence (TEST_RESULT, EXEC_TRACE)")
  .option("-q, --quiet", "Only print status changes (for git hooks)")
  .action(async (opts) => {
    const root = findRepoRoot() ?? fail("not inside a repo");
    const store = MemoryStore.open(root);
    const report = verifyAll(store, root, { ids: opts.id, deep: Boolean(opts.deep) });

    for (const r of report.results) {
      const changed = r.after !== r.before || r.decayed;
      if (opts.quiet && !changed) continue;
      const arrow = r.after !== r.before ? `${r.before} → ${r.after}` : r.after;
      const icon = r.after === "VERIFIED" ? "✓" : r.after === "STALE" ? "~" : "?";
      const decayNote = r.decayed ? " (decayed)" : "";
      console.log(`${icon} [${arrow}] conf ${r.confidenceBefore.toFixed(2)}→${r.confidenceAfter.toFixed(2)}${decayNote}  ${r.claim.slice(0, 90)}`);
      for (const o of r.outcomes) {
        if (opts.quiet && o.result !== "FAIL") continue;
        console.log(`    ${o.type}: ${o.result} (${o.detail})`);
      }
    }
    if (opts.quiet) {
      // hook mode: machine-stable output — only speak when something went stale
      if (report.stale > 0) {
        console.log(
          `\nchecked ${report.checked}: ${report.verified} verified, ${report.stale} stale, ${report.decayed} decayed, ${report.unchanged} unchanged`
        );
      }
    } else if (report.checked === 0) {
      console.log("Nothing to verify yet — store something with `dim remember` first.");
    } else if (report.stale > 0) {
      console.log(
        `\n⚠ ${report.stale} memor${report.stale === 1 ? "y" : "ies"} went stale — the code changed under ${report.stale === 1 ? "it" : "them"}. ` +
          `Stale memories are down-ranked in recall until they recover.\n` +
          `(checked ${report.checked}: ${report.verified} verified, ${report.stale} stale, ${report.decayed} decayed, ${report.unchanged} unchanged)`
      );
    } else {
      console.log(
        `\n✓ All good — ${report.verified} verified, ${report.unchanged} unchanged${report.decayed ? `, ${report.decayed} aging (decayed)` : ""} of ${report.checked} checked.`
      );
    }
    await autoSync(store);
    store.close();
    if (report.stale > 0) process.exitCode = 2; // signal staleness to scripts
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
  .command("refute")
  .description("Mark a memory REFUTED (kept as negative knowledge, unlike forget)")
  .argument("<id>", "Memory id (full or 8-char prefix)")
  .option("-s, --superseded-by <id>", "Id of a newer memory replacing it")
  .action(async (id: string, opts) => {
    const store = MemoryStore.open();
    const match = store.list(1000).find((m) => m.id === id || m.id.startsWith(id));
    if (!match) fail(`no memory matching id '${id}'`);
    store.refute(match.id, opts.supersededBy);
    console.log(`✗ refuted ${match.id.slice(0, 8)}: "${match.claim}"`);
    await autoSync(store);
    store.close();
  });

program
  .command("forget")
  .description("Delete a memory permanently (prefer refuting via agents)")
  .argument("<id>", "Memory id (full or 8-char prefix)")
  .action(async (id: string) => {
    const store = MemoryStore.open();
    // allow prefix match
    const match = store.list(1000).find((m) => m.id === id || m.id.startsWith(id));
    if (!match) fail(`no memory matching id '${id}'`);
    store.forget(match.id);
    console.log(`Forgot memory ${match.id}: "${match.claim}"`);
    await autoSync(store);
    store.close();
  });

program
  .command("ui")
  .description("Open the local web dashboard (memory list, review queue, visual graph)")
  .option("-p, --port <n>", "Port", "4517")
  .option("--no-open", "Don't open the browser automatically")
  .action(async (opts) => {
    const root = findRepoRoot() ?? fail("not inside a repo");
    const store = MemoryStore.open(root);
    const { startUiServer } = await import("../ui/server.js");
    const url = await startUiServer(store, root, parseInt(opts.port, 10));
    console.log(`aidimag dashboard: ${url}  (Ctrl+C to stop)`);
    if (opts.open) {
      const { exec } = await import("node:child_process");
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      exec(`${opener} ${url}`);
    }
  });

program
  .command("serve")
  .description("Run a self-hosted team sync server")
  .option("-p, --port <n>", "Port", "8787")
  .option("-d, --db <path>", "Server database file", "./aidimag-sync.db")
  .option("-t, --token <token>", "Shared auth token (or AIDIMAG_SYNC_TOKEN env)")
  .action(async (opts) => {
    const token = opts.token ?? process.env.AIDIMAG_SYNC_TOKEN;
    if (!token) fail("provide --token or set AIDIMAG_SYNC_TOKEN");
    const { startSyncServer } = await import("../sync/server.js");
    const url = await startSyncServer({ dbPath: opts.db, token, port: parseInt(opts.port, 10) });
    console.log(`aidimag sync server: ${url}  (db: ${opts.db}, Ctrl+C to stop)`);
    console.log(`Link a repo with: dim cloud link --server ${url} --brain <name> --token <token>`);
  });

program
  .command("cloud")
  .description("Manage the repo's cloud/team-sync binding")
  .argument("<action>", "link | unlink | status")
  .option("-s, --server <url>", "Sync server URL")
  .option("-b, --brain <name>", "Brain (team memory) name on the server")
  .option("-t, --token <token>", "Auth token (stored in ~/.aidimag/credentials.json, NOT the repo)")
  .action(async (action: string, opts) => {
    const root = findRepoRoot() ?? fail("not inside a repo");
    const { readCloudConfig, writeCloudConfig, saveToken, getToken } = await import("../sync/client.js");
    switch (action) {
      case "link": {
        if (!opts.server || !opts.brain) fail("usage: dim cloud link --server <url> --brain <name> [--token <token>]");
        const server = String(opts.server).replace(/\/$/, "");
        writeCloudConfig(root, { server, brain: opts.brain });
        if (opts.token) saveToken(server, opts.token);
        console.log(`Linked to ${server} (brain: ${opts.brain}).`);
        console.log(`Config in .aidimag/config.json (commit it — no secrets inside). Token in ~/.aidimag/credentials.json.`);
        if (!opts.token && !getToken(server)) {
          console.log("⚠ No token stored yet — pass --token or set AIDIMAG_API_KEY before `dim sync`.");
        }
        break;
      }
      case "unlink": {
        writeCloudConfig(root, { server: "", brain: "" } as never);
        console.log("Unlinked (config cleared).");
        break;
      }
      case "status": {
        const cfg = readCloudConfig(root);
        if (!cfg) console.log("Not cloud-linked. Use `dim cloud link`.");
        else console.log(`server: ${cfg.server}\nbrain:  ${cfg.brain}\ntoken:  ${getToken(cfg.server) ? "stored" : "MISSING"}`);
        break;
      }
      default:
        fail(`unknown action '${action}'. Use: link | unlink | status`);
    }
  });

program
  .command("login")
  .description("Log this device in to the sync server (device-code flow, approved in the browser)")
  .option("-s, --server <url>", "Server URL (defaults to the repo's linked server)")
  .option("--no-open", "Don't open the browser automatically")
  .action(async (opts) => {
    const { readCloudConfig, startDeviceLogin, pollDeviceLogin } = await import("../sync/client.js");
    const root = findRepoRoot();
    const server: string | undefined =
      (opts.server as string | undefined)?.replace(/\/$/, "") ?? (root ? readCloudConfig(root)?.server : undefined);
    if (!server) fail("no server: pass --server <url> or link the repo with `dim cloud link` first");
    const start = await startDeviceLogin(server);
    const approveUrl = `${start.verification_uri}?code=${encodeURIComponent(start.user_code)}`;
    console.log(`\nTo approve this device, open:\n\n  ${approveUrl}\n\nand confirm the code: ${start.user_code}\n`);
    if (opts.open) {
      const { exec } = await import("node:child_process");
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      exec(`${opener} "${approveUrl}"`);
    }
    console.log("Waiting for approval…");
    const { brain } = await pollDeviceLogin(server, start);
    console.log(`✓ Logged in to ${server} (scope: ${brain ?? "all brains"}). Token saved to ~/.aidimag/credentials.json.`);
  });

program
  .command("logout")
  .description("Remove this device's stored token for the sync server")
  .option("-s, --server <url>", "Server URL (defaults to the repo's linked server)")
  .action(async (opts) => {
    const { readCloudConfig, removeToken } = await import("../sync/client.js");
    const root = findRepoRoot();
    const server: string | undefined =
      (opts.server as string | undefined)?.replace(/\/$/, "") ?? (root ? readCloudConfig(root)?.server : undefined);
    if (!server) fail("no server: pass --server <url> or link the repo with `dim cloud link` first");
    console.log(removeToken(server) ? `✓ Logged out of ${server}.` : `No stored token for ${server}.`);
  });

program
  .command("sync")
  .description("Sync this repo's memory with the linked team server (push + pull)")
  .action(async () => {
    const root = findRepoRoot() ?? fail("not inside a repo");
    const store = MemoryStore.open(root);
    const { sync } = await import("../sync/client.js");
    try {
      const r = await sync(store, root);
      const recv = r.applied
        ? `received ${r.applied} update${r.applied === 1 ? "" : "s"} from the team`
        : "nothing new from the team";
      const sent = r.pushed ? `sent ${r.pushed}` : "nothing to send";
      console.log(`☁ Synced — ${sent}, ${recv}${r.eventsPushed ? ` (+${r.eventsPushed} verification events)` : ""}.`);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      store.close();
    }
  });

program
  .command("keys")
  .description("Manage brain-scoped API keys on the sync server (admin token required)")
  .argument("<action>", "create | list | revoke")
  .option("-s, --server <url>", "Server URL (defaults to the repo's linked server)")
  .option("-b, --brain <name>", "Brain the key grants access to (create)")
  .option("-l, --label <text>", "Key label, e.g. 'ci' or 'alice-laptop' (create)")
  .option("-k, --key <key>", "Key to revoke")
  .option("-t, --admin-token <token>", "Admin token (or AIDIMAG_ADMIN_TOKEN env)")
  .action(async (action: string, opts) => {
    const { readCloudConfig } = await import("../sync/client.js");
    const root = findRepoRoot();
    const server: string | undefined = opts.server ?? (root ? readCloudConfig(root)?.server : undefined);
    if (!server) fail("no server: pass --server or link the repo with `dim cloud link`");
    const admin = opts.adminToken ?? process.env.AIDIMAG_ADMIN_TOKEN;
    if (!admin) fail("provide --admin-token or set AIDIMAG_ADMIN_TOKEN");
    const call = async (method: string, pathq: string, body?: unknown) => {
      const res = await fetch(`${server}${pathq}`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin}` },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json();
      if (!res.ok) fail(`server: ${JSON.stringify(json)}`);
      return json;
    };
    switch (action) {
      case "create": {
        if (!opts.brain) fail("usage: dim keys create --brain <name> [--label <text>]");
        const r = (await call("POST", "/v1/keys", { brain: opts.brain, label: opts.label })) as { key: string };
        console.log(`Created key for brain '${opts.brain}':\n${r.key}\n\n⚠ Shown once — store it now (teammates: dim cloud link --token <key>).`);
        break;
      }
      case "list": {
        const r = (await call("GET", "/v1/keys")) as { keys: Array<{ key: string; brain: string; label: string | null; created_at: string; revoked_at: string | null }> };
        if (!r.keys.length) console.log("No keys.");
        for (const k of r.keys) {
          console.log(`${k.revoked_at ? "✗" : "✓"} ${k.key}  brain=${k.brain}${k.label ? `  label=${k.label}` : ""}${k.revoked_at ? "  (revoked)" : ""}`);
        }
        break;
      }
      case "revoke": {
        if (!opts.key) fail("usage: dim keys revoke --key <full-key>");
        const r = (await call("DELETE", `/v1/keys?key=${encodeURIComponent(opts.key)}`)) as { revoked: boolean };
        console.log(r.revoked ? "Key revoked." : "Key not found (or already revoked).");
        break;
      }
      default:
        fail(`unknown action '${action}'. Use: create | list | revoke`);
    }
  });

program
  .command("ticket")
  .description("Connect a ticketing app so proposals carry real context (Jira, GitHub Issues, or your own HTTP middleware)")
  .argument("<action>", "connect | status | disconnect | show")
  .argument("[id]", "Ticket id for 'show', e.g. XXX-2100 or #123")
  .option("--provider <name>", "jira | github | http (connect)")
  .option("--url <baseUrl>", "Jira site / GitHub repo URL / middleware endpoint (connect)")
  .option("--token <credential>", "Jira: email:apiToken or PAT · GitHub: token · http: optional bearer (connect)")
  .option("--pattern <regex>", "Ticket-id pattern for branch/commit extraction (connect)")
  .action(async (action: string, id: string | undefined, opts) => {
    const root = findRepoRoot() ?? fail("not inside a repo");
    const tickets = await import("../tickets/provider.js");
    switch (action) {
      case "connect": {
        if (!opts.provider || !opts.url) fail("usage: dim ticket connect --provider jira|github|http --url <baseUrl> [--token <credential>] [--pattern <regex>]");
        const provider = String(opts.provider).toLowerCase() as "jira" | "github" | "http";
        if (!["jira", "github", "http"].includes(provider)) fail(`unknown provider '${opts.provider}' — use jira, github, or http`);
        const baseUrl = String(opts.url).replace(/\/$/, "");
        const existing = tickets.readTicketsConfig(root);
        tickets.writeTicketsConfig(root, {
          ...existing,
          provider,
          baseUrl,
          pattern: opts.pattern ?? existing.pattern ?? (provider === "github" ? "#\\d+" : tickets.DEFAULT_TICKET_PATTERN),
        });
        if (opts.token) tickets.saveTicketCredential(baseUrl, String(opts.token));
        console.log(`🎫 Connected ${provider} at ${baseUrl}.`);
        console.log(`   Config in .aidimag/config.json (commit it — no secrets inside).`);
        console.log(opts.token ? `   Credential stored in ~/.aidimag/credentials.json (this machine only).` : `   ⚠ No credential yet — pass --token, or set AIDIMAG_TICKET_TOKEN.`);
        // trust-building: validate with a live round-trip when possible
        const p = tickets.ticketProviderFor(root);
        if (p && id) {
          const t = await p.getTicket(id).catch((e) => fail(`validation fetch failed: ${e.message}`));
          console.log(t ? `   ✓ Validated — fetched ${t.id}: “${t.title}”` : `   ⚠ ${id} not found (connection works, ticket doesn't exist)`);
        } else if (p) {
          console.log(`   Tip: validate with \`dim ticket show <id>\`.`);
        }
        break;
      }
      case "status": {
        const cfg = tickets.readTicketsConfig(root);
        if (!cfg.provider) {
          console.log("No ticketing app connected. Use `dim ticket connect --provider jira --url https://you.atlassian.net --token email:apiToken`.");
          break;
        }
        console.log(`provider: ${cfg.provider}\nbaseUrl:  ${cfg.baseUrl}\npattern:  ${cfg.pattern ?? tickets.DEFAULT_TICKET_PATTERN}\ntoken:    ${cfg.baseUrl && tickets.getTicketCredential(cfg.baseUrl) ? "stored" : "MISSING"}`);
        const branch = cfg.branch;
        if (branch?.pattern) console.log(`branch:   ${branch.pattern} (enforce: ${branch.enforce ?? "off"})`);
        break;
      }
      case "disconnect": {
        const existing = tickets.readTicketsConfig(root);
        tickets.writeTicketsConfig(root, { branch: existing.branch }); // keep branch rules, drop provider
        console.log("🎫 Disconnected (credential kept in ~/.aidimag/credentials.json — remove manually if needed).");
        break;
      }
      case "show": {
        if (!id) fail("usage: dim ticket show <id>");
        const p = tickets.ticketProviderFor(root) ?? fail("no ticketing app connected (or credential missing) — run `dim ticket connect` first");
        const t = await p.getTicket(id);
        if (!t) fail(`ticket ${id} not found`);
        console.log(`🎫 ${t.id} — ${t.title}\n   ${t.type} · ${t.status}${t.labels.length ? ` · ${t.labels.join(", ")}` : ""}${t.parent ? `\n   part of ${t.parent.id} “${t.parent.title}”` : ""}\n   ${t.url}`);
        if (t.body) console.log(`\n${t.body}`);
        break;
      }
      default:
        fail(`unknown action '${action}'. Use: connect | status | disconnect | show`);
    }
  });

program
  .command("branch")
  .description("Create a convention-conforming branch for a ticket (fetches the title for the slug when connected)")
  .argument("<ticketId>", "e.g. XXX-2100")
  .option("-p, --prefix <prefix>", "Branch prefix", "feature")
  .action(async (ticketId: string, opts) => {
    const root = findRepoRoot() ?? fail("not inside a git repo");
    const { ticketProviderFor, buildBranchName } = await import("../tickets/provider.js");
    const provider = ticketProviderFor(root);
    let title: string | undefined;
    if (provider) {
      const t = await provider.getTicket(ticketId).catch(() => null);
      title = t?.title;
      if (t) console.log(`🎫 ${t.id}: “${t.title}”`);
    }
    const name = buildBranchName(ticketId, title, opts.prefix);
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["checkout", "-b", name], { cwd: root, stdio: "inherit" });
    console.log(`🌿 You're on ${name} — commits here will carry ${ticketId} automatically.`);
  });

program
  .command("branch-check", { hidden: true })
  .description("Validate the current branch against the team convention (used by git hooks)")
  .option("--warn", "Warn only (post-checkout)")
  .option("--push", "Exit 1 on violation when enforce mode is 'push' (pre-push)")
  .action(async (opts) => {
    const root = findRepoRoot();
    if (!root) return;
    const { checkBranchName } = await import("../tickets/provider.js");
    const { execFileSync } = await import("node:child_process");
    let branch = "";
    try {
      branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    } catch {
      return; // detached HEAD / not a repo — nothing to check
    }
    const r = checkBranchName(root, branch);
    if (r.ok || r.exempt || r.enforce === "off") return;
    const fixHint = `git branch -m ${branch} <conforming-name>   (or next time: dim branch <TICKET-ID>)`;
    if (opts.push && r.enforce === "push") {
      console.error(`\n🌿 aidimag: branch '${branch}' doesn't match the team convention (${r.pattern}).`);
      console.error(`   Pushes of non-conforming branches are blocked. Rename with:\n   ${fixHint}\n`);
      process.exit(1);
    }
    console.error(`🌿 aidimag: heads up — '${branch}' doesn't match the team's branch convention (${r.pattern}). Fix: ${fixHint}`);
  });

program
  .command("mcp")
  .description("Run the aidimag MCP server (stdio)")
  .action(async () => {
    await import("../mcp/server.js");
  });

program.parseAsync().catch((err) => fail(err instanceof Error ? err.message : String(err)));

