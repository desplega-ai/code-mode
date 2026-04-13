/**
 * Emits the `sdks/stdlib/filter.ts` seed written into a workspace on init.
 *
 * Kept as a raw string literal so the emitted file is byte-identical to what
 * we author here (JSDoc + types preserved) without relying on bundler asset
 * imports.
 */
export function filterTs(): string {
  return `/**
 * @name filter
 * @description Returns a new array containing only the items for which the predicate returns true.
 * @tags array, collection, utility
 */
export function filter<T>(items: T[], predicate: (item: T) => boolean): T[] {
  const out: T[] = [];
  for (const item of items) {
    if (predicate(item)) out.push(item);
  }
  return out;
}
`;
}
