---
layout: home

hero:
  name: AI Dimag
  text: Verified memory for AI coding agents
  tagline: Your codebase remembers its decisions, conventions, gotchas, and rules — and proves they're still true.
  image:
    src: /hero-illustration.svg
    alt: The aiDimag memory loop — remember, verify, flag stale facts, deliver to AI tools
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: What is aiDimag?
      link: /introduction
    - theme: alt
      text: CLI reference
      link: /cli-reference

features:
  - icon: 🧠
    title: Never explain your codebase twice
    details: Your AI assistant remembers the decisions, conventions, gotchas, and dead ends you've already worked through — so every new session starts where the last one left off.
  - icon: ✅
    title: Knowledge you can actually trust
    details: Each memory comes with a way to check it's still true. As your code changes, aiDimag re-checks and flags anything that's gone out of date — no more acting on stale advice.
  - icon: 🚦
    title: Rules your AI will respect
    details: Set guardrails like "never", "ask first", or "always". They guide every AI tool, show up at the start of each session, and can even stop a risky change before it's committed.
  - icon: 🔌
    title: Plays nice with your AI tools
    details: Connects directly to Claude Code, Cursor, and Copilot — and for anything else, it writes a CLAUDE.md, .cursorrules, and Copilot instructions file your tools already read.
  - icon: 👥
    title: Yours by default, shared when you want
    details: Everything lives in one file inside your repo — no account needed to start. Ready for a team? Spin up your own sync server and share a brain. No SaaS, no lock-in.
  - icon: 🧩
    title: Use it your way
    details: Browse and add memories right inside VSCode or IntelliJ, or open the friendly web dashboard with one command (dim ui).
---

## In one sentence

**aiDimag gives AI coding agents a long-term memory of your codebase that is checked
against reality**, so they stop re-discovering the same things — and stop trusting facts
that have since become false.

## The 30-second mental model

- You (or your agent) **remember** things as short, checkable claims:
  *"All database access goes through `src/db/store.ts`."*
- aiDimag attaches **evidence** (a command, a commit, a test) and **verifies** it over time.
- When the code changes and a claim no longer holds, it's marked **stale** so nobody trusts it.
- The most important rules can be **pinned** (never expire) and turned into **guardrails**
  the agent must obey.
- All of it is fed to your AI tools automatically.

Head to **[Getting started](/getting-started)** to set it up in your repo, or read
**[What is aiDimag?](/introduction)** for the why.

