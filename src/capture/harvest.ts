/**
 * Transcript harvester — out-of-band capture of the context humans type into
 * AI chats. Claude Code persists every session as JSONL under
 * ~/.claude/projects/<path-slug>/*.jsonl; the USER messages in there are the
 * highest-signal capture source aidimag has: they're the facts a human already
 * decided were worth teaching an AI ("we use X because Y", "never touch Z").
 *
 * `dim harvest` extracts durable, falsifiable claims from those messages with
 * the configured LLM provider (OpenAI/Ollama, same fallback as knowledge
 * ingestion) and queues them as proposals (source `harvest:claude-code`) —
 * nothing becomes active memory without `dim review`.
 *
 * Privacy: opt-in by invocation, local-only (transcripts never leave the
 * machine except to the LLM provider you configured), and secret-looking lines
 * are redacted before extraction. `--install-hook` wires a Claude Code
 * SessionEnd hook so harvesting runs automatically when a session closes.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { MemoryStore } from "../db/store.js";
import { getTextProvider } from "../knowledge/llm.js";
import { parseClaims, type ExtractedClaim } from "../knowledge/extract.js";
import { debugLog } from "../debug.js";

const CURSOR_META_KEY = "harvest_claude_last_mtime";
/** Ignore short/noisy user turns ("yes", "continue", slash commands…). */
const MIN_MESSAGE_CHARS = 40;
/** Cap what we send to the LLM per session (chars). */
const MAX_SESSION_CHARS = 24_000;

export interface HarvestResult {
  sessionsScanned: number;
  messagesConsidered: number;
  proposed: number;
  duplicates: number;
  provider: string | null;
  transcriptDir: string | null;
}

/** Claude Code stores transcripts under a slug of the project's absolute path. */
export function claudeProjectDir(repoRoot: string): string | null {
  const slug = path.resolve(repoRoot).replace(/[^a-zA-Z0-9]/g, "-");
  const dir = path.join(homedir(), ".claude", "projects", slug);
  return existsSync(dir) ? dir : null;
}

/** Very conservative redaction: drop lines that look like secrets before they reach any LLM. */
export function redactSecrets(text: string): string {
  const SECRET_LINE =
    /(api[-_]?key|secret|token|password|passwd|authorization|bearer\s+[a-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY|aws_access_key_id|sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{20,}|xox[baprs]-)/i;
  return text
    .split("\n")
    .map((line) => (SECRET_LINE.test(line) ? "[REDACTED — possible secret]" : line))
    .join("\n");
}

/** Extract genuine human-typed messages from one Claude Code session JSONL. */
export function userMessagesFromTranscript(jsonl: string): string[] {
  const out: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type !== "user" || entry.isMeta) continue;
    const message = entry.message as { role?: string; content?: unknown } | undefined;
    if (!message || message.role !== "user") continue;

    let text = "";
    if (typeof message.content === "string") {
      text = message.content;
    } else if (Array.isArray(message.content)) {
      // tool_result blocks are machine output, not the human — skip them
      text = (message.content as Array<{ type?: string; text?: string }>)
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("\n");
    }
    text = text.trim();
    // skip injected command/system scaffolding and trivial turns
    if (!text || text.startsWith("<") || text.startsWith("/")) continue;
    if (text.length < MIN_MESSAGE_CHARS) continue;
    out.push(text);
  }
  return out;
}

export const HARVEST_EXTRACT_INSTRUCTIONS = `You are reviewing messages a DEVELOPER typed into an AI coding assistant while working on their project. These messages often contain durable project knowledge the developer was teaching the AI: decisions, conventions, gotchas, failed approaches, architecture facts, rules.

Extract that durable knowledge as FALSIFIABLE claims. Rules:

1. Only durable, project-specific facts the HUMAN stated — not the task of the day, not questions, not generic programming advice.
2. Write each claim as a checkable statement about the codebase.
3. kinds: DECISION, CONVENTION, GOTCHA, FAILED_APPROACH, ARCHITECTURE, INVARIANT, GUARDRAIL (set guardrail_level: never|ask-first|always), SKILL, TODO_CONTEXT.
4. Scope with paths/symbols when the messages name them; else leave empty.
5. In "rationale", QUOTE the fragment of the developer's message the claim came from.
6. Extract 0–8 claims. Zero is fine — most sessions contain none. Do NOT invent.

Respond with ONLY a JSON object of this exact shape:
{"claims":[{"kind":"CONVENTION","claim":"...","paths":["src/x"],"symbols":[],"guardrail_level":null,"rationale":"user said: \\"...\\""}]}`;

