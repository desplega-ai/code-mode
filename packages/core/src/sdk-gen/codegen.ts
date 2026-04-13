/**
 * JSON Schema → TypeScript string emitter.
 *
 * Scope (MVP, per plan Phase 6):
 *   - Primitives: string/number/integer/boolean/null → direct.
 *   - object: emits an `interface` with optional/required properties.
 *   - array: T[] (or `unknown[]` when items missing).
 *   - enum: union of string/number/boolean literals.
 *   - $ref: resolved inline using the provided root document. Cycles and
 *     deeply nested refs are capped at depth 4, falling back to `unknown`.
 *   - Missing/unknown schemas → `unknown`.
 *
 * We do not try to emit idiomatic JSON Schema semantics (allOf, oneOf, anyOf,
 * discriminators, const, format). Upstream MCPs that really need those should
 * ship their own SDK.
 */

import type { IntrospectedTool } from "./introspect.ts";

export interface CodegenOptions {
  /** Maximum depth when walking/resolving schemas. Default 4. */
  maxDepth?: number;
}

export interface ToolCodegen {
  tool: IntrospectedTool;
  /** Camel-cased function name, e.g. `createIssue` for `create_issue`. */
  fnName: string;
  /** Pascal-cased base name, e.g. `CreateIssue`. */
  typeBase: string;
  /** TS string for the input interface (never empty; falls back to `unknown` alias). */
  inputDecl: string;
  /** TS string for the output interface (never empty; falls back to `unknown` alias). */
  outputDecl: string;
  /** The generated async function signature + body. */
  fnDecl: string;
}

/**
 * Generate per-tool TS snippets for a single MCP server's `tools/list`.
 *
 * Names are deduped within the server. The caller is responsible for wrapping
 * the snippets in a module-level header + import of `_client`.
 */
export function generateToolCode(
  tools: IntrospectedTool[],
  serverName: string,
  opts: CodegenOptions = {},
): ToolCodegen[] {
  const maxDepth = opts.maxDepth ?? 4;
  const takenFns = new Set<string>();
  const takenTypes = new Set<string>();
  const out: ToolCodegen[] = [];

  for (const tool of tools) {
    const fnName = uniquify(toCamelCase(tool.name), takenFns);
    const typeBase = uniquify(toPascalCase(tool.name), takenTypes);
    const inputName = `${typeBase}Args`;
    const outputName = `${typeBase}Result`;

    const inputDecl = renderTopLevel(tool.inputSchema, inputName, maxDepth);
    const outputDecl = renderTopLevel(tool.outputSchema, outputName, maxDepth);

    const description = tool.description ?? "";
    const jsdoc = renderJsdoc(description);
    const fnDecl =
      `${jsdoc}export async function ${fnName}(args: ${inputName}): Promise<${outputName}> {\n` +
      `  return callTool(${JSON.stringify(serverName)}, ${JSON.stringify(tool.name)}, args as unknown as Record<string, unknown>) as Promise<${outputName}>;\n` +
      `}`;

    out.push({
      tool,
      fnName,
      typeBase,
      inputDecl,
      outputDecl,
      fnDecl,
    });
  }

  return out;
}

/**
 * Render a top-level named declaration. If the schema is an object we emit an
 * `interface`; otherwise we emit a `type` alias. Always emits something named
 * so that downstream code can reference it.
 */
function renderTopLevel(schema: unknown, name: string, maxDepth: number): string {
  if (schema === undefined || schema === null) {
    return `export type ${name} = unknown;`;
  }
  const root = schema;
  const ts = renderType(schema, root, 0, maxDepth, 0);
  if (isObjectSchema(schema) && ts.startsWith("{")) {
    // `ts` is `{ ... }`; wrap as interface so it reads naturally.
    return `export interface ${name} ${ts}`;
  }
  return `export type ${name} = ${ts};`;
}

/**
 * Walk a schema node and emit a TS type expression. Multi-line output is OK —
 * we prettify at module-assembly time.
 */
function renderType(
  schema: unknown,
  root: unknown,
  depth: number,
  maxDepth: number,
  indent: number,
): string {
  if (depth > maxDepth || schema === undefined || schema === null) {
    return "unknown";
  }
  if (typeof schema !== "object") return "unknown";
  const node = schema as Record<string, unknown>;

  // $ref resolution — inline, bounded by depth.
  if (typeof node.$ref === "string") {
    const resolved = resolveRef(node.$ref, root);
    if (resolved === undefined) return "unknown";
    return renderType(resolved, root, depth + 1, maxDepth, indent);
  }

  // enum → union of literals
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    const parts = node.enum.map((v) => {
      if (typeof v === "string") return JSON.stringify(v);
      if (typeof v === "number" || typeof v === "boolean") return String(v);
      if (v === null) return "null";
      return "unknown";
    });
    return parts.join(" | ");
  }

  // const → single literal
  if (node.const !== undefined) {
    const v = node.const;
    if (typeof v === "string") return JSON.stringify(v);
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (v === null) return "null";
    return "unknown";
  }

  const type = node.type;

  // Union types via schema `type: [...]`.
  if (Array.isArray(type)) {
    const parts = type.map((t) =>
      renderType({ ...node, type: t }, root, depth, maxDepth, indent),
    );
    return parts.join(" | ");
  }

  switch (type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const items = node.items;
      if (!items) return "unknown[]";
      const inner = renderType(items, root, depth + 1, maxDepth, indent);
      return needsParens(inner) ? `(${inner})[]` : `${inner}[]`;
    }
    case "object":
      return renderObject(node, root, depth, maxDepth, indent);
  }

  // No type provided — try to infer from shape.
  if (node.properties || node.required) {
    return renderObject(node, root, depth, maxDepth, indent);
  }
  if (node.items) {
    const inner = renderType(node.items, root, depth + 1, maxDepth, indent);
    return needsParens(inner) ? `(${inner})[]` : `${inner}[]`;
  }
  return "unknown";
}

