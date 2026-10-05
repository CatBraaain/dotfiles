import { describe, it } from "bun:test";
import { strict as assert } from "node:assert";
import { parseHackerNewsUrl, renderHackerNewsMarkdown } from "./hackernews";

describe("parseHackerNewsUrl", () => {
  it("parses an item URL", () => {
    assert.deepEqual(parseHackerNewsUrl("https://news.ycombinator.com/item?id=42424242"), {
      itemId: "42424242",
      permalink: "https://news.ycombinator.com/item?id=42424242",
    });
  });

  it("rejects other paths and non-numeric ids", () => {
    assert.equal(parseHackerNewsUrl("https://news.ycombinator.com/user?id=alice"), undefined);
    assert.equal(parseHackerNewsUrl("https://news.ycombinator.com/item?id=abc"), undefined);
  });
});

describe("renderHackerNewsMarkdown", () => {
  it("renders points, nested comments with quote indentation", () => {
    const markdown = renderHackerNewsMarkdown(
      {
        title: "Show HN",
        author: "alice",
        points: 42,
        url: "https://example.com",
        children: [
          { author: "bob", text: "<p>top comment</p>", children: [
            { author: "carol", text: "reply", children: [] },
          ] },
        ],
      },
      "https://news.ycombinator.com/item?id=42424242",
    );
    assert.match(markdown, /^# Show HN/);
    assert.match(markdown, /- Points: 42/);
    assert.match(markdown, /- Comments: 2/);
    assert.match(markdown, /### 1\. bob\n\ntop comment/);
    assert.match(markdown, /### 2\. carol\n\n> reply/);
  });
});
