#!/usr/bin/env node
/** MCP smoke test: spawns the server over stdio and exercises Phase 1+2 tools. */
import { spawn } from "node:child_process";

const server = spawn("node", ["dist/mcp/server.js"], { stdio: ["pipe", "pipe", "ignore"] });
const msgs = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1.0" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_propose", arguments: { kind: "TODO_CONTEXT", claim: "Phase 3 verify command is a stub; evidence runners for STATIC_CHECK and COMMIT_REF are next", agent_id: "copilot", rationale: "session-end test" } } },
  { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "proposals_pending", arguments: {} } },
  { jsonrpc: "2.0", id: 5, method: "prompts/list" },
];
for (const m of msgs) server.stdin.write(JSON.stringify(m) + "\n");

let buf = "";
let done = 0;
server.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id === 2) console.log("TOOLS:", m.result.tools.map((t) => t.name).join(", "));
    if (m.id === 3) console.log("PROPOSE:", m.result.content[0].text.split("\n")[0]);
    if (m.id === 4) console.log("PENDING:\n" + m.result.content[0].text);
    if (m.id === 5) console.log("PROMPTS:", m.result.prompts.map((p) => p.name).join(", "));
    if (m.id >= 2) done++;
    if (done === 4) { server.kill(); process.exit(0); }
  }
});
setTimeout(() => { console.error("timeout"); server.kill(); process.exit(1); }, 10000);

