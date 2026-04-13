#!/usr/bin/env node
// Thin shim: resolve the fastest available @desplega/code-mode entrypoint
// and spawn it with inherited stdio. All logic lives in ./lib/resolver.mjs
// so it stays testable without spawning subprocesses.

import { spawn } from "node:child_process";
import { resolveEntry } from "./lib/resolver.mjs";

const forwardedArgs = process.argv.slice(2);
const entry = resolveEntry();

switch (entry.kind) {
  case "error":
    process.stderr.write(`[code-mode] ${entry.reason}\n`);
    process.exit(1);
    break;

  case "dev":
    process.stderr.write(`[code-mode] dev path: ${entry.path}\n`);
    runNode(entry.path, forwardedArgs);
    break;

  case "project":
  case "global":
    runNode(entry.path, forwardedArgs);
    break;

  case "npx":
    runNpx(forwardedArgs);
    break;

  default:
    process.stderr.write(`[code-mode] unknown resolver result: ${JSON.stringify(entry)}\n`);
    process.exit(1);
}

function runNode(scriptPath, args) {
  const child = spawn(process.execPath, [scriptPath, ...args], {
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });
  child.on("error", (err) => {
    process.stderr.write(`[code-mode] spawn error: ${err.message}\n`);
    process.exit(1);
  });
}

function runNpx(args) {
  // npm/npx quirk: bare scoped-package specs (`@scope/pkg`) fail to resolve
  // the bin in some cache states — you get `sh: <bin>: command not found`
  // even though the install succeeds. Pinning `@latest` forces npx through
  // the registry metadata path, which links the bin correctly. Reproduced
  //2026-04-13 right after publishing v0.3.3 (live E2E).
  const child = spawn("npx", ["-y", "@desplega/code-mode@latest", ...args], {
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });
  child.on("error", (err) => {
    process.stderr.write(`[code-mode] npx spawn error: ${err.message}\n`);
    process.exit(1);
  });
}
