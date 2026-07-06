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
import { resolveKnowledgeConfig } from "../config.js";
import type { EvidenceType, GuardrailLevel, MemoryEntry, MemoryKind, Proposal } from "../types.js";

/** Version comes from package.json — single source of truth. */
const PKG_VERSION: string = JSON.parse(
  readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8")
).version;

const program = new Command();

const KINDS: MemoryKind[] = [
  "DECISION", "CONVENTION", "GOTCHA", "FAILED_APPROACH",
  "ARCHITECTURE", "INVARIANT", "TODO_CONTEXT", "GUARDRAIL", "SKILL",
];

const GUARDRAIL_LEVELS: GuardrailLevel[] = ["never", "always", "ask-first"];
const GUARDRAIL_ICON: Record<GuardrailLevel, string> = { never: "🚫", always: "✅", "ask-first": "🤚" };

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

/**
 * Regenerate the static context file(s) after a memory-set change, but only when
 * the repo opted in via `generateContext.auto` in .aidimag/config.json. Keeps
 * CLAUDE.md / .cursorrules / copilot-instructions in lock-step with verified
 * memory so non-MCP tools never read a stale spec. Best-effort: never throws.
 */
async function maybeRegenerateContext(store: MemoryStore): Promise<void> {
  const root = findRepoRoot();
  if (!root) return;
  try {
    const { readConfig } = await import("../config.js");
    const cfg = readConfig(root).generateContext;
    if (!cfg?.auto) return;
    const { generateContext } = await import("../context/generate.js");
    const r = generateContext(store, root, cfg.format ?? "claude");
    console.log(`(regenerated ${r.files.join(", ")} — ${r.total} memories)`);
  } catch {
    /* context regen is advisory; failures must not break the command */
  }
}

function printMemory(m: MemoryEntry, verbose = false): void {
  const statusIcon =
    m.status === "VERIFIED" ? "✓" : m.status === "REFUTED" ? "✗" : m.status === "STALE" ? "~" : "?";
  const guard =
    m.kind === "GUARDRAIL" && m.guardrailLevel
      ? ` ${GUARDRAIL_ICON[m.guardrailLevel]} ${m.guardrailLevel.toUpperCase()}`
      : "";
  console.log(`${statusIcon} ${m.pinned ? "📌 " : ""}[${m.kind}${guard}] ${m.claim}`);
  const scope = [...m.scope.paths, ...m.scope.symbols];
  console.log(
    `    id=${m.id.slice(0, 8)} status=${m.status} conf=${m.confidence.toFixed(2)}` +
      (m.pinned ? " pinned" : "") +
      (scope.length ? ` scope=${scope.join(",")}` : "")
  );
  if (verbose && m.grounding.length) {
    for (const e of m.grounding) {
      console.log(`    evidence: ${e.type}(${e.result}) ${e.payload}`);
    }
  }
}

