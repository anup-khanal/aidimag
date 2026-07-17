/**
 * Knowledge-inbox commands: knowledge sync | status | list | watch.
 */

import type { Command } from "commander";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { MemoryStore, findRepoRoot } from "../../db/store.js";
import { resolveKnowledgeConfig } from "../../config.js";
import { fail, autoSync, maybeRegenerateContext, printIngestReport } from "../shared.js";

export function registerKnowledgeCommands(program: Command): void {
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
      const { ingestAll } = await import("../../knowledge/ingest.js");
      const cfg = resolveKnowledgeConfig(root);
      
      const report = await ingestAll(store, root, cfg);
      printIngestReport(report);
      // Auto-approved knowledge (requireReview=false) becomes active memory → keep context fresh.
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
      const { knowledgeStatus } = await import("../../knowledge/ingest.js");
      const s = await knowledgeStatus(root, resolveKnowledgeConfig(root));
      console.log(`Knowledge inbox: ${s.folder}/`);
      console.log(`  pending      ${s.pending.length}${s.pending.length ? "  → run \`dim knowledge sync\`" : ""}`);
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
      const { readManifest } = await import("../../knowledge/ingest.js");
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
      const { ingestAll } = await import("../../knowledge/ingest.js");
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
}

