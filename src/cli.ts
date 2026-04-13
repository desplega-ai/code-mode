import { Command } from "commander";
import { handler as initHandler } from "./commands/init.ts";
import { handler as mcpHandler } from "./commands/mcp.ts";
import { handler as runHandler } from "./commands/run.ts";
import { handler as saveHandler } from "./commands/save.ts";
import { handler as reindexHandler } from "./commands/reindex.ts";
import { handler as doctorHandler } from "./commands/doctor.ts";
import { handler as gcHandler } from "./commands/gc.ts";
import { handler as listSdksHandler } from "./commands/listSdks.ts";
import { handler as queryTypesHandler } from "./commands/queryTypes.ts";

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
    .command("run [name]")
    .description("Execute a saved or ad-hoc script")
    .option("--path <path>", "Target workspace directory (defaults to cwd)")
    .option("--inline <file>", "Run an ad-hoc TS file outside .code-mode/")
    .option("--source <stdin>", "Read TS source from stdin (use '-')")
    .option("--args <json>", "JSON-encoded arg to pass to main(args)", "null")
    .option("--timeout <ms>", "Wall-clock timeout in milliseconds")
    .option("--max-memory <mb>", "Virtual memory cap (MB)")
    .option("--max-cpu <sec>", "CPU-seconds cap")
    .option("--max-output <bytes>", "Captured log output cap (bytes)")
    .action(async (name, opts) => {
      await runHandler({ ...opts, mode: name });
    });

  program
    .command("save <name>")
    .description("Persist a script to the workspace index")
    .option("--path <path>", "Target workspace directory (defaults to cwd)")
    .option("--file <path>", "Source file to copy into .code-mode/scripts/<name>.ts")
    .option("--source <stdin>", "Read source from stdin (use '-')")
    .option("--overwrite", "Replace an existing script with the same name")
    .action(async (name, opts) => {
      await saveHandler({ ...opts, name });
    });

  program
    .command("reindex")
    .description("Rebuild the SQLite+FTS5 index from disk")
    .option("--path <path>", "Target workspace directory (defaults to cwd)")
    .option("--paths <csv>", "Comma-separated absolute paths to re-process only")
    .action((opts) => reindexHandler(opts));

  program
    .command("list-sdks")
    .description("List every indexed SDK")
    .option("--path <path>", "Target workspace directory (defaults to cwd)")
    .option("--json", "Emit JSON instead of a table")
    .action((opts) => listSdksHandler(opts));

  program
    .command("query-types <pattern>")
    .description("FTS5-backed search over indexed symbol signatures")
    .option("--path <path>", "Target workspace directory (defaults to cwd)")
    .option("--sdk <name>", "Restrict to a single SDK")
    .option("--kind <kind>", "Restrict to a specific symbol kind (function|type|interface|class|const)")
    .option("--limit <n>", "Maximum results to return (default 50)")
    .option("--json", "Emit JSON instead of a table")
    .action((pattern, opts) => queryTypesHandler(pattern, opts));

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
