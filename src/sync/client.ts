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

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { debugLog } from "../debug.js";
import type { MemoryStore } from "../db/store.js";
import type { MemoryEntry, Proposal } from "../types.js";
import type { SyncItem, EventItem, RemoteSnapshot } from "./server.js";

export interface CloudConfig {
  server: string;
  brain: string;
}

const CURSOR_KEY = "sync_pull_cursor";
const LAST_PUSH_KEY = "sync_last_push_at";

/** Scope sync cursors per brain so linking a new cloud project triggers a fresh upload. */
export function syncMetaKey(base: string, brain: string): string {
  return `${base}:${brain}`;
}

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
  try { chmodSync(p, 0o600); } catch { /* best-effort on Windows */ }
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
  const res = await cloudFetch(server, `${server}/v1/auth/device`, { method: "POST" });
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
    const res = await cloudFetch(server, `${server}/v1/auth/token`, {
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
  /** Memory rows accepted by the server this run (excludes proposals/tombstones). */
  memoriesPushed: number;
  /** Memory rows in the push batch this run (excludes proposals/tombstones). */
  memoriesQueued: number;
  pulled: number;
  applied: number;
  skippedOlder: number;
  /** lifecycle events shipped to the server (consensus input) */
  eventsPushed: number;
  /** Local rows considered for push this run. */
  pushQueued: number;
  /** Local memories exist but incremental push sent nothing (remote may already have data). */
  pushSkipped: boolean;
  /** Remote brain is empty while local has memories — user was not asked or declined upload. */
  needsFullUploadConfirm?: boolean;
}

export interface SyncOptions {
  /** Push every local memory/proposal, not just rows changed since the last push. */
  full?: boolean;
  /** Called when local has memories missing on the remote; return true to run a full upload. */
  confirmFullUpload?: (localMemoryCount: number, remoteMemoryCount: number | null) => Promise<boolean>;
}

function formatFetchError(server: string, err: unknown): Error {
  if (err instanceof TypeError && err.message === "fetch failed") {
    const cause = err.cause as NodeJS.ErrnoException | undefined;
    const detail = cause?.code ?? cause?.message ?? "network error";
    if (detail === "ECONNREFUSED" || /ECONNREFUSED/i.test(String(detail))) {
      return new Error(
        `cannot reach sync server at ${server} (connection refused). ` +
          `For aidimag-cloud dev, run \`npm run dev\` in aidimag-cloud and link \`http://localhost:3000\`. ` +
          `For self-hosted sync, run \`dim serve\` (default port 8787). Check \`dim cloud status\`.`
      );
    }
    return new Error(`cannot reach sync server at ${server}: ${detail}`);
  }
  if (err instanceof Error) return err;
  return new Error(String(err));
}

async function cloudFetch(server: string, url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    throw formatFetchError(server, err);
  }
}

