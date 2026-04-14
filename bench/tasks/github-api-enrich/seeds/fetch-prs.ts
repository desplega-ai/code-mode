/**
 * @name fetchClosedPRs
 * @description Fetch the most recent closed PRs from a GitHub repo and format as "#N title [merged=bool]" lines.
 * @tags github, api, pulls, fetch, format
 */
import { getJson } from "@/sdks/stdlib/fetch";

export interface Args {
  repo: string;
  limit?: number;
}

interface PR {
  number: number;
  title: string;
  merged_at: string | null;
}

export default async function fetchClosedPRs(args: Args): Promise<string> {
  const per = args.limit ?? 5;
  const url = `https://api.github.com/repos/${args.repo}/pulls?state=closed&per_page=${per}`;
  const headers: Record<string, string> = { "User-Agent": "code-mode-bench" };
  if (process.env.GITHUB_TOKEN) headers["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;
  const prs = await getJson<PR[]>(url, { headers });
  return prs
    .slice(0, per)
    .map((p) => `#${p.number} ${p.title} [merged=${p.merged_at !== null}]`)
    .join("\n");
}
