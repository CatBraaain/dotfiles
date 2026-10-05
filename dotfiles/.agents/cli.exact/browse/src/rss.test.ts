import { describe, it } from "bun:test";
import { strict as assert } from "node:assert";
import { looksLikeFeed, parseFeed, renderFeedMarkdown } from "./rss";

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Blog</title>
  <entry>
    <title>First post</title>
    <link rel="alternate" href="https://example.com/1"/>
    <updated>2026-08-01T00:00:00Z</updated>
    <author><name>Alice</name></author>
    <summary><![CDATA[<p>Hello <b>world</b></p>]]></summary>
  </entry>
</feed>`;

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Example Blog</title>
  <item>
    <title>Post two</title>
    <link>https://example.com/2</link>
    <pubDate>Sat, 02 Aug 2026 00:00:00 GMT</pubDate>
    <description>Plain &amp; simple</description>
    <dc:creator>Bob</dc:creator>
  </item>
</channel></rss>`;

describe("looksLikeFeed", () => {
  it("detects RSS / Atom / RDF roots and rejects HTML", () => {
    assert.equal(looksLikeFeed(ATOM), true);
    assert.equal(looksLikeFeed(RSS), true);
    assert.equal(looksLikeFeed('<rdf:RDF xmlns="...">'), true);
    assert.equal(looksLikeFeed("<!DOCTYPE html><html>"), false);
  });
});

describe("parseFeed", () => {
  it("parses Atom entries with CDATA bodies", () => {
    const feed = parseFeed(ATOM);
    assert.equal(feed?.title, "Example Blog");
    assert.equal(feed?.entries.length, 1);
    const entry = feed?.entries[0];
    assert.equal(entry?.title, "First post");
    assert.equal(entry?.link, "https://example.com/1");
    assert.equal(entry?.author, "Alice");
    assert.equal(entry?.bodyMarkdown, "Hello **world**");
  });

  it("parses RSS items with dc:creator", () => {
    const feed = parseFeed(RSS);
    assert.equal(feed?.title, "Example Blog");
    const entry = feed?.entries[0];
    assert.equal(entry?.title, "Post two");
    assert.equal(entry?.author, "Bob");
    assert.equal(entry?.link, "https://example.com/2");
    assert.equal(entry?.bodyMarkdown, "Plain & simple");
  });

  it("returns undefined for HTML", () => {
    assert.equal(parseFeed("<!DOCTYPE html><html></html>"), undefined);
  });
});

describe("renderFeedMarkdown", () => {
  it("renders feed title and entries", () => {
    const markdown = renderFeedMarkdown("https://example.com/feed.xml", {
      title: "Example Blog",
      entries: [
        {
          title: "First post",
          author: "Alice",
          published: "2026-08-01T00:00:00Z",
          link: "https://example.com/1",
          bodyMarkdown: "Hello world",
        },
      ],
    });
    assert.match(markdown, /^# Example Blog/);
    assert.match(markdown, /## Entries \(1 retrieved\)/);
    assert.match(markdown, /### 1\. First post/);
    assert.match(markdown, /- Link: https:\/\/example\.com\/1/);
  });
});
