#!/usr/bin/env node
/**
 * Mock Ollama embeddings server for integration testing (port 11434).
 * Deterministic char-trigram hashing → 64-dim normalized vectors, so similar
 * texts get similar vectors and KNN behaves meaningfully in tests.
 */
import { createServer } from "node:http";

const DIM = 64;

function embed(text) {
  const v = new Array(DIM).fill(0);
  const s = text.toLowerCase().replace(/[^a-z0-9 ]/g, " ");
  for (let i = 0; i < s.length - 2; i++) {
    const tri = s.slice(i, i + 3);
    let h = 0;
    for (const c of tri) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    v[h % DIM] += 1;
  }
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/api/embeddings") {
    res.writeHead(404); res.end(); return;
  }
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const { prompt } = JSON.parse(body);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ embedding: embed(prompt) }));
  });
}).listen(11434, "127.0.0.1", () => console.log("mock ollama on :11434"));

