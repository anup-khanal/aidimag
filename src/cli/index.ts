#!/usr/bin/env node
/**
 * dim — the aidimag CLI (dimag = brain).
 *
 *   dim init                 initialize .aidimag/ in the current repo
 *   dim remember "<claim>"   store a memory
 *   dim recall <query|path>  search memories
 *   dim status               memory store summary
 *   dim verify               re-run evidence, update statuses
 *   dim log                  recent memories
 *   dim forget <id>          delete a memory
 */

import { Command } from "commander";
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryStore, findRepoRoot, dbPathFor, AIDIMAG_DIR } from "../db/store.js";
import { mineCommits } from "../capture/commit-miner.js";
import { verifyAll } from "../verify/engine.js";
import { installGitHooks } from "../verify/hooks.js";
import { hybridSearch, indexMemory, reindexAll } from "../embeddings/search.js";
import type { EvidenceType, MemoryEntry, MemoryKind, Proposal } from "../types.js";

/** Version comes from package.json — single source of truth. */
const PKG_VERSION: string = JSON.parse(
  readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8")
).version;

const program = new Command();

const KINDS: MemoryKind[] = [
  "DECISION", "CONVENTION", "GOTCHA", "FAILED_APPROACH",
  "ARCHITECTURE", "INVARIANT", "TODO_CONTEXT",
];

function fail(msg: string): never {
  console.error(`dim: ${msg}`);
  process.exit(1);
}

function printMemory(m: MemoryEntry, verbose = false): void {
  const statusIcon =
    m.status === "VERIFIED" ? "✓" : m.status === "REFUTED" ? "✗" : m.status === "STALE" ? "~" : "?";
  console.log(`${statusIcon} [${m.kind}] ${m.claim}`);
  const scope = [...m.scope.paths, ...m.scope.symbols];
  console.log(
    `    id=${m.id.slice(0, 8)} status=${m.status} conf=${m.confidence.toFixed(2)}` +
      (scope.length ? ` scope=${scope.join(",")}` : "")
  );
  if (verbose && m.grounding.length) {
    for (const e of m.grounding) {
      console.log(`    evidence: ${e.type}(${e.result}) ${e.payload}`);
    }
  }
}

program
  .name("dim")
  .description("aidimag — persistent, verified memory for AI coding agents")
  .version(PKG_VERSION, "-v, --version", "print the aidimag version");

program
  .command("init")
  .description("Initialize aidimag in the current repo")
  .action(() => {
    const root = findRepoRoot() ?? process.cwd();
    const dir = path.join(root, AIDIMAG_DIR);
    const fresh = !existsSync(dbPathFor(root));
    mkdirSync(dir, { recursive: true });
    const store = new MemoryStore(dbPathFor(root));
    store.close();
    // keep the DB out of git by default (team-sync mode comes later)
    const gitignore = path.join(dir, ".gitignore");
    if (!existsSync(gitignore)) {
      writeFileSync(gitignore, "memory.db\nmemory.db-wal\nmemory.db-shm\n");
    }
    // suggest MCP wiring
    console.log(fresh ? `Initialized aidimag in ${dir}` : `aidimag already initialized in ${dir}`);
    const hooks = installGitHooks(root);
    if (hooks.installed.length) {
      console.log(`Installed git hooks: ${hooks.installed.join(", ")} (re-verify on pull/checkout)`);
    } else if (hooks.alreadyPresent.length) {
      console.log(`Git hooks already installed: ${hooks.alreadyPresent.join(", ")}`);
    }
    console.log(`\nAdd the MCP server to your agent config, e.g. for Claude Code (.mcp.json):`);
    console.log(
      JSON.stringify(
        { mcpServers: { aidimag: { command: "npx", args: ["-y", "aidimag", "mcp"], env: { AIDIMAG_REPO: root } } } },
        null,
        2
      )
    );
    // append .aidimag DB files to repo .gitignore if a git repo
    const rootIgnore = path.join(root, ".gitignore");
    if (existsSync(path.join(root, ".git"))) {
      const current = existsSync(rootIgnore) ? readFileSync(rootIgnore, "utf8") : "";
      if (!current.includes(".aidimag/memory.db")) {
        appendFileSync(rootIgnore, `${current.endsWith("\n") || current === "" ? "" : "\n"}.aidimag/memory.db*\n`);
        console.log(`\nAdded .aidimag/memory.db* to ${rootIgnore}`);
      }
    }
  });

