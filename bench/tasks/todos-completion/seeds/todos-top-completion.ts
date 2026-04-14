/**
 * @name todosTopCompletion
 * @description Fetch jsonplaceholder todos, compute completion rate per userId, return top N formatted.
 * @tags jsonplaceholder, api, todos, aggregate, rate, top-n
 */
import { getJson } from "@/sdks/stdlib/fetch";

interface Todo { userId: number; completed: boolean }

export interface Args {
  limit?: number;
}

export default async function todosTopCompletion(args: Args = {}): Promise<string> {
  const limit = args.limit ?? 5;
  const todos = await getJson<Todo[]>("https://jsonplaceholder.typicode.com/todos");
  const byUser = new Map<number, { total: number; done: number }>();
  for (const t of todos) {
    const cur = byUser.get(t.userId) ?? { total: 0, done: 0 };
    cur.total += 1;
    if (t.completed) cur.done += 1;
    byUser.set(t.userId, cur);
  }
  const rows = [...byUser.entries()]
    .map(([userId, s]) => ({ userId, rate: s.done / s.total }))
    .sort((a, b) => b.rate - a.rate || a.userId - b.userId)
    .slice(0, limit);
  return rows
    .map((r) => `user=${r.userId} rate=${Math.round(r.rate * 100)}%`)
    .join("\n");
}
