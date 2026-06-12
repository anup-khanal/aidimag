/**
 * Sync client (Phase 6) — `dim cloud link` + `dim sync`.
 *
 * Local-first LWW sync:
 *   push: rows changed since last push (+ tombstones) → server
 *   pull: latest remote rows since cursor → apply if remote.updatedAt > local
 *
 * Config split (by design):
 *   .aidimag/config.json        { server, brain }   — committed to git (no secrets)
 *   ~/.aidimag/credentials.json { [server]: token } — never in the repo
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { MemoryStore } from "../db/store.js";
import type { MemoryEntry, Proposal } from "../types.js";
import type { SyncItem, EventItem } from "./server.js";

export interface CloudConfig {
  server: string;
  brain: string;
}

const CURSOR_KEY = "sync_pull_cursor";
const LAST_PUSH_KEY = "sync_last_push_at";

// ---------------------------------------------------------------- config & credentials

export function configPath(repoRoot: string): string {
  return path.join(repoRoot, ".aidimag", "config.json");
}

export function readCloudConfig(repoRoot: string): CloudConfig | null {
  const p = configPath(repoRoot);
  if (!existsSync(p)) return null;
  try {
    const cfg = JSON.parse(readFileSync(p, "utf8"));
    return cfg.server && cfg.brain ? { server: cfg.server, brain: cfg.brain } : null;
  } catch {
    return null;
  }
}

export function writeCloudConfig(repoRoot: string, cfg: CloudConfig): void {
  mkdirSync(path.join(repoRoot, ".aidimag"), { recursive: true });
  // merge: config.json also carries the tickets section etc — never clobber
  const p = configPath(repoRoot);
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    // fresh file
  }
  writeFileSync(p, JSON.stringify({ ...existing, server: cfg.server, brain: cfg.brain }, null, 2) + "\n");
}

function credentialsPath(): string {
  return path.join(homedir(), ".aidimag", "credentials.json");
}

export function getToken(server: string): string | null {
  if (process.env.AIDIMAG_API_KEY) return process.env.AIDIMAG_API_KEY;
  const p = credentialsPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"))[server] ?? null;
  } catch {
    return null;
  }
}

export function saveToken(server: string, token: string): void {
  const p = credentialsPath();
  mkdirSync(path.dirname(p), { recursive: true });
  const creds = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  creds[server] = token;
  writeFileSync(p, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
}

export function removeToken(server: string): boolean {
  const p = credentialsPath();
  if (!existsSync(p)) return false;
  const creds = JSON.parse(readFileSync(p, "utf8"));
  if (!(server in creds)) return false;
  delete creds[server];
  writeFileSync(p, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
  return true;
}

// ---------------------------------------------------------------- device-flow login (dim login)

export interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

/** Begin a device-code login: server hands back a user code + approval URL. */
export async function startDeviceLogin(server: string): Promise<DeviceStart> {
  const res = await fetch(`${server}/v1/auth/device`, { method: "POST" });
  if (!res.ok) {
    throw new Error(
      res.status === 404
        ? `server does not support device login (upgrade it to this aidimag version)`
        : `device login: HTTP ${res.status} ${await res.text()}`
    );
  }
  return (await res.json()) as DeviceStart;
}

