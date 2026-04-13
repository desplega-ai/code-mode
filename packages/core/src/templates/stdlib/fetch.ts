/**
 * Emits the `sdks/stdlib/fetch.ts` seed written into a workspace on init.
 *
 * The emitted script wraps the global `fetch` with:
 *   - 30s default timeout (AbortController)
 *   - 3 retries on 5xx / network errors with exponential backoff
 *   - Auto `Accept: application/json` header for JSON helpers
 *   - Typed parsing for `getJson<T>` / `postJson<T>`
 *
 * Zero external deps — pure Node ≥20 / Bun.
 */
export function fetchTs(): string {
  return `/**
 * @name fetchHelpers
 * @description Typed fetch wrappers with timeout, retries on 5xx/network, and JSON parsing.
 * @tags http, network, fetch, json, utility
 */

export interface FetchOptions extends RequestInit {
  /** Total timeout in milliseconds. Default: 30_000. */
  timeoutMs?: number;
  /** Number of retry attempts on 5xx / network error. Default: 3. */
  retries?: number;
  /** Base backoff in ms; each attempt doubles. Default: 200. */
  backoffBaseMs?: number;
}

const DEFAULTS = {
  timeoutMs: 30_000,
  retries: 3,
  backoffBaseMs: 200,
};

/**
 * @name getJson
 * @description GET a URL and parse the response body as JSON. Retries on 5xx / network error.
 * @tags http, json, fetch
 */
export async function getJson<T = unknown>(url: string, init: FetchOptions = {}): Promise<T> {
  const res = await fetchWithRetries(url, {
    ...init,
    method: init.method ?? "GET",
    headers: withJsonAccept(init.headers),
  });
  return (await res.json()) as T;
}

/**
 * @name postJson
 * @description POST a JSON body and parse the response as JSON. Retries on 5xx / network error.
 * @tags http, json, fetch
 */
export async function postJson<T = unknown>(
  url: string,
  body: unknown,
  init: FetchOptions = {},
): Promise<T> {
  const headers = withJsonAccept(init.headers);
  if (!hasHeader(headers, "content-type")) {
    headers.set("content-type", "application/json");
  }
  const res = await fetchWithRetries(url, {
    ...init,
    method: init.method ?? "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return (await res.json()) as T;
}

/**
 * @name fetchText
 * @description GET a URL and return the response body as text. Retries on 5xx / network error.
 * @tags http, text, fetch
 */
export async function fetchText(url: string, init: FetchOptions = {}): Promise<string> {
  const res = await fetchWithRetries(url, {
    ...init,
    method: init.method ?? "GET",
  });
  return await res.text();
}

async function fetchWithRetries(url: string, init: FetchOptions): Promise<Response> {
  const timeoutMs = init.timeoutMs ?? DEFAULTS.timeoutMs;
  const retries = init.retries ?? DEFAULTS.retries;
  const backoffBase = init.backoffBaseMs ?? DEFAULTS.backoffBaseMs;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      if (res.status >= 500 && res.status < 600 && attempt < retries) {
        await sleep(backoffBase * Math.pow(2, attempt));
        continue;
      }
      if (!res.ok) {
        throw new Error("fetch " + url + " failed: " + res.status + " " + res.statusText);
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) {
        await sleep(backoffBase * Math.pow(2, attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error("fetch " + url + " failed after retries");
}

function withJsonAccept(init: HeadersInit | undefined): Headers {
  const h = new Headers(init);
  if (!hasHeader(h, "accept")) {
    h.set("accept", "application/json");
  }
  return h;
}

function hasHeader(h: Headers, name: string): boolean {
  return h.get(name) !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
`;
}
