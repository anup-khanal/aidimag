# Cloud sync — TLDR (one page)

**Goal:** run aiDimag in *your* repo, sync a shared team brain through **aiDimag Cloud**, and keep agents reading **local** memory (fast, offline) while changes replicate in the background.

::: tip Local-first
Agents always query your local SQLite copy. Cloud is sync only — not a remote database you search over the network.
:::

## At a glance

| Step | Who | What |
|------|-----|------|
| 1 | Once (you) | Sign up at cloud.aidimag.com → create project → get API key |
| 2 | Per repo | `dim init` → `dim cloud link` → `dim sync` |
| 3 | Daily | Capture → review → verify → sync (auto-sync runs too) |
| 4 | Teammates | Clone repo → `dim init` → paste token → `dim sync` |

---

## 1. Create your cloud account

1. Go to **[cloud.aidimag.com](https://cloud.aidimag.com)**
2. **Sign up** with email/password or GitHub
3. **Create a new project** — one project = one shared **brain** for your team
4. In your project → **Keys** tab → **Create API key** → copy the `aidimag_sk_…` token (shown once)

::: warning Keep your API key secret
The token is stored per-project in `.aidimag/config.json`. Add this file to `.gitignore` to keep tokens private (done automatically by `dim init`). Each team member gets their own key from the dashboard.
:::

::: tip Self-hosting?
If you're running your own aiDimag Cloud instance instead of using cloud.aidimag.com, see [Team sync (self-hosted)](/guides/team-sync) for deployment instructions.
:::

---

## 2. Install the CLI

```sh
npm install -g aidimag
dim --version
```

---

## 3. Set up your repo

```sh
cd /path/to/your-app
dim init
```

`dim init` creates `.aidimag/` (memory DB, gitignored) and installs hooks.

---

## 4. Link to cloud

Use the brain ID and API key from your dashboard:

```sh
dim cloud link \
  --server https://cloud.aidimag.com \
  --brain YOUR_BRAIN_ID \
  --token aidimag_sk_...

dim sync
```

- **`.aidimag/config.json`** stores server URL, brain ID, and token
- **Gitignored by default** — `dim init` adds `config.json` to `.aidimag/.gitignore`

Verify the connection:

```sh
dim cloud status
dim cloud remote --summary
```

You should see memory counts (server vs local) and pending proposals.

---

## 5. Fill the brain (first time)

Pick one or more:

```sh
dim bootstrap              # LLM reads repo layout → review queue
dim mine --full            # mine git commits (fast heuristics)
dim mine --llm --full      # mine commits with LLM (needs Ollama or OPENAI_API_KEY)
```

Nothing becomes memory until you approve:

```sh
dim review                 # interactive: keep / reword / drop
# or
dim review list
dim review approve all
```

After review, sync pushes new memories:

```sh
dim sync
```

---

## 6. Day-to-day workflow

```sh
dim remember "…" -k CONVENTION -p src/…     # write a claim (+ optional evidence)
dim verify                                   # run evidence; VERIFIED or STALE
dim recall "…"                               # search local memory
dim brief                                    # session briefing for agents
dim ui                                       # local web dashboard
```

Sync runs **automatically** (~30s debounce) after remember, review, verify, refute, and forget. Disable with `AIDIMAG_AUTO_SYNC=off`.

Manual sync when you want to be sure:

```sh
dim sync              # incremental
dim sync --full       # re-upload everything (after server reset / cursor issues)
```

---

## 7. Wire up your AI agent (recommended)

**MCP** (Claude Code, Cursor, etc.) — see [MCP integration](/mcp):

```json
{
  "mcpServers": {
    "aidimag": {
      "command": "npx",
      "args": ["-y", "aidimag", "mcp"],
      "env": { "AIDIMAG_REPO": "/path/to/your-app" }
    }
  }
}
```

**Context files** (for non-MCP tools like Copilot, Cursor, Windsurf, etc.):

```sh
dim generate-context --format all --auto
```

This creates `CLAUDE.md`, `.cursorrules`, `.windsurfrules`, `AGENTS.md`, and `.github/copilot-instructions.md` with all verified/unverified memories, and enables **auto-regeneration** so these files stay fresh after `dim review`, `dim verify`, `dim sync`, etc.

::: tip Auto-regeneration is opt-in
By default, context files are **not** automatically updated. Use `--auto` to enable it. Without `--auto`, you must manually run `dim generate-context` after approving memories.
:::

---

## 8. Onboard a teammate

They clone the repo (config already has server + brain ID):

```sh
git clone … && cd your-app
dim init
dim cloud link --server https://cloud.aidimag.com --brain YOUR_BRAIN_ID --token aidimag_sk_…
dim sync
```

Each person gets their own API key from the dashboard (don’t share keys). Their machine pulls the full team brain into local SQLite.

---

## 9. Useful checks

| Command | What it tells you |
|---------|-------------------|
| `dim status` | Local memory counts |
| `dim cloud status` | Linked server + brain |
| `dim cloud remote --summary` | Remote vs local counts |
| `dim cloud remote --proposals` | Pending proposals on server |
| `dim proposals gc` | Remove legacy resolved proposal rows locally, then `dim sync` |

---

## Troubleshooting (quick)

| Symptom | Fix |
|---------|-----|
| `connection refused` on sync | Check server URL in `.aidimag/config.json` — should be `https://cloud.aidimag.com` (or your self-hosted URL) |
| `nothing to send` but local has data | `dim sync --full` |
| Remote shows old proposal count | `dim proposals gc` then `dim sync` |
| Debug detail | `AIDIMAG_DEBUG=1 dim sync` |

More: [FAQ](/faq) · [Configuration](/configuration) · [Team sync (self-hosted)](/guides/team-sync)

---

## What to read next

- [Quick start (5 minutes)](/quickstart) — remember, verify, guardrails without cloud depth  
- [The review queue](/guides/review-queue) — how proposals become memories  
- [Verifying memories](/guides/verifying) — evidence and the trust gate for synced-in claims  
- [CLI reference](/cli-reference) — every command
