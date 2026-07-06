/**
 * Ticketing commands: ticket (connect/status/disconnect/show/share/branch-rule),
 * branch, branch-check (hidden hook helper).
 */

import type { Command } from "commander";
import { findRepoRoot } from "../../db/store.js";
import { fail, createPrompter, openBrowser } from "../shared.js";

const TICKET_PROVIDERS = ["jira", "github", "linear", "http", "remote"] as const;
type TicketProviderName = (typeof TICKET_PROVIDERS)[number];
type BranchEnforce = "push" | "warn" | "off";

export function registerTicketCommands(program: Command): void {
  program
    .command("ticket")
    .description("Connect a ticketing app so proposals carry real context (Jira, GitHub Issues, Linear, the team sync server, or your own HTTP middleware)")
    .argument("<action>", "connect | status | disconnect | show | share | branch-rule")
    .argument("[id]", "Ticket id for 'show' (e.g. XXX-2100 or #123) · provider name for 'connect' (jira|github|linear|http|remote)")
    .option("--provider <name>", "jira | github | linear | http | remote (connect/share)")
    .option("--url <baseUrl>", "Jira site / GitHub repo URL / middleware endpoint (connect/share)")
    .option("--token <credential>", "Jira: email:apiToken or PAT · GitHub/Linear: token · http: optional bearer (connect/share)")
    .option("--pattern <regex>", "Ticket-id pattern for branch/commit extraction (connect) · branch pattern (branch-rule)")
    .option("--enforce <mode>", "push | warn | off (branch-rule)")
    .option("--exempt <branches...>", "Exempt branch regexes, e.g. main develop 'release/.*' (branch-rule)")
    .option("--print <host>", "Emit the server-side rule for github | gitlab | bitbucket (branch-rule)")
    .option("--remove", "Remove the team ticket config from the sync server (share)")
    .option("--admin-token <token>", "Sync-server admin token (share; or AIDIMAG_ADMIN_TOKEN env)")
    .option("--no-open", "Don't open the API-token page in the browser (connect)")
    .action(async (action: string, id: string | undefined, opts) => {
      const root = findRepoRoot() ?? fail("not inside a repo");
      const tickets = await import("../../tickets/provider.js");
      switch (action) {
        case "connect": {
          // provider: positional (`dim ticket connect jira`), flag, or asked interactively
          let provider = (id ?? opts.provider)?.toLowerCase() as TicketProviderName | undefined;
          if (provider && !TICKET_PROVIDERS.includes(provider)) {
            fail(`unknown provider '${provider}' — use ${TICKET_PROVIDERS.join(", ")}`);
          }
          // Prompt for anything missing — the prompter queues piped lines, so
          // scripted/agent-driven input works too; on closed stdin answers come
          // back empty and we fail fast instead of hanging (CI-safe).
          const needsUrl = !opts.url && provider !== "linear" && provider !== "remote";
          const interactive = !provider || (provider !== "remote" && (needsUrl || !opts.token));
          const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
          const existing = tickets.readTicketsConfig(root);

          const { ask, close } = interactive ? await createPrompter() : { ask: async () => "", close: () => undefined };
          try {
            if (!provider) {
              console.log("🎫 Let's connect your ticketing app — proposals will carry the *why* from your tickets.\n");
              const ans = (await ask(`   Which one? [${TICKET_PROVIDERS.join(" | ")}]  `)).trim().toLowerCase();
              if (!TICKET_PROVIDERS.includes(ans as TicketProviderName)) fail(`unknown provider '${ans}' — use ${TICKET_PROVIDERS.join(", ")}`);
              provider = ans as TicketProviderName;
            }

            // ---- remote: zero local credentials — the sync server is the middleman
            if (provider === "remote") {
              const { readCloudConfig, getToken } = await import("../../sync/client.js");
              const cloud = readCloudConfig(root);
              if (!cloud) fail("remote tickets ride the sync channel — link the repo first: dim cloud link (then an admin runs `dim ticket share`)");
              tickets.writeTicketsConfig(root, {
                ...existing,
                provider: "remote",
                baseUrl: undefined,
                pattern: opts.pattern ?? existing.pattern ?? tickets.DEFAULT_TICKET_PATTERN,
              });
              console.log(`🎫 Connected via the team sync server (${cloud.server}, brain: ${cloud.brain}).`);
              console.log(`   Zero local ticket credentials — the server holds the team token.`);
              if (!getToken(cloud.server)) console.log(`   ⚠ No sync token on this machine yet — run \`dim login\` first.`);
              // trust-building: check the server actually has a team config
              try {
                const res = await fetch(`${cloud.server}/v1/ticket-config?brain=${encodeURIComponent(cloud.brain)}`, {
                  headers: { Authorization: `Bearer ${getToken(cloud.server) ?? ""}` },
                });
                const body = (await res.json()) as { config?: { provider?: string } | null };
                if (res.ok && body.config?.provider) {
                  console.log(`   ✓ Server is set up for ${body.config.provider} tickets — try \`dim ticket show <id>\`.`);
                } else {
                  console.log(`   ⚠ The server has no team ticket config yet — an admin should run \`dim ticket share\`.`);
                }
              } catch {
                console.log(`   (couldn't reach the server to check its ticket config — it may be offline)`);
              }
              break;
            }

            // ---- direct providers: jira | github | linear | http
            let baseUrl = (opts.url as string | undefined)?.replace(/\/$/, "");
            if (!baseUrl && provider !== "linear") {
              const what =
                provider === "jira" ? "your Jira site URL (e.g. https://acme.atlassian.net)"
                : provider === "github" ? "the repo URL (e.g. https://github.com/acme/api)"
                : "your middleware endpoint (implements GET /ticket/:id)";
              baseUrl = (await ask(`   What's ${what}?\n   › `)).trim().replace(/\/$/, "");
              if (!baseUrl) fail("a base URL is required");
            }

            let token = opts.token as string | undefined;
            if (!token && interactive) {
              const page = tickets.TOKEN_PAGES[provider];
              if (page) {
                console.log(`\n   You'll need an API token — grab one here:\n   ${page}`);
                if (opts.open && isTTY) await openBrowser(page);
              }
              const hint =
                provider === "jira" ? "email:apiToken (or a PAT)"
                : provider === "http" ? "bearer token (enter to skip — optional for internal services)"
                : "token";
              token = (await ask(`\n   Paste your ${hint}: `)).trim() || undefined;
            }
            if (!token && provider !== "http") {
              console.log(`   ⚠ No credential provided — you can add one later (re-run connect, or set AIDIMAG_TICKET_TOKEN).`);
            }

            const credKey = baseUrl ?? "linear";
            tickets.writeTicketsConfig(root, {
              ...existing,
              provider,
              baseUrl,
              pattern: opts.pattern ?? existing.pattern ?? (provider === "github" ? "#\\d+" : tickets.DEFAULT_TICKET_PATTERN),
            });
            if (token) tickets.saveTicketCredential(credKey, token);
            console.log(`\n🎫 Connected ${provider}${baseUrl ? ` at ${baseUrl}` : ""}.`);
            console.log(`   Config in .aidimag/config.json (commit it — no secrets inside).`);
            if (token) console.log(`   Credential stored in ~/.aidimag/credentials.json (this machine only).`);

            // trust-building: validate with a live round-trip
            const p = tickets.ticketProviderFor(root);
            if (p && interactive) {
              const sample = (await ask(`   Validate with a real ticket? Enter an id (or press enter to skip): `)).trim();
              if (sample) {
                const t = await p.getTicket(sample).catch((e: Error) => fail(`validation fetch failed: ${e.message}`));
                console.log(t ? `   ✓ Validated — fetched ${t.id}: “${t.title}”` : `   ⚠ ${sample} not found (connection works, ticket doesn't exist)`);
              } else {
                console.log(`   Tip: validate any time with \`dim ticket show <id>\`.`);
              }
            } else if (p) {
              console.log(`   Tip: validate with \`dim ticket show <id>\`.`);
            }
          } finally {
            close();
          }
          break;
        }
        case "status": {
          const cfg = tickets.readTicketsConfig(root);
          if (!cfg.provider) {
            console.log("No ticketing app connected. Run `dim ticket connect` to set one up interactively.");
            break;
          }
          if (cfg.provider === "remote") {
            const { readCloudConfig, getToken } = await import("../../sync/client.js");
            const cloud = readCloudConfig(root);
            console.log(`provider: remote (via the team sync server)\nserver:   ${cloud?.server ?? "NOT LINKED — dim cloud link"}\nbrain:    ${cloud?.brain ?? "—"}\npattern:  ${cfg.pattern ?? tickets.DEFAULT_TICKET_PATTERN}\ntoken:    ${cloud && getToken(cloud.server) ? "sync token stored" : "MISSING — dim login"}`);
          } else {
            const credKey = cfg.baseUrl ?? "linear";
            console.log(`provider: ${cfg.provider}${cfg.baseUrl ? `\nbaseUrl:  ${cfg.baseUrl}` : ""}\npattern:  ${cfg.pattern ?? tickets.DEFAULT_TICKET_PATTERN}\ntoken:    ${tickets.getTicketCredential(credKey) ? "stored" : "MISSING"}`);
          }
          const branch = cfg.branch;
          if (branch?.pattern) console.log(`branch:   ${branch.pattern} (enforce: ${branch.enforce ?? "off"})`);
          break;
        }
        case "disconnect": {
          const existing = tickets.readTicketsConfig(root);
          tickets.writeTicketsConfig(root, { branch: existing.branch }); // keep branch rules, drop provider
          console.log("🎫 Disconnected (credential kept in ~/.aidimag/credentials.json — remove manually if needed).");
          break;
        }
        case "show": {
          if (!id) fail("usage: dim ticket show <id>");
          const p = tickets.ticketProviderFor(root) ?? fail("no ticketing app connected (or credential missing) — run `dim ticket connect` first");
          const t = await p.getTicket(id);
          if (!t) fail(`ticket ${id} not found`);
          console.log(`🎫 ${t.id} — ${t.title}\n   ${t.type} · ${t.status}${t.labels.length ? ` · ${t.labels.join(", ")}` : ""}${t.parent ? `\n   part of ${t.parent.id} “${t.parent.title}”` : ""}\n   ${t.url}`);
          if (t.body) console.log(`\n${t.body}`);
          break;
        }
        // T3: admin pushes the team's ticket credential to the sync server —
        // teammates then run `dim ticket connect remote` and never hold a token.
        case "share": {
          const { readCloudConfig } = await import("../../sync/client.js");
          const cloud = readCloudConfig(root) ?? fail("repo is not cloud-linked — run `dim cloud link` first");
          const admin = opts.adminToken ?? process.env.AIDIMAG_ADMIN_TOKEN;
          if (!admin) fail("provide --admin-token or set AIDIMAG_ADMIN_TOKEN (share configures TEAM credentials — admin only)");
          const endpoint = `${cloud.server}/v1/ticket-config?brain=${encodeURIComponent(cloud.brain)}`;
          if (opts.remove) {
            const res = await fetch(endpoint, { method: "DELETE", headers: { Authorization: `Bearer ${admin}` } });
            const body = (await res.json()) as { removed?: boolean; error?: string };
            if (!res.ok) fail(`server: ${body.error ?? res.status}`);
            console.log(body.removed ? "🎫 Team ticket config removed from the server." : "No team ticket config to remove.");
            break;
          }
          const local = tickets.readTicketsConfig(root);
          const provider = (opts.provider ?? (local.provider !== "remote" ? local.provider : undefined)) as string | undefined;
          if (!provider) fail("usage: dim ticket share --provider jira|github|linear|http --url <baseUrl> --token <credential> (defaults come from this repo's `dim ticket connect`)");
          const baseUrl = (opts.url as string | undefined)?.replace(/\/$/, "") ?? local.baseUrl ?? "";
          const credential = (opts.token as string | undefined) ?? tickets.getTicketCredential(baseUrl || "linear") ?? undefined;
          if (!credential && provider !== "http") fail("no credential to share — pass --token (or connect locally first so it can be reused)");
          const res = await fetch(endpoint, {
            method: "PUT",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin}` },
            body: JSON.stringify({ provider, baseUrl, credential }),
          });
          const body = (await res.json()) as { ok?: boolean; error?: string };
          if (!res.ok) fail(`server: ${body.error ?? res.status}`);
          console.log(`🎫 Team ticket config stored on ${cloud.server} (brain: ${cloud.brain}, provider: ${provider}).`);
          console.log(`   Teammates: \`dim ticket connect remote\` — zero local ticket credentials, server-side caching.`);
          break;
        }
        // T1.5/T3: manage the branch convention + emit the matching server-side rule
        case "branch-rule": {
          const existing = tickets.readTicketsConfig(root);
          if (opts.pattern || opts.enforce || opts.exempt) {
            const enforce = opts.enforce as BranchEnforce | undefined;
            if (enforce && !["push", "warn", "off"].includes(enforce)) fail(`--enforce must be push, warn, or off (got '${enforce}')`);
            tickets.writeTicketsConfig(root, {
              ...existing,
              branch: {
                ...existing.branch,
                ...(opts.pattern ? { pattern: opts.pattern } : {}),
                ...(enforce ? { enforce } : {}),
                ...(opts.exempt ? { exempt: opts.exempt as string[] } : {}),
              },
            });
            console.log("🌿 Branch convention saved to .aidimag/config.json (commit it — every member's hooks enforce it after `dim init`).");
          }
          const rules = tickets.readTicketsConfig(root).branch ?? {};
          if (!rules.pattern) {
            console.log("No branch convention configured. Set one with:\n  dim ticket branch-rule --pattern '^(feature|bugfix|hotfix|chore)/[A-Z][A-Z0-9]+-\\d+(-[a-z0-9-]+)?$' --enforce push");
            break;
          }
          if (!opts.print) {
            console.log(`pattern: ${rules.pattern}\nenforce: ${rules.enforce ?? "off"}\nexempt:  ${(rules.exempt ?? ["main", "master", "develop", "release/.*", "HEAD"]).join(", ")}`);
            console.log(`\nCatch --no-verify bypassers with a server-side rule: dim ticket branch-rule --print github|gitlab|bitbucket`);
            break;
          }
          const host = String(opts.print).toLowerCase();
          const exempt = rules.exempt ?? ["main", "master", "develop", "release/.*"];
          if (host === "github") {
            console.log(`GitHub ruleset (Settings → Rules → Rulesets → New branch ruleset → import JSON),\nor: gh api repos/{owner}/{repo}/rulesets --input ruleset.json\n`);
            console.log(JSON.stringify({
              name: "aidimag branch convention",
              target: "branch",
              enforcement: rules.enforce === "push" ? "active" : "evaluate",
              conditions: { ref_name: { include: ["~ALL"], exclude: exempt.map((e) => `refs/heads/${e}`) } },
              rules: [{ type: "branch_name_pattern", parameters: { operator: "regex", pattern: rules.pattern, negate: false, name: "ticket-prefixed branches" } }],
            }, null, 2));
          } else if (host === "gitlab") {
            console.log(`GitLab push rules (Settings → Repository → Push rules → Branch name), or via API:\n`);
            console.log(`  curl --request PUT --header "PRIVATE-TOKEN: <token>" \\\n    "https://gitlab.example.com/api/v4/projects/<id>/push_rule" \\\n    --data-urlencode "branch_name_regex=${rules.pattern}"`);
            console.log(`\nNote: exempt branches (${exempt.join(", ")}) should be protected branches — push rules don't apply to them.`);
          } else if (host === "bitbucket") {
            console.log(`Bitbucket branch restrictions (Repository settings → Branch restrictions), or via API:\n`);
            console.log(JSON.stringify({ kind: "branch-name-pattern", pattern: rules.pattern, note: "Requires Premium; exempt: " + exempt.join(", ") }, null, 2));
          } else {
            fail(`unknown host '${opts.print}' — use github, gitlab, or bitbucket`);
          }
          break;
        }
        default:
          fail(`unknown action '${action}'. Use: connect | status | disconnect | show | share | branch-rule`);
      }
    });

  program
    .command("branch")
    .description("Create a convention-conforming branch for a ticket (fetches the title for the slug when connected)")
    .argument("<ticketId>", "e.g. XXX-2100")
    .option("-p, --prefix <prefix>", "Branch prefix", "feature")
    .action(async (ticketId: string, opts) => {
      const root = findRepoRoot() ?? fail("not inside a git repo");
      const { ticketProviderFor, buildBranchName } = await import("../../tickets/provider.js");
      const provider = ticketProviderFor(root);
      let title: string | undefined;
      if (provider) {
        const t = await provider.getTicket(ticketId).catch(() => null);
        title = t?.title;
        if (t) console.log(`🎫 ${t.id}: “${t.title}”`);
      }
      const name = buildBranchName(ticketId, title, opts.prefix);
      const { execFileSync } = await import("node:child_process");
      execFileSync("git", ["checkout", "-b", name], { cwd: root, stdio: "inherit" });
      console.log(`🌿 You're on ${name} — commits here will carry ${ticketId} automatically.`);
    });

  program
    .command("branch-check", { hidden: true })
    .description("Validate the current branch against the team convention (used by git hooks)")
    .option("--warn", "Warn only (post-checkout)")
    .option("--push", "Exit 1 on violation when enforce mode is 'push' (pre-push)")
    .action(async (opts) => {
      const root = findRepoRoot();
      if (!root) return;
      const { checkBranchName } = await import("../../tickets/provider.js");
      const { execFileSync } = await import("node:child_process");
      let branch = "";
      try {
        branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
      } catch {
        return; // detached HEAD / not a repo — nothing to check
      }
      const r = checkBranchName(root, branch);
      if (r.ok || r.exempt || r.enforce === "off") return;
      const fixHint = `git branch -m ${branch} <conforming-name>   (or next time: dim branch <TICKET-ID>)`;
      if (opts.push && r.enforce === "push") {
        console.error(`\n🌿 aidimag: branch '${branch}' doesn't match the team convention (${r.pattern}).`);
        console.error(`   Pushes of non-conforming branches are blocked. Rename with:\n   ${fixHint}\n`);
        process.exit(1);
      }
      console.error(`🌿 aidimag: heads up — '${branch}' doesn't match the team's branch convention (${r.pattern}). Fix: ${fixHint}`);
    });
}

