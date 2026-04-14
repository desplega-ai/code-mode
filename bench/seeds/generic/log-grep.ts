/**
 * @name logGrep
 * @description Grep a regex across a glob of files, returning {file, line, text} matches.
 * @tags grep, search, logs, files
 */
import { grep } from "@/sdks/stdlib/grep";
import { glob } from "@/sdks/stdlib/glob";

export interface LogGrepArgs {
  /** File glob (e.g. "logs/*.log"). */
  pattern: string;
  /** Regex to match per line. */
  regex: string;
  /** Regex flags. Default: "" (case-sensitive). */
  flags?: string;
  /** Max matches to return. Default: unlimited. */
  limit?: number;
}

export interface Match {
  file: string;
  line: number;
  text: string;
}

export default async function logGrep(args: LogGrepArgs): Promise<Match[]> {
  const files = await glob(args.pattern);
  const out: Match[] = [];
  for (const file of files) {
    const rows = await grep({ file, pattern: args.regex, flags: args.flags });
    for (const r of rows) {
      out.push({ file, line: r.line, text: r.text });
      if (args.limit && out.length >= args.limit) return out;
    }
  }
  return out;
}
