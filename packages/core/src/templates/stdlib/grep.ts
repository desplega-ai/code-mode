/**
 * Emits the `sdks/stdlib/grep.ts` seed written into a workspace on init.
 *
 * The emitted script spawns `rg` (ripgrep) via `execFileSync` with the args
 * passed as an array (never shelled-out to `/bin/sh -c`), so user-supplied
 * patterns and paths are not interpreted as shell metacharacters.
 *
 * Uses `rg --vimgrep` because its output format (`file:line:col:text`) is
 * trivially line-parseable and stable across ripgrep versions. `--json` would
 * give us typed events, but at the cost of a heavier parser and a hard
 * dependency on a specific rg version.
 */
export function grepTs(): string {
  return `/**
 * @name grep
 * @description Runs ripgrep (\`rg\`) against a path and returns structured results. Requires \`rg\` on PATH.
 * @tags search, text, ripgrep, files, utility
 */

import { execFileSync } from "node:child_process";

export interface GrepOptions {
  /** Directory or file to search. Default: cwd. */
  path?: string;
  /** Glob filter (e.g. "*.ts"). Forwarded as \`-g\`. */
  glob?: string | string[];
  /** Case-insensitive matching. Forwarded as \`-i\`. */
  ignoreCase?: boolean;
  /** Treat the pattern as a literal string. Forwarded as \`-F\`. */
  fixedStrings?: boolean;
  /** Cap result count. Forwarded as \`-m\`. */
  maxCount?: number;
}

export interface GrepHit {
  file: string;
  line: number;
  text: string;
}

/**
 * @name grep
 * @description Search for \`pattern\` under \`path\` and return structured { file, line, text } hits.
 * @tags search, ripgrep, files
 */
export function grep(pattern: string, options: GrepOptions = {}): GrepHit[] {
  const args: string[] = ["--vimgrep", "--no-heading", "--color=never"];
  if (options.ignoreCase) args.push("-i");
  if (options.fixedStrings) args.push("-F");
  if (options.maxCount !== undefined) args.push("-m", String(options.maxCount));
  if (options.glob) {
    const globs = Array.isArray(options.glob) ? options.glob : [options.glob];
    for (const g of globs) {
      args.push("-g", g);
    }
  }
  // Delimit the pattern so things like "-foo" aren't interpreted as a flag.
  args.push("--", pattern);
  if (options.path) args.push(options.path);

  let out: string;
  try {
    out = execFileSync("rg", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const e = err as { code?: string; status?: number | null; stdout?: string };
    if (e.code === "ENOENT") {
      throw new Error(
        "grep: ripgrep (\`rg\`) is not on PATH. Install it:\\n" +
          "  macOS:   brew install ripgrep\\n" +
          "  Debian:  apt install ripgrep\\n" +
          "  Others:  https://github.com/BurntSushi/ripgrep#installation",
      );
    }
    // rg exits 1 when there are no matches — treat as empty result, not an error.
    if (e.status === 1) return [];
    throw err;
  }

  return parseVimgrep(out);
}

function parseVimgrep(output: string): GrepHit[] {
  const hits: GrepHit[] = [];
  // Greedy match so \`C:\\path\` (Windows drive letter) stays in the file
  // component; backtracking lands on the last \`:<digits>:<digits>:\` pair,
  // which is exactly what vimgrep emits.
  const re = /^(.*):(\\d+):(\\d+):(.*)$/;
  for (const raw of output.split(/\\r?\\n/)) {
    if (!raw) continue;
    const m = re.exec(raw);
    if (!m) continue;
    const [, file, lineStr, , text] = m;
    const lineNo = parseInt(lineStr ?? "", 10);
    if (!Number.isFinite(lineNo)) continue;
    hits.push({ file: file ?? "", line: lineNo, text: text ?? "" });
  }
  return hits;
}
`;
}
