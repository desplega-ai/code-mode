/**
 * Typecheck a file (or the whole project) and return a plain-object diagnostic
 * shape that is safe to JSON-serialize and hand to CLI / MCP callers.
 *
 * No raw ts-morph / TypeScript compiler types leak out of this module.
 */

import * as ts from "typescript";
import type { Project, Diagnostic as TsMorphDiagnostic } from "ts-morph";

/**
 * Plain diagnostic shape. All fields are primitives (no compiler refs), so the
 * result is JSON-serializable and free of circular references.
 */
export interface Diagnostic {
  file: string;
  line: number;
  col: number;
  code: number;
  message: string;
  severity: "error" | "warning" | "suggestion" | "message";
}

/**
 * Typecheck a single file. Returns only diagnostics whose source file matches
 * `filePath`.
 */
export function typecheckFile(
  project: Project,
  filePath: string,
): Diagnostic[] {
  const sourceFile = project.getSourceFile(filePath);
  if (!sourceFile) {
    return [
      {
        file: filePath,
        line: 0,
        col: 0,
        code: 0,
        message: `File not found in project: ${filePath}`,
        severity: "error",
      },
    ];
  }
  const diags = sourceFile.getPreEmitDiagnostics();
  return diags.map(mapDiagnostic);
}

/**
 * Typecheck every source file in the project. Returns a map keyed by file path.
 * Files with zero diagnostics are omitted.
 */
export function typecheckAll(project: Project): Map<string, Diagnostic[]> {
  const result = new Map<string, Diagnostic[]>();
  const diags = project.getPreEmitDiagnostics();
  for (const d of diags) {
    const mapped = mapDiagnostic(d);
    const existing = result.get(mapped.file);
    if (existing) {
      existing.push(mapped);
    } else {
      result.set(mapped.file, [mapped]);
    }
  }
  return result;
}

function mapDiagnostic(d: TsMorphDiagnostic): Diagnostic {
  const sourceFile = d.getSourceFile();
  const file = sourceFile?.getFilePath() ?? "<unknown>";
  const start = d.getStart();
  let line = 0;
  let col = 0;
  if (sourceFile && typeof start === "number") {
    const lc = sourceFile.getLineAndColumnAtPos(start);
    line = lc.line;
    col = lc.column;
  }
  const messageText = d.getMessageText();
  const message =
    typeof messageText === "string"
      ? messageText
      : ts.flattenDiagnosticMessageText(messageText.compilerObject, "\n");
  return {
    file,
    line,
    col,
    code: d.getCode(),
    message,
    severity: mapSeverity(d.getCategory()),
  };
}

function mapSeverity(category: ts.DiagnosticCategory): Diagnostic["severity"] {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return "error";
    case ts.DiagnosticCategory.Warning:
      return "warning";
    case ts.DiagnosticCategory.Suggestion:
      return "suggestion";
    case ts.DiagnosticCategory.Message:
    default:
      return "message";
  }
}
