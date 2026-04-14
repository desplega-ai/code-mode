---
date: 2026-04-14
topic: Multi-MCP variant for code-mode bench — feasibility
status: research / decision input
---

# Multi-MCP Bench Variant — Feasibility

## 1. MCP-by-MCP Feasibility

| MCP | Install / Launch (stdio) | Auth | Docker (`node:20-slim`) | Cold start | ~Tools |
|---|---|---|---|---|---|
| **dbhub** (`@bytebase/dbhub@0.21.2`) | `npx -y @bytebase/dbhub@latest --transport stdio --dsn "sqlite:///workspace/fixtures/bench.db"` | None for SQLite file | Pure JS, zero native deps. Works on `node:20-slim` out of the box. | ~1.5–2.5s (npx first pull + `sqlite3` driver load) | **~2 core tools** (`execute_sql`, `search_objects`) — intentionally minimal |
| **playwright-mcp** (`@playwright/mcp@latest`) | `npx -y @playwright/mcp@latest --headless --isolated --browser chromium` | None | **Blocker on `node:20-slim`.** Requires full Playwright Chromium + ~30 shared libs (`libnss3`, `libatk*`, `libx*`, `libasound2`, `libdrm2`, `libgbm1`, fonts). First run downloads ~180MB. Official recommendation is `mcr.microsoft.com/playwright/mcp` image; headless-only in Docker. | **Cold start 5–15s** (browser launch). First-ever session adds 30–60s of browser download unless baked into image. | **~25 tools** (browser_click, browser_snapshot, browser_navigate, browser_type, browser_fill_form, browser_take_screenshot, tabs, network, console, evaluate, dialogs, file_upload, etc.) |
| **deepwiki** (Cognition) | Remote HTTP only — `https://mcp.deepwiki.com/mcp` (Streamable HTTP) or `/sse`. No npm package from Cognition; the `deepwiki-mcp` packages on npm are 3rd-party. Register via `{"type":"http","url":"https://mcp.deepwiki.com/mcp"}`. | **Genuinely no-auth.** Public, free, remote. | N/A — no local process. Just needs outbound HTTPS from the container. | ~0s local (per-call latency ~0.5–2s) | **~3 tools** (`read_wiki_structure`, `read_wiki_contents`, `ask_question`) |

## 2. Does `code-mode init` auto-generate SDKs?

**Yes — and the pipeline is well-suited for this.**

Flow (verified in `packages/core/src/commands/init.ts` + `sdk-gen/introspect.ts`):

1. `code-mode init` scaffolds `.code-mode/`, runs `bun install`, then calls `generateSdks({ workspaceDir, sdksDir, scriptsDir })`.
2. `generateSdks` reads the active MCP config (`~/.claude.json` + project `.mcp.json`), for each server opens a `StdioClientTransport` **or** `StreamableHTTPClientTransport`, runs `initialize` + `tools/list`, then emits typed wrappers into `sdks/.generated/`.
3. `code-mode reindex` re-introspects on demand. The bench entrypoint already calls `reindex` on warm starts.

Implication: to add dbhub / playwright / deepwiki, we **only** need to (a) ensure their processes are launchable from inside the container, (b) register them in `/workspace/.mcp.json` before `code-mode init` runs. The existing introspect path handles both stdio and HTTP, so deepwiki works too. **This is not a blocker.**

One caveat: `introspect` is sequential with a 15s per-server timeout. Playwright's first-run browser download will exceed that on cold start — bake the browser into the image.

## 3. Concrete Task Designs (all require ≥2 MCPs)

### Task A — "docs-informed SQL" (dbhub + deepwiki)
**Prompt:** "Look up the SQLite `INSERT ... ON CONFLICT` (UPSERT) syntax on DeepWiki for the `sqlite/sqlite` repo, then in the bench DB upsert these 5 rows into `products` (id, name, price), where 2 ids already exist and 3 are new. Return the final row count and the updated names."
**Why baseline struggles:** baseline has WebFetch but no SQL runtime — it has to shell out to `sqlite3` CLI (possibly absent) or write a Node script. With dbhub it's one `execute_sql` call, but the system-prompt cost of both MCPs is real.
**Why code-mode wins:** one saved script (`upsert-products.ts`) reused across runs; the `execute_sql` + `read_wiki_contents` wrappers are typed; no per-turn dispatch of 25 tool descriptions.

### Task B — "schema diff + screenshot" (dbhub + playwright)
**Prompt:** "Query the `orders` and `orders_legacy` tables via dbhub, find rows in legacy missing from the new table, then open `file:///workspace/reports/orders.html` in playwright and screenshot the resulting diff table." (fixture HTML page reads from same sqlite file via a prebuilt viewer.)
**Why baseline struggles:** needs both SQL and a real browser. No realistic Bash fallback.
**Why code-mode wins:** playwright-mcp alone is ~25 tool descriptions. Code-mode's `__run` collapses a 6-step sequence (snapshot → click → snapshot → screenshot …) into one script invocation.

### Task C — "three-way triage" (all three)
**Prompt:** "DeepWiki: find the documented error codes for `better-sqlite3`. dbhub: run a failing query and capture the error. Playwright: open `file:///workspace/reports/errors.html`, fill the search box with the error code, screenshot the match."
**Why it matters:** biggest context-bloat scenario — this is the regime where code-mode's value should be largest. Good "stress test" task; skip if we only do a first cut.

## 4. Build Cost

- **Wiring effort:** dbhub-only variant = **~2–3h** (Dockerfile line, entrypoint `.mcp.json` extension, fixture DB seed, one task). Adding deepwiki = **+1h** (HTTP URL registration, task). Adding playwright = **+4–6h** (switch base to `mcr.microsoft.com/playwright/mcp` or install ~30 apt packages + `npx playwright install chromium` at image build; debug timeouts; flaky screenshots; image size jumps from ~400MB to ~2GB).
- **Per-run $ cost:** current baseline ~$0.04–0.08/run; adding 3 MCPs bloats system prompt by ~6–10k tokens (mostly playwright's verbose tool schemas) → **+$0.03–0.05 cache_creation on first turn**, negligible after cache warm. Across 54 runs × 4 variants = **~$6–12 extra vs current sweep**.
- **Risks:** (a) playwright-in-docker is where most of the pain lives — use Microsoft's image rather than apt-patching `node:20-slim`. (b) deepwiki has no published rate limit; at 54 runs × 3 calls it should be fine, but no SLA. (c) `introspect` 15s timeout may fire on cold playwright — pre-warm by running `code-mode reindex` in image build.

## 5. Recommendation

**Build it, but in two cuts:**

- **Cut 1 (commit now, ~3h):** `dbhub` + `deepwiki` only. dbhub is pure-JS zero-pain, deepwiki is just an HTTP URL. This tests the core hypothesis ("code-mode value scales with MCP count") at N=3 MCPs (code-mode + dbhub + deepwiki) with minimal infra risk. Tasks A and a dbhub-only variant of B.
- **Cut 2 (only if Cut 1 shows signal):** add playwright via `mcr.microsoft.com/playwright/mcp` as base image, ~5h. Don't burn the time if Cut 1 is another wash.

**Alternative if we skip:** to test the "value scales with surface area" hypothesis without wiring real MCPs, we could synthesize a mock MCP that exposes N tools with realistic schemas (say, 20 tools with 200-token descriptions each) and sweep N ∈ {0, 5, 10, 20}. Cheaper, faster, but less credible for an external writeup.

**Go/No-go:** Go with Cut 1 (dbhub + deepwiki). Defer playwright until we see signal.
