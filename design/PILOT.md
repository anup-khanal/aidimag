# Phase 4 Pilot Report — corruption_nepal

**Date**: 2026-06-10 · **Pilot repo**: `~/Desktop/Personal/PersonalProjects/corruption_nepal`
(React CRA transparency platform, 19 commits, CDN-backed data layer, bilingual UI)

## What was run

1. `dim init` — `.aidimag/` created, git hooks installed, repo `.gitignore` updated
2. `dim mine --full` — full history scan
3. Manual session-style extraction: explored the codebase, validated 5 claims with greps
   **before** storing them, attached `STATIC_CHECK` evidence to each
4. `dim verify` — all 5 → VERIFIED
5. Drift drill: appended a direct `dataService` import to `src/pages/Dashboard.js`
6. Recovery drill: reverted the file

## Findings

### ✅ What worked
- **Verification loop is the product.** The layering-convention memory flipped
  VERIFIED → STALE (conf 0.80 → 0.20, exit code 2) the moment a page imported
  `dataService` directly — exactly the wrong-action-prevention the pilot success
  criteria call for.
- **Hooks auto-heal.** Reverting the file triggered `post-checkout`, which re-verified
  and recovered the memory STALE → VERIFIED with no human action.
- **Scoped recall is precise.** `dim recall -p src/pages/IncidentList.js` returned only
  the page-scoped convention; keyword recall surfaced the cache-staleness gotcha first
  for "cache stale data".
- **Pre-validated claims verify cleanly**: writing the grep first, then the claim,
  produced 5/5 VERIFIED on first run.

### ⚠️ What didn't (and what changed because of it)
- **Commit miner found 0/19 candidates.** Real-world solo-project commit messages
  ("data", "fix font", "cleanup") carry no rationale. The miner only pays off on repos
  with disciplined messages (or PR bodies — future source). Session-end extraction must
  be the primary capture channel for repos like this.
- **STALE ranked equal to VERIFIED in keyword search.** Fixed: status-aware ranking —
  FTS bm25 rank + penalty (VERIFIED +0, UNVERIFIED +2, STALE +10). A stale memory now
  only surfaces when nothing trustworthy matches. Same ordering applied to scoped
  (non-FTS) retrieval.

### Ranking formula (after tuning)
```
ORDER BY (bm25_rank + status_penalty) ASC, confidence DESC
status_penalty: VERIFIED=0, UNVERIFIED=2, STALE=10, (REFUTED=20, excluded by default)
```

## Pilot success criteria — status

| Criterion | Status |
|---|---|
| Session 2 uses ≥50% fewer exploration calls | ⏳ needs a real agent session pair (wire MCP into Claude Code/Copilot and measure) |
| ≥80% of VERIFIED memories accurate after 2 weeks | ⏳ needs calendar time; 5/5 accurate at T0 |
| ≥1 incident where STALE/REFUTED prevented a wrong action | ✅ layering violation caught + exit 2 + down-ranked in recall |

## Recommended next steps
1. Wire the MCP config into a real agent on this repo and run a measured session pair
2. Phase 5: TEST_RESULT/EXEC_TRACE runners + confidence decay for HUMAN_ATTESTED
3. Consider PR-body mining (richer than commit subjects) when repos live on GitHub/Bitbucket

