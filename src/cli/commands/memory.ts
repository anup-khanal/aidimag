/**
 * Core memory commands: init, remember, recall, reindex, status, log, gaps,
 * refute, pin, unpin, forget.
 */

import type { Command } from "commander";
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { MemoryStore, findRepoRoot, dbPathFor, AIDIMAG_DIR } from "../../db/store.js";
import { installGitHooks } from "../../verify/hooks.js";
import { hybridSearch, indexMemory, reindexAll } from "../../embeddings/search.js";
import { resolveKnowledgeConfig } from "../../config.js";
import { KINDS, GUARDRAIL_LEVELS, fail, autoSync, printMemory } from "../shared.js";
import { debugLog } from "../../debug.js";
import type { EvidenceType, GuardrailLevel, MemoryKind } from "../../types.js";

export function registerMemoryCommands(program: Command): void {
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
      // create .cursorrules for automatic MCP integration
      const cursorrules = path.join(root, ".cursorrules");
      if (!existsSync(cursorrules)) {
        writeFileSync(
          cursorrules,
          `# Project Memory Integration

At the start of EVERY new chat session, you MUST:
1. Read the \`aidimag://session-briefing\` resource to load project memory, conventions, and guardrails
2. Review all GUARDRAILS before making any code changes
3. Search project memory using \`memory_search\` when working on specific features

Before making any changes to code:
- Check if there are relevant memories using \`memory_search\`
- Respect all GUARDRAIL rules (ALWAYS = block, ASK-FIRST = confirm, NEVER = refuse)
- Use \`context_note\` to capture any new conventions or decisions the user mentions

This project uses aiDimag for persistent memory. Always consult memory before proceeding.
`
        );
        console.log(`Created ${cursorrules} (tells Cursor/Claude to auto-load memory)`);
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
        } catch (err) {
          // gap logging is best-effort; never break recall
          debugLog("cli search-gap logging", err);
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
    .command("update")
    .description("Update a memory's claim, kind, or add/remove evidence")
    .argument("<id>", "Memory id (full or 8-char prefix)")
    .option("-c, --claim <text>", "Update the claim text")
    .option("-k, --kind <kind>", `Change memory kind: ${KINDS.join("|")}`)
    .option("-g, --guardrail-level <level>", `For kind=GUARDRAIL: ${GUARDRAIL_LEVELS.join("|")}`)
    .option("-e, --evidence <ev...>", "Add evidence (format: TYPE:payload)")
    .option("--remove-evidence <id>", "Remove evidence by id prefix")
    .action(async (id: string, opts) => {
      const store = MemoryStore.open();
      const match = store.list(1000).find((m) => m.id === id || m.id.startsWith(id));
      if (!match) fail(`no memory matching id '${id}'`);

      const updates: any = {};
      if (opts.claim) updates.claim = opts.claim.trim();
      if (opts.kind) {
        if (!KINDS.includes(opts.kind as any)) fail(`invalid kind '${opts.kind}' — must be one of: ${KINDS.join(", ")}`);
        updates.kind = opts.kind;
      }
      if (opts.guardrailLevel) {
        if (updates.kind !== "GUARDRAIL" && match.kind !== "GUARDRAIL") {
          fail("--guardrail-level only applies to GUARDRAIL memories");
        }
        if (!GUARDRAIL_LEVELS.includes(opts.guardrailLevel as any)) {
          fail(`invalid --guardrail-level '${opts.guardrailLevel}' — must be one of: ${GUARDRAIL_LEVELS.join(", ")}`);
        }
        updates.guardrailLevel = opts.guardrailLevel;
      }

      if (Object.keys(updates).length > 0) {
        store.update(match.id, updates);
        console.log(`✓ Updated memory ${match.id.slice(0, 8)}`);
      }

      // Add evidence
      for (const ev of opts.evidence || []) {
        const [type, ...payloadParts] = ev.split(":");
        const payload = payloadParts.join(":");
        if (!payload) fail(`evidence format: TYPE:payload (e.g. STATIC_CHECK:grep -r "foo" src/)`);
        store.addEvidence(match.id, { type: type as any, payload });
        console.log(`✓ Added evidence: ${type}`);
      }

      // Remove evidence
      if (opts.removeEvidence) {
        const evidence = match.grounding.find((e) => e.id === opts.removeEvidence || e.id.startsWith(opts.removeEvidence));
        if (!evidence) fail(`no evidence matching id '${opts.removeEvidence}'`);
        store.removeEvidence(evidence.id);
        console.log(`✓ Removed evidence ${evidence.id.slice(0, 8)}`);
      }

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
}

