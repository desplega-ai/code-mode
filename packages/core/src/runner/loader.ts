/**
 * Emits the loader source that Bun runs in the child process.
 *
 * The loader:
 *   - Takes `entryUrl` (a file:// URL) and `argsJson` (base64-encoded JSON) as argv.
 *   - Dynamically imports the entry module.
 *   - Calls `default(args)` (or throws if the default export isn't a function).
 *   - Awaits, then prints `\n__CODE_MODE_RESULT__:<json>\n` to stdout.
 *   - Any other stdout / stderr chatter from the script itself is captured as `logs`.
 *
 * Design choices:
 *   - Loader is emitted inline to avoid a file-on-disk bootstrap requirement.
 *     Bun accepts `-e <code>` which we use via a shell wrapper.
 *   - argsJson is base64-encoded so shell-escaping of nested JSON is a non-issue.
 *   - The sentinel is a newline-fenced unique string so we can split logs from
 *     the serialized result even if the script itself writes arbitrary bytes.
 */

export const RESULT_SENTINEL = "__CODE_MODE_RESULT__:";

/**
 * Generate the loader TS source. The loader is self-contained — no imports
 * from code-mode — so it can be piped into `bun -e`.
 *
 * The `entryUrl` and `argsJsonB64` are baked into the source as string
 * literals so we don't have to wrestle with argv when running via `bun -e`.
 */
export function emitLoaderSource(entryUrl: string, argsJsonB64: string): string {
  const escapedEntry = JSON.stringify(entryUrl);
  const escapedArgs = JSON.stringify(argsJsonB64);
  const sentinel = JSON.stringify(RESULT_SENTINEL);
  return `
const __entryUrl = ${escapedEntry};
const __argsB64 = ${escapedArgs};
const __sentinel = ${sentinel};

async function __runLoader() {
  let args;
  try {
    const decoded = Buffer.from(__argsB64, "base64").toString("utf8");
    args = decoded.length === 0 ? undefined : JSON.parse(decoded);
  } catch (e) {
    process.stderr.write("[code-mode loader] failed to parse argsJson: " + (e && e.message ? e.message : String(e)) + "\\n");
    process.exit(2);
  }

  let mod;
  try {
    mod = await import(__entryUrl);
  } catch (e) {
    process.stderr.write("[code-mode loader] import failed: " + (e && e.stack ? e.stack : String(e)) + "\\n");
    process.exit(3);
  }

  const main = mod && (mod.default || mod.main);
  if (typeof main !== "function") {
    process.stderr.write("[code-mode loader] entry has no default-exported async main(args) function\\n");
    process.exit(4);
  }

  let result;
  try {
    result = await main(args);
  } catch (e) {
    process.stderr.write("[code-mode loader] main() threw: " + (e && e.stack ? e.stack : String(e)) + "\\n");
    process.exit(5);
  }

  let serialized;
  try {
    serialized = JSON.stringify(result === undefined ? null : result);
  } catch (e) {
    process.stderr.write("[code-mode loader] result not JSON-serializable: " + (e && e.message ? e.message : String(e)) + "\\n");
    process.exit(6);
  }

  process.stdout.write("\\n" + __sentinel + serialized + "\\n");
  process.exit(0);
}

__runLoader();
`;
}
