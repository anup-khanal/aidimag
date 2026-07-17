# aiDimag

> Persistent, verified memory for AI coding agents. CLI: **`dim`**.

aiDimag gives any MCP-compatible agent (Claude Code, Cursor, Copilot, …) a memory of your
codebase that survives across sessions — decisions, conventions, gotchas, failed approaches,
**guardrails**, and reusable **skills** — stored as **falsifiable claims with grounding
evidence** in `.aidimag/` next to your code. It also generates the static context files
(`CLAUDE.md`, `.cursorrules`, …) that *non-MCP* tools read, so every AI tool benefits.

What makes it different: **memories are verified, not just stored.** Every memory carries
evidence (a shell check, an anchored commit, a test) that `dim verify` re-runs against the
current repo — beliefs that stop being true go **STALE** instead of silently misleading
your AI.

## Install

```sh
npm install -g aidimag
```

Requires Node 18+. Ships two equivalent binaries: `dim` (short) and `aidimag`.

## Quick start

```sh
cd your-repo
dim init            # creates .aidimag/, installs additive git hooks
dim bootstrap       # optional: LLM-survey the repo into a starter memory set
dim review          # approve what enters memory (nothing is stored unreviewed)

dim remember "All DB access goes through src/db/store.ts" -k INVARIANT -p src/db \
  -e "STATIC_CHECK:grep -rL better-sqlite3 src --include=*.ts"
dim recall db access
dim verify          # re-run all evidence; stale beliefs get flagged
dim brief           # session-start briefing: in-scope memory, guardrails, gaps
```

## Hook it up to your AI agent (MCP)

Add to your agent config (e.g. `.mcp.json` for Claude Code):

```json
{
  "mcpServers": {
    "aidimag": {
      "command": "npx",
      "args": ["-y", "aidimag", "mcp"],
      "env": { "AIDIMAG_REPO": "/path/to/your/repo" }
    }
  }
}
```

Agents get `memory_search`, `memory_propose`, `context_note` (live in-chat fact capture),
`memory_critique` (a second critic grounded in verified memory), session-start briefings,
session-end extraction, and more. For non-MCP tools, `dim generate-context -f all` renders
verified memory into `CLAUDE.md` / `.cursorrules` / `.github/copilot-instructions.md`
(`--auto` keeps them refreshed).

## Highlights

- **Human-gated capture** — commits, PRs, AI-chat transcripts, and pasted docs are mined
  into *proposals*; nothing enters memory until you approve it in `dim review`
  (auto-triaged best-first, `approve all --min-score 0.7` for batches).
- **Verification lifecycle** — `STATIC_CHECK` / `COMMIT_REF` / `TEST_RESULT` /
  `EXEC_TRACE` / `HUMAN_ATTESTED` evidence; failing evidence flips memories to STALE and
  auto-drafts a recovery proposal. Confidence decays without re-confirmation.
- **Evidence trust gate** — shell-command evidence that arrives via team sync is **never
  executed** until you inspect and approve it (`dim verify --trust`).
- **Hybrid semantic recall** — FTS5 keyword + vector KNN (OpenAI or local Ollama,
  auto-detected; works keyword-only with neither).
- **Guardrails & skills** — behavioral rules (`never` / `ask-first` / `always`) and
  step-by-step procedures, enforced by `dim check` (pre-commit) and `memory_critique`.
- **Team mode, self-hosted** — `dim serve` + `dim sync`: local-first replicas, device-code
  login, brain-scoped API keys, hashed credentials, cross-machine verification consensus.
- **Knowledgebase inbox** — drop design docs / ADRs / PDFs / DOCX into `knowledge/` and
  they're summarized into reviewed, pinned memories.
- **Web dashboard** (`dim ui`) plus [VS Code](https://github.com/anupkhanal/aidimag/tree/main/vscode-extension) and
  [IntelliJ](https://github.com/anupkhanal/aidimag/tree/main/intellij-plugin) extensions.

## Documentation

Full documentation available at: **[github.com/anupkhanal/aidimag](https://github.com/anupkhanal/aidimag)**

- [Getting Started](https://github.com/anupkhanal/aidimag/blob/main/docs/getting-started.md)
- [Quick Start](https://github.com/anupkhanal/aidimag/blob/main/docs/quickstart.md)
- [CLI Reference](https://github.com/anupkhanal/aidimag/blob/main/docs/cli-reference.md)
- [MCP Integration](https://github.com/anupkhanal/aidimag/blob/main/docs/mcp.md)
- [Team Sync Guide](https://github.com/anupkhanal/aidimag/blob/main/docs/guides/team-sync.md)
- [Configuration](https://github.com/anupkhanal/aidimag/blob/main/docs/configuration.md)

## Development

```sh
npm install
npm run build       # tsc → dist/
npm test            # node --test (builds first)
```

Self-hosted sync deployment (Docker / Fly.io): [deploy/](https://github.com/anupkhanal/aidimag/tree/main/deploy).

## Author

**Anup Khanal**

## License

[Elastic License 2.0](./LICENSE) — free for teams of 10 or fewer users. Commercial license required for larger organizations. Cannot be offered as a managed service to third parties. See [pricing & licensing](docs/pricing.md) for details.

