# Script contract

Every script runnable by `code-mode run` MUST have a default export shaped as:

```typescript
export default async function main(args: unknown): Promise<unknown>;
```

## Contract details

1. **Default export.** The loader looks up the module's `default` export first,
   falling back to a named `main` export if present. If neither is a function,
   the loader exits non-zero with a diagnostic.
2. **Async.** The loader always `await`s the result.
3. **Argument.** The CLI's `--args <json>` flag is parsed with `JSON.parse` and
   handed to `main` as-is. When `--args` is omitted, `args` is `undefined`.
4. **Return value.** Whatever you return is serialized with `JSON.stringify` and
   printed on a dedicated line prefixed with `__CODE_MODE_RESULT__:`. If your
   return value is not JSON-serializable (e.g. contains `BigInt`, functions,
   or circular references), the loader exits non-zero.
5. **Side effects.** Anything written to `stdout` / `stderr` that is not the
   sentinel line is captured in `RunResult.logs`. Logs are capped at 1 MB by
   default; excess output is truncated with a `[truncated]` marker.

## Example

```typescript
// .code-mode/scripts/sum.ts
import { filter } from "@/sdks/stdlib/filter";

export default async function main(args: { numbers: number[] }) {
  const positives = filter(args.numbers, (n) => n > 0);
  return { count: positives.length, sum: positives.reduce((a, b) => a + b, 0) };
}
```

Run it:

```
code-mode run sum --args '{"numbers":[1,-2,3,-4,5]}'
```

## Execution limits

| Flag            | Default | Max         |
|-----------------|---------|-------------|
| `--timeout`     | 30,000  | 300,000 ms  |
| `--max-memory`  | 512 MB  | 2,048 MB    |
| `--max-cpu`     | 60 s    | 600 s       |
| `--max-output`  | 1 MB    | 50 MB       |
| `argsJson` size | 256 KB  | 10 MB       |

Memory and CPU caps are enforced via `ulimit` inside a POSIX shell wrapper.
On Windows these flags are accepted but log a warning and are not enforced
(MVP).

Each `RunResult` includes a `reason` field: one of `ok`, `timeout`, `memory`,
`cpu`, `crash`, `typecheck`, `loader`, or `argscap` — distinguishing a
wall-clock timeout from an OOM or a bad return value.
