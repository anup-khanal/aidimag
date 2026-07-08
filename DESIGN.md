# Codebase Memory Layer — "aidimag"
### Persistent, verified memory for AI coding agents

> **CLI**: `dim`. npm package: `aidimag`, binary: `dim`.
>
> ```
> dim init      dim remember    dim recall <path>
> dim status    dim verify      dim log         dim forget <id>
> ```

**One-liner:** A git-native, MCP-compatible memory sidecar that lets any AI coding agent
(Claude Code, Cursor, Copilot, Codex) remember a codebase across sessions — with every
memory **grounded in verifiable evidence** (commits, test runs, execution results) so it
never poisons the agent with stale or wrong context.

---

## 1. The Problem

1. **Statelessness**: Every agent session starts from zero. The agent re-discovers
   architecture, conventions, gotchas, and "why this hack exists" every single time.
2. **Stale memory is worse than no memory**: Naive memory systems (notes files, generic
   vector stores) rot. An agent acting on a memory that's no longer true is dangerous.
3. **Tool lock-in**: Each vendor's context solution (CLAUDE.md, .cursorrules, Copilot
   instructions) is static, manual, and siloed.

**The wedge — Verification**: Memory entries are not free-text claims. Each one carries
*grounding evidence* and is *continuously re-verified* against the repo's actual state.
This is the differentiator vs. Mem0/Zep/Letta-style generic memory.

---

## 2. Core Concepts (Data Model)

### Memory Entry
```
MemoryEntry {
  id:            uuid
  kind:          DECISION | CONVENTION | GOTCHA | FAILED_APPROACH |
                 ARCHITECTURE | INVARIANT | TODO_CONTEXT
  claim:         string          # the memory itself, written as a falsifiable statement
  scope:         repo | path[] | symbol[]   # what part of the codebase it applies to
  grounding:     Evidence[]      # what makes this true (see below)
  confidence:    float           # decays without re-verification; boosted on re-confirmation
  status:        VERIFIED | UNVERIFIED | STALE | REFUTED
  created_by:    agent-id | human
  created_at / verified_at / superseded_by
  links:         [memory-ids]    # graph edges (supports / contradicts / refines)
}
```

### Evidence (the verification wedge)
```
Evidence {
  type:     COMMIT_REF        # claim anchored to specific commit(s)/file hash(es)
          | TEST_RESULT       # a test that passes iff the claim holds
          | EXEC_TRACE        # sandboxed execution output demonstrating behavior
          | STATIC_CHECK      # grep/AST assertion (e.g. "no module imports X directly")
          | HUMAN_ATTESTED    # explicitly confirmed by a human (weakest auto-decay)
  payload:  ref / script / assertion
  last_run: timestamp
  result:   PASS | FAIL | UNKNOWN
}
```

**Key mechanism — re-verification loop**: a background job (or pre-session hook) re-runs
cheap evidence checks (STATIC_CHECK, file-hash diffs) on every `git pull`, and expensive
ones (TEST_RESULT, EXEC_TRACE) on a schedule. Failing evidence flips a memory to STALE
or REFUTED so agents are warned or blocked from using it.

### Storage
- **Graph + document store**, local-first: SQLite (+ sqlite-vec for embeddings) in
  `.aidimag/` inside the repo, versioned alongside git (like `.git` but for understanding).
- Sync layer (team mode) comes later — start single-player.

---

## 3. Architecture (MVP)

```
┌─────────────────────────────────────────────────────────┐
│  AI Agent (Claude Code / Cursor / Copilot / any MCP)     │
└──────────────┬──────────────────────────────────────────┘
               │ MCP (stdio/HTTP)
┌──────────────▼──────────────────────────────────────────┐
│  aidimag MCP Server                                      │
│  ─ tools: memory_search, memory_get_for_files,           │
│           memory_write, memory_refute, memory_status     │
│  ─ resources: repo memory digest (auto-injected context) │
├──────────────────────────────────────────────────────────┤
│  Memory Engine                                           │
│  ─ scoped retrieval (path/symbol-aware, hybrid           │
│    vector + graph + recency/confidence ranking)          │
│  ─ consolidation (dedupe, summarize, link contradictions)│
├──────────────────────────────────────────────────────────┤
│  Verification Engine  ← THE WEDGE                        │
│  ─ evidence runners (static checks, test harness,        │
│    sandboxed exec)                                       │
│  ─ git hooks: re-verify on pull/checkout/merge           │
│  ─ confidence decay + status transitions                 │
├──────────────────────────────────────────────────────────┤
│  Capture Pipeline                                        │
│  ─ session-end extraction (agent summarizes learnings    │
│    → structured MemoryEntry proposals)                   │
│  ─ commit/PR miner (decisions from messages + diffs)     │
│  ─ human CLI: `aidimag remember "..." --evidence ...`    │
└──────────────────────────────────────────────────────────┘
        │
   .aidimag/  (SQLite + embeddings, lives in repo, gitignored or LFS-synced)
```

