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

describe("search pipeline contract", () => {
  it("tries Google, DuckDuckGo, then Bing, stopping at the first nonempty response", async () => {
    const rendered = spyOn(camoufox, "camoufoxRender");
    spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ results: [] }))
      .mockResolvedValueOnce(Response.json({ results: [] }))
      .mockResolvedValueOnce(Response.json({ results: [{ title: "Bing result" }] }));
    const result = await searchOne("query");
    assert.equal(result.engine, "bing");
    assert.deepEqual(
      rendered.mock.calls.map(([url]) => new URL(url).hostname),
      ["www.google.com", "duckduckgo.com", "www.bing.com"],
    );
  });

  const invalidOpenserpResponses = [
    ["non-array results", { results: { title: "Google result" } }],
    ["null result", { results: [null] }],
    ["array result", { results: [[]] }],
    ["primitive result", { results: ["Google result"] }],
    ["string rank", { results: [{ rank: "1" }] }],
    ["numeric title", { results: [{ title: "Valid result" }, { title: 42 }] }],
    ["numeric URL", { results: [{ url: 42 }] }],
    ["numeric display URL", { results: [{ display_url: 42 }] }],
    ["numeric type", { results: [{ type: 42 }] }],
    ["null snippet", { results: [{ snippet: null }] }],
  ] as const;

  for (const [description, invalidResponse] of invalidOpenserpResponses) {
    it(`falls back after an OpenSERP response with ${description}`, async () => {
      const results = [{ title: "Duck result" }];
      const parseRequest = spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(Response.json(invalidResponse))
        .mockResolvedValueOnce(Response.json({ results }));

      const outcome = await searchOne("query");

      assert.equal(outcome.engine, "duckduckgo");
      assert.deepEqual(outcome.results, results);
      assert.deepEqual(
        parseRequest.mock.calls.map(([url]) => url),
        ["google", "duckduckgo"].map(
          (engine) => `${openserpBaseUrl()}/${engine}/parse?format=json`,
        ),
      );
    });
  }

  it("retries a challenged engine before falling back to the next engine", async () => {
    const rendered = spyOn(camoufox, "camoufoxRender")
      .mockRejectedValueOnce(new Error("render: challenge detected"))
      .mockRejectedValueOnce(new Error("render: challenge detected"))
      .mockResolvedValue(html);
    const prepare = spyOn(camoufox, "recoverCamoufoxBeforeRetry").mockResolvedValue({
      shouldRetry: true,
      consumesRecoveryBudget: false,
    });
    spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ results: [{ title: "Duck result" }] }),
    );
    const result = await searchOne("query");
    assert.equal(result.engine, "duckduckgo");
    assert.deepEqual(
      rendered.mock.calls.map(([url]) => new URL(url).hostname),
      ["www.google.com", "www.google.com", "duckduckgo.com"],
    );
    assert.equal(prepare.mock.calls.length, 1);
  });

  it("uses only the successful final attempt for tookMs and applies 15-second parse deadlines", async () => {
    let now = 0;
    spyOn(Date, "now").mockImplementation(() => now);
    spyOn(camoufox, "camoufoxRender").mockImplementation(async () => {
      now += 70;
      return html;
    });
    let parses = 0;
    const parseRequest = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async () => {
          now += 30;
          return Response.json({ results: ++parses === 1 ? [] : [{ title: "Found" }] });
        },
        { preconnect: fetch.preconnect },
      ),
    );
    const deadline = spyOn(AbortSignal, "timeout");
    const result = await searchOne("query");
    assert.equal(result.engine, "duckduckgo");
    assert.equal(result.tookMs, 100);
    assert.deepEqual(deadline.mock.calls, [[15000], [15000], [15000], [15000]]);
    const requestSignals = parseRequest.mock.calls.map(([, options]) => options?.signal);
    assert.equal(new Set(requestSignals).size, 2);
    for (const [index, signal] of requestSignals.entries()) {
      assert.ok(signal instanceof AbortSignal);
      assert.strictEqual(signal, deadline.mock.results[index * 2 + 1]!.value);
    }
  });
});
