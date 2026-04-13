/**
 * Emits the `sdks/stdlib/table.ts` seed written into a workspace on init.
 */
export function tableTs(): string {
  return `/**
 * @name table
 * @description Renders an array of records as a monospaced ASCII table string.
 * @tags formatting, output, utility
 */
export function table<T extends Record<string, unknown>>(rows: T[], columns?: (keyof T)[]): string {
  if (rows.length === 0) return "";
  const cols: (keyof T)[] = columns ?? (Object.keys(rows[0] as object) as (keyof T)[]);
  const header = cols.map((c) => String(c));
  const body = rows.map((row) => cols.map((c) => formatCell(row[c])));
  const widths = header.map((h, i) => {
    let w = h.length;
    for (const line of body) {
      if (line[i].length > w) w = line[i].length;
    }
    return w;
  });
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  const sep = "+" + widths.map((w) => "-".repeat(w + 2)).join("+") + "+";
  const fmtRow = (cells: string[]) =>
    "|" + cells.map((c, i) => " " + pad(c, widths[i]!) + " ").join("|") + "|";
  const lines: string[] = [];
  lines.push(sep);
  lines.push(fmtRow(header));
  lines.push(sep);
  for (const line of body) lines.push(fmtRow(line));
  lines.push(sep);
  return lines.join("\\n");
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
`;
}
