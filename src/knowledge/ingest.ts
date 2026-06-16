/**
 * Knowledge ingestion pipeline (KNOWLEDGEBASE_DESIGN.md).
 *
 * Drop docs into the `knowledge/` inbox → they're classified, (chunked and)
 * summarized into typed claims → queued as proposals (source `knowledge:<doc>`,
 * pin-on-approve) → a plain-text summary is written and the original is backed up
 * to .aidimag/knowledge/processed/ before the inbox copy is removed.
 *
 * Trust gate: claims become PINNED memories only after `dim review` (unless the
 * repo opts out with knowledge.requireReview = false). Nothing is ever deleted —
 * unsupported files move to .aidimag/knowledge/skipped/ with a reason.
 */

import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
  statSync, renameSync, copyFileSync,
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { MemoryStore } from "../db/store.js";
import type { ResolvedKnowledgeConfig } from "../config.js";
import type { ExtractedClaim } from "./extract.js";
import { KNOWLEDGE_EXTRACT_INSTRUCTIONS, buildExtractionUser, parseClaims, dedupeClaims } from "./extract.js";
import { chunkText } from "./chunk.js";
import { getTextProvider, type TextProvider } from "./llm.js";

const KB_DIR = path.join(".aidimag", "knowledge");

export interface PendingDoc {
  file: string;       // basename in the inbox
  abs: string;        // absolute path
  content: string;
  hash: string;       // sha256 of content
  bytes: number;
}
export interface SkipCandidate {
  file: string;
  reason: string;
}
export interface DocResult {
  file: string;
  hash: string;
  claimCount: number;
  proposalIds: string[];
  memoryIds: string[];   // populated when auto-approved (requireReview = false)
  pinned: boolean;       // true when auto-approved
}
export interface IngestReport {
  processed: DocResult[];
  pendingNoSummarizer: string[];   // supported, but no agent/provider — left in inbox
  duplicates: string[];            // identical content already ingested — backed up, not re-proposed
  skipped: SkipCandidate[];        // moved to skipped/ this run
  summarizer: string | null;       // provider name used, or null
}

// ── paths ───────────────────────────────────────────────────────────────────
function inboxDir(root: string, cfg: ResolvedKnowledgeConfig): string {
  return path.join(root, cfg.folder);
}
function kbDir(root: string): string { return path.join(root, KB_DIR); }
function processedDir(root: string): string { return path.join(kbDir(root), "processed"); }
function skippedDir(root: string): string { return path.join(kbDir(root), "skipped"); }
function manifestPath(root: string): string { return path.join(kbDir(root), "manifest.json"); }
function summaryPath(root: string, file: string): string {
  return path.join(kbDir(root), `${file}.summary.md`);
}

// ── manifest ──────────────────────────────────────────────────────────────────
interface ManifestEntry {
  file: string;
  hash: string;
  date: string;
  via: string;
  claimCount: number;
  proposalIds: string[];
  memoryIds: string[];
}
interface Manifest { version: number; docs: ManifestEntry[] }

export function readManifest(root: string): Manifest {
  try {
    return JSON.parse(readFileSync(manifestPath(root), "utf8")) as Manifest;
  } catch {
    return { version: 1, docs: [] };
  }
}
function appendManifest(root: string, entry: ManifestEntry): void {
  const m = readManifest(root);
  m.docs.push(entry);
  mkdirSync(kbDir(root), { recursive: true });
  writeFileSync(manifestPath(root), JSON.stringify(m, null, 2) + "\n");
}

// ── classification (read-only; no side effects) ───────────────────────────────
function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true; // NUL byte → binary
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, n));
    return false;
  } catch {
    return true; // not valid UTF-8
  }
}

