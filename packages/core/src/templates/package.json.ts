/**
 * Emits the minimal `package.json` contents for a `.code-mode/` workspace.
 *
 * The workspace is not published; it only exists to anchor `node_modules/`
 * and `tsconfig.json` paths so that `@/sdks/...` imports resolve when
 * agent-written scripts typecheck or run.
 */
export function packageJson(): string {
  const pkg = {
    name: "code-mode-workspace",
    version: "0.0.0",
    private: true,
    type: "module",
    description: "code-mode workspace — scripts + generated SDKs",
    dependencies: {
      // Required at runtime by `.code-mode/sdks/.generated/_client.ts`, which
      // dynamically imports `@modelcontextprotocol/sdk/client/{index,stdio,
      // streamableHttp}.js` whenever a generated tool wrapper is invoked.
      "@modelcontextprotocol/sdk": "^1.0.0",
    },
    devDependencies: {
      "bun-types": "latest",
      typescript: "^5.5.0",
    },
  };
  return JSON.stringify(pkg, null, 2) + "\n";
}
