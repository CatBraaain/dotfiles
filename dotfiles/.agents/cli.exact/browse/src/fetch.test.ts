import { afterEach, describe, it, mock, spyOn } from "bun:test";
import { strict as assert } from "node:assert";
import * as childProcess from "node:child_process";
import { fetchOne, fetchRoute } from "./fetch";
import * as camoufox from "./camoufox";
import * as util from "./util";
import { CAMOUFOX_FETCH_SESSION_KEY, camoufoxSessionKey } from "./config";

afterEach(() => mock.restore());

describe("fetchRoute", () => {
  it("routes Reddit post permalinks to the camoufox-free Reddit path", () => {
    assert.equal(fetchRoute("https://www.reddit.com/r/bun/comments/1abcdef/title_slug/"), "reddit");
    assert.equal(fetchRoute("https://old.reddit.com/r/bun/comments/1abcdef/"), "reddit");
  });

  it("routes StackOverflow question permalinks to the camoufox-free path", () => {
    assert.equal(
      fetchRoute("https://stackoverflow.com/questions/12345678/question-title"),
      "stackoverflow",
    );
    assert.equal(fetchRoute("https://stackoverflow.com/questions/12345678"), "stackoverflow");
  });

  it("routes everything else through camoufox", () => {
    assert.equal(fetchRoute("https://example.com/article"), "camoufox");
    // A subreddit listing is not a post permalink, so it renders via camoufox.
    assert.equal(fetchRoute("https://www.reddit.com/r/bun/"), "camoufox");
    assert.equal(fetchRoute("https://stackoverflow.com/users/12345/someone"), "camoufox");
  });
});

