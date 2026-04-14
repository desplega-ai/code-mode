/**
 * @name apiFetchRetry
 * @description Fetch a URL with exponential backoff on 5xx / network errors. Returns final status, attempts, and body.
 * @tags http, fetch, retry, backoff, api
 */
import { fetchWithRetries } from "@/sdks/stdlib/fetch";

export interface FetchRetryArgs {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  attempts?: number;
  backoffBaseMs?: number;
  timeoutMs?: number;
}

export interface FetchRetryResult {
  status: number;
  attempts: number;
  ms: number;
  body: string;
}

export default async function apiFetchRetry(args: FetchRetryArgs): Promise<FetchRetryResult> {
  const started = Date.now();
  const attempts = args.attempts ?? 3;
  let tried = 0;
  let lastStatus = 0;
  let body = "";

  for (let i = 0; i < attempts; i++) {
    tried = i + 1;
    try {
      const res = await fetchWithRetries(args.url, {
        method: args.method ?? "GET",
        headers: args.headers,
        body: args.body,
        retries: 0,
        timeoutMs: args.timeoutMs ?? 30_000,
      });
      lastStatus = res.status;
      body = await res.text();
      if (res.status < 500) break;
    } catch {
      lastStatus = 0;
    }
    if (i < attempts - 1) {
      const delay = (args.backoffBaseMs ?? 200) * Math.pow(2, i);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  return { status: lastStatus, attempts: tried, ms: Date.now() - started, body };
}