export function classifyInbox(
  root: string,
  cfg: ResolvedKnowledgeConfig
): { pending: PendingDoc[]; toSkip: SkipCandidate[] } {
  const dir = inboxDir(root, cfg);
  const pending: PendingDoc[] = [];
  const toSkip: SkipCandidate[] = [];
  if (!existsSync(dir)) return { pending, toSkip };

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name.startsWith(".")) continue; // .gitkeep and other dotfiles
    const abs = path.join(dir, entry.name);
    const ext = path.extname(entry.name).toLowerCase();
    if (!cfg.extensions.includes(ext)) {
      toSkip.push({ file: entry.name, reason: `unsupported type (${ext || "no extension"})` });
      continue;
    }
    const size = statSync(abs).size;
    if (size > cfg.maxBytes) {
      toSkip.push({ file: entry.name, reason: `exceeds maxBytes (${size} > ${cfg.maxBytes})` });
      continue;
    }
    const buf = readFileSync(abs);
    if (isBinary(buf)) {
      toSkip.push({ file: entry.name, reason: "not text-decodable (looks binary)" });
      continue;
    }
    const content = buf.toString("utf8");
    if (!content.trim()) {
      toSkip.push({ file: entry.name, reason: "no content" });
      continue;
    }
    pending.push({
      file: entry.name,
      abs,
      content,
      bytes: size,
      hash: createHash("sha256").update(content).digest("hex"),
    });
  }
  return { pending, toSkip };
}

function moveToSkipped(root: string, cfg: ResolvedKnowledgeConfig, file: string, reason: string): void {
  const dest = skippedDir(root);
  mkdirSync(dest, { recursive: true });
  const src = path.join(inboxDir(root, cfg), file);
  try {
    renameSync(src, path.join(dest, file));
  } catch {
    // cross-device or already gone — best-effort copy
    try { copyFileSync(src, path.join(dest, file)); } catch { /* ignore */ }
  }
  writeFileSync(
    path.join(dest, `${file}.reason.txt`),
    `${reason}\nskipped: ${new Date().toISOString()}\n`
  );
}

// ── summarization (LLM path) ──────────────────────────────────────────────────
async function summarizeWithLlm(
  provider: TextProvider,
  doc: PendingDoc,
  cfg: ResolvedKnowledgeConfig
): Promise<ExtractedClaim[]> {
  const chunks = chunkText(doc.content, cfg.chunkBytes);
  const all: ExtractedClaim[] = [];
  for (const chunk of chunks) {
    const raw = await provider.generate(KNOWLEDGE_EXTRACT_INSTRUCTIONS, buildExtractionUser(doc.file, chunk));
    all.push(...parseClaims(raw));
  }
  return dedupeClaims(all);
}

// ── finalize one doc: proposals → summary → backup → remove inbox copy ─────────
/**
 * Turn extracted claims into proposals and retire the inbox file safely.
 * Used by both the LLM path and the MCP agent path (which supplies its own claims).
 */
export function finalizeDoc(
  store: MemoryStore,
  root: string,
  cfg: ResolvedKnowledgeConfig,
  doc: { file: string; hash: string; abs?: string },
  claims: ExtractedClaim[],
  via: string
): DocResult {
  const source = `knowledge:${doc.file}`;
  const sourceRef = doc.hash.slice(0, 12);
  const proposalIds: string[] = [];
  for (const c of claims) {
    const p = store.propose({
      kind: c.kind,
      claim: c.claim,
      paths: c.paths,
      symbols: c.symbols,
      guardrailLevel: c.guardrailLevel,
      source,
      sourceRef,
      rationale: c.rationale ?? `Extracted from ${doc.file}`,
    });
    if (p) proposalIds.push(p.id);
  }

  // Optional auto-approve (opt-out of the review gate) → pinned memories.
  const memoryIds: string[] = [];
  const pinned = cfg.requireReview === false;
  if (pinned) {
    for (const id of proposalIds) {
      try { memoryIds.push(store.approveProposal(id).id); } catch { /* ignore */ }
    }
  }

  // Durable record + backup BEFORE removing the inbox copy (no data loss).
  mkdirSync(kbDir(root), { recursive: true });
  writeFileSync(summaryPath(root, doc.file), renderSummary(doc.file, doc.hash, via, claims, pinned));
  if (cfg.backup) {
    mkdirSync(processedDir(root), { recursive: true });
    const src = doc.abs ?? path.join(inboxDir(root, cfg), doc.file);
    if (existsSync(src)) copyFileSync(src, path.join(processedDir(root), doc.file));
  }
  // retire the inbox original
  const inboxFile = doc.abs ?? path.join(inboxDir(root, cfg), doc.file);
  try { if (existsSync(inboxFile)) renameSync(inboxFile, path.join(processedDir(root), doc.file)); } catch { /* already backed up */ }

  appendManifest(root, {
    file: doc.file, hash: doc.hash, date: new Date().toISOString(),
    via, claimCount: claims.length, proposalIds, memoryIds,
  });

  return { file: doc.file, hash: doc.hash, claimCount: claims.length, proposalIds, memoryIds, pinned };
}

