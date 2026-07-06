/**
 * Capture & review commands: mine (commits/PRs), bootstrap, harvest, review.
 */

import type { Command } from "commander";
import { existsSync } from "node:fs";
import path from "node:path";
import { MemoryStore, findRepoRoot } from "../../db/store.js";
import { mineCommits } from "../../capture/commit-miner.js";
import { fail, autoSync, maybeRegenerateContext, printProposal, createPrompter } from "../shared.js";

/**
 * Conversational review: walk the queue one proposal at a time —
 * keep / reword / drop / skip. The human gate, made friendly.
 */
async function interactiveReview(store: MemoryStore): Promise<{ kept: number; rejected: number }> {
  const { triagePending } = await import("../../capture/triage.js");
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
  const { ticketProviderFor } = await import("../../tickets/provider.js");
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

export function registerCaptureCommands(program: Command): void {
  program
    .command("mine")
    .description("Mine git history for memory candidates (queued for review, never auto-saved)")
    .option("-n, --max <n>", "Max commits to scan", "500")
    .option("--full", "Rescan from the beginning of history (ignore cursor)")
    .option("--llm", "Deep mining: LLM reads each commit's message AND diff, synthesizes claims + suggested checks (needs Ollama/OPENAI_API_KEY; slower, much higher quality)")
    .option("--prs", "Mine merged GitHub PRs + review comments instead of commits (needs the `gh` CLI and an LLM provider; review threads carry the unwritten rules)")
    .option("-q, --quiet", "Only speak up when candidates are found (for the post-commit hook)")
    .action(async (opts) => {
      const root = findRepoRoot() ?? fail("not inside a git repo");
      if (!existsSync(path.join(root, ".git"))) fail("commit mining requires a git repo");
      const store = MemoryStore.open(root, { create: true });

      if (opts.prs) {
        const { minePrs, ghAvailable } = await import("../../capture/pr-miner.js");
        if (!ghAvailable(root)) {
          store.close();
          fail("PR mining needs the GitHub CLI — install `gh` and run `gh auth login`");
        }
        const r = await minePrs(store, root, { max: opts.max ? parseInt(opts.max, 10) : undefined, all: Boolean(opts.full) });
        if (!r.provider) {
          store.close();
          fail("no LLM provider available — review threads need synthesis; run Ollama or set OPENAI_API_KEY (see AIDIMAG_LLM)");
        }
        console.log(
          `Scanned ${r.scanned} merged PR(s) with ${r.provider}: ${r.proposed.length} proposal(s) queued` +
            (r.skippedDuplicates ? `, ${r.skippedDuplicates} duplicate(s) skipped` : "")
        );
        for (const p of r.proposed) printProposal(p);
        if (r.proposed.length) console.log(`\nReview with \`dim review\`.`);
        else if (r.scanned === 0) console.log("No newly merged PRs since the last run (use --full to rescan).");
        store.close();
        return;
      }

      let res;
      let llmProvider: string | null = null;
      if (opts.llm) {
        const { mineCommitsLlm } = await import("../../capture/commit-miner.js");
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
      const { bootstrapRepo } = await import("../../capture/bootstrap.js");
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
        "../../capture/harvest.js"
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
          const { triagePending } = await import("../../capture/triage.js");
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
            const { triagePending } = await import("../../capture/triage.js");
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
}

