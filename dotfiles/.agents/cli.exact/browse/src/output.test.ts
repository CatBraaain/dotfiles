import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { fetchJson, formatSearchMarkdown, searchJson } from "./output";

const searchOutcome = {
  engine: "google" as const,
  tookMs: 1250,
  results: [
    { rank: 3 },
    { rank: 2, url: " https://example.com/ " },
    {
      rank: 1,
      title: " First ",
      url: " https://example.com/first ",
      display_url: " example.com ",
      snippet: " Summary ",
    },
  ],
};

describe("search output", () => {
  it("formats metadata, ranked blocks, defaults and missing fields", () => {
    assert.equal(
      formatSearchMarkdown('a "query"', searchOutcome),
      '**Query:** "a \\"query\\"" - **Engines:** google - **Took:** 1.3s\n\n' +
        "### 1. First\n\n**example.com** - organic\n\nSummary\n\n-> https://example.com/first\n\n" +
        "### 2. https://example.com/\n\n-> https://example.com/\n\n### 3. (no title)",
    );
  });

  it("emits only present JSON fields without adding the markdown type default", () => {
    assert.deepEqual(searchJson("query", searchOutcome), {
      query: "query",
      engine: "google",
      tookMs: 1250,
      results: [
        {
          rank: 1,
          title: "First",
          url: "https://example.com/first",
          display_url: "example.com",
          snippet: "Summary",
        },
        { rank: 2, url: "https://example.com/" },
        { rank: 3 },
      ],
    });
  });

  it("limits both output formats to the first ten ranked results", () => {
    const outcome = {
      ...searchOutcome,
      results: Array.from({ length: 12 }, (_, index) => ({
        rank: 12 - index,
        title: `R${12 - index}`,
        type: "ad",
      })),
    };
    const json = searchJson("query", outcome);
    assert.deepEqual(
      (json.results as { rank: number }[]).map(({ rank }) => rank),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    );
    const markdown = formatSearchMarkdown("query", outcome);
    assert.equal((markdown.match(/^### /gm) ?? []).length, 10);
    assert.ok(!markdown.includes("R11"));
    assert.equal((json.results as { type: string }[])[0]?.type, "ad");
  });
});

describe("fetch JSON output", () => {
  for (const [markdown, title] of [
    ["### 1. Earlier\n# Main title  \n# Later", "Main title"],
    ["## 12. Numbered title  ", "Numbered title"],
    ["### 3. Third-level title", "Third-level title"],
    ["## Unnumbered\nPlain text", undefined],
  ]) {
    it(`extracts the specified title from ${JSON.stringify(markdown)}`, () => {
      const output = fetchJson("https://example.com/", {
        backend: "camoufox+trafilatura",
        markdown: markdown!,
        tookMs: 80,
        fallbacks: [],
      });
      assert.deepEqual(output, {
        url: "https://example.com/",
        backend: "camoufox+trafilatura",
        body: markdown,
        tookMs: 80,
        ...(title === undefined ? {} : { title }),
      });
    });
  }

  it("normalizes permalinks and preserves failed attempts in their original order", () => {
    const fallbacks = [
      { backend: "RSS", error: "not a feed" },
      { backend: "camoufox+trafilatura", error: "render: aborted" },
    ];
    const result = fetchJson("https://old.reddit.com/r/bun/comments/abc123/title/?x=1", {
      backend: "Reddit",
      markdown: "# Post",
      tookMs: 20,
      fallbacks,
    });
    assert.equal(result.url, "https://www.reddit.com/r/bun/comments/abc123/title/");
    assert.deepEqual(result.fallbacks, fallbacks);
  });
});