/** Human-readable summary of a knowledge-inbox ingest run. */
function printIngestReport(report: import("../knowledge/ingest.js").IngestReport): void {
  if (report.processed.length) {
    const claims = report.processed.reduce((n, d) => n + d.claimCount, 0);
    const pinned = report.processed.filter((d) => d.pinned).length;
    console.log(
      `📚 Processed ${report.processed.length} doc(s) → ${claims} claim(s) ` +
        (pinned ? `(${pinned} auto-pinned)` : "queued as proposals — review with `dim review`") +
        (report.summarizer ? `  ·  via ${report.summarizer}` : "")
    );
    for (const d of report.processed) {
      console.log(`   • ${d.file}: ${d.claimCount} claim(s)${d.pinned ? " (pinned)" : ""}`);
    }
  }
  if (report.duplicates.length) {
    console.log(`↩︎  ${report.duplicates.length} unchanged duplicate(s) retired: ${report.duplicates.join(", ")}`);
  }
  if (report.skipped.length) {
    console.log(`⚠️  Skipped ${report.skipped.length} unsupported file(s) (moved to .aidimag/knowledge/skipped/):`);
    for (const s of report.skipped) console.log(`   • ${s.file} — ${s.reason}`);
  }
  if (report.pendingNoSummarizer.length) {
    console.log(
      `⏳ ${report.pendingNoSummarizer.length} doc(s) waiting in the inbox — no summarizer available ` +
        `(configure knowledge.summarizer / an LLM provider, or summarize via a connected MCP agent).`
    );
    for (const f of report.pendingNoSummarizer) console.log(`   • ${f}`);
  }
  if (
    !report.processed.length && !report.duplicates.length &&
    !report.skipped.length && !report.pendingNoSummarizer.length
  ) {
    console.log("Knowledge inbox is empty — nothing to process.");
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
      writeFileSync(gitignore, "memory.db\nmemory.db-wal\nmemory.db-shm\nknowledge/\n");
    } else if (!readFileSync(gitignore, "utf8").includes("knowledge/")) {
      appendFileSync(gitignore, "knowledge/\n");
    }
    // knowledge inbox: a drop folder for project docs (summaries/backups live in .aidimag/)
    const knowledgeInbox = path.join(root, resolveKnowledgeConfig(root).folder);
    mkdirSync(knowledgeInbox, { recursive: true });
    const gitkeep = path.join(knowledgeInbox, ".gitkeep");
    if (!existsSync(gitkeep)) {
      writeFileSync(
        gitkeep,
        "# Drop project docs here (design docs, ADRs, style guides, runbooks).\n" +
          "# aidimag summarizes them into reviewed, pinned memories — see `dim knowledge`.\n"
      );
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
      const folder = resolveKnowledgeConfig(root).folder;
      const additions: string[] = [];
      if (!current.includes(".aidimag/memory.db")) additions.push(".aidimag/memory.db*");
      // keep dropped knowledge docs (may contain secrets) out of git, but track the folder
      if (!current.includes(`${folder}/*`)) additions.push(`${folder}/*`, `!${folder}/.gitkeep`);
      if (additions.length) {
        appendFileSync(rootIgnore, `${current.endsWith("\n") || current === "" ? "" : "\n"}${additions.join("\n")}\n`);
        console.log(`\nUpdated ${rootIgnore} (ignored memory.db + ${folder}/ drops)`);
      }
    }
    console.log(`\nNext: \`dim bootstrap\` gives this repo an instant starter brain (surveys docs/structure/history, queues reviewable memories).`);
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
  .option("-g, --guardrail-level <level>", `For kind=GUARDRAIL: ${GUARDRAIL_LEVELS.join("|")}`)
  .option("--pin", "Pin the memory: it never decays with age (evidence failure can still mark it stale)")
  .action(async (claim: string, opts) => {
    const kind = String(opts.kind).toUpperCase() as MemoryKind;
    if (!KINDS.includes(kind)) fail(`invalid kind '${opts.kind}'. Use one of: ${KINDS.join(", ")}`);
    let guardrailLevel: GuardrailLevel | undefined;
    if (kind === "GUARDRAIL") {
      guardrailLevel = (opts.guardrailLevel ?? "ask-first") as GuardrailLevel;
      if (!GUARDRAIL_LEVELS.includes(guardrailLevel)) {
        fail(`invalid --guardrail-level '${opts.guardrailLevel}'. Use one of: ${GUARDRAIL_LEVELS.join(", ")}`);
      }
    } else if (opts.guardrailLevel) {
      fail("--guardrail-level only applies to --kind GUARDRAIL");
    }
    const evidence = (opts.evidence as string[] | undefined)?.map((spec) => {
      const idx = spec.indexOf(":");
      if (idx < 1) fail(`invalid evidence '${spec}'. Format: TYPE:payload`);
      const type = spec.slice(0, idx).toUpperCase() as EvidenceType;
      return { type, payload: spec.slice(idx + 1) };
    });
    const store = MemoryStore.open(process.cwd(), { create: true });
    const entry = store.write({ kind, claim, paths: opts.path, symbols: opts.symbol, evidence, createdBy: "human", pinned: Boolean(opts.pin), guardrailLevel });
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
    if (query.length) {
      try {
        store.logSearch(query.join(" "), opts.path ?? [], results.length, "cli");
      } catch {
        /* best-effort */
      }
    }
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
    if (s.pinned) {
      console.log(`  pinned:    ${s.pinned} (exempt from time decay)`);
    }
    if (s.pendingProposals) {
      console.log(`\n${s.pendingProposals} proposal(s) awaiting review — run \`dim review\``);
    }
    store.close();
  });

/**
 * Line-buffering prompt for interactive flows (review, ticket connect).
 * Unlike readline/promises, lines arriving between questions (piped input)
 * are queued, not dropped — so scripted/agent-driven input works too.
 */
async function createPrompter(
  closedValue = ""
): Promise<{ ask: (prompt: string) => Promise<string>; close: () => void }> {
  const { createInterface } = await import("node:readline");
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
    while (waiters.length) waiters.shift()!(closedValue);
  });
  const ask = (prompt: string): Promise<string> => {
    process.stdout.write(prompt);
    if (queued.length) return Promise.resolve(queued.shift()!);
    if (closed) return Promise.resolve(closedValue);
    return new Promise((resolve) => waiters.push(resolve));
  };
  return { ask, close: () => rl.close() };
}

/** Open a URL in the default browser, best-effort (matches `dim login` / `dim ui`). */
async function openBrowser(url: string): Promise<void> {
  const { exec } = await import("node:child_process");
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${opener} "${url}"`);
}

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
  const { triagePending } = await import("../capture/triage.js");
  const triaged = triagePending(store, 1000);
  const pending = triaged.map((t) => t.proposal);
  const scoreOf = new Map(triaged.map((t) => [t.proposal.id, t] as const));
  if (pending.length === 0) {
    console.log("✨ Nothing waiting on you — the review queue is empty.");
    return { kept: 0, rejected: 0 };
  }
  const { ask, close } = await createPrompter("q"); // closed stdin = quit
  let kept = 0;
  let rejected = 0;
  let skipped = 0;
  // T2: lazy ticket enrichment — fetched at review time, never at capture time
  const reviewRoot = findRepoRoot();
  const { ticketProviderFor } = await import("../tickets/provider.js");
  const provider = reviewRoot ? ticketProviderFor(reviewRoot) : null;
  const plural = pending.length === 1 ? "proposal is" : "proposals are";
  console.log(`🧠 ${pending.length} memory ${plural} waiting for your review (best first).\n`);
  try {
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i];
      const src = p.source === "commit-miner" ? `mined from commit ${p.sourceRef?.slice(0, 8) ?? "?"}` : `proposed by ${p.source}`;
      const tri = scoreOf.get(p.id);
      console.log(`── ${i + 1} of ${pending.length} ── ${p.kind} · ${src}${tri ? ` · score ${tri.score.toFixed(2)}` : ""}`);
      if (tri?.reasons.length) console.log(`   (${tri.reasons.join(", ")})`);
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
    close();
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
  .option("--llm", "Deep mining: LLM reads each commit's message AND diff, synthesizes claims + suggested checks (needs Ollama/OPENAI_API_KEY; slower, much higher quality)")
  .option("-q, --quiet", "Only speak up when candidates are found (for the post-commit hook)")
  .action(async (opts) => {
    const root = findRepoRoot() ?? fail("not inside a git repo");
    if (!existsSync(path.join(root, ".git"))) fail("commit mining requires a git repo");
    const store = MemoryStore.open(root, { create: true });
    let res;
    let llmProvider: string | null = null;
    if (opts.llm) {
      const { mineCommitsLlm } = await import("../capture/commit-miner.js");
      const r = await mineCommitsLlm(store, root, {
        maxCommits: parseInt(opts.max, 10),
        full: Boolean(opts.full),
      });
      res = r;
      llmProvider = r.provider;
      if (!llmProvider && !opts.quiet) {
        console.log("(no LLM provider available — fell back to keyword mining; run Ollama or set OPENAI_API_KEY)");
      }
    } else {
      res = mineCommits(store, root, {
        maxCommits: parseInt(opts.max, 10),
        full: Boolean(opts.full),
      });
    }
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
      `Scanned ${res.scanned} commit(s)${llmProvider ? ` with ${llmProvider}` : ""}: ${res.proposed.length} proposal(s) queued` +
        (res.skippedDuplicates ? `, ${res.skippedDuplicates} duplicate(s) skipped` : "") +
        (res.lastSha ? ` (cursor @ ${res.lastSha.slice(0, 8)})` : "")
    );
    for (const p of res.proposed) printProposal(p);
    if (res.proposed.length) console.log(`\nReview with \`dim review\`.`);
    store.close();
  });

