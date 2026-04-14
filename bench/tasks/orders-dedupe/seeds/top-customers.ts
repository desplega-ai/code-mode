/**
 * @name topCustomersByRevenue
 * @description Dedupe orders across /workspace/orders/*.jsonl by order_id (latest ts wins), sum by customer, return top N.
 * @tags orders, jsonl, dedupe, groupby, aggregate, top-n, revenue
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface Order {
  order_id: string;
  customer_id: string;
  amount: number;
  ts: string;
}

export interface Args {
  dir: string;
  limit?: number;
}

export default async function topCustomersByRevenue(args: Args): Promise<string> {
  const files = readdirSync(args.dir).filter((f) => f.endsWith(".jsonl"));
  const latest = new Map<string, Order>();
  for (const f of files) {
    const text = readFileSync(join(args.dir, f), "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      const o = JSON.parse(line) as Order;
      const cur = latest.get(o.order_id);
      if (!cur || Date.parse(o.ts) > Date.parse(cur.ts)) latest.set(o.order_id, o);
    }
  }
  const totals = new Map<string, number>();
  for (const o of latest.values()) {
    totals.set(o.customer_id, (totals.get(o.customer_id) ?? 0) + o.amount);
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, args.limit ?? 3)
    .map(([c, t]) => `${c} ${t.toFixed(2)}`)
    .join("\n");
}
