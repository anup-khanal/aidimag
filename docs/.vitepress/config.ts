import { defineConfig } from "vitepress";

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: "AI Dimag",
  description:
    "aiDimag — persistent, verified memory for AI coding agents. Plain-English docs for the dim CLI, MCP server, IDE extensions, and team sync.",
  lang: "en-US",

  // GitHub Pages project site lives at https://<user>.github.io/aidimag/
  // If you deploy to a custom domain or a user/org root site, set base to "/".
  base: "/aidimag/",

  lastUpdated: true,
  cleanUrls: true,
  ignoreDeadLinks: true,

  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/aidimag/favicon.svg" }],
    ["meta", { name: "theme-color", content: "#2563eb" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "AI Dimag — verified memory for AI coding agents" }],
    [
      "meta",
      {
        property: "og:description",
        content:
          "Your codebase remembers its decisions, conventions, gotchas, and rules — and proves they're still true.",
      },
    ],
    ["meta", { property: "og:image", content: "/aidimag/logo.svg" }],
    ["meta", { name: "twitter:card", content: "summary" }],
  ],

  themeConfig: {
    logo: { src: "/logo.svg", alt: "aiDimag logo" },

    nav: [
      { text: "Home", link: "/" },
      { text: "Introduction", link: "/introduction" },
      { text: "Getting Started", link: "/getting-started" },
      { text: "CLI Reference", link: "/cli-reference" },
      { text: "Guides", link: "/guides/claims-and-evidence" },
      { text: "Pricing", link: "/pricing" },
    ],

    sidebar: [
      {
        text: "Overview",
        items: [
          { text: "Introduction", link: "/introduction" },
          { text: "Core concepts", link: "/concepts" },
          { text: "How it works", link: "/how-it-works" },
        ],
      },
      {
        text: "Getting started",
        items: [
          { text: "Install & setup", link: "/getting-started" },
          { text: "Quick start (5 minutes)", link: "/quickstart" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "CLI reference", link: "/cli-reference" },
          { text: "Configuration", link: "/configuration" },
          { text: "MCP integration", link: "/mcp" },
          { text: "IDE extensions", link: "/ide-extensions" },
          { text: "Web dashboard", link: "/dashboard" },
        ],
      },
      {
        text: "Guides",
        items: [
          { text: "Writing claims & evidence", link: "/guides/claims-and-evidence" },
          { text: "Verifying memories", link: "/guides/verifying" },
          { text: "The review queue", link: "/guides/review-queue" },
          { text: "Guardrails", link: "/guides/guardrails" },
          { text: "Skills", link: "/guides/skills" },
          { text: "Pinned memories", link: "/guides/pinned" },
          { text: "Generating context files", link: "/guides/generate-context" },
          { text: "Pre-commit checks", link: "/guides/dim-check" },
          { text: "Session briefings", link: "/guides/session-briefing" },
          { text: "Connecting tickets", link: "/guides/tickets" },
          { text: "Team sync", link: "/guides/team-sync" },
          { text: "Knowledgebase", link: "/guides/knowledgebase" },
        ],
      },
      {
        text: "Help",
        items: [
          { text: "FAQ & troubleshooting", link: "/faq" },
          { text: "Glossary", link: "/glossary" },
          { text: "Pricing & licensing", link: "/pricing" },
        ],
      },
    ],

    socialLinks: [{ icon: "github", link: "https://github.com/anupkhanal/aidimag" }],

    search: { provider: "local" },

    footer: {
      message: "Licensed under Elastic License 2.0 — free for teams of 10 or fewer users.",
      copyright: "Copyright © 2025 Anup Khanal",
    },

    editLink: {
      pattern: "https://github.com/anupkhanal/aidimag/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
  },
});

