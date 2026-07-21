# Configuration

aiDimag keeps repo settings in **`.aidimag/config.json`**. This file contains server URL, brain ID, and authentication tokens. **By default, it's gitignored** — `dim init` automatically adds `config.json` to `.aidimag/.gitignore` to prevent committing tokens. You can commit the server/brain config separately if needed for team coordination.

## Where settings live

| Location | Contents | Committed? |
|---|---|---|
| `.aidimag/config.json` | Repo settings (sync server, brain, token, tickets, context, checks) | ❌ gitignored (contains token) |
| `.aidimag/memory.db` | The memory store | ❌ gitignored |

## Example `config.json`

```json
{
  "generateContext": {
    "auto": true,
    "format": "all"
  },
  "preCommitCheck": "warn",
  "server": "https://cloud.aidimag.com",
  "brain": "myrepo-abc123",
  "token": "aidimag_sk_...",
  "tickets": {
    "provider": "github",
    "branch": { "pattern": "^(feature|fix)/[A-Z]+-\\d+", "enforce": "warn" }
  },
  "knowledge": {
    "folder": "knowledge",
    "summarizer": "auto",
    "requireReview": true,
    "backup": true
  }
}
```

## Options

### `generateContext`

Controls [generated context files](/guides/generate-context).

| Field | Values | Meaning |
|---|---|---|
| `auto` | `true` / `false` | Regenerate context files automatically after verify/review/sync |
| `format` | `claude` / `cursorrules` / `copilot` / `all` | Which file(s) to write |

The easiest way to set this is `dim generate-context --auto`.

### `preCommitCheck`

Controls the optional [`pre-commit` hook](/guides/dim-check).

| Value | Behavior |
|---|---|
| *(unset)* / `false` | Hook is a no-op |
| `"warn"` / `true` | Print violations, allow the commit |
| `"block"` | Print violations and **block** the commit on a hard violation |

### `server`, `brain`, `token`

Set by `dim cloud link` or `dim login`. The server URL, brain name, and authentication token for [team sync](/guides/team-sync). The token is stored per-project and gitignored by default.

### `tickets`

Set by `dim ticket connect`. The connected provider and the branch-naming convention. See
[Connecting tickets](/guides/tickets).

### `knowledge`

Controls the [knowledge inbox](/guides/knowledgebase). All fields are optional — defaults
work out of the box.

| Field | Default | Meaning |
|---|---|---|
| `folder` | `"knowledge"` | Inbox folder (repo-relative) where you drop docs |
| `summarizer` | `"auto"` | `auto` (agent → LLM) / `agent` / `llm` / `off` |
| `requireReview` | `true` | Require `dim review` approval before pinning. `false` auto-approves claims as ACTIVE but **unpinned** memories (no human reviewed them, so they stay subject to decay and evidence checks — pin keepers with `dim pin`) |
| `backup` | `true` | Keep originals in `.aidimag/knowledge/processed/` |
| `extensions` | text formats + `.pdf`/`.docx` | Allowlist of file extensions to summarize (e.g. `[".md", ".txt", ".pdf"]`). PDF and DOCX text is extracted before summarization |
| `maxBytes` | `1048576` | Hard size cap; larger files are skipped |
| `chunkBytes` | `16384` | Soft threshold; larger text docs are chunked before summarizing |

## Environment variables

Some behavior is controlled by environment variables rather than the config file — see the
table in the [CLI reference](/cli-reference#environment-variables). The most useful:

- `AIDIMAG_REPO` — point the CLI/MCP server at a specific repo.
- `AIDIMAG_EMBEDDINGS` — `auto` / `openai` / `ollama` / `off`.
- `AIDIMAG_AUTO_SYNC=off` — disable automatic sync after writes.