/** Poll until the device is approved in the browser. Saves the token on success. */
export async function pollDeviceLogin(server: string, start: DeviceStart): Promise<{ token: string; brain: string | null }> {
  const deadline = Date.now() + start.expires_in * 1000;
  for (;;) {
    if (Date.now() > deadline) throw new Error("login timed out — run `dim login` again");
    await new Promise((r) => setTimeout(r, start.interval * 1000));
    const res = await fetch(`${server}/v1/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: start.device_code }),
    });
    if (res.status === 428) continue; // authorization_pending
    if (!res.ok) throw new Error(`login failed: HTTP ${res.status} ${await res.text()}`);
    const out = (await res.json()) as { token: string; brain: string | null };
    saveToken(server, out.token);
    return out;
  }
}

// ---------------------------------------------------------------- sync

export interface SyncResult {
  pushed: number;
  pulled: number;
  applied: number;
  skippedOlder: number;
  /** lifecycle events shipped to the server (consensus input) */
  eventsPushed: number;
}

async function api<T>(cfg: CloudConfig, token: string, pathAndQuery: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${cfg.server}${pathAndQuery}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`sync server ${pathAndQuery}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export async function sync(store: MemoryStore, repoRoot: string): Promise<SyncResult> {
  const cfg = readCloudConfig(repoRoot);
  if (!cfg) throw new Error("repo is not cloud-linked. Run `dim cloud link --server <url> --brain <name> --token <token>` first.");
  const token = getToken(cfg.server);
  if (!token) throw new Error(`no credentials for ${cfg.server}. Run \`dim cloud link\` with --token, or set AIDIMAG_API_KEY.`);

  // ---- push
  const lastPush = store.getMeta(LAST_PUSH_KEY);
  const changes = store.changedSince(lastPush);
  const items: SyncItem[] = [
    ...changes.memories.map((m) => ({
      tbl: "memories" as const,
      id: m.id,
      updatedAt: m.updatedAt ?? m.createdAt,
      deleted: false,
      payload: m,
    })),
    ...changes.proposals.map((p) => ({
      tbl: "proposals" as const,
      id: p.id,
      updatedAt: p.updatedAt ?? p.createdAt,
      deleted: false,
      payload: p,
    })),
    ...changes.tombstones.map((t) => ({
      tbl: t.tbl as SyncItem["tbl"],
      id: t.id,
      updatedAt: t.deletedAt,
      deleted: true,
      payload: null,
    })),
  ];
  let pushed = 0;
  if (items.length > 0) {
    const r = await api<{ accepted: number }>(cfg, token, `/v1/push?brain=${encodeURIComponent(cfg.brain)}`, {
      method: "POST",
      body: JSON.stringify({ items }),
    });
    pushed = r.accepted;
  }
  store.setMeta(LAST_PUSH_KEY, new Date().toISOString());

  // ---- push events (append-only lifecycle log → server-side consensus)
  let eventsPushed = 0;
  try {
    for (;;) {
      const batch = store.unsyncedEvents(500);
      if (!batch.length) break;
      const events: EventItem[] = batch.map((e) => ({
        id: e.id,
        type: e.type,
        memoryId: e.memoryId,
        payload: e.payload,
        machine: e.machine,
        schemaVersion: e.schemaVersion,
        createdAt: e.createdAt,
      }));
      await api<{ accepted: number }>(cfg, token, `/v1/events?brain=${encodeURIComponent(cfg.brain)}`, {
        method: "POST",
        body: JSON.stringify({ events }),
      });
      store.markEventsSynced(batch.map((e) => e.seq));
      eventsPushed += batch.length;
      if (batch.length < 500) break;
    }
  } catch (err) {
    // older server without /v1/events — events stay queued locally, retry next sync
    if (!(err instanceof Error && /HTTP 404/.test(err.message))) throw err;
  }

  // ---- pull
  const cursor = parseInt(store.getMeta(CURSOR_KEY) ?? "0", 10);
  const pullRes = await api<{ items: SyncItem[]; seq: number }>(
    cfg,
    token,
    `/v1/pull?brain=${encodeURIComponent(cfg.brain)}&since=${cursor}`
  );

  let applied = 0;
  let skippedOlder = 0;
  for (const it of pullRes.items) {
    if (it.deleted) {
      const localUpdated =
        it.tbl === "memories" ? store.memoryUpdatedAt(it.id) : store.proposalUpdatedAt(it.id);
      if (localUpdated !== null && localUpdated > it.updatedAt) {
        skippedOlder++; // local resurrection is newer than remote delete
        continue;
      }
      store.applyRemoteTombstone(it.id, it.tbl, it.updatedAt);
      applied++;
      continue;
    }
    if (store.isTombstoned(it.id, it.tbl)) {
      // locally deleted; only resurrect if the remote edit is newer than our delete — handled above via push
      skippedOlder++;
      continue;
    }
    if (it.tbl === "memories") {
      const local = store.memoryUpdatedAt(it.id);
      if (local !== null && local >= it.updatedAt) {
        skippedOlder++;
        continue;
      }
      store.applyRemoteMemory(it.payload as MemoryEntry);
      applied++;
    } else {
      const local = store.proposalUpdatedAt(it.id);
      if (local !== null && local >= it.updatedAt) {
        skippedOlder++;
        continue;
      }
      store.applyRemoteProposal(it.payload as Proposal);
      applied++;
    }
  }
  store.setMeta(CURSOR_KEY, String(pullRes.seq));

  return { pushed, pulled: pullRes.items.length, applied, skippedOlder, eventsPushed };
}

// ---------------------------------------------------------------- auto-sync (debounced)

const AUTO_SYNC_DEBOUNCE_MS = 30_000;
const AUTO_SYNC_LAST_KEY = "sync_last_auto_at";

/**
 * Best-effort background sync after local mutations (CLOUD_DESIGN: "runs
 * automatically (debounced) after remember / review / verify").
 * No-ops when the repo isn't cloud-linked, no token is stored, the last
 * auto-sync was <30s ago, or AIDIMAG_AUTO_SYNC=off. Never throws.
 */
export async function maybeAutoSync(store: MemoryStore, repoRoot: string): Promise<SyncResult | null> {
  if ((process.env.AIDIMAG_AUTO_SYNC ?? "").toLowerCase() === "off") return null;
  const cfg = readCloudConfig(repoRoot);
  if (!cfg) return null;
  if (!getToken(cfg.server)) return null;
  const last = store.getMeta(AUTO_SYNC_LAST_KEY);
  if (last && Date.now() - new Date(last).getTime() < AUTO_SYNC_DEBOUNCE_MS) return null;
  try {
    const r = await sync(store, repoRoot);
    store.setMeta(AUTO_SYNC_LAST_KEY, new Date().toISOString());
    return r;
  } catch {
    return null; // offline / server down — local-first means we just carry on
  }
}

