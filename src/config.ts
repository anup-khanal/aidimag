/**
 * Generic reader/writer for the committed, secret-free repo config at
 * <repo>/.aidimag/config.json. Ticket + sync sections have their own typed
 * helpers; this covers the rest (generateContext, preCommitCheck, ...).
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { GuardrailLevel } from "./types.js";

export type ContextFormat = "claude" | "cursorrules" | "copilot" | "windsurfrules" | "agents" | "all";

export interface GenerateContextConfig {
  /** which file(s) to write — defaults to "claude" */
  format?: ContextFormat;
  /** regenerate automatically after verify/sync/review */
  auto?: boolean;
}

/** "block" → exit 1 on violations; true → warn (exit 0); falsy → hook is a no-op. */
export type PreCommitCheckConfig = boolean | "warn" | "block";

/** Who summarizes dropped knowledge docs: auto (agent→llm), agent-only, llm-only, or off. */
export type KnowledgeSummarizer = "auto" | "agent" | "llm" | "off";

export interface KnowledgeConfig {
  /** inbox folder (repo-relative) where docs are dropped — default "knowledge" */
  folder?: string;
  /** summarizer strategy — default "auto" */
  summarizer?: KnowledgeSummarizer;
  /** require `dim review` approval before pinning — default true */
  requireReview?: boolean;
  /** keep a backup of the original in .aidimag/knowledge/processed/ — default true */
  backup?: boolean;
  /** text extensions we will summarize — default DEFAULT_KNOWLEDGE_EXTENSIONS */
  extensions?: string[];
  /** hard cap; larger files are skipped — default 1 MiB */
  maxBytes?: number;
  /** soft threshold; larger text docs are chunked — default 16 KiB */
  chunkBytes?: number;
}

export interface AidimagConfig {
  generateContext?: GenerateContextConfig;
  preCommitCheck?: PreCommitCheckConfig;
  knowledge?: KnowledgeConfig;
  [k: string]: unknown;
}

export const DEFAULT_KNOWLEDGE_EXTENSIONS = [
  ".md", ".markdown", ".txt", ".rst", ".adoc", ".org",
  ".json", ".yaml", ".yml", ".toml", ".csv", ".html",
  ".pdf", ".docx", // binary docs — text is extracted before summarization
];

export interface ResolvedKnowledgeConfig {
  folder: string;
  summarizer: KnowledgeSummarizer;
  requireReview: boolean;
  backup: boolean;
  extensions: string[];
  maxBytes: number;
  chunkBytes: number;
}

/** Reject repo-relative knowledge inbox paths that escape or touch sensitive dirs. */
function safeKnowledgeFolder(folder: string): string {
  const normalized = folder.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!normalized || normalized.includes("..") || normalized.startsWith(".aidimag")) return "knowledge";
  return normalized;
}

/** Knowledge config with every field filled in from defaults. */
export function resolveKnowledgeConfig(repoRoot: string): ResolvedKnowledgeConfig {
  const k = readConfig(repoRoot).knowledge ?? {};
  return {
    folder: safeKnowledgeFolder(k.folder ?? "knowledge"),
    summarizer: k.summarizer ?? "auto",
    requireReview: k.requireReview ?? true,
    backup: k.backup ?? true,
    extensions: (k.extensions ?? DEFAULT_KNOWLEDGE_EXTENSIONS).map((e) =>
      e.startsWith(".") ? e.toLowerCase() : "." + e.toLowerCase()
    ),
    maxBytes: k.maxBytes ?? 1024 * 1024,
    chunkBytes: k.chunkBytes ?? 16 * 1024,
  };
}

function configPath(repoRoot: string): string {
  return path.join(repoRoot, ".aidimag", "config.json");
}

export function readConfig(repoRoot: string): AidimagConfig {
  try {
    return JSON.parse(readFileSync(configPath(repoRoot), "utf8")) as AidimagConfig;
  } catch {
    return {};
  }
}

/** Shallow-merge a patch into config.json, never clobbering sibling sections. */
export function writeConfig(repoRoot: string, patch: Partial<AidimagConfig>): void {
  const p = configPath(repoRoot);
  mkdirSync(path.dirname(p), { recursive: true });
  const existing = readConfig(repoRoot);
  writeFileSync(p, JSON.stringify({ ...existing, ...patch }, null, 2) + "\n");
}

export type { GuardrailLevel };