function renderSummary(file: string, hash: string, via: string, claims: ExtractedClaim[], pinned: boolean): string {
  const lines: string[] = [];
  lines.push(`# Knowledge summary: ${file}`);
  lines.push(`> source: ${file} · sha256: ${hash} · summarized by: ${via} · ${new Date().toISOString()}`);
  lines.push(
    pinned
      ? `> ${claims.length} claim(s) auto-approved as PINNED memories.`
      : `> ${claims.length} claim(s) queued as proposals — review with \`dim review\`.`
  );
  lines.push("");
  if (!claims.length) {
    lines.push("_No durable claims were extracted from this document._");
  }
  for (const c of claims) {
    const lvl = c.kind === "GUARDRAIL" && c.guardrailLevel ? ` (${c.guardrailLevel})` : "";
    lines.push(`- **[${c.kind}${lvl}]** ${c.claim}`);
    const scope = [...(c.paths ?? []), ...(c.symbols ?? [])];
    if (scope.length) lines.push(`  - scope: ${scope.join(", ")}`);
    if (c.rationale) lines.push(`  - why: ${c.rationale}`);
  }
  return lines.join("\n") + "\n";
}

// ── top-level: process the whole inbox (CLI / hook / watcher) ──────────────────
export async function ingestAll(
  store: MemoryStore,
  root: string,
  cfg: ResolvedKnowledgeConfig
): Promise<IngestReport> {
  const { pending, toSkip } = classifyInbox(root, cfg);

  // move unsupported files aside (never deleted)
  for (const s of toSkip) moveToSkipped(root, cfg, s.file, s.reason);

  const report: IngestReport = {
    processed: [], pendingNoSummarizer: [], duplicates: [], skipped: toSkip, summarizer: null,
  };

  // resolve summarizer (LLM path); "agent"/"off" never summarize from the CLI
  let provider: TextProvider | null = null;
  if (cfg.summarizer === "auto" || cfg.summarizer === "llm") {
    provider = await getTextProvider().catch(() => null);
  }
  report.summarizer = provider?.name ?? null;

  const known = new Set(readManifest(root).docs.map((d) => d.hash));

  for (const doc of pending) {
    if (known.has(doc.hash)) {
      // identical content already ingested — just retire the inbox copy
      mkdirSync(processedDir(root), { recursive: true });
      try { renameSync(doc.abs, path.join(processedDir(root), doc.file)); } catch { /* ignore */ }
      report.duplicates.push(doc.file);
      continue;
    }
    if (!provider) {
      report.pendingNoSummarizer.push(doc.file); // leave in inbox for next time
      continue;
    }
    const claims = await summarizeWithLlm(provider, doc, cfg);
    report.processed.push(finalizeDoc(store, root, cfg, doc, claims, `llm:${provider.name}`));
  }
  return report;
}

// ── status (read-only) ────────────────────────────────────────────────────────
export interface KnowledgeStatus {
  folder: string;
  pending: PendingDoc[];
  unsupported: SkipCandidate[];   // present in inbox, will be skipped on next sync
  skippedOnDisk: string[];        // already in skipped/
  processed: ManifestEntry[];
}
export function knowledgeStatus(root: string, cfg: ResolvedKnowledgeConfig): KnowledgeStatus {
  const { pending, toSkip } = classifyInbox(root, cfg);
  const skippedOnDisk = existsSync(skippedDir(root))
    ? readdirSync(skippedDir(root)).filter((f) => !f.endsWith(".reason.txt"))
    : [];
  return {
    folder: cfg.folder,
    pending,
    unsupported: toSkip,
    skippedOnDisk,
    processed: readManifest(root).docs,
  };
}

