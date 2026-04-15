import { describe, expect, test } from "bun:test";
import { slugify } from "../../src/analysis/slug.ts";

describe("slugify", () => {
  test("converts a clean imperative intent into kebab-case", () => {
    const r = slugify("fetch all Claude Monet paintings from the Met");
    expect(r.valid).toBe(true);
    expect(r.slug).toBe("fetch-all-claude-monet-paintings-from-the-met");
  });

  test("strips punctuation and collapses whitespace", () => {
    const r = slugify("  Fetch, join, and summarize!  Wikipedia data  ");
    expect(r.valid).toBe(true);
    expect(r.slug).toBe("fetch-join-and-summarize-wikipedia-data");
  });

  test("lowercases and drops combining marks", () => {
    const r = slugify("résumé all Monet paintings in département");
    expect(r.valid).toBe(true);
    expect(r.slug).toBe("resume-all-monet-paintings-in-departement");
  });

  test("rejects intents shorter than minWords", () => {
    const r = slugify("do stuff", { fallbackHash: "abcdef0123456789" });
    expect(r.valid).toBe(false);
    expect(r.reason).toContain("word");
    expect(r.slug).toBe("auto-abcdef01");
  });

  test("rejects cleaned slugs shorter than minLength", () => {
    // Four words, each very short after cleaning → cleaned length < 12.
    const r = slugify("a b c d", { fallbackHash: "0123456789abcdef" });
    expect(r.valid).toBe(false);
    expect(r.reason).toContain("char");
    expect(r.slug).toBe("auto-01234567");
  });

  test("fallback is empty string when no hash provided", () => {
    const r = slugify("do stuff");
    expect(r.valid).toBe(false);
    expect(r.slug).toBe("");
  });

  test("truncates at word boundary near maxLength", () => {
    const r = slugify(
      "fetch everything everywhere all at once with joy and abandon please",
      { maxLength: 30 },
    );
    expect(r.valid).toBe(true);
    expect(r.slug.length).toBeLessThanOrEqual(30);
    // Must not end at a dangling dash from mid-word truncation.
    expect(r.slug).not.toMatch(/-$/);
    expect(r.slug.startsWith("fetch")).toBe(true);
    // Concretely: should cut on the last dash inside the 30-char window.
    expect(r.slug).toBe("fetch-everything-everywhere");
  });

  test("handles pure-symbol intent via fallback", () => {
    const r = slugify("!!! @@@ ### $$$", { fallbackHash: "deadbeefcafebabe" });
    expect(r.valid).toBe(false);
    expect(r.slug).toBe("auto-deadbeef");
  });

  test("respects custom minWords", () => {
    const r = slugify("fetch monet art now", { minWords: 2 });
    expect(r.valid).toBe(true);
    expect(r.slug).toBe("fetch-monet-art-now");
  });

  test("custom minLength gates correctly", () => {
    // 4 words, cleaned length = 13.
    const r = slugify("a bc def ghijk", { minLength: 20, fallbackHash: "ff00ff00aabbccdd" });
    expect(r.valid).toBe(false);
    expect(r.slug).toBe("auto-ff00ff00");
  });
});
