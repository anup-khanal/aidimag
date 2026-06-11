/**
 * Hybrid semantic recall — merges FTS keyword results with vector KNN using
 * reciprocal-rank fusion, then applies the trust (status) penalty so VERIFIED
 * memories outrank STALE ones regardless of similarity.
 *
 * Degrades gracefully: no provider / no vec extension → plain FTS search.
 */

import type { MemoryStore } from "../db/store.js";
import type { MemoryEntry, MemorySearchOptions } from "../types.js";
import { getEmbeddingProvider, type EmbeddingProvider } from "./provider.js";

const RRF_K = 60;
const STATUS_PENALTY: Record<string, number> = { VERIFIED: 0, UNVERIFIED: 0.004, STALE: 0.012, REFUTED: 0.02 };

/** Embed and index one memory (call after write/approve). No-op without a provider. */
export async function indexMemory(store: MemoryStore, entry: MemoryEntry): Promise<boolean> {
  const provider = await getEmbeddingProvider();
  if (!provider || !store.vecAvailable) return false;
  if (!store.ensureVecTable(provider.model, provider.dim)) return false;
  const [vec] = await provider.embed([embeddingText(entry)]);
  store.upsertEmbedding(entry.id, vec);
  return true;
}

/** Backfill embeddings for all memories missing one. Returns count indexed. */
export async function reindexAll(store: MemoryStore): Promise<{ indexed: number; provider: EmbeddingProvider | null }> {
  const provider = await getEmbeddingProvider();
  if (!provider || !store.vecAvailable) return { indexed: 0, provider: null };
  store.ensureVecTable(provider.model, provider.dim);
  const ids = store.unembeddedIds();
  let indexed = 0;
  const BATCH = 16;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH).map((id) => store.get(id)).filter((m): m is MemoryEntry => !!m);
    if (batch.length === 0) continue;
    const vectors = await provider.embed(batch.map(embeddingText));
    batch.forEach((m, j) => store.upsertEmbedding(m.id, vectors[j]));
    indexed += batch.length;
  }
  return { indexed, provider };
}

/** Hybrid search: FTS + KNN fused, status-aware. Falls back to FTS-only. */
export async function hybridSearch(store: MemoryStore, opts: MemorySearchOptions): Promise<{ results: MemoryEntry[]; semantic: boolean }> {
  const ftsResults = store.search(opts);
  const provider = opts.query.trim() ? await getEmbeddingProvider().catch(() => null) : null;
  if (!provider || !store.vecAvailable) return { results: ftsResults, semantic: false };

  let knnIds: Array<{ id: string; distance: number }> = [];
  try {
    const [qvec] = await provider.embed([opts.query]);
    knnIds = store.knn(qvec, Math.max(opts.limit ?? 10, 10) * 2);
  } catch {
    return { results: ftsResults, semantic: false };
  }
  if (knnIds.length === 0) return { results: ftsResults, semantic: false };

  // reciprocal-rank fusion
  const scores = new Map<string, number>();
  ftsResults.forEach((m, rank) => scores.set(m.id, (scores.get(m.id) ?? 0) + 1 / (RRF_K + rank + 1)));
  knnIds.forEach(({ id }, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));

  const byId = new Map(ftsResults.map((m) => [m.id, m]));
  for (const { id } of knnIds) {
    if (!byId.has(id)) {
      const m = store.get(id);
      if (m) byId.set(id, m);
    }
  }

  let candidates = [...byId.values()];
  // re-apply filters that FTS applied but KNN bypassed
  if (opts.kind) candidates = candidates.filter((m) => m.kind === opts.kind);
  if (opts.status) candidates = candidates.filter((m) => m.status === opts.status);
  else if (!opts.includeRefuted) candidates = candidates.filter((m) => m.status !== "REFUTED");
  if (opts.paths?.length) {
    candidates = candidates.filter(
      (m) =>
        m.scope.paths.length === 0 ||
        m.scope.paths.some((sp) => opts.paths!.some((p) => p.startsWith(sp) || sp.startsWith(p)))
    );
  }

  candidates.sort((a, b) => {
    const sa = (scores.get(a.id) ?? 0) - (STATUS_PENALTY[a.status] ?? 0);
    const sb = (scores.get(b.id) ?? 0) - (STATUS_PENALTY[b.status] ?? 0);
    return sb - sa || b.confidence - a.confidence;
  });

  return { results: candidates.slice(0, Math.min(opts.limit ?? 10, 50)), semantic: true };
}

function embeddingText(m: MemoryEntry): string {
  const scope = [...m.scope.paths, ...m.scope.symbols].join(" ");
  return `${m.kind}: ${m.claim}${scope ? `\nscope: ${scope}` : ""}`;
}

