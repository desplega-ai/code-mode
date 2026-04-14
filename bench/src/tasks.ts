import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { SmokeCheck, TaskDef } from "./types.ts";

/**
 * Load a single task directory. Expects task.yaml inside.
 */
export function loadTask(dir: string): TaskDef {
  const absDir = resolve(dir);
  const yamlPath = join(absDir, "task.yaml");
  if (!existsSync(yamlPath)) {
    throw new Error(`task.yaml not found in ${absDir}`);
  }
  const raw = parseYaml(readFileSync(yamlPath, "utf8")) as Record<string, unknown>;
  const id = requireString(raw, "id", yamlPath);
  const prompt = requireString(raw, "prompt", yamlPath);
  const timeout_seconds = typeof raw.timeout_seconds === "number" ? raw.timeout_seconds : 180;
  const smoke_check = normalizeSmokeCheck(raw.smoke_check);

  const fixturesDir = existsDir(join(absDir, "fixtures")) ? join(absDir, "fixtures") : null;
  const seedsDir = existsDir(join(absDir, "seeds")) ? join(absDir, "seeds") : null;

  return { id, prompt, timeout_seconds, smoke_check, dir: absDir, fixturesDir, seedsDir };
}

/**
 * Load tasks from a path. If path points at a directory with task.yaml, load that single task.
 * Otherwise treat as a parent dir and load every subdir containing task.yaml.
 */
export function loadTasks(path: string): TaskDef[] {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(`tasks path does not exist: ${abs}`);
  if (existsSync(join(abs, "task.yaml"))) return [loadTask(abs)];
  const entries = readdirSync(abs)
    .map((n) => join(abs, n))
    .filter((p) => existsDir(p) && existsSync(join(p, "task.yaml")))
    .sort();
  if (entries.length === 0) {
    throw new Error(`no tasks found under ${abs} (expected subdirs with task.yaml)`);
  }
  return entries.map(loadTask);
}

export function checkSmoke(check: SmokeCheck | undefined, finalText: string): boolean | null {
  if (!check) return null;
  if (check.kind === "includes_all") {
    return check.needles.every((n) => finalText.includes(n));
  }
  if (check.kind === "regex") {
    return new RegExp(check.pattern, check.flags ?? "").test(finalText);
  }
  return null;
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
    return { kind: "includes_all", needles: r.needles.filter((n): n is string => typeof n === "string") };
  }
  if (r.kind === "regex" && typeof r.pattern === "string") {
    const flags = typeof r.flags === "string" ? r.flags : undefined;
    return { kind: "regex", pattern: r.pattern, flags };
  }
  return undefined;
}