describe("dedicated fetch pipelines", () => {
  const redditUrl = "https://www.reddit.com/r/bun/comments/abc123/";
  const stackUrl = "https://stackoverflow.com/questions/123";

  it("fetches Reddit RSS with 500 comments and renders the post and comments without camoufox", async () => {
    const render = spyOn(camoufox, "camoufoxRender").mockRejectedValue(
      new Error("unexpected browser"),
    );
    const request = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        '<feed><entry><id>t3_abc123</id><title>Post title</title><name>/u/author</name><updated>2026-01-01</updated><link href="' +
          redditUrl +
          '"/><content>&lt;p&gt;Post body&lt;/p&gt;</content></entry>' +
          "<entry><id>t1_comment</id><title>Comment</title><name>/u/reader</name><content>&lt;p&gt;Reply&lt;/p&gt;</content></entry></feed>",
      ),
    );
    const result = await fetchOne(redditUrl);
    assert.equal(result.backend, "Reddit");
    assert.deepEqual(result.fallbacks, []);
    assert.equal(
      result.markdown,
      "# Post title\n\n- Author: u/author\n- Permalink: " +
        redditUrl +
        "\n- Updated: 2026-01-01\n- Comments: 1 fetched\n\n## Post\n\nPost body\n\n## Comments (1 retrieved)\n\nScores and reply hierarchy are not exposed by Reddit RSS.\n\n### 1. u/reader\n\nReply",
    );
    assert.equal(request.mock.calls[0]?.[0], redditUrl + ".rss?limit=500&sort=top");
    assert.equal(request.mock.calls.length, 1);
    assert.equal(render.mock.calls.length, 0);
  });

  for (const endpoint of ["embed", "oembed"] as const) {
    it(`falls back to Reddit ${endpoint} in RSS -> embed -> oEmbed order`, async () => {
      const calls: string[] = [];
      spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
          async (input: Parameters<typeof fetch>[0]) => {
            const url = String(input);
            calls.push(url);
            if (url.includes("/oembed")) return Response.json({ title: "oEmbed title" });
            if (url.includes("embed.reddit.com") && endpoint === "embed")
              return new Response('<h1 id="embed-title">Embed title</h1>12 comments');
            return new Response("", { status: 403 });
          },
          { preconnect: fetch.preconnect },
        ),
      );
      const render = spyOn(camoufox, "camoufoxRender").mockRejectedValue(
        new Error("unexpected browser"),
      );
      const result = await fetchOne(redditUrl);
      assert.equal(result.backend, "Reddit");
      assert.match(result.markdown, endpoint === "embed" ? /^# Embed title/ : /^# oEmbed title/);
      assert.ok(
        result.markdown.includes(
          endpoint === "embed"
            ? "- Comments: unavailable (Reddit displays 12)"
            : "- Comments: unavailable",
        ),
      );
      assert.ok(!result.markdown.includes("## Comments"));
      assert.deepEqual(
        calls.map((url) => new URL(url).hostname),
        endpoint === "embed"
          ? ["www.reddit.com", "embed.reddit.com"]
          : ["www.reddit.com", "embed.reddit.com", "www.reddit.com"],
      );
      assert.equal(render.mock.calls.length, 0);
    });
  }

  it("reports the original RSS status when all Reddit endpoints fail", async () => {
    const request = spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 403 }));
    await assert.rejects(() => fetchOne(redditUrl), {
      message:
        "All web fetch backends failed: Reddit: Unable to fetch Reddit post abc123 (RSS 403)",
    });
    assert.equal(request.mock.calls.length, 3);
  });

  it("fetches StackOverflow answers by votes in pages of 100, stops at 500, and honors backoff", async () => {
    const waits = spyOn(util, "delay").mockResolvedValue(undefined);
    const urls: URL[] = [];
    const render = spyOn(camoufox, "camoufoxRender").mockRejectedValue(
      new Error("unexpected browser"),
    );
    spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          const url = new URL(String(input));
          urls.push(url);
          if (!url.pathname.endsWith("/answers"))
            return Response.json({
              backoff: 2,
              items: [
                {
                  title: "A &amp; B",
                  body: "<p>Question</p>",
                  owner: { display_name: "Asker" },
                  score: 3,
                  answer_count: 600,
                  tags: ["bun"],
                },
              ],
            });
          return Response.json({
            has_more: true,
            items: Array.from({ length: 100 }, (_, index) => ({
              body: "<p>Answer</p>",
              owner: { display_name: "Reader" },
              score: 20 - index,
              is_accepted: index === 0,
            })),
          });
        },
        { preconnect: fetch.preconnect },
      ),
    );
    const result = await fetchOne(stackUrl);
    assert.equal(result.backend, "StackOverflow");
    assert.match(result.markdown, /^# A & B\n\n- Author: Asker/);
    assert.ok(
      result.markdown.includes("- Score: 3\n- Answers: 500 retrieved / 600 total\n- Tags: bun"),
    );
    assert.ok(result.markdown.includes("## Question\n\nQuestion"));
    assert.ok(result.markdown.includes("## Answers (500 retrieved)"));
    assert.ok(result.markdown.includes("### 1. Reader (accepted, score 20)"));
    assert.equal(urls.length, 6);
    assert.deepEqual(
      urls.slice(1).map((url) => Object.fromEntries(url.searchParams)),
      [1, 2, 3, 4, 5].map((page) => ({
        site: "stackoverflow",
        filter: "withbody",
        order: "desc",
        sort: "votes",
        pagesize: "100",
        page: String(page),
      })),
    );
    assert.deepEqual(waits.mock.calls, [[2000]]);
    assert.equal(render.mock.calls.length, 0);
  });

  it("falls back from the StackExchange API to the question feed", async () => {
    const calls: string[] = [];
    spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          calls.push(String(input));
          if (calls.length === 1) return new Response("", { status: 503 });
          return new Response(
            "<feed><entry><title>Question title</title><name>Asker</name><summary>&lt;p&gt;Question&lt;/p&gt;</summary></entry>" +
              "<entry><title>Answer</title><name>Reader</name><summary>&lt;p&gt;Response&lt;/p&gt;</summary></entry></feed>",
          );
        },
        { preconnect: fetch.preconnect },
      ),
    );
    const result = await fetchOne(stackUrl);
    assert.deepEqual(calls, [
      "https://api.stackexchange.com/2.3/questions/123?site=stackoverflow&filter=withbody",
      "https://stackoverflow.com/feeds/question/123",
    ]);
    assert.equal(
      result.markdown,
      "# Question title\n\n- Author: Asker\n- Permalink: " +
        stackUrl +
        "\n\nNote: score, accepted and vote order are unavailable from the question feed.\n\n## Question\n\nQuestion\n\n## Answers (1 retrieved)\n\n### 1. Reader\n\nResponse",
    );
  });

  it("reports a dedicated StackOverflow failure without trying camoufox", async () => {
    spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const render = spyOn(camoufox, "camoufoxRender").mockResolvedValue("unused");
    await assert.rejects(() => fetchOne(stackUrl), {
      message:
        "All web fetch backends failed: StackOverflow: Unable to fetch StackOverflow question 123",
    });
    assert.equal(render.mock.calls.length, 0);
  });

  it("renders an ordinary URL and pipes HTML through trafilatura after RSS fails", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>not a feed</html>"));
    const render = spyOn(camoufox, "camoufoxRender").mockResolvedValue("<html>Article</html>");
    const convert = spyOn(util, "runWithStdin").mockResolvedValue("# Article\n\nBody");
    const result = await fetchOne("https://example.com/article");
    assert.equal(result.backend, "camoufox+trafilatura");
    assert.equal(result.markdown, "# Article\n\nBody");
    assert.deepEqual(render.mock.calls, [
      ["https://example.com/article", camoufoxSessionKey(CAMOUFOX_FETCH_SESSION_KEY)],
    ]);
    assert.deepEqual(convert.mock.calls, [["trafilatura", ["--markdown"], "<html>Article</html>"]]);
    assert.equal(result.fallbacks.length, 1);
    assert.equal(result.fallbacks[0]?.backend, "RSS");
  });

  it("records a failed render retry before the successful final fetch attempt", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>not a feed</html>"));
    const render = spyOn(camoufox, "camoufoxRender")
      .mockRejectedValueOnce(new Error("render: aborted"))
      .mockResolvedValue("<html>Article</html>");
    spyOn(camoufox, "recoverCamoufoxBeforeRetry").mockResolvedValue({
      shouldRetry: true,
      consumesRecoveryBudget: true,
    });
    spyOn(util, "runWithStdin").mockResolvedValue("# Article");
    const result = await fetchOne("https://example.com/");
    assert.equal(render.mock.calls.length, 2);
    assert.deepEqual(
      result.fallbacks.map(({ backend }) => backend),
      ["RSS", "camoufox+trafilatura"],
    );
    assert.equal(result.fallbacks[1]?.error, "render: aborted");
  });
});

