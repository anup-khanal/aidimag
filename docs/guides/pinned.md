# Pinned memories

Most memory is meant to **expire** unless it keeps proving itself — that's the whole point of
confidence decay. But some knowledge is foundational and should never fade just because time
passed. For that, **pin** it.

## What pinning does

- **Exempt from time decay.** A pinned memory won't lose confidence (or get demoted) just
  from age.
- **Still falsifiable.** If its evidence fails, it still goes **stale**. Pinning protects
  against *forgetting*, not against *being wrong*.

> "Never decays" is not the same as "never wrong." A pinned memory whose `STATIC_CHECK` fails
> is still marked stale — exactly as it should be.

## Pin and unpin

```sh
dim pin 4f3a9c21
dim unpin 4f3a9c21
```

Or pin at creation time:

```sh
dim remember "We use last-writer-wins, not CRDTs, for sync" -k DECISION --pin
```

You can also pin/unpin from the [VSCode and IntelliJ](/ide-extensions) extensions.

## What to pin (and what not to)

| Good candidates to pin | Leave unpinned |
|---|---|
| Core architectural decisions | Day-to-day gotchas |
| Hard guardrails ("never log tokens") | Todo context for in-flight work |
| Stable deployment/release skills | Anything you expect to change soon |
| Long-lived invariants | Experimental conventions |

## How pinned memories are treated

- They sort **first** in generated context files (most load-bearing knowledge leads).
- They're shown with a 📌 in the CLI, dashboard, and IDE panels.
- `dim status` reports how many memories are pinned.

## The knowledgebase connection

[Knowledgebase ingestion](/guides/knowledgebase) turns approved
summaries of your project docs into **pinned** memories — because reference material
(design docs, ADRs, style guides) is exactly the "stays with the project forever" case
pinning was built for.

Next: **[Generating context files](/guides/generate-context)**.

