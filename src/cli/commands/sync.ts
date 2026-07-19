/**
 * Team-sync commands: serve, cloud, login, logout, sync, keys.
 */

import type { Command } from "commander";
import { MemoryStore, findRepoRoot } from "../../db/store.js";
import { fail, maybeRegenerateContext, openBrowser, createPrompter } from "../shared.js";

export function registerSyncCommands(program: Command): void {
  program
    .command("serve")
    .description("Run a self-hosted team sync server")
    .option("-p, --port <n>", "Port", "8787")
    .option("-d, --db <path>", "Server database file", "./aidimag-sync.db")
    .option("-t, --token <token>", "Shared auth token (or AIDIMAG_SYNC_TOKEN env)")
    .action(async (opts) => {
      const token = opts.token ?? process.env.AIDIMAG_SYNC_TOKEN;
      if (!token) fail("provide --token or set AIDIMAG_SYNC_TOKEN");
      const { startSyncServer } = await import("../../sync/server.js");
      const url = await startSyncServer({ dbPath: opts.db, token, port: parseInt(opts.port, 10) });
      console.log(`aidimag sync server: ${url}  (db: ${opts.db}, Ctrl+C to stop)`);
      console.log(`Link a repo with: dim cloud link --server ${url} --brain <name> --token <token>`);
    });

  program
    .command("cloud")
    .description("Manage the repo's cloud/team-sync binding")
    .argument("<action>", "link | unlink | status | remote")
    .option("-s, --server <url>", "Sync server URL")
    .option("-b, --brain <name>", "Brain (team memory) name on the server")
    .option("-t, --token <token>", "Auth token (stored in ~/.aidimag/credentials.json, NOT the repo)")
    .option("--json", "Machine-readable output (remote)")
    .option("--id <memoryId>", "Show one remote memory by id (remote)")
    .option("--limit <n>", "Max rows to list (remote)", "20")
    .option("--summary", "Counts only — skip listing rows (remote)")
    .option("--proposals", "List proposals instead of memories (remote)")
    .option("--all", "With --proposals: include resolved rows (default: pending only)")
    .option("--full", "Include full remote payload JSON (remote)")
    .action(async (action: string, opts) => {
      const root = findRepoRoot() ?? fail("not inside a repo");
      const { readCloudConfig, writeCloudConfig, saveToken, getToken, fetchRemoteSnapshot, syncMetaKey } = await import("../../sync/client.js");
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
        case "remote": {
          const cfg = readCloudConfig(root);
          if (!cfg) fail("not cloud-linked. Use `dim cloud link` first.");
          const store = MemoryStore.open(root);
          let localCursor = 0;
          let localMemories = 0;
          try {
            localCursor = parseInt(store.getMeta(syncMetaKey("sync_pull_cursor", cfg.brain)) ?? "0", 10);
            localMemories = store.statusSummary().total;
          } finally {
            store.close();
          }
          const snapshot = await fetchRemoteSnapshot(root, {
            id: opts.id,
            tbl: opts.proposals ? "proposals" : undefined,
            limit: parseInt(String(opts.limit ?? "20"), 10),
            list: opts.summary ? false : opts.id ? false : true,
            full: Boolean(opts.full || opts.id),
            all: Boolean(opts.all),
          });
          if (opts.json) {
            console.log(JSON.stringify({ server: cfg.server, localCursor, localMemories, ...snapshot }, null, 2));
            break;
          }
          if (snapshot.item) {
            const m = snapshot.item;
            console.log(`☁ Remote ${m.tbl.slice(0, -1)} — ${m.id}`);
            console.log(`server: ${cfg.server}`);
            console.log(`brain:  ${snapshot.brain}`);
            if (m.kind) console.log(`kind:   ${m.kind}`);
            if (m.status) console.log(`status: ${m.status}`);
            console.log(`updated: ${m.updatedAt}`);
            if (m.claim) console.log(`\n${m.claim}`);
            if (m.payload && opts.full) console.log(`\n${JSON.stringify(m.payload, null, 2)}`);
            break;
          }
          const pending = Math.max(0, snapshot.seq - localCursor);
          console.log(`☁ Remote snapshot — ${snapshot.brain}`);
          console.log(`server:    ${cfg.server}`);
          console.log(
            `seq:       ${snapshot.seq}${pending ? ` (local cursor ${localCursor} — ${pending} update${pending === 1 ? "" : "s"} behind)` : " (up to date with local cursor)"}`
          );
          console.log(`memories:  ${snapshot.counts.memories} on server · ${localMemories} local`);
          console.log(`proposals: ${snapshot.counts.proposals} pending on server`);
          if (snapshot.counts.tombstones) console.log(`tombstones: ${snapshot.counts.tombstones} on server`);
          if (localMemories > 0 && snapshot.counts.memories === 0) {
            console.log("\n⚠ Local memories exist but remote is empty — run `dim sync` to confirm upload.");
          } else if (pending) {
            console.log(`\nRun \`dim sync\` to pull remote changes.`);
          }
          if (snapshot.items?.length) {
            const heading = opts.proposals ? "Remote proposals" : "Remote memories";
            console.log(`\n${heading}:`);
            for (const row of snapshot.items) {
              const claim = row.claim ? row.claim.replace(/\s+/g, " ").slice(0, 72) : "";
              const suffix = row.claim && row.claim.length > 72 ? "…" : "";
              console.log(
                `  ${(row.status ?? "—").padEnd(11)} ${(row.kind ?? "—").padEnd(10)} ${row.id.slice(0, 12).padEnd(12)} ${claim}${suffix}`
              );
            }
          } else if (!opts.summary) {
            console.log("\n(no remote rows to list)");
          }
          break;
        }
        default:
          fail(`unknown action '${action}'. Use: link | unlink | status | remote`);
      }
    });

  program
    .command("login")
    .description("Log this device in to the sync server (device-code flow, approved in the browser)")
    .option("-s, --server <url>", "Server URL (defaults to the repo's linked server)")
    .option("--no-open", "Don't open the browser automatically")
    .action(async (opts) => {
      const { readCloudConfig, startDeviceLogin, pollDeviceLogin } = await import("../../sync/client.js");
      const root = findRepoRoot();
      const server: string | undefined =
        (opts.server as string | undefined)?.replace(/\/$/, "") ?? (root ? readCloudConfig(root)?.server : undefined);
      if (!server) fail("no server: pass --server <url> or link the repo with `dim cloud link` first");
      const start = await startDeviceLogin(server);
      const approveUrl = `${start.verification_uri}?code=${encodeURIComponent(start.user_code)}`;
      console.log(`\nTo approve this device, open:\n\n  ${approveUrl}\n\nand confirm the code: ${start.user_code}\n`);
      if (opts.open) await openBrowser(approveUrl);
      console.log("Waiting for approval…");
      const { brain } = await pollDeviceLogin(server, start);
      console.log(`✓ Logged in to ${server} (scope: ${brain ?? "all brains"}). Token saved to ~/.aidimag/credentials.json.`);
    });

  program
    .command("logout")
    .description("Remove this device's stored token for the sync server")
    .option("-s, --server <url>", "Server URL (defaults to the repo's linked server)")
    .action(async (opts) => {
      const { readCloudConfig, removeToken } = await import("../../sync/client.js");
      const root = findRepoRoot();
      const server: string | undefined =
        (opts.server as string | undefined)?.replace(/\/$/, "") ?? (root ? readCloudConfig(root)?.server : undefined);
      if (!server) fail("no server: pass --server <url> or link the repo with `dim cloud link` first");
      console.log(removeToken(server) ? `✓ Logged out of ${server}.` : `No stored token for ${server}.`);
    });

  program
    .command("sync")
    .description("Sync this repo's memory with the linked team server (push + pull)")
    .option("--full", "Upload all local memories to this brain (not just changes since last push)")
    .option("-y, --yes", "Skip confirmation when uploading to an empty remote brain")
    .action(async (opts) => {
      const root = findRepoRoot() ?? fail("not inside a repo");
      const store = MemoryStore.open(root);
      const { sync } = await import("../../sync/client.js");
      try {
        const r = await sync(store, root, {
          full: Boolean(opts.full),
          confirmFullUpload: opts.full
            ? undefined
            : async (localCount, remoteCount) => {
                if (opts.yes) return true;
                if (!process.stdin.isTTY) {
                  const remoteHint =
                    remoteCount === null
                      ? "could not read remote memory count"
                      : remoteCount === 0
                        ? "remote brain is empty"
                        : `remote has ${remoteCount} ${remoteCount === 1 ? "memory" : "memories"}, local has ${localCount}`;
                  console.log(`${remoteHint}. Run \`dim sync --full\` (or \`dim sync -y\`) to upload all local memories.`);
                  return false;
                }
                const prompter = await createPrompter();
                try {
                  const prompt =
                    remoteCount === 0 || remoteCount === null
                      ? `Remote brain is empty but you have ${localCount} local ${localCount === 1 ? "memory" : "memories"}. Upload all to the cloud? [y/N] `
                      : `You have ${localCount} local ${localCount === 1 ? "memory" : "memories"} but only ${remoteCount} on the remote. Upload all local memories? [y/N] `;
                  const answer = await prompter.ask(prompt);
                  return /^y(es)?$/i.test(answer.trim());
                } finally {
                  prompter.close();
                }
              },
        });
        const recv = r.applied
          ? `received ${r.applied} update${r.applied === 1 ? "" : "s"} from the team`
          : "nothing new from the team";
        const mem = (n: number) => `${n} ${n === 1 ? "memory" : "memories"}`;
        const sent = r.memoriesPushed
          ? `sent ${mem(r.memoriesPushed)}`
          : r.memoriesQueued
            ? `already on server (${mem(r.memoriesQueued)} unchanged)`
            : "nothing to send";
        console.log(`☁ Synced — ${sent}, ${recv}${r.eventsPushed ? ` (+${r.eventsPushed} verification events)` : ""}.`);
        const localMemories = store.statusSummary().total;
        if (opts.full && r.memoriesQueued > 0 && r.memoriesPushed === 0 && localMemories > 0) {
          console.log("✓ Full sync checked all local memories — cloud already has them (no updates needed).");
        } else if (opts.full && localMemories === 0 && r.pushQueued === 0) {
          console.log("⚠ memory.db has 0 memories — nothing to upload with --full.");
          console.log("  If you expected memories here, they may have been deleted locally by a prior sync pull (tombstones).");
          console.log("  Check `dim status` and restore from backup if needed.");
        } else if (r.needsFullUploadConfirm) {
          console.log("Skipped uploading local memories — run `dim sync` again and confirm, or use `dim sync --full`.");
        } else if (r.pushSkipped) {
          console.log("⚠ Local memories were not uploaded (incremental sync only sends changes since the last push to this brain).");
          console.log("  Run `dim sync --full` to upload all local memories to the cloud.");
        }
        // a pull that changed local memory should refresh the generated context
        if (r.applied) await maybeRegenerateContext(store);
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
      const { readCloudConfig } = await import("../../sync/client.js");
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
}

