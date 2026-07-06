/**
 * Debug channel for best-effort code paths.
 *
 * aidimag deliberately swallows errors in advisory paths (auto-sync, gap
 * logging, embeddings, context regeneration) so they can never break a user
 * command. The cost was observability: "why didn't X happen?" had no answer.
 *
 * `AIDIMAG_DEBUG=1 dim <cmd>` makes every swallowed error visible on stderr
 * without changing behavior. Use `debugLog(scope, err)` in any catch that
 * intentionally continues.
 */

export const DEBUG_ENABLED =
  process.env.AIDIMAG_DEBUG === "1" || process.env.AIDIMAG_DEBUG === "true";

/** Report a swallowed error when AIDIMAG_DEBUG is on. Never throws. */
export function debugLog(scope: string, err: unknown): void {
  if (!DEBUG_ENABLED) return;
  try {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`[aidimag:debug] ${scope}: ${msg}`);
  } catch {
    /* the debug channel itself must never throw */
  }
}

