/**
 * Verification-engine tests: status lifecycle, confidence decay math,
 * the trust gate at run time, and the STALE → recovery-proposal loop.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryStore } from "../db/store.js";
import { verifyAll, decayedConfidence } from "../verify/engine.js";
import { runEvidence } from "../verify/runners.js";

function tempRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "aidimag-verify-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

test("decayedConfidence: halves at one half-life, floors at minimum", () => {
  const thirtyDaysAgo = new Date(Date.now() - 45 * 86_400_000).toISOString();
  const halved = decayedConfidence(0.8, thirtyDaysAgo, 45);
  assert.ok(Math.abs(halved - 0.4) < 0.01, `expected ~0.4, got ${halved}`);
  const ancient = new Date(Date.now() - 3650 * 86_400_000).toISOString();
  assert.equal(decayedConfidence(0.9, ancient, 45), 0.05);
  // future/now anchor → unchanged
  assert.equal(decayedConfidence(0.6, new Date().toISOString(), 45), 0.6);
});

test("verifyAll: pass → VERIFIED with boost; fail → STALE with floor + recovery proposal", () => {
  const dir = tempRepo();
  const store = new MemoryStore(path.join(dir, ".aidimag", "memory.db"));
  try {
    const good = store.write({
      kind: "INVARIANT",
      claim: "true is true",
      evidence: [{ type: "STATIC_CHECK", payload: "true" }],
    });
    const bad = store.write({
      kind: "INVARIANT",
      claim: "false is true",
      evidence: [{ type: "STATIC_CHECK", payload: "false" }],
    });

    const report = verifyAll(store, dir);
    assert.equal(report.verified, 1);
    assert.equal(report.stale, 1);
    assert.equal(store.get(good.id)?.status, "VERIFIED");
    assert.ok(store.get(good.id)!.confidence > 0.7);
    assert.equal(store.get(bad.id)?.status, "STALE");
    assert.equal(store.get(bad.id)?.confidence, 0.2);

    // staleness is a capture trigger: a recovery proposal was drafted
    const pending = store.listProposals("PENDING", 100);
    const recovery = pending.filter((p) => p.source === "verify:stale");
    assert.equal(recovery.length, 1);
    assert.equal(recovery[0].sourceRef, bad.id);
    assert.match(recovery[0].claim, /Stale belief needs revisiting/);

    // second run: still stale, but no duplicate proposal (before === STALE)
    verifyAll(store, dir);
    assert.equal(store.listProposals("PENDING", 100).filter((p) => p.source === "verify:stale").length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("trust gate: untrusted synced evidence is SKIPPED, not executed", () => {
  const dir = tempRepo();
  const store = new MemoryStore(path.join(dir, ".aidimag", "memory.db"));
  try {
    const local = store.write({ kind: "GOTCHA", claim: "seed" });
    // a synced-in memory whose STATIC_CHECK would FAIL if it ever ran
    store.applyRemoteMemory({
      ...local,
      id: "99999999-8888-7777-6666-555555555555",
      claim: "Synced claim with foreign shell command",
      status: "VERIFIED",
      grounding: [
        {
          id: "ev-foreign",
          memoryId: "99999999-8888-7777-6666-555555555555",
          type: "STATIC_CHECK",
          payload: "exit 1",
          lastRun: null,
          result: "UNKNOWN",
        },
      ],
      links: [],
    });

    const report = verifyAll(store, dir);
    const r = report.results.find((x) => x.memoryId === "99999999-8888-7777-6666-555555555555")!;
    const outcome = r.outcomes.find((o) => o.type === "STATIC_CHECK")!;
    assert.equal(outcome.result, "SKIPPED");
    assert.match(outcome.detail, /untrusted/);
    // and because it never ran, the memory was NOT marked STALE by it
    assert.notEqual(r.after, "STALE");

    // after explicit approval, it runs (and correctly fails)
    store.trustAllEvidence();
    const report2 = verifyAll(store, dir);
    const r2 = report2.results.find((x) => x.memoryId === "99999999-8888-7777-6666-555555555555")!;
    assert.equal(r2.after, "STALE");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runEvidence: deep tier skipped without --deep; HUMAN_ATTESTED passes; TICKET_REF annotates", () => {
  const dir = tempRepo();
  try {
    const base = { id: "e1", memoryId: "m1", lastRun: null, result: "UNKNOWN" as const };
    assert.equal(runEvidence({ ...base, type: "TEST_RESULT", payload: "true" }, dir).result, "SKIPPED");
    assert.equal(runEvidence({ ...base, type: "TEST_RESULT", payload: "true" }, dir, { deep: true }).result, "PASS");
    assert.equal(runEvidence({ ...base, type: "EXEC_TRACE", payload: "echo hello :: hel+o" }, dir, { deep: true }).result, "PASS");
    assert.equal(runEvidence({ ...base, type: "EXEC_TRACE", payload: "echo hello :: nope" }, dir, { deep: true }).result, "FAIL");
    assert.equal(runEvidence({ ...base, type: "HUMAN_ATTESTED", payload: "trust me" }, dir).result, "PASS");
    assert.equal(runEvidence({ ...base, type: "TICKET_REF", payload: "XXX-1" }, dir).result, "SKIPPED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

