import { existsSync, readFileSync } from "node:fs";

/**
 * Load KEY=VALUE lines from a .env file, merging UNDER process.env
 * (shell export wins). Supports # comments and quoted values.
 */
export function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/**
 * Extract BENCH_FORWARD_* env vars, stripping the prefix.
 * e.g. BENCH_FORWARD_GITHUB_TOKEN=xxx -> { GITHUB_TOKEN: "xxx" }
 */
export function forwardedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("BENCH_FORWARD_") || typeof v !== "string" || v === "") continue;
    out[k.slice("BENCH_FORWARD_".length)] = v;
  }
  return out;
}
