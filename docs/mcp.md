# MCP integration

aiDimag ships an [MCP](https://modelcontextprotocol.io) server so any MCP-capable AI agent
can read and write memory **live** during a session — search before exploring, write
learnings at the end, and critique its own work against your verified rules.

## Start the server

The server runs over stdio and is normally launched by your agent, not by hand:

```sh
dim mcp
```

Point it at a repo with the `AIDIMAG_REPO` environment variable (most agent configs set this
for you).

## Add it to your agent

### Claude Code (`.mcp.json`)

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

### Cursor

Add the same server block to Cursor's MCP settings (Settings → MCP), using the
`npx -y aidimag mcp` command and the `AIDIMAG_REPO` env var.

### GitHub Copilot / other MCP clients

Any client that supports MCP servers can use the identical `command`/`args`/`env`. If your
tool doesn't speak MCP, use [generated context files](/guides/generate-context) instead.

`dim init` prints a ready-to-paste snippet for you.

## What the server exposes

### Tools

| Tool | What it does |
|---|---|
| `memory_search` | Search verified memory before exploring the codebase |
| `memory_get_for_files` | Get memories relevant to specific files before editing them |
| `memory_write` | Save a new memory (set `guardrail_level` for guardrails) |
| `memory_propose` | Queue a memory for human review (preferred at session end) |
| `memory_verify` | Re-run cheap evidence and update statuses |
| `memory_refute` | Mark a memory false when it no longer holds |
| `memory_status` | Counts by status and kind |
| `memory_critique` | Review work against verified memory + guardrails (a "second critic") |
| `proposals_pending` | List proposals awaiting review |
| `knowledge_pending` | List documents waiting in the knowledge inbox to be summarized |
| `knowledge_ingest_submit` | Submit the claims extracted from a pending knowledge doc (queues proposals, backs up the original) |
| `ticket_get` | Fetch the current ticket's details (auto-detects from the branch) |

### Prompts

| Prompt | When to run it |
|---|---|
| `session_start` | At the **start** of a session — surfaces in-scope memory, guardrails, stale warnings, questions to ask, and any docs waiting in the knowledge inbox |
| `session_end_extraction` | At the **end** — extract durable learnings into the proposal queue |
| `knowledge_ingest` | Process the [knowledge inbox](/guides/knowledgebase) in-session — read each pending doc, extract falsifiable claims, and submit them with `knowledge_ingest_submit` |

### Resources

| Resource | Contents |
|---|---|
| `aidimag://digest` | A compact digest of repo memory for bootstrapping |
| `aidimag://session-briefing` | The same briefing as `dim brief`, as a resource |

## A typical agent loop

1. **Start** → run `session_start` (or read `aidimag://session-briefing`) to learn the rules
   and stale spots.
2. **Before editing files** → `memory_get_for_files` to pull conventions/gotchas/guardrails.
3. **While working** → `memory_search` whenever a question comes up.
4. **Before finishing** → `memory_critique` with a short summary to catch guardrail
   violations and contradictions.
5. **End** → run `session_end_extraction` and `memory_propose` durable learnings (which you
   later approve with `dim review`).

## Do I even need MCP?

No — it's the richest integration, but optional. `dim generate-context` produces
`CLAUDE.md`, `.cursorrules`, and `copilot-instructions.md` that any assistant reads at
startup. Many teams use both: MCP for live read/write, generated files as a static fallback.

