/**
 * @name joinByKey
 * @description Inner-join two arrays on a key extractor. Returns [left, right] tuples.
 * @tags join, merge, aggregate, data
 */

export interface JoinArgs<L, R> {
  left: L[];
  right: R[];
  leftKey: (l: L) => string | number;
  rightKey: (r: R) => string | number;
}

export default async function joinByKey<L, R>(args: JoinArgs<L, R>): Promise<[L, R][]> {
  const index = new Map<string, R[]>();
  for (const r of args.right) {
    const k = String(args.rightKey(r));
    const bucket = index.get(k) ?? [];
    bucket.push(r);
    index.set(k, bucket);
  }
  const out: [L, R][] = [];
  for (const l of args.left) {
    const k = String(args.leftKey(l));
    for (const r of index.get(k) ?? []) out.push([l, r]);
  }
  return out;
}
