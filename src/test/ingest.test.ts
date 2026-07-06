/**
 * Knowledge ingestion classification tests — PDF/DOCX text extraction,
 * plain-text passthrough, and safe skipping of corrupt/unsupported files.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyInbox } from "../knowledge/ingest.js";
import { resolveKnowledgeConfig } from "../config.js";

// dist/test/ → repo root → committed binary fixtures under src/test/fixtures
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/test/fixtures");

function tempInbox(): { root: string; inbox: string } {
  const root = mkdtempSync(path.join(tmpdir(), "aidimag-ingest-"));
  const inbox = path.join(root, "knowledge");
  mkdirSync(inbox, { recursive: true });
  return { root, inbox };
}

test("classifyInbox extracts text from PDF and DOCX before summarization", async () => {
  const { root, inbox } = tempInbox();
  try {
    copyFileSync(path.join(FIXTURES, "sample.pdf"), path.join(inbox, "sample.pdf"));
    copyFileSync(path.join(FIXTURES, "sample.docx"), path.join(inbox, "sample.docx"));
    writeFileSync(path.join(inbox, "note.md"), "# Note\nPlain markdown still works.\n");

    const { pending, toSkip } = await classifyInbox(root, resolveKnowledgeConfig(root));
    assert.equal(toSkip.length, 0);
    assert.equal(pending.length, 3);

    const pdf = pending.find((d) => d.file === "sample.pdf");
    assert.ok(pdf, "PDF should be pending, not skipped");
    assert.match(pdf.content, /Hello aidimag PDF extraction/);
    assert.match(pdf.content, /src\/db\/store\.ts/); // multi-line survives extraction

    const docx = pending.find((d) => d.file === "sample.docx");
    assert.ok(docx, "DOCX should be pending, not skipped");
    assert.match(docx.content, /Hello aidimag DOCX extraction/);

    const md = pending.find((d) => d.file === "note.md");
    assert.ok(md);
    assert.match(md.content, /Plain markdown still works/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("classifyInbox skips corrupt binary docs with the parser error (never deletes)", async () => {
  const { root, inbox } = tempInbox();
  try {
    writeFileSync(path.join(inbox, "corrupt.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0x02])); // "%PDF" + garbage
    writeFileSync(path.join(inbox, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47])); // unsupported extension

    const { pending, toSkip } = await classifyInbox(root, resolveKnowledgeConfig(root));
    assert.equal(pending.length, 0);

    const corrupt = toSkip.find((s) => s.file === "corrupt.pdf");
    assert.ok(corrupt);
    assert.match(corrupt.reason, /text extraction failed/);

    const png = toSkip.find((s) => s.file === "image.png");
    assert.ok(png);
    assert.match(png.reason, /unsupported type/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