async function api<T>(cfg: CloudConfig, token: string, pathAndQuery: string, init?: RequestInit): Promise<T> {
  const res = await cloudFetch(cfg.server, `${cfg.server}${pathAndQuery}`, {
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

export type { RemoteSnapshot, RemoteSnapshotItem } from "./server.js";

export interface FetchRemoteSnapshotOpts {
  id?: string;
  tbl?: "memories" | "proposals";
  limit?: number;
  /** When false, return counts/seq only. Default true unless fetching by id. */
  list?: boolean;
  full?: boolean;
  /** When listing proposals, include resolved (APPROVED/REJECTED) rows. Default: pending only. */
  all?: boolean;
}

/** Read the server's current latest-state snapshot without pulling into local DB. */
export async function fetchRemoteSnapshot(
  repoRoot: string,
  opts: FetchRemoteSnapshotOpts = {}
): Promise<RemoteSnapshot> {
  const cfg = readCloudConfig(repoRoot);
  if (!cfg) throw new Error("repo is not cloud-linked. Run `dim cloud link --server <url> --brain <name> --token <token>` first.");
  const token = getToken(cfg.server);
  if (!token) throw new Error(`no credentials for ${cfg.server}. Run \`dim cloud link\` with --token, or set AIDIMAG_API_KEY.`);

  const q = new URLSearchParams({ brain: cfg.brain });
  if (opts.id) q.set("id", opts.id);
  if (opts.tbl) q.set("tbl", opts.tbl);
  if (opts.limit != null) q.set("limit", String(opts.limit));
  if (opts.list === false) q.set("list", "0");
  if (opts.full) q.set("full", "1");
  if (opts.all) q.set("all", "1");

  return api<RemoteSnapshot>(cfg, token, `/v1/snapshot?${q.toString()}`);
}

/** Remote memory count for this brain, or null if the server could not be queried. */
async function getRemoteMemoryCount(cfg: CloudConfig, token: string): Promise<number | null> {
  try {
    const remote = await api<RemoteSnapshot>(
      cfg,
      token,
      `/v1/snapshot?brain=${encodeURIComponent(cfg.brain)}&list=0`
    );
    return remote.counts.memories;
  } catch (err) {
    if (!(err instanceof Error && /HTTP 404/.test(err.message))) throw err;
    // Older servers without /v1/snapshot — infer from pull.
    try {
      const pull = await api<{ items: SyncItem[] }>(
        cfg,
        token,
        `/v1/pull?brain=${encodeURIComponent(cfg.brain)}&since=0`
      );
      return pull.items.filter((i) => i.tbl === "memories" && !i.deleted).length;
    } catch {
      return null;
    }
  }
}

export async function sync(store: MemoryStore, repoRoot: string, opts: SyncOptions = {}): Promise<SyncResult> {
  const cfg = readCloudConfig(repoRoot);
  if (!cfg) throw new Error("repo is not cloud-linked. Run `dim cloud link --server <url> --brain <name> --token <token>` first.");
  const token = getToken(cfg.server);
  if (!token) throw new Error(`no credentials for ${cfg.server}. Run \`dim cloud link\` with --token, or set AIDIMAG_API_KEY.`);

  const cursorKey = syncMetaKey(CURSOR_KEY, cfg.brain);
  const lastPushKey = syncMetaKey(LAST_PUSH_KEY, cfg.brain);
  const localMemoryCount = store.statusSummary().total;

  // ---- push
  const lastPush = opts.full ? null : store.getMeta(lastPushKey);
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

  let uploadGapDetected = false;
  let remoteMemoryCount: number | null = null;

  // Incremental push is empty but local still has memories not reflected on the remote.
  if (!opts.full && items.length === 0 && localMemoryCount > 0) {
    remoteMemoryCount = await getRemoteMemoryCount(cfg, token);
    const missingOnRemote = remoteMemoryCount === null || remoteMemoryCount < localMemoryCount;
    if (missingOnRemote) {
      uploadGapDetected = true;
      if (opts.confirmFullUpload) {
        const ok = await opts.confirmFullUpload(localMemoryCount, remoteMemoryCount);
        if (ok) {
          store.setMeta(cursorKey, "0");
          return sync(store, repoRoot, { full: true });
        }
      }
    }
  }

  let pushed = 0;
  let memoriesPushed = 0;
  const pushQueued = items.length;
  const memoriesQueued = items.filter((it) => it.tbl === "memories" && !it.deleted).length;
  if (items.length > 0) {
    const r = await api<{ accepted: number; memoriesAccepted?: number }>(
      cfg,
      token,
      `/v1/push?brain=${encodeURIComponent(cfg.brain)}`,
      {
        method: "POST",
        body: JSON.stringify({ items }),
      }
    );
    pushed = r.accepted;
    memoriesPushed =
      r.memoriesAccepted ??
      (pushed === 0 ? 0 : pushed === pushQueued ? memoriesQueued : Math.min(memoriesQueued, pushed));
  }
  if (pushQueued > 0) {
    const latestItemAt = items.reduce(
      (max, it) => (!max || it.updatedAt > max ? it.updatedAt : max),
      ""
    );
    store.setMeta(lastPushKey, latestItemAt || new Date().toISOString());
  }

  // Warn only when incremental sent nothing and remote still appears to be missing local data.
  const pushSkipped =
    !opts.full &&
    pushQueued === 0 &&
    localMemoryCount > 0 &&
    !uploadGapDetected &&
    (remoteMemoryCount === null || remoteMemoryCount < localMemoryCount);
  const needsFullUploadConfirm = uploadGapDetected && pushQueued === 0 && !opts.full;

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
  const cursor = parseInt(store.getMeta(cursorKey) ?? "0", 10);
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
  store.setMeta(cursorKey, String(pullRes.seq));

  return {
    pushed,
    memoriesPushed,
    memoriesQueued,
    pulled: pullRes.items.length,
    applied,
    skippedOlder,
    eventsPushed,
    pushQueued,
    pushSkipped,
    ...(needsFullUploadConfirm ? { needsFullUploadConfirm: true } : {}),
  };
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
  } catch (err) {
    debugLog("auto-sync", err);
    return null; // offline / server down — local-first means we just carry on
  }
}

