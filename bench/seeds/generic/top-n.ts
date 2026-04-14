/**
 * @name topN
 * @description Count occurrences by a key function and return the top N entries sorted desc.
 * @tags aggregate, groupby, count, top-n, stats
 */

export interface TopNArgs<T> {
  items: T[];
  key: (item: T) => string;
  n?: number;
}

export interface TopNEntry<T> {
  key: string;
  count: number;
  sample: T;
}

export default async function topN<T>(args: TopNArgs<T>): Promise<TopNEntry<T>[]> {
  const counts = new Map<string, { count: number; sample: T }>();
  for (const item of args.items) {
    const k = args.key(item);
    const cur = counts.get(k);
    if (cur) cur.count += 1;
    else counts.set(k, { count: 1, sample: item });
  }
  const entries = [...counts.entries()]
    .map(([key, v]) => ({ key, count: v.count, sample: v.sample }))
    .sort((a, b) => b.count - a.count);
  return args.n ? entries.slice(0, args.n) : entries;
}
