/**
 * Git hook installer (Phase 3) — re-verify memory on every pull/checkout/merge
 * so agents never see a stale green checkmark.
 *
 * Hooks are additive: if a hook already exists without our marker, we append;
 * existing logic is never clobbered.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export const HOOK_MARKER = "# >>> aidimag verify hook >>>";
const HOOK_NAMES = ["post-merge", "post-checkout", "post-rewrite"] as const;

function hookBlock(): string {
  return [
    HOOK_MARKER,
    "# Re-verifies aidimag memories against the new repo state (cheap tier only).",
    "command -v dim >/dev/null 2>&1 && dim verify --quiet || npx -y aidimag verify --quiet 2>/dev/null || true",
    "# <<< aidimag verify hook <<<",
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
    result.skipped = [...HOOK_NAMES];
    return result;
  }
  const hooksDir = path.join(gitDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });

  for (const name of HOOK_NAMES) {
    const file = path.join(hooksDir, name);
    if (existsSync(file)) {
      const current = readFileSync(file, "utf8");
      if (current.includes(HOOK_MARKER)) {
        result.alreadyPresent.push(name);
        continue;
      }
      appendFileSync(file, `\n${hookBlock()}`);
    } else {
      writeFileSync(file, `#!/bin/sh\n${hookBlock()}`);
    }
    chmodSync(file, 0o755);
    result.installed.push(name);
  }
  return result;
}

