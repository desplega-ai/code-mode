/**
 * Extract structured export info from a TypeScript source file.
 *
 * Design notes (per research guidance):
 * - We intentionally avoid `getExportedDeclarations()` in hot paths because of
 *   the ~1s overhead observed in ts-morph issue #644 on larger workspaces.
 * - Instead we walk `getDescendantsOfKind(SyntaxKind.ExportKeyword)` and climb
 *   to the declaration node, resolving types lazily via `.getType().getText()`.
 * - Output is plain JSON-serializable objects (no ts-morph node references).
 */

import {
  Node,
  SyntaxKind,
  type Project,
  type SourceFile,
  type FunctionDeclaration,
  type ClassDeclaration,
  type InterfaceDeclaration,
  type TypeAliasDeclaration,
  type VariableDeclaration,
  type JSDocableNode,
  type JSDocTag,
} from "ts-morph";

export type ExportKind =
  | "function"
  | "type"
  | "interface"
  | "class"
  | "const";

export interface JSDocTagInfo {
  name: string;
  value: string;
}

export interface ExportInfo {
  name: string;
  kind: ExportKind;
  signature: string;
  jsdocDescription?: string;
  jsdocTags?: JSDocTagInfo[];
}

/**
 * Extract the list of exports for a file already added to the project.
 *
 * Returns an empty array if the file is not in the project (typecheck layer
 * surfaces that as a diagnostic; this layer stays silent).
 */
export function extractExports(
  project: Project,
  filePath: string,
): ExportInfo[] {
  const sourceFile = project.getSourceFile(filePath);
  if (!sourceFile) return [];
  return extractExportsFromSourceFile(sourceFile);
}

/**
 * Same as `extractExports` but takes an already-resolved `SourceFile`. Useful
 * when a caller is iterating through `project.getSourceFiles()`.
 */
export function extractExportsFromSourceFile(
  sourceFile: SourceFile,
): ExportInfo[] {
  const seen = new Set<Node>();
  const out: ExportInfo[] = [];

  for (const keyword of sourceFile.getDescendantsOfKind(
    SyntaxKind.ExportKeyword,
  )) {
    const parent = keyword.getParent();
    if (!parent) continue;

    // `export default` declarations live under an ExportAssignment, not an
    // ExportKeyword modifier — this walk skips them, which is intentional for
    // the MVP (stdlib/user SDKs use named exports only).
    const declarations = explodeDeclarations(parent);
    for (const decl of declarations) {
      if (seen.has(decl)) continue;
      seen.add(decl);
      const info = buildExportInfo(decl);
      if (info) out.push(info);
    }
  }

  return out;
}

/**
 * An ExportKeyword's parent may be a single declaration (FunctionDeclaration,
 * ClassDeclaration, etc.) or a VariableStatement containing multiple
 * VariableDeclarations. Flatten to the individual nodes we want to describe.
 */
function explodeDeclarations(parent: Node): Node[] {
  if (parent.getKind() === SyntaxKind.VariableStatement) {
    const vs = parent.asKindOrThrow(SyntaxKind.VariableStatement);
    return vs.getDeclarations();
  }
  return [parent];
}

function buildExportInfo(node: Node): ExportInfo | null {
  const kind = node.getKind();
  switch (kind) {
    case SyntaxKind.FunctionDeclaration:
      return fromFunction(node as FunctionDeclaration);
    case SyntaxKind.ClassDeclaration:
      return fromClass(node as ClassDeclaration);
    case SyntaxKind.InterfaceDeclaration:
      return fromInterface(node as InterfaceDeclaration);
    case SyntaxKind.TypeAliasDeclaration:
      return fromTypeAlias(node as TypeAliasDeclaration);
    case SyntaxKind.VariableDeclaration:
      return fromVariable(node as VariableDeclaration);
    default:
      return null;
  }
}

function fromFunction(fn: FunctionDeclaration): ExportInfo | null {
  const name = fn.getName();
  if (!name) return null;
  const jsdoc = collectJsDoc(fn);
  // Build a compact callable signature from the declaration (params + return
  // type). We avoid `fn.getType().getText()` because it can collapse to a bare
  // `typeof name` reference. Lazy type resolution still happens per-param on
  // demand if callers ask for it; here we prefer source fidelity.
  const typeParams = fn.getTypeParameters();
  const typeParamText =
    typeParams.length > 0
      ? `<${typeParams.map((t) => t.getText()).join(", ")}>`
      : "";
  const params = fn
    .getParameters()
    .map((p) => p.getText())
    .join(", ");
  const returnTypeNode = fn.getReturnTypeNode();
  const returnText = returnTypeNode
    ? returnTypeNode.getText()
    : fn.getReturnType().getText(fn);
  const signature = `${name}${typeParamText}(${params}): ${returnText}`;
  return {
    name,
    kind: "function",
    signature,
    ...jsdoc,
  };
}

function fromClass(cls: ClassDeclaration): ExportInfo | null {
  const name = cls.getName();
  if (!name) return null;
  const jsdoc = collectJsDoc(cls);
  // Use the declaration text for classes — full type is often huge and not
  // useful for discovery.
  const signature = `class ${name}`;
  return { name, kind: "class", signature, ...jsdoc };
}

function fromInterface(iface: InterfaceDeclaration): ExportInfo {
  const name = iface.getName();
  const jsdoc = collectJsDoc(iface);
  const signature = iface.getText().replace(/^export\s+/, "");
  return { name, kind: "interface", signature, ...jsdoc };
}

function fromTypeAlias(alias: TypeAliasDeclaration): ExportInfo {
  const name = alias.getName();
  const jsdoc = collectJsDoc(alias);
  const signature = alias.getText().replace(/^export\s+/, "");
  return { name, kind: "type", signature, ...jsdoc };
}

function fromVariable(v: VariableDeclaration): ExportInfo {
  const name = v.getName();
  // JSDoc for a `const` lives on the parent VariableStatement.
  const vs = v.getFirstAncestorByKind(SyntaxKind.VariableStatement);
  const jsdoc = vs ? collectJsDoc(vs) : {};
  const signature = `${name}: ${v.getType().getText(v)}`;
  return { name, kind: "const", signature, ...jsdoc };
}

interface JsDocFields {
  jsdocDescription?: string;
  jsdocTags?: JSDocTagInfo[];
}

function collectJsDoc(node: JSDocableNode): JsDocFields {
  const docs = node.getJsDocs();
  if (docs.length === 0) return {};
  // Use the last JSDoc comment (closest to the declaration) — this matches
  // how TypeScript itself interprets the associated doc.
  const doc = docs[docs.length - 1]!;
  const description = doc.getDescription().trim();
  const tags: JSDocTagInfo[] = [];
  for (const tag of doc.getTags()) {
    tags.push({
      name: tag.getTagName(),
      value: readTagComment(tag),
    });
  }
  const fields: JsDocFields = {};
  if (description) fields.jsdocDescription = description;
  if (tags.length > 0) fields.jsdocTags = tags;
  return fields;
}

function readTagComment(tag: JSDocTag): string {
  const raw = tag.getComment();
  if (!raw) return "";
  if (typeof raw === "string") return raw.trim();
  // Array of parts (JSDocText | JSDocLink | …). Concatenate their source text.
  let out = "";
  for (const part of raw) {
    if (!part) continue;
    if (typeof part === "string") out += part;
    else if (typeof (part as Node).getText === "function")
      out += (part as Node).getText();
  }
  return out.trim();
}
