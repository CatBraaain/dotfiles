import { afterEach, beforeEach, describe, it, mock, spyOn } from "bun:test";
import assert from "node:assert/strict";
import * as camoufox from "./camoufox";
import { CAMOUFOX_SEARCH_SESSION_KEY, camoufoxSessionKey, openserpBaseUrl } from "./config";
import { searchOne } from "./search";
import * as server from "./server";

const html = "<html><body>Search results</body></html>";
const googleSearchUrl = "https://www.google.com/search?q=test+query&hl=ja&gl=jp";

beforeEach(() => {
  spyOn(camoufox, "camoufoxRender").mockResolvedValue(html);
  spyOn(server, "ensureOpenserpServer").mockResolvedValue(undefined);
});

afterEach(() => mock.restore());

describe("searchOne result URLs", () => {
  it("resolves Google's relative URLs against the rendered search URL without extra requests", async () => {
    const relativeUrls = [
      [
        "/goto?url=https%3A%2F%2Fexample.com%2Farticle",
        "https://www.google.com/goto?url=https%3A%2F%2Fexample.com%2Farticle",
      ],
      ["article/page", "https://www.google.com/article/page"],
      ["../article", "https://www.google.com/article"],
      ["?page=2", "https://www.google.com/search?page=2"],
      ["#section", `${googleSearchUrl}#section`],
      ["//example.com/article", "https://example.com/article"],
    ];
    const results = relativeUrls.map(([url], index) => ({
      rank: index + 1,
      title: `Result ${index + 1}`,
      url,
      display_url: "example.com/article",
      type: "organic",
      snippet: "Example result",
    }));
    const parseRequest = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results }));
    const renderRequest = spyOn(camoufox, "camoufoxRender");

    const outcome = await searchOne("test query", "JA");

    assert.equal(outcome.engine, "google");
    assert.deepEqual(
      outcome.results,
      results.map((result, index) => ({
        ...result,
        url: relativeUrls[index]?.[1],
      })),
    );
    assert.deepEqual(renderRequest.mock.calls, [
      [googleSearchUrl, camoufoxSessionKey(CAMOUFOX_SEARCH_SESSION_KEY)],
    ]);
    assert.equal(parseRequest.mock.calls.length, 1);
    const [endpoint, request] = parseRequest.mock.calls[0]!;
    assert.equal(endpoint, `${openserpBaseUrl()}/google/parse?format=json`);
    assert.equal(request?.method, "POST");
    assert.equal(request?.body, html);
  });

  it("preserves Google's absolute URLs byte-for-byte and keeps empty and missing URLs", async () => {
    const results = [
      { url: "https://EXAMPLE.com:443/a/../b?q=%2f#fragment" },
      { url: "http://example.com" },
      { url: "mailto:reader@example.com" },
      { url: "" },
      { title: "Missing URL" },
    ];
    spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results }));

    const outcome = await searchOne("test query");

    assert.equal(outcome.engine, "google");
    assert.deepEqual(outcome.results, results);
  });

  for (const engine of ["duckduckgo", "bing"] as const) {
    it(`preserves ${engine}'s result URLs after falling back from Google`, async () => {
      const results = [
        { url: "/relative" },
        { url: "https://EXAMPLE.com:443" },
        { url: "" },
        { title: "Missing URL" },
      ];
      const parseRequest = spyOn(globalThis, "fetch")
        .mockResolvedValue(Response.json({ results }))
        .mockResolvedValueOnce(Response.json({ results: [] }));
      if (engine === "bing") {
        parseRequest.mockResolvedValueOnce(Response.json({ results: [] }));
      }

      const outcome = await searchOne("test query");

      assert.equal(outcome.engine, engine);
      assert.deepEqual(outcome.results, results);
      assert.equal(parseRequest.mock.calls.length, engine === "duckduckgo" ? 2 : 3);
    });
  }
});
