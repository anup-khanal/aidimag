/**
 * `dim ui` — local web dashboard (zero extra dependencies, node:http only).
 *
 * Serves a single-page UI: memory list with trust badges, proposal review
 * queue, verify buttons, and a force-directed graph of memories ↔ scope paths
 * (D3 from CDN). Works alongside any IDE; later IDE extensions can embed this
 * same dashboard in a webview.
 */

import { createServer } from "node:http";
import { verifyAll } from "../verify/engine.js";
import { mineCommits } from "../capture/commit-miner.js";
import { hybridSearch, indexMemory, reindexAll } from "../embeddings/search.js";
import { readCloudConfig, writeCloudConfig, saveToken, getToken, sync as cloudSync } from "../sync/client.js";
import type { MemoryStore } from "../db/store.js";
import type { MemoryKind } from "../types.js";
import { PAGE_HTML } from "./page.js";

function json(res: import("node:http").ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

export function startUiServer(store: MemoryStore, repoRoot: string, port = 4517): Promise<string> {
  // Auto-sync with the linked team server every N minutes while the dashboard
  // runs (AIDIMAG_AUTOSYNC_MINUTES, default 10, 0 disables). Failures are
  // silent — the next manual sync or dashboard action surfaces them.
  const autoSyncMinutes = Number(process.env.AIDIMAG_AUTOSYNC_MINUTES ?? "10");
  if (autoSyncMinutes > 0) {
    const timer = setInterval(() => {
      const cloud = readCloudConfig(repoRoot);
      if (!cloud || !getToken(cloud.server)) return;
      cloudSync(store, repoRoot).catch(() => undefined);
    }, autoSyncMinutes * 60 * 1000);
    timer.unref(); // never keep the process alive on its own
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const path = url.pathname;

    try {
      if (req.method === "GET" && path === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(PAGE_HTML);
        return;
      }

      if (req.method === "GET" && path === "/api/state") {
        const cloud = readCloudConfig(repoRoot);
        json(res, 200, {
          repoRoot,
          memories: store.list(1000),
          proposals: store.listProposals("PENDING", 200),
          summary: store.statusSummary(),
          cloud: cloud
            ? { server: cloud.server, brain: cloud.brain, hasToken: !!getToken(cloud.server) }
            : null,
          vecAvailable: store.vecAvailable,
        });
        return;
      }

      // ---- search (hybrid when embeddings configured) ----
      if (req.method === "GET" && path === "/api/search") {
        const { results, semantic } = await hybridSearch(store, {
          query: url.searchParams.get("q") ?? "",
          kind: (url.searchParams.get("kind") as MemoryKind) || undefined,
          paths: url.searchParams.get("path") ? [url.searchParams.get("path")!] : undefined,
          limit: 50,
          includeRefuted: url.searchParams.get("all") === "1",
        });
        json(res, 200, { results, semantic });
        return;
      }

      // ---- create memory (dim remember) ----
      if (req.method === "POST" && path === "/api/memories") {
        const b = await readBody(req);
        if (!b.kind || !b.claim) {
          json(res, 400, { error: "kind and claim are required" });
          return;
        }
        const entry = store.write({
          kind: b.kind as MemoryKind,
          claim: String(b.claim),
          paths: (b.paths as string[]) ?? [],
          symbols: (b.symbols as string[]) ?? [],
          evidence: (b.evidence as Array<{ type: never; payload: string }>) ?? [],
          createdBy: "human:dashboard",
        });
        await indexMemory(store, entry).catch(() => false);
        json(res, 201, { memory: entry });
        return;
      }

      if (req.method === "POST" && path === "/api/verify") {
        const deep = url.searchParams.get("deep") === "1";
        json(res, 200, verifyAll(store, repoRoot, { deep }));
        return;
      }

      // ---- mine git history ----
      if (req.method === "POST" && path === "/api/mine") {
        const full = url.searchParams.get("full") === "1";
        const r = mineCommits(store, repoRoot, { full });
        json(res, 200, { scanned: r.scanned, proposed: r.proposed.length, skipped: r.skippedDuplicates });
        return;
      }

      // ---- embeddings reindex ----
      if (req.method === "POST" && path === "/api/reindex") {
        const r = await reindexAll(store);
        json(res, 200, {
          indexed: r.indexed,
          provider: r.provider ? `${r.provider.name}/${r.provider.model}` : null,
        });
        return;
      }

      // ---- team sync ----
      if (req.method === "POST" && path === "/api/sync") {
        const r = await cloudSync(store, repoRoot);
        json(res, 200, r);
        return;
      }

      // ---- cloud link/unlink ----
      if (req.method === "POST" && path === "/api/cloud/link") {
        const b = await readBody(req);
        if (!b.server || !b.brain) {
          json(res, 400, { error: "server and brain are required" });
          return;
        }
        const serverUrl = String(b.server).replace(/\/$/, "");
        writeCloudConfig(repoRoot, { server: serverUrl, brain: String(b.brain) });
        if (b.token) saveToken(serverUrl, String(b.token));
        json(res, 200, { ok: true, hasToken: !!getToken(serverUrl) });
        return;
      }
      if (req.method === "POST" && path === "/api/cloud/unlink") {
        writeCloudConfig(repoRoot, { server: "", brain: "" } as never);
        json(res, 200, { ok: true });
        return;
      }

      // ---- API key management (proxies to the sync server; admin token is
      //      passed per-request from the UI and never stored) ----
      if (path === "/api/keys") {
        const b = req.method === "GET" ? {} : await readBody(req);
        const cloud = readCloudConfig(repoRoot);
        const target = String((b.server as string) ?? url.searchParams.get("server") ?? cloud?.server ?? "");
        const admin = String((b.adminToken as string) ?? url.searchParams.get("adminToken") ?? "");
        if (!target || !admin) {
          json(res, 400, { error: "server and adminToken are required" });
          return;
        }
        const headers = { "Content-Type": "application/json", Authorization: `Bearer ${admin}` };
        let upstream: Response;
        if (req.method === "POST" && !b.revoke) {
          upstream = await fetch(`${target}/v1/keys`, {
            method: "POST",
            headers,
            body: JSON.stringify({ brain: b.brain, label: b.label }),
          });
        } else if (req.method === "POST" && b.revoke) {
          upstream = await fetch(`${target}/v1/keys?key=${encodeURIComponent(String(b.revoke))}`, {
            method: "DELETE",
            headers,
          });
        } else {
          upstream = await fetch(`${target}/v1/keys`, { headers });
        }
        json(res, upstream.status, await upstream.json());
        return;
      }

      // POST /api/proposals/:id/(approve|reject)
      const propMatch = path.match(/^\/api\/proposals\/([^/]+)\/(approve|reject)$/);
      if (req.method === "POST" && propMatch) {
        const [, id, action] = propMatch;
        if (action === "approve") {
          const memory = store.approveProposal(id);
          await indexMemory(store, memory).catch(() => false);
          json(res, 200, { memory });
        } else json(res, 200, { proposal: store.rejectProposal(id) });
        return;
      }

      // POST /api/memories/:id/(refute|forget)
      const memMatch = path.match(/^\/api\/memories\/([^/]+)\/(refute|forget)$/);
      if (req.method === "POST" && memMatch) {
        const [, id, action] = memMatch;
        const full = store.list(1000).find((m) => m.id === id || m.id.startsWith(id));
        if (!full) {
          json(res, 404, { error: `no memory ${id}` });
          return;
        }
        if (action === "refute") store.refute(full.id);
        else store.forget(full.id);
        json(res, 200, { ok: true });
        return;
      }

      json(res, 404, { error: "not found" });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(`http://localhost:${port}`));
  });
}

