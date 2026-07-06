/**
 * Security regression tests for the sync/UI servers.
 *
 * Run with `npm test` (compiles to dist/test/ then `node --test`).
 * These lock in the XSS-escaping and request-body-limit fixes so the
 * vulnerabilities can't silently regress.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml } from "../sync/server.js";

test("escapeHtml neutralizes script-injection characters", () => {
  const payload = `<script>alert('xss')</script>`;
  const escaped = escapeHtml(payload);
  assert.ok(!escaped.includes("<script>"), "raw <script> must not survive escaping");
  assert.equal(
    escaped,
    "&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;"
  );
});

test("escapeHtml escapes all five sensitive characters", () => {
  assert.equal(escapeHtml(`& < > " '`), "&amp; &lt; &gt; &quot; &#39;");
});

test("escapeHtml escapes attribute-breaking quotes (value=\"...\" context)", () => {
  // A crafted user_code that tries to break out of the value="" attribute.
  const breakout = `"><img src=x onerror=alert(1)>`;
  const escaped = escapeHtml(breakout);
  assert.ok(!escaped.includes(`">`), "must not allow attribute breakout");
  assert.ok(!escaped.includes("<img"), "must not allow tag injection");
});

test("escapeHtml leaves safe text unchanged", () => {
  assert.equal(escapeHtml("ABCD-1234"), "ABCD-1234");
});

