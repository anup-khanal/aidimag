/**
 * Team-sync commands: serve, cloud, login, logout, sync, keys.
 */

import type { Command } from "commander";
import { MemoryStore, findRepoRoot } from "../../db/store.js";
import { fail, maybeRegenerateContext, openBrowser } from "../shared.js";

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
    .argument("<action>", "link | unlink | status")
    .option("-s, --server <url>", "Sync server URL")
    .option("-b, --brain <name>", "Brain (team memory) name on the server")
    .option("-t, --token <token>", "Auth token (stored in ~/.aidimag/credentials.json, NOT the repo)")
    .action(async (action: string, opts) => {
      const root = findRepoRoot() ?? fail("not inside a repo");
      const { readCloudConfig, writeCloudConfig, saveToken, getToken } = await import("../../sync/client.js");
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
    .action(async () => {
      const root = findRepoRoot() ?? fail("not inside a repo");
      const store = MemoryStore.open(root);
      const { sync } = await import("../../sync/client.js");
      try {
        const r = await sync(store, root);
        const recv = r.applied
          ? `received ${r.applied} update${r.applied === 1 ? "" : "s"} from the team`
          : "nothing new from the team";
        const sent = r.pushed ? `sent ${r.pushed}` : "nothing to send";
        console.log(`☁ Synced — ${sent}, ${recv}${r.eventsPushed ? ` (+${r.eventsPushed} verification events)` : ""}.`);
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

