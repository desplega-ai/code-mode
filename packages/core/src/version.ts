/**
 * Single source of truth for the CLI + MCP server version.
 *
 * Read from the package manifest at load time so a publish-time version
 * bump propagates everywhere without a manual code edit. `createRequire`
 * keeps this working under both Bun and Node without needing JSON import
 * assertions (which differ across runtimes and bundler toolchains).
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

export const VERSION: string = pkg.version;
