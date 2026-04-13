import { Command } from "commander";
import { handler as initHandler } from "./commands/init.ts";
import { handler as mcpHandler } from "./commands/mcp.ts";
import { handler as runHandler } from "./commands/run.ts";
import { handler as saveHandler } from "./commands/save.ts";
import { handler as reindexHandler } from "./commands/reindex.ts";
import { handler as doctorHandler } from "./commands/doctor.ts";
import { handler as gcHandler } from "./commands/gc.ts";

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("code-mode")
    .description("CLI + MCP server for typed, reusable script management")
    .version("0.0.0");

  program
    .command("init")
    .description("Scaffold a .code-mode/ workspace in the current project")
    .option("--path <path>", "Target path (defaults to cwd)")
    .option("--force", "Overwrite existing .code-mode/ workspace")
    .option("--no-install", "Skip 'bun install' inside the workspace")
    .action((opts) => initHandler(opts));

  program
    .command("mcp")
    .description("Run code-mode as an MCP server over stdio")
    .action((opts) => mcpHandler(opts));

  program
    .command("run [mode]")
    .description("Execute a saved or ad-hoc script")
    .action((mode, opts) => runHandler({ ...opts, mode }));

  program
    .command("save")
    .description("Persist a script to the workspace index")
    .action((opts) => saveHandler(opts));

  program
    .command("reindex")
    .description("Rebuild the SQLite+FTS5 index from disk")
    .action((opts) => reindexHandler(opts));

  program
    .command("doctor")
    .description("Inspect workspace health and report issues")
    .action((opts) => doctorHandler(opts));

  program
    .command("gc")
    .description("Identify stale or duplicate scripts")
    .action((opts) => gcHandler(opts));

  return program;
}

export function run(argv: string[]): void {
  const program = buildProgram();
  program.parse(argv);
}