program
  .command("remember")
  .description("Store a memory (write the claim as a falsifiable statement)")
  .argument("<claim>", "The claim to remember")
  .option("-k, --kind <kind>", `Memory kind: ${KINDS.join("|")}`, "GOTCHA")
  .option("-p, --path <paths...>", "Paths this memory applies to")
  .option("-s, --symbol <symbols...>", "Symbols this memory applies to")
  .option(
    "-e, --evidence <spec...>",
    "Evidence as TYPE:payload, e.g. COMMIT_REF:abc123 or STATIC_CHECK:'grep ...'"
  )
  .action(async (claim: string, opts) => {
    const kind = String(opts.kind).toUpperCase() as MemoryKind;
    if (!KINDS.includes(kind)) fail(`invalid kind '${opts.kind}'. Use one of: ${KINDS.join(", ")}`);
    const evidence = (opts.evidence as string[] | undefined)?.map((spec) => {
      const idx = spec.indexOf(":");
      if (idx < 1) fail(`invalid evidence '${spec}'. Format: TYPE:payload`);
      const type = spec.slice(0, idx).toUpperCase() as EvidenceType;
      return { type, payload: spec.slice(idx + 1) };
    });
    const store = MemoryStore.open(process.cwd(), { create: true });
    const entry = store.write({ kind, claim, paths: opts.path, symbols: opts.symbol, evidence, createdBy: "human" });
    printMemory(entry, true);
    await indexMemory(store, entry).catch(() => false);
    store.close();
  });

program
  .command("recall")
  .description("Search memories — hybrid keyword + semantic when embeddings are configured")
  .argument("[query...]", "Keywords to search")
  .option("-p, --path <paths...>", "Restrict to memories scoped to these paths")
  .option("-k, --kind <kind>", "Filter by kind")
  .option("-n, --limit <n>", "Max results", "10")
  .option("--all", "Include refuted memories")
  .action(async (query: string[], opts) => {
    const store = MemoryStore.open();
    const { results, semantic } = await hybridSearch(store, {
      query: query.join(" "),
      paths: opts.path,
      kind: opts.kind ? (String(opts.kind).toUpperCase() as MemoryKind) : undefined,
      limit: parseInt(opts.limit, 10),
      includeRefuted: Boolean(opts.all),
    });
    if (results.length === 0) console.log("No matching memories.");
    for (const m of results) printMemory(m, true);
    if (query.length && !semantic) {
      console.log("\n(keyword search only — set up Ollama or OPENAI_API_KEY for semantic recall, then `dim reindex`)");
    }
    store.close();
  });

program
  .command("reindex")
  .description("Build/refresh semantic embeddings for all memories")
  .action(async () => {
    const store = MemoryStore.open();
    if (!store.vecAvailable) fail("sqlite-vec extension failed to load on this platform");
    const { indexed, provider } = await reindexAll(store);
    if (!provider) {
      fail("no embedding provider available — run Ollama locally or set OPENAI_API_KEY (see AIDIMAG_EMBEDDINGS)");
    }
    console.log(`Indexed ${indexed} memorie(s) with ${provider.name}/${provider.model} (${provider.dim}d).`);
    store.close();
  });

program
  .command("status")
  .description("Memory store summary")
  .action(() => {
    const store = MemoryStore.open();
    const s = store.statusSummary();
    console.log(`aidimag @ ${s.dbPath}`);
    console.log(`total memories: ${s.total}`);
    console.log(`  by status: ${Object.entries(s.byStatus).map(([k, v]) => `${k}=${v}`).join("  ")}`);
    if (Object.keys(s.byKind).length) {
      console.log(`  by kind:   ${Object.entries(s.byKind).map(([k, v]) => `${k}=${v}`).join("  ")}`);
    }
    if (s.pendingProposals) {
      console.log(`\n${s.pendingProposals} proposal(s) awaiting review — run \`dim review\``);
    }
    store.close();
  });

function printProposal(p: Proposal): void {
  console.log(`◆ [${p.id.slice(0, 8)}] ${p.kind} (via ${p.source}${p.sourceRef ? ` @ ${p.sourceRef.slice(0, 8)}` : ""})`);
  console.log(`    ${p.claim}`);
  if (p.paths.length || p.symbols.length) {
    console.log(`    scope: ${[...p.paths, ...p.symbols].join(", ")}`);
  }
  if (p.evidence.length) {
    console.log(`    evidence: ${p.evidence.map((e) => `${e.type}:${e.payload}`).join("  ")}`);
  }
  if (p.rationale) console.log(`    rationale: ${p.rationale}`);
}

