import { defineConfig } from "vitepress";

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: "AI Dimag",
  titleTemplate: ":title | AI Dimag - Verified Memory for AI Coding Agents",
  description:
    "aiDimag — persistent, verified memory for AI coding agents. Plain-English docs for the dim CLI, MCP server, IDE extensions, and team sync.",
  lang: "en-US",

  // Custom domain (aidimag.com) - base path is root
  base: "/",

  lastUpdated: true,
  cleanUrls: true,
  ignoreDeadLinks: true,

  appearance: "dark",

  sitemap: {
    hostname: "https://aidimag.com",
  },

  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
    ["link", { rel: "canonical", href: "https://aidimag.com" }],
    ["link", { rel: "preconnect", href: "https://fonts.googleapis.com" }],
    ["link", { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" }],
    ["meta", { name: "theme-color", content: "#0b1220" }],
    ["meta", { name: "color-scheme", content: "light dark" }],
    ["meta", { name: "viewport", content: "width=device-width, initial-scale=1.0" }],
    ["meta", { name: "robots", content: "index, follow" }],
    ["meta", { name: "author", content: "Anup Khanal" }],
    ["meta", { name: "keywords", content: "AI coding assistant, AI memory, code memory, AI agent, verified memory, coding agent, Claude Code, Cursor, GitHub Copilot, MCP, Model Context Protocol, dim CLI, aiDimag, codebase memory, AI tools" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "AI Dimag" }],
    ["meta", { property: "og:url", content: "https://aidimag.com" }],
    ["meta", { property: "og:title", content: "AI Dimag — verified memory for AI coding agents" }],
    [
      "meta",
      {
        property: "og:description",
        content:
          "Your codebase remembers its decisions, conventions, gotchas, and rules — and proves they're still true.",
      },
    ],
    ["meta", { property: "og:image", content: "https://aidimag.com/logo.svg" }],
    ["meta", { property: "og:image:alt", content: "AI Dimag logo" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:site", content: "@aidimag" }],
    ["meta", { name: "twitter:title", content: "AI Dimag — verified memory for AI coding agents" }],
    ["meta", { name: "twitter:description", content: "Your codebase remembers its decisions, conventions, gotchas, and rules — and proves they're still true." }],
    ["meta", { name: "twitter:image", content: "https://aidimag.com/logo.svg" }],
    [
      "script",
      {
        async: "",
        src: "https://www.googletagmanager.com/gtag/js?id=G-TGYE1Y8YGJ",
      },
    ],
    [
      "script",
      {},
      `window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('consent', 'default', {
  'analytics_storage': 'denied',
  'ad_storage': 'denied',
  'ad_user_data': 'denied',
  'ad_personalization': 'denied'
});
gtag('config', 'G-TGYE1Y8YGJ');`,
    ],
    [
      "script",
      { type: "application/ld+json" },
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        "name": "AI Dimag",
        "applicationCategory": "DeveloperApplication",
        "operatingSystem": "Cross-platform",
        "description": "Persistent, verified memory for AI coding agents. Your codebase remembers its decisions, conventions, gotchas, and rules — and proves they're still true.",
        "url": "https://aidimag.com",
        "author": {
          "@type": "Person",
          "name": "Anup Khanal"
        },
        "offers": {
          "@type": "Offer",
          "price": "0",
          "priceCurrency": "USD",
          "description": "Free for teams of 10 or fewer users"
        },
        "softwareVersion": "1.0.0",
        "aggregateRating": {
          "@type": "AggregateRating",
          "ratingValue": "5",
          "ratingCount": "1"
        }
      })
    ],
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
          { text: "Cloud sync TLDR", link: "/cloud-quickstart" },
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

    socialLinks: [{ icon: "github", link: "https://github.com/anup-khanal/aidimag" }],

    search: { provider: "local" },

    footer: {
      message: "Licensed under Elastic License 2.0 — free for teams of 10 or fewer users.",
      copyright: "Copyright © 2026 Anup Khanal",
    },

    editLink: {
      pattern: "https://github.com/anup-khanal/aidimag/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
  },
});

