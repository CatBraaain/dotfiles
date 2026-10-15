import { strict as assert } from "node:assert/strict";
import { describe, it } from "bun:test";
import { scanViolations } from "./scan";

describe("scan", () => {
  it("detects script elements case-insensitively with line numbers", () => {
    const html = "<p>a</p>\n<SCRIPT src='x'></SCRIPT>\n<p>b</p>";
    const violations = scanViolations(html);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].kind, "script");
    assert.equal(violations[0].line, 2);
  });

  it("does not flag noscript or data references", () => {
    const html = [
      "<noscript>fallback</noscript>",
      "<img src='data:image/png;base64,AAA'>",
      "<div style=\"background:url(data:image/svg+xml;utf8,%3Csvg/%3E)\"></div>",
    ].join("\n");
    assert.equal(scanViolations(html).length, 0);
  });

  it("detects external references across attributes and css", () => {
    const html = [
      "<img src='https://cdn.example/x.png'>",
      "<a href='//example.com/y'>link</a>",
      "<img srcset=\"https://a.example/z 1x, local.png 2x\">",
      "<style>a{background:url(http://b.example/w.png)}</style>",
      "<style>@import '//c.example/s.css';</style>",
      "<img src='file:///etc/passwd'>",
    ].join("\n");
    const violations = scanViolations(html);
    assert.equal(violations.length, 6);
    assert.deepEqual(
      violations.map((v) => v.line),
      [1, 2, 3, 4, 5, 6],
    );
    assert.ok(violations.every((v) => v.kind === "external-ref"));
  });

  it("reports the same line once when patterns overlap", () => {
    const html = "<style>@import url(//d.example/a.css);</style>";
    assert.equal(scanViolations(html).length, 1);
  });

  it("allows relative references", () => {
    const html = "<img src='img/a.png'><a href='#top'><link rel=stylesheet href='style.css'>";
    assert.equal(scanViolations(html).length, 0);
  });
});
