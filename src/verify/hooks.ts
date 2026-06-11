/**
 * Git hook installer (Phase 3) — re-verify memory on every pull/checkout/merge
 * so agents never see a stale green checkmark.
 *
 * Also installs a post-commit CAPTURE hook: each new commit is mined for
 * memory-worthy signals (decisions, gotchas, failed approaches). Candidates go
 * to the proposal queue and the committer gets a gentle nudge to review —
 * capture stays human-gated, it just stops depending on humans remembering
 * to run `dim mine`.
 *
 * Hooks are additive: if a hook already exists without our marker, we append;
 * existing logic is never clobbered.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export const HOOK_MARKER = "# >>> aidimag verify hook >>>";
export const CAPTURE_HOOK_MARKER = "# >>> aidimag capture hook >>>";
const VERIFY_HOOK_NAMES = ["post-merge", "post-checkout", "post-rewrite"] as const;
const CAPTURE_HOOK_NAME = "post-commit";

function hookBlock(): string {
  return [
    HOOK_MARKER,
    "# Re-verifies aidimag memories against the new repo state (cheap tier only).",
    "command -v dim >/dev/null 2>&1 && dim verify --quiet || npx -y aidimag verify --quiet 2>/dev/null || true",
    "# <<< aidimag verify hook <<<",
    "",
  ].join("\n");
}

function captureHookBlock(): string {
  return [
    CAPTURE_HOOK_MARKER,
    "# Mines the new commit for memory candidates (queued for review, never auto-saved).",
    "command -v dim >/dev/null 2>&1 && dim mine --quiet || npx -y aidimag mine --quiet 2>/dev/null || true",
    "# <<< aidimag capture hook <<<",
    "",
  ].join("\n");
}

export interface HookInstallResult {
  installed: string[];
  alreadyPresent: string[];
  skipped: string[];
}

export function installGitHooks(repoRoot: string): HookInstallResult {
  const gitDir = path.join(repoRoot, ".git");
  const result: HookInstallResult = { installed: [], alreadyPresent: [], skipped: [] };
  if (!existsSync(gitDir)) {
    result.skipped = [...VERIFY_HOOK_NAMES, CAPTURE_HOOK_NAME];
    return result;
  }
  const hooksDir = path.join(gitDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });

  const install = (name: string, marker: string, block: string) => {
    const file = path.join(hooksDir, name);
    if (existsSync(file)) {
      const current = readFileSync(file, "utf8");
      if (current.includes(marker)) {
        result.alreadyPresent.push(name);
        return;
      }
      appendFileSync(file, `\n${block}`);
    } else {
      writeFileSync(file, `#!/bin/sh\n${block}`);
    }
    chmodSync(file, 0o755);
    result.installed.push(name);
  };

  for (const name of VERIFY_HOOK_NAMES) install(name, HOOK_MARKER, hookBlock());
  install(CAPTURE_HOOK_NAME, CAPTURE_HOOK_MARKER, captureHookBlock());
  return result;
}

