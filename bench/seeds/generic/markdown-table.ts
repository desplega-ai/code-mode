/**
 * @name markdownTable
 * @description Render an array of records as a GitHub-flavored markdown table.
 * @tags format, markdown, table, report
 */

export interface MarkdownTableArgs {
  rows: Record<string, string | number>[];
  columns?: string[];
}

export default async function markdownTable(args: MarkdownTableArgs): Promise<string> {
  if (args.rows.length === 0) return "";
  const cols = args.columns ?? Object.keys(args.rows[0]!);
  const header = `| ${cols.join(" | ")} |`;
  const sep = `| ${cols.map(() => "---").join(" | ")} |`;
  const body = args.rows
    .map((r) => `| ${cols.map((c) => String(r[c] ?? "")).join(" | ")} |`)
    .join("\n");
  return `${header}\n${sep}\n${body}`;
}
