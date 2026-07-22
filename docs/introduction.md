---
title: What is aiDimag? | Introduction to Verified Memory for AI Agents
description: Learn how aiDimag solves the forgetfulness problem in AI coding assistants with verified, falsifiable memory that stays true as your code evolves.
head:
  - - meta
    - name: keywords
      content: aiDimag introduction, AI memory system, verified memory, falsifiable claims, AI coding assistant memory, dim CLI, codebase knowledge
  - - meta
    - property: og:title
      content: What is aiDimag? Introduction to Verified Memory
  - - meta
    - property: og:url
      content: https://aidimag.com/introduction
  - - link
    - rel: canonical
      href: https://aidimag.com/introduction
---

# What is aiDimag?

**aiDimag** is a memory system for AI coding agents. Its command-line
tool is called **`dim`**.

## The problem it solves

AI coding assistants are powerful but **forgetful**. Every new session starts from zero:

- They re-discover the same architecture you explained yesterday.
- They repeat approaches your team already tried and abandoned.
- They confidently follow a "convention" that was true six months ago but isn't anymore.
- They have no idea which rules are sacred ("never call the production API from a test").

Teams try to fix this with a big `CLAUDE.md` or a wiki, but those rot. Nobody updates them,
and worse — **nothing checks whether what they say is still true.** A stale instruction is
more dangerous than no instruction, because the agent trusts it.

## The idea: verified memory

aiDimag treats every piece of knowledge as a **falsifiable claim with evidence**, not a
free-text note. For example:

> **Claim:** "All database access goes through `src/db/store.ts`; nothing else imports
> `better-sqlite3`."
>
> **Evidence:** the shell command `grep -rL better-sqlite3 src --include=*.ts` (passes only
> if the claim holds).

Because the claim is checkable, aiDimag can **re-run the evidence as your code changes**:

- If the check still passes, the memory stays **trusted**.
- If the code changes and the check fails, the memory is marked **stale** — and the agent
  is told *not* to rely on it until it's re-confirmed.

That's the whole wedge: **memory that proves itself, instead of memory you hope is right.**

## What you can remember

aiDimag organizes knowledge into **kinds**:

| Kind | What it captures |
|---|---|
| **Decision** | A choice you made and why (what you rejected) |
| **Convention** | A rule the repo consistently follows |
| **Gotcha** | Surprising behavior that cost someone time |
| **Failed approach** | Something tried that did *not* work — so nobody retries it |
| **Architecture** | How the pieces fit together |
| **Invariant** | Something that must always (or never) hold |
| **Guardrail** | A behavioral rule for agents: *never*, *ask first*, or *always* |
| **Skill** | A reusable step-by-step procedure (e.g. "how we deploy") |
| **Todo context** | Unfinished work plus the context to resume it |

## Who it's for

- **Developers** who pair with AI agents and want them to stop forgetting.
- **Teams** who want a shared, self-correcting brain for a codebase.
- **Any AI tool** — aiDimag speaks the [Model Context Protocol](/mcp) for Claude Code,
  Cursor, and Copilot, *and* generates plain context files (`CLAUDE.md`, `.cursorrules`,
  `copilot-instructions.md`) for tools that don't.

## What makes it different

- **Local-first.** Everything lives in a single SQLite file in `.aidimag/` next to your
  code. No account required to start.
- **Human-gated.** Nothing becomes active memory automatically — proposals wait in a review
  queue until you approve them.
- **Self-correcting.** Memories carry confidence that decays over time and collapses when
  evidence fails, so trust expires instead of lingering.
- **Team-optional.** Add a self-hosted sync server when you want a shared brain. No SaaS lock-in.

Next: **[Core concepts](/concepts)** explains the moving parts, or jump to
**[Getting started](/getting-started)**.

