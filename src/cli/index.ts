#!/usr/bin/env node
/**
 * dim — the aidimag CLI (dimag = brain).
 *
 * Thin entry point: builds the commander program and delegates to the command
 * modules in ./commands/ (one file per domain):
 *
 *   memory.ts     init, remember, recall, reindex, status, log, gaps,
 *                 refute, pin, unpin, forget
 *   capture.ts    mine (commits/PRs), bootstrap, harvest, review
 *   verify.ts     verify, check, brief
 *   sync.ts       serve, cloud, login, logout, sync, keys
 *   tickets.ts    ticket, branch, branch-check
 *   knowledge.ts  knowledge sync | status | list | watch
 *   hosts.ts      ui, generate-context, mcp
 *
 * Shared helpers (printers, prompter, auto-sync, fail) live in ../shared.ts.
 */

import { Command } from "commander";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fail } from "./shared.js";
import { registerMemoryCommands } from "./commands/memory.js";
import { registerCaptureCommands } from "./commands/capture.js";
import { registerVerifyCommands } from "./commands/verify.js";
import { registerSyncCommands } from "./commands/sync.js";
import { registerTicketCommands } from "./commands/tickets.js";
import { registerKnowledgeCommands } from "./commands/knowledge.js";
import { registerHostCommands } from "./commands/hosts.js";

/** Version comes from package.json — single source of truth. */
const PKG_VERSION: string = JSON.parse(
  readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8")
).version;

const program = new Command();

program
  .name("dim")
  .description("aidimag — persistent, verified memory for AI coding agents")
  .version(PKG_VERSION, "-v, --version", "print the aidimag version");

registerMemoryCommands(program);
registerCaptureCommands(program);
registerVerifyCommands(program);
registerSyncCommands(program);
registerTicketCommands(program);
registerKnowledgeCommands(program);
registerHostCommands(program);

program.parseAsync().catch((err) => fail(err instanceof Error ? err.message : String(err)));

