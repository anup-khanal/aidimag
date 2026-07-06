/**
 * Shared CLI helpers — used by every command module in src/cli/commands/.
 *
 * Nothing here registers commands; it's the common vocabulary: fail-fast
 * error exit, printers for memories/proposals/ingest reports, the
 * line-buffering prompter, best-effort auto-sync and context regeneration.
 */

import { MemoryStore, findRepoRoot } from "../db/store.js";
import { debugLog } from "../debug.js";
import type { GuardrailLevel, MemoryEntry, MemoryKind, Proposal } from "../types.js";

export const KINDS: MemoryKind[] = [
  "DECISION", "CONVENTION", "GOTCHA", "FAILED_APPROACH",
  "ARCHITECTURE", "INVARIANT", "TODO_CONTEXT", "GUARDRAIL", "SKILL",
];

export const GUARDRAIL_LEVELS: GuardrailLevel[] = ["never", "always", "ask-first"];
export const GUARDRAIL_ICON: Record<GuardrailLevel, string> = { never: "🚫", always: "✅", "ask-first": "🤚" };

export function fail(msg: string): never {
  console.error(`dim: ${msg}`);
  process.exit(1);
}

/** Debounced best-effort sync after local mutations (no-op unless cloud-linked). */
export async function autoSync(store: MemoryStore): Promise<void> {
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
export async function maybeRegenerateContext(store: MemoryStore): Promise<void> {
  const root = findRepoRoot();
  if (!root) return;
  try {
    const { readConfig } = await import("../config.js");
    const cfg = readConfig(root).generateContext;
    if (!cfg?.auto) return;
    const { generateContext } = await import("../context/generate.js");
    const r = generateContext(store, root, cfg.format ?? "claude");
    console.log(`(regenerated ${r.files.join(", ")} — ${r.total} memories)`);
  } catch (err) {
    // context regen is advisory; failures must not break the command
    debugLog("context regeneration", err);
  }
}

export function printMemory(m: MemoryEntry, verbose = false): void {
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

export function printProposal(p: Proposal): void {
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

/** Human-readable summary of a knowledge-inbox ingest run. */
export function printIngestReport(report: import("../knowledge/ingest.js").IngestReport): void {
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

/**
 * Line-buffering prompt for interactive flows (review, ticket connect).
 * Unlike readline/promises, lines arriving between questions (piped input)
 * are queued, not dropped — so scripted/agent-driven input works too.
 */
export async function createPrompter(
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
export async function openBrowser(url: string): Promise<void> {
  const { exec } = await import("node:child_process");
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${opener} "${url}"`);
}

