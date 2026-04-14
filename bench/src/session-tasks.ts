import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { SessionDef, SessionTaskDef, SmokeCheck } from "./types.ts";

/**
 * Load a single session-task directory. Expects session-task.yaml inside.
 * Distinct filename from task.yaml so the original loader ignores it.
 */
export function loadSessionTask(dir: string): SessionTaskDef {
  const absDir = resolve(dir);
  const yamlPath = join(absDir, "session-task.yaml");
  if (!existsSync(yamlPath)) {
    throw new Error(`session-task.yaml not found in ${absDir}`);
  }
  const raw = parseYaml(readFileSync(yamlPath, "utf8")) as Record<string, unknown>;
  const id = requireString(raw, "id", yamlPath);
  const rawSessions = raw.sessions;
  if (!Array.isArray(rawSessions) || rawSessions.length === 0) {
    throw new Error(`${yamlPath}: "sessions" must be a non-empty array`);
  }
  const sessions: SessionDef[] = rawSessions.map((s, i) => {
    if (!s || typeof s !== "object") {
      throw new Error(`${yamlPath}: sessions[${i}] must be an object`);
    }
    const obj = s as Record<string, unknown>;
    return {
      id: requireString(obj, "id", `${yamlPath} sessions[${i}]`),
      prompt: requireString(obj, "prompt", `${yamlPath} sessions[${i}]`),
      timeout_seconds:
        typeof obj.timeout_seconds === "number" ? obj.timeout_seconds : 240,
      smoke_check: normalizeSmokeCheck(obj.smoke_check),
    };
  });

  const fixturesDir = existsDir(join(absDir, "fixtures")) ? join(absDir, "fixtures") : null;
  const seedsDir = existsDir(join(absDir, "seeds")) ? join(absDir, "seeds") : null;

  return { id, sessions, dir: absDir, fixturesDir, seedsDir };
}

/**
 * Load session-tasks from a path. If path points at a dir containing
 * session-task.yaml, load that single task. Otherwise treat as a parent dir
 * and load every subdir containing session-task.yaml.
 */
export function loadSessionTasks(path: string): SessionTaskDef[] {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(`session-tasks path does not exist: ${abs}`);
  if (existsSync(join(abs, "session-task.yaml"))) return [loadSessionTask(abs)];
  const entries = readdirSync(abs)
    .map((n) => join(abs, n))
    .filter((p) => existsDir(p) && existsSync(join(p, "session-task.yaml")))
    .sort();
  if (entries.length === 0) {
    throw new Error(`no session-tasks found under ${abs} (expected subdirs with session-task.yaml)`);
  }
  return entries.map(loadSessionTask);
}

function existsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function requireString(obj: Record<string, unknown>, key: string, path: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${path}: required field "${key}" missing or not a string`);
  }
  return v;
}

function normalizeSmokeCheck(raw: unknown): SmokeCheck | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (r.kind === "includes_all" && Array.isArray(r.needles)) {
    return {
      kind: "includes_all",
      needles: r.needles.filter((n): n is string => typeof n === "string"),
    };
  }
  if (r.kind === "regex" && typeof r.pattern === "string") {
    const flags = typeof r.flags === "string" ? r.flags : undefined;
    return { kind: "regex", pattern: r.pattern, flags };
  }
  return undefined;
}
