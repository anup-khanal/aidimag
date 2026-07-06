# Configuration

aiDimag keeps repo settings in **`.aidimag/config.json`**. This file is **safe to commit** —
it never contains secrets (tokens live in `~/.aidimag/credentials.json` instead). Committing
it means teammates inherit the same settings.

## Where settings live

| Location | Contents | Committed? |
|---|---|---|
| `.aidimag/config.json` | Repo settings (sync server, tickets, context, checks) | ✅ yes (no secrets) |
| `.aidimag/memory.db` | The memory store | ❌ gitignored |
| `~/.aidimag/credentials.json` | Auth tokens | ❌ never in the repo |

## Example `config.json`

```json
{
  "generateContext": {
    "auto": true,
    "format": "all"
  },
  "preCommitCheck": "warn",
  "cloud": {
    "server": "http://your-server:8787",
    "brain": "myrepo"
  },
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

### `cloud`

Set by `dim cloud link`. The server URL and brain name for [team sync](/guides/team-sync).
No token here — that's in your credentials file.

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

