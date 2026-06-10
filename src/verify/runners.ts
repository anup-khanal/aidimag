/**
 * Evidence runners (Phase 3 — Verification v1).
 *
 * Cheap tier only: STATIC_CHECK and COMMIT_REF run on every `git pull`.
 * Expensive tier (TEST_RESULT, EXEC_TRACE) lands in Phase 5 and is reported
 * as SKIPPED here so it never blocks fast verification.
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

export function runEvidence(ev: Evidence, repoRoot: string): RunOutcome {
  switch (ev.type) {
    case "STATIC_CHECK":
      return runStaticCheck(ev, repoRoot);
    case "COMMIT_REF":
      return runCommitRef(ev, repoRoot);
    case "HUMAN_ATTESTED":
      // human word is taken as-is; decay handles aging (Phase 5)
      return { evidenceId: ev.id, type: ev.type, result: "PASS", detail: "human attested" };
    case "TEST_RESULT":
    case "EXEC_TRACE":
      return { evidenceId: ev.id, type: ev.type, result: "SKIPPED", detail: "expensive tier (Phase 5)" };
  }
}

