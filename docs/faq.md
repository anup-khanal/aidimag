# FAQ & troubleshooting

## General

### Is aiDimag tied to a specific AI tool?
No. It works with any [MCP](/mcp)-capable agent (Claude Code, Cursor, Copilot), and for tools
that don't speak MCP it generates `CLAUDE.md` / `.cursorrules` / `copilot-instructions.md`.

### Does it send my code anywhere?
No. Everything is local by default — a SQLite file in `.aidimag/`. The only network traffic is
optional: an embedding provider (if you enable semantic search) and the team sync server (if
you set one up).

### Do I need an API key?
No. aiDimag works fully offline with keyword search. An `OPENAI_API_KEY` or local Ollama
unlocks the optional smart features: *semantic* search plus LLM-powered capture
(`dim bootstrap`, `dim mine --llm`, `dim harvest`, knowledgebase summarization).

### Will it eat a lot of memory/CPU?
The CLI and extensions are tiny. The only real consumer is the optional `dim ui` dashboard
(a small Node process), which you start and stop yourself.

## Setup

### `dim: command not found`
The CLI isn't on your `PATH`. Install globally (`npm i -g aidimag`) or, from source,
`npm run build && npm link`. You can also run it via `npx aidimag <command>`.

### The IntelliJ/VSCode extension says it can't find `dim`
IDEs launched from the OS GUI sometimes have a minimal `PATH`. Make sure `dim` is installed
**globally** so GUI apps can find it. See [IDE extensions](/ide-extensions).

### Git hooks didn't install
`dim init` only installs hooks inside a git repository. Run it from the repo root (where
`.git/` lives). Existing hooks are appended to, never overwritten.

## Memory & verification

### Why is my memory stuck on "unverified"?
It has no machine-checkable evidence, or you haven't run `dim verify`. Add a `STATIC_CHECK`
and verify — see [Writing claims & evidence](/guides/claims-and-evidence).

### A memory went stale — what do I do?
A piece of its evidence failed. Decide whether the **code** drifted (fix it and re-verify) or
the **claim** is genuinely outdated (refute or rewrite it). See
[Verifying memories](/guides/verifying).

### My memory's confidence keeps dropping even though nothing's wrong.
Memories without machine-checkable evidence **decay** over time by design. Attach evidence so
it re-verifies itself, or **pin** it if it's foundational and shouldn't expire.

### What's the difference between `refute` and `forget`?
`refute` keeps the memory as *negative knowledge* ("we believed this until it stopped being
true"). `forget` deletes it entirely. Prefer `refute`.

### Why didn't my agent's learning show up immediately?
Agent-proposed and mined memories enter the [review queue](/guides/review-queue) first. Run
`dim review` to approve them.

## Capture

### `dim bootstrap` / `dim mine --llm` says "no LLM provider available"
These features synthesize claims with a text LLM. Run [Ollama](https://ollama.com) locally
(auto-detected) or set `OPENAI_API_KEY`. You can force a provider with
`AIDIMAG_LLM=openai|ollama|off`.

### `dim mine --prs` doesn't find anything
PR mining needs the [`gh` CLI](https://cli.github.com) installed and authenticated
(`gh auth status`), plus an LLM provider. It only scans PRs merged since the last run —
use `dim mine --prs --full` to rescan everything.

### A teammate's memory says its evidence was "skipped (untrusted)"
That's the security trust gate: evidence commands that arrive via team sync never execute
until you inspect and approve them with `dim verify --trust`. See the
[CLI reference](/cli-reference#dim-verify).

## Context files

### My `CLAUDE.md` changes were overwritten.
`dim generate-context` owns that file — don't edit it by hand. Edit the underlying memory and
regenerate. Turn on `--auto` so it stays current automatically.

### A stale fact isn't in my generated context — is that a bug?
No, that's intended. Generated files exclude stale and refuted memories so tools never read
knowledge you can't currently trust.

## Team sync

### Two machines edited the same memory — who wins?
Last-writer-wins by modification time. Deletions propagate via tombstones. For verification,
the server aggregates results across machines into consensus.

### I don't want to share the admin token with the team.
Don't — mint brain-scoped member keys with `dim keys create`, or use `dim login`. See
[Team sync](/guides/team-sync).

## Still stuck?

- `dim <command> --help` shows usage for any command.
- Run the failing command with `AIDIMAG_DEBUG=1` — best-effort features (auto-sync,
  embeddings, LLM mining) fail silently by design; debug mode prints every swallowed error.
- Check `dim status` to see the store's health at a glance.
- Open `dim ui` for a visual view of memories, proposals, and the graph.

