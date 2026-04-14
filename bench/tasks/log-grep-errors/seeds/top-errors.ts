/**
 * @name topErrorsInLogs
 * @description Scan /workspace/logs/*.log for ERROR lines, group by message, return top N counts.
 * @tags logs, grep, errors, aggregate, top-n
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Args {
  dir: string;
  limit?: number;
}

export default async function topErrorsInLogs(args: Args): Promise<string> {
  const files = readdirSync(args.dir).filter((f) => f.endsWith(".log"));
  const counts = new Map<string, number>();
  const re = /ERROR:\s+(.+)$/;
  for (const f of files) {
    const text = readFileSync(join(args.dir, f), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(re);
      if (!m) continue;
      const msg = m[1]!.trim();
      counts.set(msg, (counts.get(msg) ?? 0) + 1);
    }
  }
  const sorted = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, args.limit ?? 3);
  return sorted.map(([msg, n]) => `${n} ${msg}`).join("\n");
}
