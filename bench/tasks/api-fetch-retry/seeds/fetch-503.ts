/**
 * @name fetch503Status
 * @description Fetch httpbin.org/status/503 with 3 retries + exponential backoff; returns {status, attempts}.
 * @tags http, fetch, retry, httpbin
 */

export default async function fetch503Status(): Promise<{ status: number; attempts: number }> {
  const url = "https://httpbin.org/status/503";
  let status = 0;
  let attempts = 0;
  for (let i = 0; i < 3; i++) {
    attempts = i + 1;
    try {
      const res = await fetch(url);
      status = res.status;
      if (status < 500) break;
    } catch {
      status = 0;
    }
    if (i < 2) await new Promise((r) => setTimeout(r, 200 * Math.pow(2, i)));
  }
  return { status, attempts };
}