program
  .command("mine")
  .description("Mine git history for memory candidates (queued for review, never auto-saved)")
  .option("-n, --max <n>", "Max commits to scan", "500")
  .option("--full", "Rescan from the beginning of history (ignore cursor)")
  .action((opts) => {
    const root = findRepoRoot() ?? fail("not inside a git repo");
    if (!existsSync(path.join(root, ".git"))) fail("commit mining requires a git repo");
    const store = MemoryStore.open(root, { create: true });
    const res = mineCommits(store, root, {
      maxCommits: parseInt(opts.max, 10),
      full: Boolean(opts.full),
    });
    console.log(
      `Scanned ${res.scanned} commit(s): ${res.proposed.length} proposal(s) queued` +
        (res.skippedDuplicates ? `, ${res.skippedDuplicates} duplicate(s) skipped` : "") +
        (res.lastSha ? ` (cursor @ ${res.lastSha.slice(0, 8)})` : "")
    );
    for (const p of res.proposed) printProposal(p);
    if (res.proposed.length) console.log(`\nReview with \`dim review\`.`);
    store.close();
  });

program
  .command("review")
  .description("Review pending memory proposals (approve/reject)")
  .argument("[action]", "list | approve | reject", "list")
  .argument("[id]", "Proposal id (8-char prefix ok); 'all' with approve/reject applies to every pending proposal")
  .option("-n, --limit <n>", "Max proposals to list", "50")
  .action((action: string, id: string | undefined, opts) => {
    const store = MemoryStore.open();
    switch (action) {
      case "list": {
        const pending = store.listProposals("PENDING", parseInt(opts.limit, 10));
        if (pending.length === 0) console.log("No pending proposals.");
        for (const p of pending) printProposal(p);
        if (pending.length) {
          console.log(`\nApprove: dim review approve <id> | Reject: dim review reject <id>`);
        }
        break;
      }
      case "approve": {
        if (!id) fail("usage: dim review approve <id|all>");
        const targets =
          id === "all" ? store.listProposals("PENDING", 1000).map((p) => p.id) : [id];
        for (const t of targets) {
          const entry = store.approveProposal(t);
          console.log(`✓ approved → memory ${entry.id.slice(0, 8)}: ${entry.claim}`);
        }
        break;
      }
      case "reject": {
        if (!id) fail("usage: dim review reject <id|all>");
        const targets =
          id === "all" ? store.listProposals("PENDING", 1000).map((p) => p.id) : [id];
        for (const t of targets) {
          const p = store.rejectProposal(t);
          console.log(`✗ rejected ${p.id.slice(0, 8)}: ${p.claim}`);
        }
        break;
      }
      default:
        fail(`unknown action '${action}'. Use: list | approve | reject`);
    }
    store.close();
  });

program
  .command("verify")
  .description("Re-run evidence and update memory statuses (cheap tier; --deep adds tests/exec)")
  .option("-i, --id <ids...>", "Only verify specific memory ids (prefix ok)")
  .option("-d, --deep", "Also run expensive evidence (TEST_RESULT, EXEC_TRACE)")
  .option("-q, --quiet", "Only print status changes (for git hooks)")
  .action((opts) => {
    const root = findRepoRoot() ?? fail("not inside a repo");
    const store = MemoryStore.open(root);
    const report = verifyAll(store, root, { ids: opts.id, deep: Boolean(opts.deep) });

    for (const r of report.results) {
      const changed = r.after !== r.before || r.decayed;
      if (opts.quiet && !changed) continue;
      const arrow = r.after !== r.before ? `${r.before} → ${r.after}` : r.after;
      const icon = r.after === "VERIFIED" ? "✓" : r.after === "STALE" ? "~" : "?";
      const decayNote = r.decayed ? " (decayed)" : "";
      console.log(`${icon} [${arrow}] conf ${r.confidenceBefore.toFixed(2)}→${r.confidenceAfter.toFixed(2)}${decayNote}  ${r.claim.slice(0, 90)}`);
      for (const o of r.outcomes) {
        if (opts.quiet && o.result !== "FAIL") continue;
        console.log(`    ${o.type}: ${o.result} (${o.detail})`);
      }
    }
    if (!opts.quiet || report.stale > 0) {
      console.log(
        `\nchecked ${report.checked}: ${report.verified} verified, ${report.stale} stale, ${report.decayed} decayed, ${report.unchanged} unchanged`
      );
    }
    store.close();
    if (report.stale > 0) process.exitCode = 2; // signal staleness to scripts
  });

