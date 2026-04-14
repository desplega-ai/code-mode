/**
 * @name usersWithPostCounts
 * @description Fetch jsonplaceholder users + posts, return "<name> — <n> posts" lines for first N users.
 * @tags jsonplaceholder, api, join, fetch, format
 */
import { getJson } from "@/sdks/stdlib/fetch";

interface User { id: number; name: string }
interface Post { id: number; userId: number }

export interface Args {
  limit?: number;
}

export default async function usersWithPostCounts(args: Args = {}): Promise<string> {
  const limit = args.limit ?? 5;
  const [users, posts] = await Promise.all([
    getJson<User[]>("https://jsonplaceholder.typicode.com/users"),
    getJson<Post[]>("https://jsonplaceholder.typicode.com/posts"),
  ]);
  const counts = new Map<number, number>();
  for (const p of posts) counts.set(p.userId, (counts.get(p.userId) ?? 0) + 1);
  return users
    .sort((a, b) => a.id - b.id)
    .slice(0, limit)
    .map((u) => `${u.name} — ${counts.get(u.id) ?? 0} posts`)
    .join("\n");
}
