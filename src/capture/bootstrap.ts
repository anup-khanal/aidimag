/**
 * `dim bootstrap` — instant brain on day one (kills the cold-start problem).
 *
 * Surveys the repo (README/docs/ADRs, manifests, directory shape, git churn)
 * and LLM-extracts an initial set of falsifiable memory candidates, each with
 * a suggested STATIC_CHECK where one makes sense. Everything lands in the
 * proposal queue (source `bootstrap`) — `dim review` remains the trust gate.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { MemoryStore } from "../db/store.js";
import { getTextProvider } from "../knowledge/llm.js";
import { parseClaims, type ExtractedClaim } from "../knowledge/extract.js";
import type { EvidenceType } from "../types.js";

const BOOTSTRAP_DONE_KEY = "bootstrap_done_at";
const MAX_DOC_CHARS = 12_000;
const MAX_TOTAL_CHARS = 48_000;

/** Files worth reading whole (truncated) for the survey. */
const DOC_CANDIDATES = [
  "README.md", "readme.md", "ARCHITECTURE.md", "DESIGN.md", "CONTRIBUTING.md",
  "docs/architecture.md", "docs/adr", "adr", "docs/decisions",
];
const MANIFEST_CANDIDATES = [
  "package.json", "pyproject.toml", "go.mod", "Cargo.toml", "pom.xml",
  "build.gradle", "build.gradle.kts", "Gemfile", "composer.json", "Makefile",
  "docker-compose.yml", "Dockerfile", ".github/workflows",
];

export interface BootstrapResult {
  proposed: number;
  duplicates: number;
  provider: string | null;
  surveyedFiles: string[];
  alreadyBootstrapped: boolean;
}

function git(repoRoot: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

function readCapped(abs: string): string {
  try {
    return readFileSync(abs, "utf8").slice(0, MAX_DOC_CHARS);
  } catch {
    return "";
  }
}

/** Top-level directory listing, two levels deep — enough shape without noise. */
export function surveyTree(repoRoot: string): string {
  const lines: string[] = [];
  const skip = new Set(["node_modules", ".git", "dist", "build", ".aidimag", "coverage", "target", ".idea", ".vscode"]);
  const walk = (dir: string, depth: number, prefix: string) => {
    if (depth > 2) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).filter((e) => !skip.has(e) && !e.startsWith("."));
    } catch {
      return;
    }
    for (const e of entries.slice(0, 30)) {
      const abs = path.join(dir, e);
      let isDir = false;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      lines.push(`${prefix}${e}${isDir ? "/" : ""}`);
      if (isDir) walk(abs, depth + 1, prefix + "  ");
    }
  };
  walk(repoRoot, 1, "");
  return lines.join("\n");
}

/** Most-changed files in recent history — where the action (and the gotchas) live. */
export function surveyChurn(repoRoot: string, maxCommits = 300, top = 15): string {
  const raw = git(repoRoot, ["log", `--max-count=${maxCommits}`, "--name-only", "--pretty=format:"]);
  const counts = new Map<string, number>();
  for (const f of raw.split("\n").map((l) => l.trim()).filter(Boolean)) {
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([f, n]) => `${n}× ${f}`)
    .join("\n");
}

function collectDocs(repoRoot: string): Array<{ file: string; content: string }> {
  const out: Array<{ file: string; content: string }> = [];
  for (const cand of DOC_CANDIDATES) {
    const abs = path.join(repoRoot, cand);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) {
      for (const f of readdirSync(abs).filter((f) => f.endsWith(".md")).slice(0, 5)) {
        out.push({ file: path.join(cand, f), content: readCapped(path.join(abs, f)) });
      }
    } else {
      out.push({ file: cand, content: readCapped(abs) });
    }
  }
  for (const cand of MANIFEST_CANDIDATES) {
    const abs = path.join(repoRoot, cand);
    if (!existsSync(abs) || statSync(abs).isDirectory()) continue;
    out.push({ file: cand, content: readCapped(abs).slice(0, 4_000) });
  }
  // existing hand-written AI context files are pre-distilled knowledge — gold
  for (const cand of ["CLAUDE.md", ".cursorrules", ".github/copilot-instructions.md"]) {
    const abs = path.join(repoRoot, cand);
    if (existsSync(abs) && !statSync(abs).isDirectory()) out.push({ file: cand, content: readCapped(abs) });
  }
  return out;
}