program
  .command("log")
  .description("Show recent memories")
  .option("-n, --limit <n>", "Max entries", "20")
  .action((opts) => {
    const store = MemoryStore.open();
    const memories = store.list(parseInt(opts.limit, 10));
    if (memories.length === 0) console.log("No memories yet. Try `dim remember \"...\"`.");
    for (const m of memories) printMemory(m);
    store.close();
  });

program
  .command("refute")
  .description("Mark a memory REFUTED (kept as negative knowledge, unlike forget)")
  .argument("<id>", "Memory id (full or 8-char prefix)")
  .option("-s, --superseded-by <id>", "Id of a newer memory replacing it")
  .action((id: string, opts) => {
    const store = MemoryStore.open();
    const match = store.list(1000).find((m) => m.id === id || m.id.startsWith(id));
    if (!match) fail(`no memory matching id '${id}'`);
    store.refute(match.id, opts.supersededBy);
    console.log(`✗ refuted ${match.id.slice(0, 8)}: "${match.claim}"`);
    store.close();
  });

program
  .command("forget")
  .description("Delete a memory permanently (prefer refuting via agents)")
  .argument("<id>", "Memory id (full or 8-char prefix)")
  .action((id: string) => {
    const store = MemoryStore.open();
    // allow prefix match
    const match = store.list(1000).find((m) => m.id === id || m.id.startsWith(id));
    if (!match) fail(`no memory matching id '${id}'`);
    store.forget(match.id);
    console.log(`Forgot memory ${match.id}: "${match.claim}"`);
    store.close();
  });

program
  .command("ui")
  .description("Open the local web dashboard (memory list, review queue, visual graph)")
  .option("-p, --port <n>", "Port", "4517")
  .option("--no-open", "Don't open the browser automatically")
  .action(async (opts) => {
    const root = findRepoRoot() ?? fail("not inside a repo");
    const store = MemoryStore.open(root);
    const { startUiServer } = await import("../ui/server.js");
    const url = await startUiServer(store, root, parseInt(opts.port, 10));
    console.log(`aidimag dashboard: ${url}  (Ctrl+C to stop)`);
    if (opts.open) {
      const { exec } = await import("node:child_process");
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      exec(`${opener} ${url}`);
    }
  });

program
  .command("serve")
  .description("Run a self-hosted team sync server")
  .option("-p, --port <n>", "Port", "8787")
  .option("-d, --db <path>", "Server database file", "./aidimag-sync.db")
  .option("-t, --token <token>", "Shared auth token (or AIDIMAG_SYNC_TOKEN env)")
  .action(async (opts) => {
    const token = opts.token ?? process.env.AIDIMAG_SYNC_TOKEN;
    if (!token) fail("provide --token or set AIDIMAG_SYNC_TOKEN");
    const { startSyncServer } = await import("../sync/server.js");
    const url = await startSyncServer({ dbPath: opts.db, token, port: parseInt(opts.port, 10) });
    console.log(`aidimag sync server: ${url}  (db: ${opts.db}, Ctrl+C to stop)`);
    console.log(`Link a repo with: dim cloud link --server ${url} --brain <name> --token <token>`);
  });

