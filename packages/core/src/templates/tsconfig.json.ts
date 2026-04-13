/**
 * Emits the `tsconfig.json` contents used inside a `.code-mode/` workspace.
 *
 * Kept as a TS module (returning a string) so that `code-mode init` can write
 * this file without any bundler/asset-loading gymnastics.
 */
export function tsconfigJson(): string {
  const config = {
    compilerOptions: {
      target: "esnext",
      module: "preserve",
      moduleResolution: "bundler",
      strict: true,
      noEmit: true,
      types: ["bun-types"],
      baseUrl: ".",
      paths: { "@/*": ["./*"] },
    },
    include: ["scripts/**/*.ts", "sdks/**/*.ts"],
  };
  return JSON.stringify(config, null, 2) + "\n";
}