function renderObject(
  node: Record<string, unknown>,
  root: unknown,
  depth: number,
  maxDepth: number,
  indent: number,
): string {
  const props = (node.properties ?? {}) as Record<string, unknown>;
  const required = new Set<string>(
    Array.isArray(node.required) ? (node.required as string[]) : [],
  );
  const keys = Object.keys(props);
  const childIndent = indent + 2;
  const pad = " ".repeat(childIndent);
  const closePad = " ".repeat(indent);

  if (keys.length === 0) {
    // object with no declared props — allow arbitrary fields
    const ap = node.additionalProperties;
    if (ap === false) return "{}";
    if (ap && typeof ap === "object") {
      const inner = renderType(ap, root, depth + 1, maxDepth, childIndent);
      return `{ [key: string]: ${inner} }`;
    }
    return "Record<string, unknown>";
  }

  const lines: string[] = ["{"];
  for (const key of keys) {
    const propSchema = props[key];
    const optional = !required.has(key) ? "?" : "";
    const rendered = renderType(propSchema, root, depth + 1, maxDepth, childIndent);
    const desc = extractDescription(propSchema);
    if (desc) {
      lines.push(`${pad}/** ${escapeJsdoc(desc)} */`);
    }
    lines.push(`${pad}${safeKey(key)}${optional}: ${rendered};`);
  }
  // additionalProperties handling when properties exist too.
  const ap = node.additionalProperties;
  if (ap && typeof ap === "object") {
    const inner = renderType(ap, root, depth + 1, maxDepth, childIndent);
    lines.push(`${pad}[key: string]: ${inner};`);
  }
  lines.push(`${closePad}}`);
  return lines.join("\n");
}

function extractDescription(schema: unknown): string | null {
  if (!schema || typeof schema !== "object") return null;
  const d = (schema as Record<string, unknown>).description;
  return typeof d === "string" && d.trim() !== "" ? d.trim() : null;
}

function escapeJsdoc(s: string): string {
  return s.replace(/\*\//g, "*\\/").replace(/\n/g, " ");
}

function renderJsdoc(description: string): string {
  if (!description.trim()) return "";
  const lines = description.trim().split(/\r?\n/);
  if (lines.length === 1) return `/** ${escapeJsdoc(lines[0]!)} */\n`;
  const body = lines.map((l) => ` * ${escapeJsdoc(l)}`).join("\n");
  return `/**\n${body}\n */\n`;
}

function safeKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

function needsParens(ts: string): boolean {
  // Wrap unions in parens before appending `[]`.
  return /\s\|\s/.test(ts) && !ts.startsWith("(");
}

function isObjectSchema(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;
  const n = schema as Record<string, unknown>;
  if (n.type === "object") return true;
  if (n.properties && typeof n.properties === "object") return true;
  return false;
}

function resolveRef(ref: string, root: unknown): unknown {
  // Only local refs: `#/definitions/Foo`, `#/$defs/Foo`, `#/properties/x`.
  if (!ref.startsWith("#/")) return undefined;
  const segments = ref.slice(2).split("/").map(decodeJsonPointer);
  let cur: unknown = root;
  for (const seg of segments) {
    if (cur && typeof cur === "object" && seg in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

function decodeJsonPointer(seg: string): string {
  return seg.replace(/~1/g, "/").replace(/~0/g, "~");
}

function toCamelCase(s: string): string {
  const parts = s.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return "_";
  const first = parts[0]!.toLowerCase();
  const rest = parts.slice(1).map(cap);
  const name = first + rest.join("");
  return /^[0-9]/.test(name) ? "_" + name : name;
}

function toPascalCase(s: string): string {
  const parts = s.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return "_";
  const name = parts.map(cap).join("");
  return /^[0-9]/.test(name) ? "_" + name : name;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function uniquify(candidate: string, taken: Set<string>): string {
  if (!taken.has(candidate)) {
    taken.add(candidate);
    return candidate;
  }
  let i = 2;
  while (taken.has(`${candidate}${i}`)) i++;
  const picked = `${candidate}${i}`;
  taken.add(picked);
  return picked;
}
