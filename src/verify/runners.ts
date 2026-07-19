/**
 * Evidence runners.
 *
 * Cheap tier (STATIC_CHECK, COMMIT_REF) runs on every `git pull` via hooks.
 * Expensive tier (TEST_RESULT, EXEC_TRACE) runs only with deep=true
 * (`dim verify --deep`) so hook-triggered verification stays fast.
 */

import { execFileSync, execSync } from "node:child_process";
import type { Evidence, EvidenceResult } from "../types.js";

export interface RunOutcome {
  evidenceId: string;
  type: Evidence["type"];
  result: EvidenceResult | "SKIPPED";
  detail: string;
}

const STATIC_CHECK_TIMEOUT_MS = 15_000;
const DEEP_TIMEOUT_MS = 120_000; // TEST_RESULT / EXEC_TRACE

/** STATIC_CHECK: payload is a shell command; exit 0 = claim holds. */
function runStaticCheck(ev: Evidence, repoRoot: string): RunOutcome {
  try {
    execSync(ev.payload, {
      cwd: repoRoot,
      timeout: STATIC_CHECK_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { evidenceId: ev.id, type: ev.type, result: "PASS", detail: "exit 0" };
  } catch (err) {
    const e = err as { status?: number; killed?: boolean; message: string };
    if (e.killed) {
      return {
        evidenceId: ev.id,
        type: ev.type,
        result: "UNKNOWN",
        detail: `timed out after ${STATIC_CHECK_TIMEOUT_MS}ms`,
      };
    }
    return {
      evidenceId: ev.id,
      type: ev.type,
      result: "FAIL",
      detail: `exit ${e.status ?? "?"}`,
    };
  }
}

/**
 * COMMIT_REF: payload is a commit sha (optionally "sha:path,path" to also
 * check the anchored files haven't changed since that commit).
 * - sha missing from history → FAIL (rebased away / rewritten)
 * - anchored files changed since sha → FAIL (claim may have drifted)
 * - otherwise → PASS
 */
function runCommitRef(ev: Evidence, repoRoot: string): RunOutcome {
  const [sha, pathSpec] = ev.payload.split(":", 2);
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  try {
    git(["cat-file", "-e", `${sha}^{commit}`]);
  } catch {
    return {
      evidenceId: ev.id,
      type: ev.type,
      result: "FAIL",
      detail: `commit ${sha.slice(0, 8)} no longer exists in history`,
    };
  }

  // is the commit still reachable from HEAD? (revert/branch-switch detection)
  try {
    git(["merge-base", "--is-ancestor", sha, "HEAD"]);
  } catch {
    return {
      evidenceId: ev.id,
      type: ev.type,
      result: "FAIL",
      detail: `commit ${sha.slice(0, 8)} is not an ancestor of HEAD`,
    };
  }

  if (pathSpec) {
    const paths = pathSpec.split(",").map((p) => p.trim()).filter(Boolean);
    for (const p of paths) {
      if (p.startsWith("/") || p.includes("..")) {
        return {
          evidenceId: ev.id,
          type: ev.type,
          result: "FAIL",
          detail: "invalid path in COMMIT_REF evidence",
        };
      }
    }
    try {
      const changed = git(["diff", "--name-only", sha, "HEAD", "--", ...paths]).trim();
      if (changed) {
        return {
          evidenceId: ev.id,
          type: ev.type,
          result: "FAIL",
          detail: `anchored file(s) changed since ${sha.slice(0, 8)}: ${changed.split("\n").slice(0, 3).join(", ")}`,
        };
      }
    } catch {
      return { evidenceId: ev.id, type: ev.type, result: "UNKNOWN", detail: "diff failed" };
    }
  }

  return { evidenceId: ev.id, type: ev.type, result: "PASS", detail: `${sha.slice(0, 8)} reachable from HEAD` };
}

/**
 * TEST_RESULT: payload is a test command (e.g. "npm test -- --run auth").
 * Expensive tier — only runs when deep=true. Exit 0 = the claim holds.
 */
function runTestResult(ev: Evidence, repoRoot: string): RunOutcome {
  try {
    execSync(ev.payload, {
      cwd: repoRoot,
      timeout: DEEP_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "1" }, // non-interactive, no watch mode
    });
    return { evidenceId: ev.id, type: ev.type, result: "PASS", detail: "test command exit 0" };
  } catch (err) {
    const e = err as { status?: number; killed?: boolean };
    if (e.killed) {
      return { evidenceId: ev.id, type: ev.type, result: "UNKNOWN", detail: `timed out after ${DEEP_TIMEOUT_MS}ms` };
    }
    return { evidenceId: ev.id, type: ev.type, result: "FAIL", detail: `test command exit ${e.status ?? "?"}` };
  }
}

/**
 * EXEC_TRACE: payload is "command :: expected-output-regex".
 * Runs the command and matches stdout against the regex — the claim holds iff
 * the observed behavior matches. Without " :: ", exit 0 = PASS.
 * Sandboxing note: v1 confines execution to the repo root with a hard timeout;
 * container/VM isolation is a later hardening step.
 */
function runExecTrace(ev: Evidence, repoRoot: string): RunOutcome {
  const sep = " :: ";
  const idx = ev.payload.indexOf(sep);
  const cmd = idx >= 0 ? ev.payload.slice(0, idx) : ev.payload;
  const expect = idx >= 0 ? ev.payload.slice(idx + sep.length) : null;
  try {
    const stdout = execSync(cmd, {
      cwd: repoRoot,
      timeout: DEEP_TIMEOUT_MS,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (expect === null) {
      return { evidenceId: ev.id, type: ev.type, result: "PASS", detail: "exec exit 0" };
    }
    const re = new RegExp(expect, "m");
    return re.test(stdout)
      ? { evidenceId: ev.id, type: ev.type, result: "PASS", detail: `output matched /${expect}/` }
      : { evidenceId: ev.id, type: ev.type, result: "FAIL", detail: `output did not match /${expect}/` };
  } catch (err) {
    const e = err as { status?: number; killed?: boolean };
    if (e.killed) {
      return { evidenceId: ev.id, type: ev.type, result: "UNKNOWN", detail: `timed out after ${DEEP_TIMEOUT_MS}ms` };
    }
    return { evidenceId: ev.id, type: ev.type, result: "FAIL", detail: `exec exit ${e.status ?? "?"}` };
  }
}

export interface RunOptions {
  /** Run the expensive tier (TEST_RESULT, EXEC_TRACE). Default false — cheap tier only. */
  deep?: boolean;
  /**
   * Trust gate for executable evidence (STATIC_CHECK/TEST_RESULT/EXEC_TRACE):
   * payloads run shell commands, so only locally-approved ones may execute.
   * Returns true if the payload is approved on this machine. Omitted = trust
   * everything (unit tests / explicit --trust runs).
   */
  isTrusted?: (payload: string) => boolean;
}

const EXECUTABLE_TYPES = new Set<Evidence["type"]>(["STATIC_CHECK", "TEST_RESULT", "EXEC_TRACE"]);

export function runEvidence(ev: Evidence, repoRoot: string, opts: RunOptions = {}): RunOutcome {
  // Supply-chain guard: evidence that arrived via team sync is shell code
  // someone else wrote. It never executes until approved on this machine
  // (`dim verify --trust` to review & approve).
  if (EXECUTABLE_TYPES.has(ev.type) && opts.isTrusted && !opts.isTrusted(ev.payload)) {
    return {
      evidenceId: ev.id,
      type: ev.type,
      result: "SKIPPED",
      detail: "untrusted (synced) evidence — inspect & approve with `dim verify --trust`",
    };
  }
  switch (ev.type) {
    case "STATIC_CHECK":
      return runStaticCheck(ev, repoRoot);
    case "COMMIT_REF":
      return runCommitRef(ev, repoRoot);
    case "HUMAN_ATTESTED":
      // human word is taken as-is; confidence decay handles its aging
      return { evidenceId: ev.id, type: ev.type, result: "PASS", detail: "human attested" };
    case "TEST_RESULT":
      return opts.deep
        ? runTestResult(ev, repoRoot)
        : { evidenceId: ev.id, type: ev.type, result: "SKIPPED", detail: "expensive tier — use --deep" };
    case "EXEC_TRACE":
      return opts.deep
        ? runExecTrace(ev, repoRoot)
        : { evidenceId: ev.id, type: ev.type, result: "SKIPPED", detail: "expensive tier — use --deep" };
    case "TICKET_REF":
      // annotation-only provenance (TICKETS_DESIGN open question #2: ticket
      // lifecycle is a weaker signal than code evidence — never flips status)
      return { evidenceId: ev.id, type: ev.type, result: "SKIPPED", detail: `ticket ${ev.payload} (provenance annotation)` };
  }
}

