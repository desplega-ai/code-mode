/**
 * Emits the `sdks/stdlib/flatten.ts` seed written into a workspace on init.
 */
export function flattenTs(): string {
  return `/**
 * @name flatten
 * @description Flattens a nested object into a single-level record with dot-delimited keys.
 * @tags object, transform, utility
 */
export function flatten(obj: unknown, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (obj === null || typeof obj !== "object") {
    if (prefix) out[prefix] = obj;
    return out;
  }
  if (Array.isArray(obj)) {
    obj.forEach((item, idx) => {
      const key = prefix ? prefix + "[" + idx + "]" : "[" + idx + "]";
      Object.assign(out, flatten(item, key));
    });
    return out;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? prefix + "." + k : k;
    if (v !== null && typeof v === "object") {
      Object.assign(out, flatten(v, key));
    } else {
      out[key] = v;
    }
  }
  return out;
}
`;
}
