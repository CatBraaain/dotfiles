import { describe, it } from "bun:test";
import { strict as assert } from "node:assert";
import { parseArxivAtom, parseArxivUrl, renderArxivMarkdown } from "./arxiv";

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.12345v1</id>
    <updated>2024-01-23T18:59:59Z</updated>
    <published>2024-01-23T18:59:59Z</published>
    <title>A Study of Something Interesting</title>
    <summary>  This paper studies
      interesting things. </summary>
    <author><name>Alice Author</name></author>
    <author><name>Bob Builder</name></author>
    <category term="cs.AI"/>
    <category term="cs.CL"/>
    <arxiv:comment xmlns:arxiv="http://arxiv.org/schemas/atom">15 pages</arxiv:comment>
  </entry>
</feed>`;

describe("parseArxivUrl", () => {
  it("parses new-style ids and drops version suffixes", () => {
    assert.deepEqual(parseArxivUrl("https://arxiv.org/abs/2401.12345v2"), {
      arxivId: "2401.12345",
      permalink: "https://arxiv.org/abs/2401.12345",
    });
  });

  it("parses old-style category ids", () => {
    assert.equal(parseArxivUrl("https://www.arxiv.org/abs/math.GT/0309136")?.arxivId, "math.GT/0309136");
  });

  it("rejects other paths", () => {
    assert.equal(parseArxivUrl("https://arxiv.org/pdf/2401.12345"), undefined);
    assert.equal(parseArxivUrl("https://arxiv.org/abs/not-an-id"), undefined);
  });
});

describe("parseArxivAtom", () => {
  it("parses title, authors, categories and the arxiv comment", () => {
    const article = parseArxivAtom(ATOM);
    assert.equal(article?.title, "A Study of Something Interesting");
    assert.deepEqual(article?.authors, ["Alice Author", "Bob Builder"]);
    assert.deepEqual(article?.categories, ["cs.AI", "cs.CL"]);
    assert.equal(article?.comment, "15 pages");
    assert.equal(article?.abstract, "This paper studies interesting things.");
  });
});

describe("renderArxivMarkdown", () => {
  it("renders the abstract shape", () => {
    const markdown = renderArxivMarkdown(
      {
        title: "A Study",
        authors: ["Alice"],
        published: "2024-01-23T18:59:59Z",
        categories: ["cs.AI"],
        abstract: "The abstract.",
      },
      "https://arxiv.org/abs/2401.12345",
    );
    assert.match(markdown, /^# A Study/);
    assert.match(markdown, /- Categories: cs\.AI/);
    assert.match(markdown, /## Abstract\n\nThe abstract\./);
  });
});
