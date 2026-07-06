/**
 * Verification & guardrail commands: verify, check, brief.
 */

import type { Command } from "commander";
import { MemoryStore, findRepoRoot } from "../../db/store.js";
import { verifyAll } from "../../verify/engine.js";
import { fail, autoSync, maybeRegenerateContext, createPrompter } from "../shared.js";

export function registerVerifyCommands(program: Command): void {
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
    .command("check")
    .description("Pre-commit contradiction check: scan the staged diff against active memories and guardrails")
    .option("-r, --ref <ref>", "Diff against a ref instead of the staged index (e.g. HEAD~1)")
    .option("--block", "Exit 1 when a hard violation is found (default: warn only)")
    .option("--pre-commit", "Run in hook mode: behavior follows preCommitCheck in .aidimag/config.json (no-op if unset)", false)
    .action(async (opts) => {
      const root = findRepoRoot() ?? fail("not inside a git repo");
      let block = Boolean(opts.block);
      if (opts.preCommit) {
        const { readConfig } = await import("../../config.js");
        const mode = readConfig(root).preCommitCheck;
        if (!mode) return; // hook installed but feature disabled — silent no-op
        block = mode === "block";
      }
      const store = MemoryStore.open(root);
      const { checkDiff } = await import("../../verify/check.js");
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
      const { buildSessionBriefing, renderBriefing } = await import("../../capture/session-briefing.js");
      const briefing = buildSessionBriefing(store, root);
      process.stdout.write(renderBriefing(briefing));
      store.close();
    });
}

