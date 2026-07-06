/**
 * Capture-pipeline unit tests: triage scoring (incl. the correction loop),
 * transcript harvesting helpers, claim extraction, and commit classification.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryStore } from "../db/store.js";
import { scoreProposal, claimSimilarity, triagePending } from "../capture/triage.js";
import { userMessagesFromTranscript, redactSecrets } from "../capture/harvest.js";
import { parseClaims, dedupeClaims } from "../knowledge/extract.js";
import { classifyCommit, scopeFromFiles } from "../capture/commit-miner.js";
import type { Proposal } from "../types.js";

function fakeProposal(over: Partial<Proposal>): Proposal {
  return {
    id: "p1",
    kind: "CONVENTION",
    claim: "All network calls go through src/services",
    paths: [],
    symbols: [],
    evidence: [],
    source: "commit-miner",
    createdAt: new Date().toISOString(),
    status: "PENDING",
    memoryId: null,
    ...over,
  };
}

// ---------------------------------------------------------------- triage

test("triage: machine evidence + trusted source outrank bare miner output", () => {
  const rich = scoreProposal(
    fakeProposal({
      source: "context:claude-code",
      paths: ["src/services"],
      evidence: [
        { type: "STATIC_CHECK", payload: "grep -q fetch src/services" },
        { type: "HUMAN_ATTESTED", payload: "user said so" },
      ],
    }),
    [],
    []
  );
  const bare = scoreProposal(fakeProposal({ source: "commit-miner" }), [], []);
  assert.ok(rich.score > bare.score, `${rich.score} should beat ${bare.score}`);
  assert.ok(rich.reasons.includes("machine-checkable evidence"));
  assert.ok(rich.reasons.includes("user-stated in chat"));
});

test("triage correction loop: similarity to rejected claims sinks the score", () => {
  const rejected = ["All network calls go through src/services layer only"];
  const withPenalty = scoreProposal(fakeProposal({}), rejected, []);
  const without = scoreProposal(fakeProposal({}), [], []);
  assert.ok(withPenalty.score < without.score);
  assert.ok(withPenalty.reasons.some((r) => r.includes("rejected")));
});

test("claimSimilarity: near-duplicates high, unrelated low", () => {
  assert.ok(claimSimilarity("Retries are handled in src/queue only", "retries handled in src/queue") > 0.5);
  assert.ok(claimSimilarity("Retries are handled in src/queue", "The dashboard uses Vue components") < 0.2);
});

test("triagePending orders the real queue best-first", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aidimag-triage-"));
  const store = new MemoryStore(path.join(dir, ".aidimag", "memory.db"));
  try {
    store.propose({ kind: "GOTCHA", claim: "Weak unscoped claim from mining", source: "commit-miner" });
    store.propose({
      kind: "CONVENTION",
      claim: "User-stated: payments retries live in src/queue",
      source: "context:agent",
      paths: ["src/queue"],
      evidence: [{ type: "HUMAN_ATTESTED", payload: "user said" }],
    });
    const triaged = triagePending(store);
    assert.equal(triaged.length, 2);
    assert.equal(triaged[0].proposal.source, "context:agent");
    assert.ok(triaged[0].score > triaged[1].score);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- harvest helpers

test("userMessagesFromTranscript keeps real human turns only", () => {
  const jsonl = [
    JSON.stringify({ type: "user", message: { role: "user", content: "We never touch src/billing without approval — it is legacy and fragile." } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Understood, avoiding it." }] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "file contents..." }] } }),
    JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: "<command-name>/clear</command-name>" } }),
    JSON.stringify({ type: "user", message: { role: "user", content: "ok" } }), // too short
    "not json at all",
  ].join("\n");
  const msgs = userMessagesFromTranscript(jsonl);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /billing/);
});

test("redactSecrets strips secret-looking lines, keeps the rest", () => {
  const out = redactSecrets("safe line\nAPI_KEY=sk-abcdefghijklmnopqrstuvwx\nBearer ya29_longtokenvalue1234567\nanother safe line");
  const lines = out.split("\n");
  assert.equal(lines[0], "safe line");
  assert.equal(lines[1], "[REDACTED — possible secret]");
  assert.equal(lines[2], "[REDACTED — possible secret]");
  assert.equal(lines[3], "another safe line");
});

// ---------------------------------------------------------------- extraction

test("parseClaims: tolerant parsing, static_check, kind validation, dedupe", () => {
  const raw = `Sure! Here you go:
{"claims":[
  {"kind":"convention","claim":"Retries live in src/queue","paths":["src/queue"],"static_check":"test -d src/queue"},
  {"kind":"GUARDRAIL","claim":"Never edit generated files","guardrail_level":"never"},
  {"kind":"NOT_A_KIND","claim":"should be dropped"},
  {"kind":"CONVENTION","claim":"retries   live in src/queue"}
]}`;
  const claims = parseClaims(raw);
  assert.equal(claims.length, 2); // invalid kind dropped, near-duplicate deduped
  assert.equal(claims[0].staticCheck, "test -d src/queue");
  assert.equal(claims[1].guardrailLevel, "never");
  assert.equal(parseClaims("garbage with no json").length, 0);
  assert.equal(dedupeClaims([]).length, 0);
});

// ---------------------------------------------------------------- commit miner

test("classifyCommit: signals map to kinds; routine commits yield null", () => {
  assert.equal(
    classifyCommit({ sha: "a", subject: "Revert the streaming parser", body: "", files: [] })?.kind,
    "FAILED_APPROACH"
  );
  assert.equal(
    classifyCommit({ sha: "b", subject: "Add workaround for safari cookies", body: "", files: [] })?.kind,
    "GOTCHA"
  );
  assert.equal(
    classifyCommit({ sha: "c", subject: "Migrated from REST to gRPC", body: "", files: [] })?.kind,
    "DECISION"
  );
  assert.equal(classifyCommit({ sha: "d", subject: "Bump deps", body: "", files: [] }), null);
  // long explanatory body with why-markers → DECISION even without keywords
  const long = "x".repeat(100) + " because the previous behaviour caused data loss on retry " + "y".repeat(30);
  assert.equal(classifyCommit({ sha: "e", subject: "Update pipeline", body: long, files: [] })?.kind, "DECISION");
});

test("scopeFromFiles: filters noise, collapses to top directories", () => {
  assert.deepEqual(scopeFromFiles([".DS_Store", "node_modules/x.js"]), []);
  assert.deepEqual(scopeFromFiles(["src/a.ts", "src/b.ts"]), ["src/a.ts", "src/b.ts"]);
  const many = ["src/db/a.ts", "src/db/b.ts", "src/db/c.ts", "src/ui/d.ts", "docs/e.md", "src/db/f.ts", "src/ui/g.ts"];
  const scoped = scopeFromFiles(many, 2);
  assert.deepEqual(scoped, ["src/db", "src/ui"]);
});

