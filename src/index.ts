export * from "./types.js";
export { MemoryStore, findRepoRoot, dbPathFor, AIDIMAG_DIR, DB_FILE } from "./db/store.js";
export { mineCommits, readCommits, classifyCommit, scopeFromFiles } from "./capture/commit-miner.js";
export { SESSION_END_PROMPT, proposalSummaryLine } from "./capture/session-extraction.js";
export { verifyAll, verifyMemory, decayedConfidence } from "./verify/engine.js";
export { runEvidence } from "./verify/runners.js";
export { installGitHooks } from "./verify/hooks.js";
export { getEmbeddingProvider } from "./embeddings/provider.js";
export { hybridSearch, indexMemory, reindexAll } from "./embeddings/search.js";