program
  .command("bootstrap")
  .description("Give a fresh repo an instant brain: survey README/docs/manifests/structure/churn and LLM-extract an initial memory set (queued for review)")
  .option("--force", "Re-run even if this repo was already bootstrapped")
  .action(async (opts) => {
    const root = findRepoRoot() ?? fail("not inside a git repo");
    const store = MemoryStore.open(root, { create: true });
    const { bootstrapRepo } = await import("../capture/bootstrap.js");
    console.log("Surveying the repo (docs, manifests, structure, churn)…");
    const res = await bootstrapRepo(store, root, { force: Boolean(opts.force) });
    if (res.alreadyBootstrapped) {
      console.log("Already bootstrapped — use --force to re-run (dedupe absorbs repeats).");
    } else if (!res.provider) {
      fail("no LLM provider available — run Ollama locally or set OPENAI_API_KEY (see AIDIMAG_LLM)");
    } else {
      console.log(
        `Surveyed ${res.surveyedFiles.length} file(s) with ${res.provider}: ` +
          `${res.proposed} proposal(s) queued${res.duplicates ? `, ${res.duplicates} duplicate(s) skipped` : ""}.`
      );
      if (res.proposed) {
        console.log(`\nYour repo's starter brain is ready for review: \`dim review\``);
        console.log(`(then \`dim verify\` to put the suggested checks to the test)`);
      } else {
        console.log("No durable claims extracted — the survey found little written-down knowledge. Feed docs into knowledge/ or use `dim mine --llm`.");
      }
    }
    store.close();
  });

program
  .command("harvest")
  .description("Harvest durable facts YOU typed into AI chats (Claude Code transcripts) into the review queue — local-only, secrets redacted")
  .option("--all", "Rescan every session (ignore cursor; dedupe absorbs repeats)")
  .option("--install-hook", "Wire `dim harvest -q` into this repo's Claude Code SessionEnd hook (.claude/settings.json)")
  .option("-q, --quiet", "Only speak up when proposals are queued (for the SessionEnd hook)")
  .action(async (opts) => {
    const root = findRepoRoot() ?? fail("not inside a git repo");
    const { harvestClaudeSessions, installClaudeSessionEndHook, claudeProjectDir } = await import(
      "../capture/harvest.js"
    );
    if (opts.installHook) {
      const { installed, settingsPath } = installClaudeSessionEndHook(root);
      console.log(
        installed
          ? `✓ SessionEnd hook installed in ${settingsPath} — every Claude Code session is now harvested on close.`
          : `Hook already present in ${settingsPath} — nothing to do.`
      );
      return;
    }
    const store = MemoryStore.open(root, { create: true });
    const res = await harvestClaudeSessions(store, root, { all: Boolean(opts.all) });
    if (opts.quiet) {
      if (res.proposed > 0) {
        console.log(
          `🧠 aidimag: harvested ${res.proposed} memory candidate(s) from your AI chat — review with \`dim review\`.`
        );
      }
      store.close();
      return;
    }
    if (!res.transcriptDir) {
      console.log(`No Claude Code transcripts found for this repo (${claudeProjectDir(root) ?? "~/.claude/projects/<repo-slug>"} missing).`);
      console.log("Transcripts appear after your first Claude Code session here. Cursor/Copilot chat harvesting: planned.");
    } else if (!res.provider) {
      fail("no LLM provider available — run Ollama locally or set OPENAI_API_KEY (see AIDIMAG_LLM)");
    } else if (res.sessionsScanned === 0) {
      console.log("No new sessions since the last harvest. Use --all to rescan everything.");
    } else {
      console.log(
        `Scanned ${res.sessionsScanned} session(s), ${res.messagesConsidered} user message(s) via ${res.provider}: ` +
          `${res.proposed} proposal(s) queued` +
          (res.duplicates ? `, ${res.duplicates} duplicate(s) skipped` : "") +
          "."
      );
      if (res.proposed) console.log(`Review with \`dim review\`.`);
    }
    if (!opts.installHook && res.transcriptDir) {
      console.log(`(tip: \`dim harvest --install-hook\` runs this automatically when each Claude Code session ends)`);
    }
    store.close();
  });

program
  .command("review")
  .description("Review pending memory proposals — interactive walkthrough by default (list | approve | reject for scripting)")
  .argument("[action]", "interactive (default in a terminal) | list | approve | reject")
  .argument("[id]", "Proposal id (8-char prefix ok); 'all' with approve/reject applies to every pending proposal")
  .option("-n, --limit <n>", "Max proposals to list", "50")
  .option("--min-score <s>", "With 'approve all': only approve proposals triaged at or above this score (0–1)")
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
        const { triagePending } = await import("../capture/triage.js");
        const triaged = triagePending(store, parseInt(opts.limit, 10));
        if (triaged.length === 0) console.log("No pending proposals.");
        for (const t of triaged) {
          console.log(`  score ${t.score.toFixed(2)}${t.reasons.length ? ` (${t.reasons.join(", ")})` : ""}`);
          printProposal(t.proposal);
        }
        if (triaged.length) {
          console.log(`\nApprove: dim review approve <id> | Reject: dim review reject <id> | Walkthrough: dim review`);
          console.log(`Batch: dim review approve all --min-score 0.7`);
        }
        break;
      }
      case "approve": {
        if (!id) fail("usage: dim review approve <id|all> [--min-score <s>]");
        let targets: string[];
        if (id === "all") {
          const { triagePending } = await import("../capture/triage.js");
          const minScore = opts.minScore !== undefined ? parseFloat(opts.minScore) : null;
          const triaged = triagePending(store, 1000);
          const chosen = minScore === null ? triaged : triaged.filter((t) => t.score >= minScore);
          targets = chosen.map((t) => t.proposal.id);
          if (minScore !== null) {
            console.log(`${chosen.length} of ${triaged.length} pending proposal(s) scored ≥ ${minScore}.`);
          }
        } else {
          targets = [id];
        }
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
    await maybeRegenerateContext(store);
    store.close();
  });

