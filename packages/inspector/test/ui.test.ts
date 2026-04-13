/**
 * Component-level smoke tests for the inspector UI bundle.
 *
 * The UI is shipped as a single inline-JS bundle (see server/ui.ts); this test
 * asserts that the bundle contains the expected behavior hooks — server list
 * fetcher, invocation form, and SDK tab — without actually booting a browser.
 * If/when the UI is upgraded to a real React SPA, these become happy-path
 * renders using happy-dom.
 */

import { describe, expect, test } from "bun:test";
import { renderIndexHtml, INDEX_CLIENT_JS } from "../server/ui.ts";

describe("inspector UI — HTML shell", () => {
  test("includes a sidebar and a main pane", () => {
    const html = renderIndexHtml();
    expect(html).toContain('id="sidebar"');
    expect(html).toContain('id="main"');
  });

  test("references the client JS bundle", () => {
    expect(renderIndexHtml()).toContain('src="/app.js"');
  });
});

describe("inspector UI — client JS bundle", () => {
  test("fetches the server list from /api/servers on load", () => {
    expect(INDEX_CLIENT_JS).toContain("/api/servers");
  });

  test("fetches tools from /api/tools/", () => {
    expect(INDEX_CLIENT_JS).toContain("/api/tools/");
  });

  test("renders an Invoke button for tool cards", () => {
    expect(INDEX_CLIENT_JS).toContain("Invoke");
  });

  test("POSTs to /api/invoke with JSON args", () => {
    expect(INDEX_CLIENT_JS).toContain("/api/invoke");
    expect(INDEX_CLIENT_JS).toContain("JSON.stringify");
  });

  test("renders a Generated SDK tab backed by /api/generated/", () => {
    expect(INDEX_CLIENT_JS).toContain("/api/generated/");
    expect(INDEX_CLIENT_JS).toContain("sdk");
  });

  test("falls back to a raw JSON textarea for argument input", () => {
    expect(INDEX_CLIENT_JS).toContain("textarea");
    expect(INDEX_CLIENT_JS).toContain("JSON.parse");
  });
});
