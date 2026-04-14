/**
 * @name csvParse
 * @description Parse a CSV file (or string) into an array of typed records keyed by header.
 * @tags csv, parse, data, table
 */
import { readFileSync } from "node:fs";

export interface CsvParseArgs {
  /** Path to the CSV file. Mutually exclusive with `text`. */
  path?: string;
  /** Raw CSV text. Mutually exclusive with `path`. */
  text?: string;
  /** Delimiter. Default: ",". */
  delimiter?: string;
}

export default async function csvParse(args: CsvParseArgs): Promise<Record<string, string>[]> {
  const raw = args.text ?? (args.path ? readFileSync(args.path, "utf8") : "");
  const delim = args.delimiter ?? ",";
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = splitLine(lines[0]!, delim);
  const out: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]!, delim);
    const row: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) {
      row[header[c]!] = cells[c] ?? "";
    }
    out.push(row);
  }
  return out;
}

function splitLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; continue; }
      if (ch === '"') { inQuote = false; continue; }
      cur += ch;
    } else {
      if (ch === '"') { inQuote = true; continue; }
      if (ch === delim) { out.push(cur); cur = ""; continue; }
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}
