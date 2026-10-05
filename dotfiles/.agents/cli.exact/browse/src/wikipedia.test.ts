import { describe, it } from "bun:test";
import { strict as assert } from "node:assert";
import { parseWikipediaUrl, renderWikipediaMarkdown } from "./wikipedia";

describe("parseWikipediaUrl", () => {
  it("parses language editions including mobile", () => {
    for (const [raw, lang] of [
      ["https://en.wikipedia.org/wiki/Emacs", "en"],
      ["https://ja.m.wikipedia.org/wiki/Emacs", "ja"],
      ["https://simple.wikipedia.org/wiki/Emacs", "simple"],
    ] as const) {
      const parsed = parseWikipediaUrl(raw);
      assert.equal(parsed?.lang, lang);
      assert.equal(parsed?.title, "Emacs");
    }
  });

  it("normalizes the permalink", () => {
    assert.equal(
      parseWikipediaUrl("https://ja.wikipedia.org/wiki/%E3%82%A8%E3%83%94%E3%83%83%E3%82%AF")?.permalink,
      "https://ja.wikipedia.org/wiki/%E3%82%A8%E3%83%94%E3%83%83%E3%82%AF",
    );
  });

  it("rejects namespaced pages and non-wiki hosts", () => {
    assert.equal(parseWikipediaUrl("https://en.wikipedia.org/wiki/File:Emacs.png"), undefined);
    assert.equal(parseWikipediaUrl("https://en.wikipedia.org/w/index.php?title=Emacs"), undefined);
    assert.equal(parseWikipediaUrl("https://en.wiktionary.org/wiki/emacs"), undefined);
  });
});

describe("renderWikipediaMarkdown", () => {
  it("extracts the first paragraph as summary", () => {
    const markdown = renderWikipediaMarkdown(
      "Emacs",
      "https://en.wikipedia.org/wiki/Emacs",
      "First paragraph.\n\nSecond paragraph.",
    );
    assert.match(markdown, /^# Emacs/);
    assert.match(markdown, /- Summary: First paragraph\./);
    assert.match(markdown, /## Article\n\nFirst paragraph\.\n\nSecond paragraph\./);
  });
});