export const BOOTSTRAP_INSTRUCTIONS = `You are bootstrapping a "repo brain" for an AI coding assistant memory system. Below is a survey of a codebase: its docs, manifests, directory shape, and most-changed files.

Extract the durable, project-specific knowledge as FALSIFIABLE claims. Rules:

1. Only facts THIS survey supports — architecture, conventions, decisions, invariants, build/deploy procedures (SKILL), behavioral rules (GUARDRAIL with guardrail_level never|ask-first|always). Do NOT invent or pad; skip anything generic ("uses TypeScript" is useless unless there's a rule attached).
2. Write each claim as a checkable statement scoped with paths when the survey names them.
3. Where possible, include "static_check": a cheap shell command (grep/test/ls) that exits 0 iff the claim holds. Omit it when no honest check exists.
4. kinds: DECISION, CONVENTION, GOTCHA, FAILED_APPROACH, ARCHITECTURE, INVARIANT, GUARDRAIL, SKILL, TODO_CONTEXT.
5. Extract 5–30 claims depending on how much real signal exists. Quality over quantity.

Respond with ONLY a JSON object:
{"claims":[{"kind":"ARCHITECTURE","claim":"...","paths":["src/x"],"symbols":[],"guardrail_level":null,"rationale":"from README section ...","static_check":"test -f src/x/index.ts"}]}`;

/** Turn a repo survey into an initial proposal set. */
export async function bootstrapRepo(
  store: MemoryStore,
  repoRoot: string,
  opts: { force?: boolean } = {}
): Promise<BootstrapResult> {
  const result: BootstrapResult = {
    proposed: 0,
    duplicates: 0,
    provider: null,
    surveyedFiles: [],
    alreadyBootstrapped: false,
  };
  if (!opts.force && store.getMeta(BOOTSTRAP_DONE_KEY)) {
    result.alreadyBootstrapped = true;
    return result;
  }

  const provider = await getTextProvider();
  if (!provider) return result;
  result.provider = `${provider.name}/${provider.model}`;

  const docs = collectDocs(repoRoot);
  result.surveyedFiles = docs.map((d) => d.file);
  const sections: string[] = [];
  sections.push(`## Directory shape\n${surveyTree(repoRoot)}`);
  const churn = surveyChurn(repoRoot);
  if (churn) sections.push(`## Most-changed files (recent history)\n${churn}`);
  for (const d of docs) {
    if (sections.join("\n").length > MAX_TOTAL_CHARS) break;
    sections.push(`## File: ${d.file}\n${d.content}`);
  }

  let claims: ExtractedClaim[] = [];
  try {
    const raw = await provider.generate(BOOTSTRAP_INSTRUCTIONS, sections.join("\n\n").slice(0, MAX_TOTAL_CHARS));
    claims = parseClaims(raw);
  } catch {
    return result; // provider hiccup — bootstrap can simply be re-run
  }

  for (const c of claims) {
    const evidence: Array<{ type: EvidenceType; payload: string }> = [];
    if (c.staticCheck) evidence.push({ type: "STATIC_CHECK", payload: c.staticCheck });
    const p = store.propose({
      kind: c.kind,
      claim: c.claim,
      paths: c.paths,
      symbols: c.symbols,
      guardrailLevel: c.guardrailLevel,
      evidence: evidence.length ? evidence : undefined,
      rationale: c.rationale ?? "Extracted by repo bootstrap survey.",
      source: "bootstrap",
      sourceRef: "initial-survey",
    });
    if (p) result.proposed++;
    else result.duplicates++;
  }

  store.setMeta(BOOTSTRAP_DONE_KEY, new Date().toISOString());
  return result;
}

