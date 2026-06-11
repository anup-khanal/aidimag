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
import type { MemoryStore } from "../db/store.js";
import { PAGE_HTML } from "./page.js";

function json(res: import("node:http").ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function startUiServer(store: MemoryStore, repoRoot: string, port = 4517): Promise<string> {
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
        json(res, 200, {
          repoRoot,
          memories: store.list(1000),
          proposals: store.listProposals("PENDING", 200),
          summary: store.statusSummary(),
        });
        return;
      }

      if (req.method === "POST" && path === "/api/verify") {
        const deep = url.searchParams.get("deep") === "1";
        const report = verifyAll(store, repoRoot, { deep });
        json(res, 200, report);
        return;
      }

      // POST /api/proposals/:id/(approve|reject)
      const propMatch = path.match(/^\/api\/proposals\/([^/]+)\/(approve|reject)$/);
      if (req.method === "POST" && propMatch) {
        const [, id, action] = propMatch;
        if (action === "approve") json(res, 200, { memory: store.approveProposal(id) });
        else json(res, 200, { proposal: store.rejectProposal(id) });
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