interface SessionFile {
  file: string;
  abs: string;
  mtimeMs: number;
}

function pendingSessions(dir: string, sinceMtimeMs: number, all: boolean): SessionFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const abs = path.join(dir, f);
      return { file: f, abs, mtimeMs: statSync(abs).mtimeMs };
    })
    .filter((s) => all || s.mtimeMs > sinceMtimeMs)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/**
 * Harvest new/updated Claude Code sessions for this repo into the proposal
 * queue. Cursor-tracked by file mtime; `all` rescans everything (the proposal
 * dedupe index absorbs repeats).
 */
export async function harvestClaudeSessions(
  store: MemoryStore,
  repoRoot: string,
  opts: { all?: boolean } = {}
): Promise<HarvestResult> {
  const result: HarvestResult = {
    sessionsScanned: 0,
    messagesConsidered: 0,
    proposed: 0,
    duplicates: 0,
    provider: null,
    transcriptDir: null,
  };
  const dir = claudeProjectDir(repoRoot);
  if (!dir) return result;
  result.transcriptDir = dir;

  const provider = await getTextProvider();
  if (!provider) return result;
  result.provider = `${provider.name}/${provider.model}`;

  const cursor = opts.all ? 0 : parseFloat(store.getMeta(CURSOR_META_KEY) ?? "0") || 0;
  const sessions = pendingSessions(dir, cursor, Boolean(opts.all));
  let maxMtime = cursor;

  for (const s of sessions) {
    result.sessionsScanned++;
    maxMtime = Math.max(maxMtime, s.mtimeMs);
    let messages: string[];
    try {
      messages = userMessagesFromTranscript(readFileSync(s.abs, "utf8"));
    } catch (err) {
      debugLog(`harvest transcript ${s.file} (skipped)`, err);
      continue; // unreadable/partial file — retry next run (cursor still advances past it)
    }
    if (!messages.length) continue;
    result.messagesConsidered += messages.length;

    const corpus = redactSecrets(messages.join("\n\n---\n\n")).slice(0, MAX_SESSION_CHARS);
    let claims: ExtractedClaim[];
    try {
      const raw = await provider.generate(
        HARVEST_EXTRACT_INSTRUCTIONS,
        `Developer messages from one coding session on this project:\n\n----- BEGIN MESSAGES -----\n${corpus}\n----- END MESSAGES -----`
      );
      claims = parseClaims(raw);
    } catch (err) {
      debugLog(`harvest llm extraction ${s.file} (skipped)`, err);
      continue; // provider hiccup — this session retries on the next --all run
    }

    const sessionId = s.file.replace(/\.jsonl$/, "");
    for (const c of claims) {
      const p = store.propose({
        kind: c.kind,
        claim: c.claim,
        paths: c.paths,
        symbols: c.symbols,
        guardrailLevel: c.guardrailLevel,
        rationale: c.rationale ?? "Stated by the user in a Claude Code session.",
        evidence: [
          { type: "HUMAN_ATTESTED", payload: `stated by user in Claude Code session ${sessionId.slice(0, 8)}` },
        ],
        source: "harvest:claude-code",
        sourceRef: sessionId,
      });
      if (p) result.proposed++;
      else result.duplicates++;
    }
  }

  if (maxMtime > cursor) store.setMeta(CURSOR_META_KEY, String(maxMtime));
  return result;
}

// ---------------------------------------------------------------- hook install

const HOOK_COMMAND = "dim harvest -q";

/**
 * Wire `dim harvest -q` into the repo's Claude Code SessionEnd hook
 * (.claude/settings.json) so every session is harvested when it closes.
 * Additive: merges with existing settings, never clobbers other hooks.
 */
export function installClaudeSessionEndHook(repoRoot: string): { installed: boolean; settingsPath: string } {
  const settingsPath = path.join(repoRoot, ".claude", "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    } catch {
      throw new Error(`${settingsPath} exists but is not valid JSON — fix it before installing the hook.`);
    }
  }
  const hooks = (settings.hooks ??= {}) as Record<string, unknown>;
  const sessionEnd = (hooks.SessionEnd ??= []) as Array<{ hooks?: Array<{ type?: string; command?: string }> }>;
  const already = sessionEnd.some((m) => m.hooks?.some((h) => h.command?.includes("dim harvest")));
  if (already) return { installed: false, settingsPath };

  sessionEnd.push({ hooks: [{ type: "command", command: HOOK_COMMAND }] });
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return { installed: true, settingsPath };
}


