import type { SyncItem } from "../sync/server.js";

const MAX_PUSH_ITEMS = 500;
const MAX_PAYLOAD_CHARS = 512_000;
const MAX_CLAIM_CHARS = 8_000;

export function validateSyncPushItems(items: SyncItem[]): SyncItem[] {
  if (!Array.isArray(items)) return [];
  const out: SyncItem[] = [];
  for (const it of items.slice(0, MAX_PUSH_ITEMS)) {
    if (!it?.id || !it.tbl || !it.updatedAt) continue;
    if (it.tbl !== "memories" && it.tbl !== "proposals") continue;
    if (typeof it.updatedAt !== "string" || it.updatedAt.length > 64) continue;
    if (it.deleted) {
      out.push({ tbl: it.tbl, id: String(it.id), updatedAt: it.updatedAt, deleted: true, payload: null });
      continue;
    }
    if (it.payload === null || it.payload === undefined) continue;
    const payloadStr = JSON.stringify(it.payload);
    if (payloadStr.length > MAX_PAYLOAD_CHARS) continue;
    const claim = (it.payload as { claim?: unknown }).claim;
    if (typeof claim === "string" && claim.length > MAX_CLAIM_CHARS) continue;
    out.push({
      tbl: it.tbl,
      id: String(it.id),
      updatedAt: it.updatedAt,
      deleted: false,
      payload: it.payload,
    });
  }
  return out;
}