program
  .command("cloud")
  .description("Manage the repo's cloud/team-sync binding")
  .argument("<action>", "link | unlink | status")
  .option("-s, --server <url>", "Sync server URL")
  .option("-b, --brain <name>", "Brain (team memory) name on the server")
  .option("-t, --token <token>", "Auth token (stored in ~/.aidimag/credentials.json, NOT the repo)")
  .action(async (action: string, opts) => {
    const root = findRepoRoot() ?? fail("not inside a repo");
    const { readCloudConfig, writeCloudConfig, saveToken, getToken } = await import("../sync/client.js");
    switch (action) {
      case "link": {
        if (!opts.server || !opts.brain) fail("usage: dim cloud link --server <url> --brain <name> [--token <token>]");
        const server = String(opts.server).replace(/\/$/, "");
        writeCloudConfig(root, { server, brain: opts.brain });
        if (opts.token) saveToken(server, opts.token);
        console.log(`Linked to ${server} (brain: ${opts.brain}).`);
        console.log(`Config in .aidimag/config.json (commit it — no secrets inside). Token in ~/.aidimag/credentials.json.`);
        if (!opts.token && !getToken(server)) {
          console.log("⚠ No token stored yet — pass --token or set AIDIMAG_API_KEY before `dim sync`.");
        }
        break;
      }
      case "unlink": {
        writeCloudConfig(root, { server: "", brain: "" } as never);
        console.log("Unlinked (config cleared).");
        break;
      }
      case "status": {
        const cfg = readCloudConfig(root);
        if (!cfg) console.log("Not cloud-linked. Use `dim cloud link`.");
        else console.log(`server: ${cfg.server}\nbrain:  ${cfg.brain}\ntoken:  ${getToken(cfg.server) ? "stored" : "MISSING"}`);
        break;
      }
      default:
        fail(`unknown action '${action}'. Use: link | unlink | status`);
    }
  });

program
  .command("sync")
  .description("Sync this repo's memory with the linked team server (push + pull)")
  .action(async () => {
    const root = findRepoRoot() ?? fail("not inside a repo");
    const store = MemoryStore.open(root);
    const { sync } = await import("../sync/client.js");
    try {
      const r = await sync(store, root);
      console.log(`pushed ${r.pushed}, pulled ${r.pulled} (applied ${r.applied}, kept ${r.skippedOlder} newer local)`);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      store.close();
    }
  });

program
  .command("keys")
  .description("Manage brain-scoped API keys on the sync server (admin token required)")
  .argument("<action>", "create | list | revoke")
  .option("-s, --server <url>", "Server URL (defaults to the repo's linked server)")
  .option("-b, --brain <name>", "Brain the key grants access to (create)")
  .option("-l, --label <text>", "Key label, e.g. 'ci' or 'alice-laptop' (create)")
  .option("-k, --key <key>", "Key to revoke")
  .option("-t, --admin-token <token>", "Admin token (or AIDIMAG_ADMIN_TOKEN env)")
  .action(async (action: string, opts) => {
    const { readCloudConfig } = await import("../sync/client.js");
    const root = findRepoRoot();
    const server: string | undefined = opts.server ?? (root ? readCloudConfig(root)?.server : undefined);
    if (!server) fail("no server: pass --server or link the repo with `dim cloud link`");
    const admin = opts.adminToken ?? process.env.AIDIMAG_ADMIN_TOKEN;
    if (!admin) fail("provide --admin-token or set AIDIMAG_ADMIN_TOKEN");
    const call = async (method: string, pathq: string, body?: unknown) => {
      const res = await fetch(`${server}${pathq}`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin}` },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json();
      if (!res.ok) fail(`server: ${JSON.stringify(json)}`);
      return json;
    };
    switch (action) {
      case "create": {
        if (!opts.brain) fail("usage: dim keys create --brain <name> [--label <text>]");
        const r = (await call("POST", "/v1/keys", { brain: opts.brain, label: opts.label })) as { key: string };
        console.log(`Created key for brain '${opts.brain}':\n${r.key}\n\n⚠ Shown once — store it now (teammates: dim cloud link --token <key>).`);
        break;
      }
      case "list": {
        const r = (await call("GET", "/v1/keys")) as { keys: Array<{ key: string; brain: string; label: string | null; created_at: string; revoked_at: string | null }> };
        if (!r.keys.length) console.log("No keys.");
        for (const k of r.keys) {
          console.log(`${k.revoked_at ? "✗" : "✓"} ${k.key}  brain=${k.brain}${k.label ? `  label=${k.label}` : ""}${k.revoked_at ? "  (revoked)" : ""}`);
        }
        break;
      }
      case "revoke": {
        if (!opts.key) fail("usage: dim keys revoke --key <full-key>");
        const r = (await call("DELETE", `/v1/keys?key=${encodeURIComponent(opts.key)}`)) as { revoked: boolean };
        console.log(r.revoked ? "Key revoked." : "Key not found (or already revoked).");
        break;
      }
      default:
        fail(`unknown action '${action}'. Use: create | list | revoke`);
    }
  });

program
  .command("mcp")
  .description("Run the aidimag MCP server (stdio)")
  .action(async () => {
    await import("../mcp/server.js");
  });

program.parseAsync().catch((err) => fail(err instanceof Error ? err.message : String(err)));