---

## 4. Agent Workflow (what it feels like)

1. **Session start**: agent calls `memory_get_for_files(changed/opened files)` →
   receives a ranked digest: verified conventions, gotchas, prior failed approaches.
   Tokens spent: hundreds, not tens of thousands.
2. **During work**: before risky changes, agent queries invariants in scope
   ("any VERIFIED memory contradicting deleting this null-check?").
3. **Session end**: agent proposes new memories with grounding; verification engine
   runs the evidence; only PASS entries become VERIFIED.
4. **Over time**: git hook re-verification keeps the graph honest; refuted memories
   become negative knowledge ("we believed X until commit abc123 — no longer true"),
   which is itself valuable.

---

## 5. Build Plan & Timeline

| Phase | Scope | Effort (w/ AI pair) |
|---|---|---|
| **0. Spec freeze** | this doc + tool schemas | ✅ done |
| **1. Skeleton** | MCP server, SQLite schema, memory_write/search, CLI | ✅ done |
| **2. Capture** | session-end extraction prompt + commit miner | ✅ done |
| **3. Verification v1** | STATIC_CHECK + COMMIT_REF runners, git-hook re-verify, status lifecycle | ✅ done |
| **4. Pilot** | run on a real repo, tune retrieval ranking | ✅ done |
| **5. Verification v2** | TEST_RESULT + sandboxed EXEC_TRACE evidence, confidence decay | ✅ done |
| **6. Team mode** | shared store sync, device login, API keys, event log, consensus | ✅ done |
| **7. Tickets** | Jira/GitHub/Linear/HTTP/Remote providers, branch enforcement, session-end awareness | ✅ done |
| **8. IDE clients** | VSCode extension (Memory Explorer tree + detail webview) + IntelliJ plugin (native panel) | ✅ done |
| **9. Pinned memories** | `dim pin`/`unpin`: exempt from time decay, still falsifiable by evidence | ✅ done |
| **10. Karpathy layers** | `dim generate-context`, GUARDRAIL/SKILL kinds, `memory_critique`, `dim check`, session briefing | ✅ done — see [KARPATHY_LAYERS.md](./KARPATHY_LAYERS.md) |
| **11. Knowledgebase ingestion** | `knowledge/` inbox → summarized into reviewed, pinned memories (agent/LLM summarizer, originals backed up) | ✅ shipped — see [KNOWLEDGEBASE_DESIGN.md](./KNOWLEDGEBASE_DESIGN.md) |

**Realistic total to a pilotable v0.1 with the verification wedge: ~4–6 weeks part-time,
2–3 weeks full-time** — because phases 1–3 are buildable on existing primitives
(MCP SDK, SQLite, sqlite-vec, simple-git) with no model training and no infra.

---

## 6. Tech Choices (MVP)

- **Language**: TypeScript (official MCP SDK maturity, easy distribution via npx)
- **Store**: SQLite + sqlite-vec (zero-dependency, local-first)
- **Embeddings**: pluggable — local (ollama/all-MiniLM) or API
- **Distribution**: `npx aidimag init` (or `dim init` once installed) in any repo → installs MCP config + git hooks
- **License/positioning**: open-core. OSS single-player; paid team sync + org memory.

---

## 7. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Memory rot poisons agents | the entire verification wedge exists for this; UNVERIFIED entries are clearly labeled and down-ranked |
| Vendors ship native repo memory | stay neutral/multi-tool; go deeper on verification + org memory than a vendor feature will |
| Extraction quality is noisy | human-in-the-loop approval queue for new memories at first; tighten autonomously later |
| Evidence checks too slow | tier them: hash/static checks on every pull, tests nightly, exec on demand |

---

## 8. Success Criteria for the Pilot

- Agent session 2 on a known repo uses ≥50% fewer exploration tool-calls than session 1
- ≥80% of VERIFIED memories judged accurate by the human after 2 weeks of churn
- At least one incident where a STALE/REFUTED flag prevented a wrong agent action



