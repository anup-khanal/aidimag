/**
 * Host-process & integration commands: ui (dashboard), generate-context, mcp.
 */

import type { Command } from "commander";
import { MemoryStore, findRepoRoot } from "../../db/store.js";
import { fail, openBrowser } from "../shared.js";

export function registerHostCommands(program: Command): void {
  program
    .command("ui")
    .argument("[action]", "start (default) | stop")
    .description("Manage the local web dashboard (memory list, review queue, visual graph)")
    .option("-p, --port <n>", "Port", "4517")
    .option("--no-open", "Don't open the browser automatically (start only)")
    .action(async (action: string | undefined, opts) => {
      const effectiveAction = action ?? "start";

      if (effectiveAction === "stop") {
        const port = parseInt(opts.port, 10);
        const { exec } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execAsync = promisify(exec);

        try {
          // Find process listening on the port
          const cmd = process.platform === "win32"
            ? `netstat -ano | findstr :${port}`
            : `lsof -ti:${port}`;

          const { stdout } = await execAsync(cmd);

          if (!stdout.trim()) {
            console.log(`No server found running on port ${port}`);
            return;
          }

          // Kill the process
          const pids = process.platform === "win32"
            ? stdout.split("\n").map(line => line.trim().split(/\s+/).pop()).filter(Boolean)
            : stdout.trim().split("\n");

          for (const pid of pids) {
            const killCmd = process.platform === "win32" ? `taskkill /F /PID ${pid}` : `kill ${pid}`;
            await execAsync(killCmd);
          }

          console.log(`✓ Stopped server on port ${port}`);
        } catch (err) {
          if (err instanceof Error && "code" in err && err.code === 1) {
            console.log(`No server found running on port ${port}`);
          } else {
            fail(`Failed to stop server: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } else if (effectiveAction === "start") {
        const root = findRepoRoot() ?? fail("not inside a repo");
        const store = MemoryStore.open(root);
        const { startUiServer } = await import("../../ui/server.js");
        const url = await startUiServer(store, root, parseInt(opts.port, 10));
        console.log(`aidimag dashboard: ${url}  (Ctrl+C to stop)`);
        if (opts.open) await openBrowser(url);
      } else {
        fail(`unknown action '${action}'. Use: start | stop`);
      }
    });

  program
    .command("generate-context")
    .description("Render trustworthy memory into a static context file (CLAUDE.md, .cursorrules, .windsurfrules, AGENTS.md, copilot-instructions) for non-MCP AI tools")
    .option("-f, --format <format>", "claude | cursorrules | copilot | windsurfrules | agents | all", "claude")
    .option("--auto", "Also persist generateContext.auto in .aidimag/config.json so verify/review/sync keep it fresh")
    .option("--no-auto", "Disable auto-regeneration (clears generateContext.auto)")
    .action(async (opts) => {
      const root = findRepoRoot() ?? fail("not inside a repo");
      const store = MemoryStore.open(root);
      const { generateContext } = await import("../../context/generate.js");
      const format = String(opts.format).toLowerCase();
      if (!["claude", "cursorrules", "copilot", "windsurfrules", "agents", "all"].includes(format)) {
        fail(`invalid --format '${opts.format}'. Use: claude | cursorrules | copilot | windsurfrules | agents | all`);
      }
      const r = generateContext(store, root, format as never);
      console.log(`📝 Wrote ${r.files.join(", ")} — ${r.total} memories (${r.pinned} pinned).`);
      if (r.total === 0) {
        console.log("   (no verified memories yet — run `dim remember` or approve proposals with `dim review`)");
      }
      // commander sets opts.auto=false only when --no-auto is passed; undefined otherwise
      if (opts.auto === true || opts.auto === false) {
        const { writeConfig } = await import("../../config.js");
        writeConfig(root, { generateContext: opts.auto ? { auto: true, format: format as never } : { auto: false } });
        console.log(
          opts.auto
            ? `🔄 Auto-regeneration ON — verify/review/sync will refresh ${format === "all" ? "the context files" : r.files[0]}.`
            : `Auto-regeneration OFF.`
        );
      }
      store.close();
    });

  program
    .command("mcp")
    .description("Run the aidimag MCP server (stdio)")
    .action(async () => {
      await import("../../mcp/server.js");
    });
}

