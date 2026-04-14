/**
 * @name regionTotals
 * @description Sum `amount` by `region` in a sales CSV and return a markdown table sorted desc.
 * @tags csv, groupby, aggregate, markdown, sales
 */
import { readFileSync } from "node:fs";

export interface Args {
  path: string;
}

export default async function regionTotals(args: Args): Promise<string> {
  const raw = readFileSync(args.path, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  const header = lines[0]!.split(",");
  const regionIdx = header.indexOf("region");
  const amountIdx = header.indexOf("amount");
  const totals = new Map<string, number>();
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i]!.split(",");
    const region = cells[regionIdx]!;
    const amount = parseFloat(cells[amountIdx] ?? "0");
    totals.set(region, (totals.get(region) ?? 0) + amount);
  }
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const header_md = `| Region | Total |\n| --- | --- |`;
  const body = sorted.map(([r, t]) => `| ${r} | ${t} |`).join("\n");
  return `${header_md}\n${body}`;
}