describe("dedicated request deadlines", () => {
  for (const url of [
    "https://www.reddit.com/r/bun/comments/abc123/",
    "https://stackoverflow.com/questions/123",
  ]) {
    it(`assigns an independent 15-second deadline to each request for ${new URL(url).hostname}`, async () => {
      const deadline = spyOn(AbortSignal, "timeout");
      const request = spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("", { status: 503 }),
      );
      await assert.rejects(() => fetchOne(url), /All web fetch backends failed/);
      assert.deepEqual(
        deadline.mock.calls,
        url.includes("reddit") ? [[15000], [15000], [15000]] : [[15000], [15000]],
      );
      const requestSignals = request.mock.calls.map(([, options]) => options?.signal);
      assert.equal(requestSignals.length, deadline.mock.results.length);
      assert.equal(new Set(requestSignals).size, requestSignals.length);
      for (const [index, signal] of requestSignals.entries()) {
        assert.ok(signal instanceof AbortSignal);
        assert.strictEqual(signal, deadline.mock.results[index]!.value);
      }
    });
  }
});

describe("HTML conversion deadline", () => {
  it("pipes rendered HTML to trafilatura with a 15-second subprocess timeout and trims its output", async () => {
    let receivedInput: string | undefined;
    const exec = spyOn(childProcess, "execFile").mockImplementation(((
      _command: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      queueMicrotask(() => callback(null, "  # Converted\n\nBody\n  "));
      return {
        stdin: {
          end: (input: string) => {
            receivedInput = input;
          },
        },
      };
    }) as never);
    const markdown = await util.runWithStdin("trafilatura", ["--markdown"], "<html>Body</html>");
    assert.equal(markdown, "# Converted\n\nBody");
    assert.equal(receivedInput, "<html>Body</html>");
    assert.deepEqual(exec.mock.calls[0]?.slice(0, 3), [
      "trafilatura",
      ["--markdown"],
      { timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
    ]);
  });
});

describe("dedicated fetch completion", () => {
  it("stops StackOverflow pagination as soon as has_more is false", async () => {
    const request = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ items: [{ title: "Question", body: "<p>Body</p>" }] }))
      .mockResolvedValueOnce(
        Response.json({ has_more: false, items: [{ body: "<p>Answer</p>" }] }),
      );
    const result = await fetchOne("https://stackoverflow.com/questions/123");
    assert.equal(request.mock.calls.length, 2);
    assert.ok(result.markdown.includes("## Answers (1 retrieved)"));
  });

  it("preserves an RSS transport error when every Reddit endpoint is unreachable", async () => {
    const request = spyOn(globalThis, "fetch").mockRejectedValue(new Error("network unavailable"));
    await assert.rejects(() => fetchOne("https://www.reddit.com/r/bun/comments/abc123/"), {
      message:
        "All web fetch backends failed: Reddit: Unable to fetch Reddit post abc123 (RSS network unavailable)",
    });
    assert.equal(request.mock.calls.length, 3);
  });
});