program
  .command("verify")
  .description("Re-run evidence and update memory statuses (cheap tier; --deep adds tests/exec)")
  .option("-i, --id <ids...>", "Only verify specific memory ids (prefix ok)")
  .option("-d, --deep", "Also run expensive evidence (TEST_RESULT, EXEC_TRACE)")
  .option("--trust", "Review evidence commands that arrived via team sync and approve them to run on this machine")
  .option("-q, --quiet", "Only print status changes (for git hooks)")
  .action(async (opts) => {
    const root = findRepoRoot() ?? fail("not inside a repo");
    const store = MemoryStore.open(root);
    if (opts.trust) {
      const pending = store.untrustedEvidence();
      if (!pending.length) {
        console.log("No untrusted evidence — everything runnable was authored or approved on this machine.");
      } else {
        console.log(`${pending.length} synced-in evidence command(s) are NOT yet approved to execute here:\n`);
        for (const u of pending) {
          console.log(`  [${u.type}] ${u.payload}`);
          console.log(`      for: "${u.claim.slice(0, 90)}"\n`);
        }
        const { ask, close } = await createPrompter("n");
        const ans = (await ask("Approve ALL of the above to run on this machine? [y/N] ")).trim().toLowerCase();
        close();
        if (ans === "y" || ans === "yes") {
          console.log(`✓ approved ${store.trustAllEvidence()} command(s). They'll run on the next verify.`);
        } else {
          console.log("Nothing approved — they stay skipped during verification.");
        }
      }
    }
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
    // keep generated context in sync when a status actually flipped
    if (report.results.some((r) => r.after !== r.before)) await maybeRegenerateContext(store);
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
  .command("gaps")
  .description("Knowledge gaps: searches agents/you ran that returned NOTHING — the facts your brain is missing")
  .option("-d, --days <n>", "Look-back window in days", "30")
  .option("-n, --limit <n>", "Max entries", "20")
  .option("--clear", "Clear the search log after showing")
  .action((opts) => {
    const store = MemoryStore.open();
    const gaps = store.searchGaps({ sinceDays: parseInt(opts.days, 10), limit: parseInt(opts.limit, 10) });
    if (gaps.length === 0) {
      console.log(`No knowledge gaps in the last ${opts.days} day(s) — every search found something.`);
    } else {
      console.log(`${gaps.length} knowledge gap(s) in the last ${opts.days} day(s) — most-asked first:\n`);
      for (const g of gaps) {
        const scope = g.paths.length ? `  [scope: ${g.paths.join(", ")}]` : "";
        console.log(`  ${String(g.misses).padStart(3)}× "${g.query}"${scope}  (last: ${g.lastAsked.slice(0, 10)})`);
      }
      console.log(`\nFill a gap: dim remember "<the answer>" -k <kind> [-e TYPE:proof]`);
    }
    if (opts.clear) {
      const n = store.clearSearchGaps();
      console.log(`\nCleared ${n} logged search(es).`);
    }
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
  .command("pin")
  .description("Pin a memory: it stays with the project forever — never decays with age (evidence failure can still mark it stale)")
  .argument("<id>", "Memory id (full or 8-char prefix)")
  .action(async (id: string) => {
    const store = MemoryStore.open();
    const match = store.list(1000).find((m) => m.id === id || m.id.startsWith(id));
    if (!match) fail(`no memory matching id '${id}'`);
    store.setPinned(match.id, true);
    console.log(`📌 pinned ${match.id.slice(0, 8)}: "${match.claim}"`);
    console.log(`   It won't decay with age. Evidence checks still apply — a failing check marks it stale.`);
    await autoSync(store);
    store.close();
  });

program
  .command("unpin")
  .description("Unpin a memory — normal confidence decay resumes")
  .argument("<id>", "Memory id (full or 8-char prefix)")
  .action(async (id: string) => {
    const store = MemoryStore.open();
    const match = store.list(1000).find((m) => m.id === id || m.id.startsWith(id));
    if (!match) fail(`no memory matching id '${id}'`);
    store.setPinned(match.id, false);
    console.log(`unpinned ${match.id.slice(0, 8)}: "${match.claim}" — normal decay resumes.`);
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
  .argument("[action]", "start (default) | stop")
  .description("Manage the local web dashboard (memory list, review queue, visual graph)")
  .option("-p, --port <n>", "Port", "4517")
  .option("--no-open", "Don't open the browser automatically (start only)")
  .action(async (action: string | undefined, opts) => {
    const effectiveAction = action ?? "start";
    
    if (effectiveAction === "stop") {
      const port = parseInt(opts.port, 10);
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(exec);
      
      try {
        // Find process listening on the port
        const cmd = process.platform === "win32"
          ? `netstat -ano | findstr :${port}`
          : `lsof -ti:${port}`;
        
        const { stdout } = await execAsync(cmd);
        
        if (!stdout.trim()) {
          console.log(`No server found running on port ${port}`);
          return;
        }
        
        // Kill the process
        const pids = process.platform === "win32"
          ? stdout.split("\n").map(line => line.trim().split(/\s+/).pop()).filter(Boolean)
          : stdout.trim().split("\n");
        
        for (const pid of pids) {
          const killCmd = process.platform === "win32" ? `taskkill /F /PID ${pid}` : `kill ${pid}`;
          await execAsync(killCmd);
        }
        
        console.log(`✓ Stopped server on port ${port}`);
      } catch (err) {
        if (err instanceof Error && "code" in err && err.code === 1) {
          console.log(`No server found running on port ${port}`);
        } else {
          fail(`Failed to stop server: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } else if (effectiveAction === "start") {
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
    } else {
      fail(`unknown action '${action}'. Use: start | stop`);
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
      // a pull that changed local memory should refresh the generated context
      if (r.applied) await maybeRegenerateContext(store);
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

const TICKET_PROVIDERS = ["jira", "github", "linear", "http", "remote"] as const;
type TicketProviderName = (typeof TICKET_PROVIDERS)[number];
type BranchEnforce = "push" | "warn" | "off";

program
  .command("ticket")
  .description("Connect a ticketing app so proposals carry real context (Jira, GitHub Issues, Linear, the team sync server, or your own HTTP middleware)")
  .argument("<action>", "connect | status | disconnect | show | share | branch-rule")
  .argument("[id]", "Ticket id for 'show' (e.g. XXX-2100 or #123) · provider name for 'connect' (jira|github|linear|http|remote)")
  .option("--provider <name>", "jira | github | linear | http | remote (connect/share)")
  .option("--url <baseUrl>", "Jira site / GitHub repo URL / middleware endpoint (connect/share)")
  .option("--token <credential>", "Jira: email:apiToken or PAT · GitHub/Linear: token · http: optional bearer (connect/share)")
  .option("--pattern <regex>", "Ticket-id pattern for branch/commit extraction (connect) · branch pattern (branch-rule)")
  .option("--enforce <mode>", "push | warn | off (branch-rule)")
  .option("--exempt <branches...>", "Exempt branch regexes, e.g. main develop 'release/.*' (branch-rule)")
  .option("--print <host>", "Emit the server-side rule for github | gitlab | bitbucket (branch-rule)")
  .option("--remove", "Remove the team ticket config from the sync server (share)")
  .option("--admin-token <token>", "Sync-server admin token (share; or AIDIMAG_ADMIN_TOKEN env)")
  .option("--no-open", "Don't open the API-token page in the browser (connect)")
  .action(async (action: string, id: string | undefined, opts) => {
    const root = findRepoRoot() ?? fail("not inside a repo");
    const tickets = await import("../tickets/provider.js");
    switch (action) {
      case "connect": {
        // provider: positional (`dim ticket connect jira`), flag, or asked interactively
        let provider = (id ?? opts.provider)?.toLowerCase() as TicketProviderName | undefined;
        if (provider && !TICKET_PROVIDERS.includes(provider)) {
          fail(`unknown provider '${provider}' — use ${TICKET_PROVIDERS.join(", ")}`);
        }
        // Prompt for anything missing — the prompter queues piped lines, so
        // scripted/agent-driven input works too; on closed stdin answers come
        // back empty and we fail fast instead of hanging (CI-safe).
        const needsUrl = !opts.url && provider !== "linear" && provider !== "remote";
        const interactive = !provider || (provider !== "remote" && (needsUrl || !opts.token));
        const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
        const existing = tickets.readTicketsConfig(root);


        const { ask, close } = interactive ? await createPrompter() : { ask: async () => "", close: () => undefined };
        try {
          if (!provider) {
            console.log("🎫 Let's connect your ticketing app — proposals will carry the *why* from your tickets.\n");
            const ans = (await ask(`   Which one? [${TICKET_PROVIDERS.join(" | ")}]  `)).trim().toLowerCase();
            if (!TICKET_PROVIDERS.includes(ans as TicketProviderName)) fail(`unknown provider '${ans}' — use ${TICKET_PROVIDERS.join(", ")}`);
            provider = ans as TicketProviderName;
          }

          // ---- remote: zero local credentials — the sync server is the middleman
          if (provider === "remote") {
            const { readCloudConfig, getToken } = await import("../sync/client.js");
            const cloud = readCloudConfig(root);
            if (!cloud) fail("remote tickets ride the sync channel — link the repo first: dim cloud link (then an admin runs `dim ticket share`)");
            tickets.writeTicketsConfig(root, {
              ...existing,
              provider: "remote",
              baseUrl: undefined,
              pattern: opts.pattern ?? existing.pattern ?? tickets.DEFAULT_TICKET_PATTERN,
            });
            console.log(`🎫 Connected via the team sync server (${cloud.server}, brain: ${cloud.brain}).`);
            console.log(`   Zero local ticket credentials — the server holds the team token.`);
            if (!getToken(cloud.server)) console.log(`   ⚠ No sync token on this machine yet — run \`dim login\` first.`);
            // trust-building: check the server actually has a team config
            try {
              const res = await fetch(`${cloud.server}/v1/ticket-config?brain=${encodeURIComponent(cloud.brain)}`, {
                headers: { Authorization: `Bearer ${getToken(cloud.server) ?? ""}` },
              });
              const body = (await res.json()) as { config?: { provider?: string } | null };
              if (res.ok && body.config?.provider) {
                console.log(`   ✓ Server is set up for ${body.config.provider} tickets — try \`dim ticket show <id>\`.`);
              } else {
                console.log(`   ⚠ The server has no team ticket config yet — an admin should run \`dim ticket share\`.`);
              }
            } catch {
              console.log(`   (couldn't reach the server to check its ticket config — it may be offline)`);
            }
            break;
          }

          // ---- direct providers: jira | github | linear | http
          let baseUrl = (opts.url as string | undefined)?.replace(/\/$/, "");
          if (!baseUrl && provider !== "linear") {
            const what =
              provider === "jira" ? "your Jira site URL (e.g. https://acme.atlassian.net)"
              : provider === "github" ? "the repo URL (e.g. https://github.com/acme/api)"
              : "your middleware endpoint (implements GET /ticket/:id)";
            baseUrl = (await ask(`   What's ${what}?\n   › `)).trim().replace(/\/$/, "");
            if (!baseUrl) fail("a base URL is required");
          }

          let token = opts.token as string | undefined;
          if (!token && interactive) {
            const page = tickets.TOKEN_PAGES[provider];
            if (page) {
              console.log(`\n   You'll need an API token — grab one here:\n   ${page}`);
              if (opts.open && isTTY) await openBrowser(page);
            }
            const hint =
              provider === "jira" ? "email:apiToken (or a PAT)"
              : provider === "http" ? "bearer token (enter to skip — optional for internal services)"
              : "token";
            token = (await ask(`\n   Paste your ${hint}: `)).trim() || undefined;
          }
          if (!token && provider !== "http") {
            console.log(`   ⚠ No credential provided — you can add one later (re-run connect, or set AIDIMAG_TICKET_TOKEN).`);
          }

          const credKey = baseUrl ?? "linear";
          tickets.writeTicketsConfig(root, {
            ...existing,
            provider,
            baseUrl,
            pattern: opts.pattern ?? existing.pattern ?? (provider === "github" ? "#\\d+" : tickets.DEFAULT_TICKET_PATTERN),
          });
          if (token) tickets.saveTicketCredential(credKey, token);
          console.log(`\n🎫 Connected ${provider}${baseUrl ? ` at ${baseUrl}` : ""}.`);
          console.log(`   Config in .aidimag/config.json (commit it — no secrets inside).`);
          if (token) console.log(`   Credential stored in ~/.aidimag/credentials.json (this machine only).`);

          // trust-building: validate with a live round-trip
          const p = tickets.ticketProviderFor(root);
          if (p && interactive) {
            const sample = (await ask(`   Validate with a real ticket? Enter an id (or press enter to skip): `)).trim();
            if (sample) {
              const t = await p.getTicket(sample).catch((e: Error) => fail(`validation fetch failed: ${e.message}`));
              console.log(t ? `   ✓ Validated — fetched ${t.id}: “${t.title}”` : `   ⚠ ${sample} not found (connection works, ticket doesn't exist)`);
            } else {
              console.log(`   Tip: validate any time with \`dim ticket show <id>\`.`);
            }
          } else if (p) {
            console.log(`   Tip: validate with \`dim ticket show <id>\`.`);
          }
        } finally {
          close();
        }
        break;
      }
      case "status": {
        const cfg = tickets.readTicketsConfig(root);
        if (!cfg.provider) {
          console.log("No ticketing app connected. Run `dim ticket connect` to set one up interactively.");
          break;
        }
        if (cfg.provider === "remote") {
          const { readCloudConfig, getToken } = await import("../sync/client.js");
          const cloud = readCloudConfig(root);
          console.log(`provider: remote (via the team sync server)\nserver:   ${cloud?.server ?? "NOT LINKED — dim cloud link"}\nbrain:    ${cloud?.brain ?? "—"}\npattern:  ${cfg.pattern ?? tickets.DEFAULT_TICKET_PATTERN}\ntoken:    ${cloud && getToken(cloud.server) ? "sync token stored" : "MISSING — dim login"}`);
        } else {
          const credKey = cfg.baseUrl ?? "linear";
          console.log(`provider: ${cfg.provider}${cfg.baseUrl ? `\nbaseUrl:  ${cfg.baseUrl}` : ""}\npattern:  ${cfg.pattern ?? tickets.DEFAULT_TICKET_PATTERN}\ntoken:    ${tickets.getTicketCredential(credKey) ? "stored" : "MISSING"}`);
        }
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
      // T3: admin pushes the team's ticket credential to the sync server —
      // teammates then run `dim ticket connect remote` and never hold a token.
      case "share": {
        const { readCloudConfig } = await import("../sync/client.js");
        const cloud = readCloudConfig(root) ?? fail("repo is not cloud-linked — run `dim cloud link` first");
        const admin = opts.adminToken ?? process.env.AIDIMAG_ADMIN_TOKEN;
        if (!admin) fail("provide --admin-token or set AIDIMAG_ADMIN_TOKEN (share configures TEAM credentials — admin only)");
        const endpoint = `${cloud.server}/v1/ticket-config?brain=${encodeURIComponent(cloud.brain)}`;
        if (opts.remove) {
          const res = await fetch(endpoint, { method: "DELETE", headers: { Authorization: `Bearer ${admin}` } });
          const body = (await res.json()) as { removed?: boolean; error?: string };
          if (!res.ok) fail(`server: ${body.error ?? res.status}`);
          console.log(body.removed ? "🎫 Team ticket config removed from the server." : "No team ticket config to remove.");
          break;
        }
        const local = tickets.readTicketsConfig(root);
        const provider = (opts.provider ?? (local.provider !== "remote" ? local.provider : undefined)) as string | undefined;
        if (!provider) fail("usage: dim ticket share --provider jira|github|linear|http --url <baseUrl> --token <credential> (defaults come from this repo's `dim ticket connect`)");
        const baseUrl = (opts.url as string | undefined)?.replace(/\/$/, "") ?? local.baseUrl ?? "";
        const credential = (opts.token as string | undefined) ?? tickets.getTicketCredential(baseUrl || "linear") ?? undefined;
        if (!credential && provider !== "http") fail("no credential to share — pass --token (or connect locally first so it can be reused)");
        const res = await fetch(endpoint, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin}` },
          body: JSON.stringify({ provider, baseUrl, credential }),
        });
        const body = (await res.json()) as { ok?: boolean; error?: string };
        if (!res.ok) fail(`server: ${body.error ?? res.status}`);
        console.log(`🎫 Team ticket config stored on ${cloud.server} (brain: ${cloud.brain}, provider: ${provider}).`);
        console.log(`   Teammates: \`dim ticket connect remote\` — zero local ticket credentials, server-side caching.`);
        break;
      }
      // T1.5/T3: manage the branch convention + emit the matching server-side rule
      case "branch-rule": {
        const existing = tickets.readTicketsConfig(root);
        if (opts.pattern || opts.enforce || opts.exempt) {
          const enforce = opts.enforce as BranchEnforce | undefined;
          if (enforce && !["push", "warn", "off"].includes(enforce)) fail(`--enforce must be push, warn, or off (got '${enforce}')`);
          tickets.writeTicketsConfig(root, {
            ...existing,
            branch: {
              ...existing.branch,
              ...(opts.pattern ? { pattern: opts.pattern } : {}),
              ...(enforce ? { enforce } : {}),
              ...(opts.exempt ? { exempt: opts.exempt as string[] } : {}),
            },
          });
          console.log("🌿 Branch convention saved to .aidimag/config.json (commit it — every member's hooks enforce it after `dim init`).");
        }
        const rules = tickets.readTicketsConfig(root).branch ?? {};
        if (!rules.pattern) {
          console.log("No branch convention configured. Set one with:\n  dim ticket branch-rule --pattern '^(feature|bugfix|hotfix|chore)/[A-Z][A-Z0-9]+-\\d+(-[a-z0-9-]+)?$' --enforce push");
          break;
        }
        if (!opts.print) {
          console.log(`pattern: ${rules.pattern}\nenforce: ${rules.enforce ?? "off"}\nexempt:  ${(rules.exempt ?? ["main", "master", "develop", "release/.*", "HEAD"]).join(", ")}`);
          console.log(`\nCatch --no-verify bypassers with a server-side rule: dim ticket branch-rule --print github|gitlab|bitbucket`);
          break;
        }
        const host = String(opts.print).toLowerCase();
        const exempt = rules.exempt ?? ["main", "master", "develop", "release/.*"];
        if (host === "github") {
          console.log(`GitHub ruleset (Settings → Rules → Rulesets → New branch ruleset → import JSON),\nor: gh api repos/{owner}/{repo}/rulesets --input ruleset.json\n`);
          console.log(JSON.stringify({
            name: "aidimag branch convention",
            target: "branch",
            enforcement: rules.enforce === "push" ? "active" : "evaluate",
            conditions: { ref_name: { include: ["~ALL"], exclude: exempt.map((e) => `refs/heads/${e}`) } },
            rules: [{ type: "branch_name_pattern", parameters: { operator: "regex", pattern: rules.pattern, negate: false, name: "ticket-prefixed branches" } }],
          }, null, 2));
        } else if (host === "gitlab") {
          console.log(`GitLab push rules (Settings → Repository → Push rules → Branch name), or via API:\n`);
          console.log(`  curl --request PUT --header "PRIVATE-TOKEN: <token>" \\\n    "https://gitlab.example.com/api/v4/projects/<id>/push_rule" \\\n    --data-urlencode "branch_name_regex=${rules.pattern}"`);
          console.log(`\nNote: exempt branches (${exempt.join(", ")}) should be protected branches — push rules don't apply to them.`);
        } else if (host === "bitbucket") {
          console.log(`Bitbucket branch restrictions (Repository settings → Branch restrictions), or via API:\n`);
          console.log(JSON.stringify({ kind: "branch-name-pattern", pattern: rules.pattern, note: "Requires Premium; exempt: " + exempt.join(", ") }, null, 2));
        } else {
          fail(`unknown host '${opts.print}' — use github, gitlab, or bitbucket`);
        }
        break;
      }
      default:
        fail(`unknown action '${action}'. Use: connect | status | disconnect | show | share | branch-rule`);
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
  .command("generate-context")
  .description("Render trustworthy memory into a static context file (CLAUDE.md, .cursorrules, copilot-instructions) for non-MCP AI tools")
  .option("-f, --format <format>", "claude | cursorrules | copilot | all", "claude")
  .option("--auto", "Also persist generateContext.auto in .aidimag/config.json so verify/review/sync keep it fresh")
  .option("--no-auto", "Disable auto-regeneration (clears generateContext.auto)")
  .action(async (opts) => {
    const root = findRepoRoot() ?? fail("not inside a repo");
    const store = MemoryStore.open(root);
    const { generateContext } = await import("../context/generate.js");
    const format = String(opts.format).toLowerCase();
    if (!["claude", "cursorrules", "copilot", "all"].includes(format)) {
      fail(`invalid --format '${opts.format}'. Use: claude | cursorrules | copilot | all`);
    }
    const r = generateContext(store, root, format as never);
    console.log(`📝 Wrote ${r.files.join(", ")} — ${r.total} memories (${r.pinned} pinned).`);
    if (r.total === 0) {
      console.log("   (no verified memories yet — run `dim remember` or approve proposals with `dim review`)");
    }
    // commander sets opts.auto=false only when --no-auto is passed; undefined otherwise
    if (opts.auto === true || opts.auto === false) {
      const { writeConfig } = await import("../config.js");
      writeConfig(root, { generateContext: opts.auto ? { auto: true, format: format as never } : { auto: false } });
      console.log(
        opts.auto
          ? `🔄 Auto-regeneration ON — verify/review/sync will refresh ${format === "all" ? "the context files" : r.files[0]}.`
          : `Auto-regeneration OFF.`
      );
    }
    store.close();
  });

program
  .command("check")
  .description("Pre-commit contradiction check: scan the staged diff against active memories and guardrails")
  .option("-r, --ref <ref>", "Diff against a ref instead of the staged index (e.g. HEAD~1)")
  .option("--block", "Exit 1 when a hard violation is found (default: warn only)")
  .option("--pre-commit", "Run in hook mode: behavior follows preCommitCheck in .aidimag/config.json (no-op if unset)", false)
  .action(async (opts) => {
    const root = findRepoRoot() ?? fail("not inside a git repo");
    let block = Boolean(opts.block);
    if (opts.preCommit) {
      const { readConfig } = await import("../config.js");
      const mode = readConfig(root).preCommitCheck;
      if (!mode) return; // hook installed but feature disabled — silent no-op
      block = mode === "block";
    }
    const store = MemoryStore.open(root);
    const { checkDiff } = await import("../verify/check.js");
    const report = checkDiff(store, root, { ref: opts.ref });
    store.close();
    if (report.changedFiles.length === 0) {
      if (!opts.preCommit) console.log("dim check: no changes to check.");
      return;
    }
    const fails = report.violations.filter((v) => v.severity === "fail");
    const warns = report.violations.filter((v) => v.severity === "warn");
    if (report.violations.length === 0) {
      if (!opts.preCommit) {
        console.log(`✓ dim check: ${report.checked} memorie(s) considered across ${report.changedFiles.length} file(s) — no conflicts.`);
      }
      return;
    }
    for (const v of fails) {
      console.error(`✗ [${v.memory.kind}] ${v.detail}\n    "${v.memory.claim}"`);
    }
    for (const v of warns) {
      console.error(`~ [${v.memory.kind}] ${v.detail}\n    "${v.memory.claim}"`);
    }
    if (fails.length && block) {
      console.error(`\ndim check: ${fails.length} blocking violation(s). Resolve them or commit with --no-verify.`);
      process.exit(1);
    }
  });

program
  .command("brief")
  .description("Print a session-start briefing: in-scope memory, guardrails, stale warnings, and questions to ask")
  .action(async () => {
    const root = findRepoRoot() ?? fail("not inside a git repo");
    const store = MemoryStore.open(root);
    const { buildSessionBriefing, renderBriefing } = await import("../capture/session-briefing.js");
    const briefing = buildSessionBriefing(store, root);
    process.stdout.write(renderBriefing(briefing));
    store.close();
  });

const knowledge = program
  .command("knowledge")
  .description("Manage the knowledge inbox: summarize dropped docs into reviewed, pinned memories")
  .action(() => knowledge.help());

knowledge
  .command("sync", { isDefault: true })
  .description("Process the knowledge inbox now: summarize new docs into proposals (review with `dim review`)")
  .action(async () => {
    const root = findRepoRoot() ?? fail("not inside a repo");
    const store = MemoryStore.open(root);
    const { ingestAll } = await import("../knowledge/ingest.js");
    const report = await ingestAll(store, root, resolveKnowledgeConfig(root));
    printIngestReport(report);
    // Auto-approved knowledge (requireReview=false) becomes pinned memory → keep context fresh.
    if (report.processed.some((d) => d.pinned)) {
      await autoSync(store);
      await maybeRegenerateContext(store);
    }
    store.close();
  });

knowledge
  .command("status")
  .description("Show pending / skipped / processed counts for the knowledge inbox")
  .action(async () => {
    const root = findRepoRoot() ?? fail("not inside a repo");
    const { knowledgeStatus } = await import("../knowledge/ingest.js");
    const s = await knowledgeStatus(root, resolveKnowledgeConfig(root));
    console.log(`Knowledge inbox: ${s.folder}/`);
    console.log(`  pending      ${s.pending.length}${s.pending.length ? "  → run `dim knowledge sync`" : ""}`);
    for (const p of s.pending) console.log(`    • ${p.file} (${p.bytes} bytes)`);
    console.log(`  unsupported  ${s.unsupported.length}${s.unsupported.length ? "  (will move to skipped/ on next sync)" : ""}`);
    for (const u of s.unsupported) console.log(`    • ${u.file} — ${u.reason}`);
    console.log(`  skipped/     ${s.skippedOnDisk.length}`);
    for (const f of s.skippedOnDisk) console.log(`    • ${f}`);
    console.log(`  processed    ${s.processed.length}`);
  });

knowledge
  .command("list")
  .description("List processed knowledge docs and the memories they produced")
  .action(async () => {
    const root = findRepoRoot() ?? fail("not inside a repo");
    const { readManifest } = await import("../knowledge/ingest.js");
    const docs = readManifest(root).docs;
    if (!docs.length) {
      console.log("No knowledge docs processed yet. Drop files in the inbox and run `dim knowledge sync`.");
      return;
    }
    for (const d of docs) {
      const memo = d.memoryIds.length ? `${d.memoryIds.length} pinned` : `${d.proposalIds.length} proposed`;
      console.log(`📄 ${d.file}  ·  ${d.claimCount} claim(s) (${memo})  ·  via ${d.via}  ·  ${d.date.slice(0, 10)}`);
    }
  });

knowledge
  .command("watch")
  .description("Foreground watcher: process the inbox automatically whenever a doc is dropped (Ctrl-C to stop)")
  .option("-d, --debounce <ms>", "Settle time before processing a batch of drops", "750")
  .action(async (opts) => {
    const root = findRepoRoot() ?? fail("not inside a repo");
    const cfg = resolveKnowledgeConfig(root);
    const inbox = path.join(root, cfg.folder);
    mkdirSync(inbox, { recursive: true });
    const { ingestAll } = await import("../knowledge/ingest.js");
    const debounceMs = Math.max(100, parseInt(opts.debounce, 10) || 750);

    let running = false;
    let queued = false;
    const run = async (): Promise<void> => {
      if (running) { queued = true; return; }
      running = true;
      try {
        const store = MemoryStore.open(root);
        const report = await ingestAll(store, root, cfg);
        if (report.processed.length || report.skipped.length || report.duplicates.length) {
          printIngestReport(report);
          if (report.processed.some((d) => d.pinned)) { await autoSync(store); await maybeRegenerateContext(store); }
        }
        store.close();
      } catch (err) {
        console.error(`dim knowledge watch: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        running = false;
        if (queued) { queued = false; void run(); }
      }
    };

    let timer: NodeJS.Timeout | undefined;
    const { watch } = await import("node:fs");
    const watcher = watch(inbox, { persistent: true }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void run(), debounceMs);
    });
    console.log(`👀 Watching ${cfg.folder}/ for dropped docs — Ctrl-C to stop.`);
    await run(); // catch up on anything already sitting in the inbox
    process.on("SIGINT", () => { watcher.close(); console.log("\nStopped."); process.exit(0); });
    await new Promise(() => { /* run until SIGINT */ });
  });

program
  .command("mcp")
  .description("Run the aidimag MCP server (stdio)")
  .action(async () => {
    await import("../mcp/server.js");
  });

program.parseAsync().catch((err) => fail(err instanceof Error ? err.message : String(err)));

