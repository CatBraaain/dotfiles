import { describe, it } from "bun:test";
import { strict as assert } from "node:assert";
import {
  fetchTweetViaFxTwitterMarkdown,
  parseFxTwitterResponse,
  parseTweetUrl,
  parseTwitterListUrl,
} from "./twitter";

describe("parseTweetUrl", () => {
  it("parses x.com and twitter.com permalinks to a canonical permalink", () => {
    for (const raw of [
      "https://x.com/user1/status/1234567890",
      "https://twitter.com/user1/status/1234567890?s=20",
      "https://mobile.twitter.com/user1/status/1234567890/photo/1",
      "https://x.com/jack/status/20",
    ]) {
      assert.ok(parseTweetUrl(raw), raw);
    }
    assert.deepEqual(parseTweetUrl("https://x.com/jack/status/20"), {
      tweetId: "20",
      permalink: "https://x.com/jack/status/20",
    });
  });

  it("rejects user pages and non-twitter hosts", () => {
    assert.equal(parseTweetUrl("https://x.com/user1"), undefined);
    assert.equal(parseTweetUrl("https://example.com/a/status/1234567890"), undefined);
  });
});

describe("parseTwitterListUrl", () => {
  it("parses a search URL with the live flag", () => {
    assert.deepEqual(parseTwitterListUrl("https://x.com/search?q=browse%20cli&f=live"), {
      kind: "search",
      query: "browse cli",
      latest: true,
    });
  });

  it("parses a user page but not reserved paths", () => {
    assert.deepEqual(parseTwitterListUrl("https://x.com/user1"), {
      kind: "user",
      user: "user1",
      latest: false,
    });
    assert.equal(parseTwitterListUrl("https://x.com/i/notifications"), undefined);
    assert.equal(parseTwitterListUrl("https://x.com/search"), undefined);
  });
});

describe("parseFxTwitterResponse", () => {
  it("unwraps the tweet", () => {
    const tweet = parseFxTwitterResponse(
      JSON.stringify({ code: 200, tweet: { text: "hi" } }),
    );
    assert.equal(tweet.text, "hi");
  });

  it("throws without a tweet", () => {
    assert.throws(() => parseFxTwitterResponse(JSON.stringify({ code: 404 })));
  });
});

describe("fetchTweetViaFxTwitterMarkdown", () => {
  it("renders author, stats, media, poll and quote", () => {
    const markdown = fetchTweetViaFxTwitterMarkdown(
      {
        text: "main text",
        author: { name: "Alice", screen_name: "alice" },
        created_at: "2026-08-01T00:00:00.000Z",
        likes: 3,
        retweets: 2,
        replies: 1,
        media: { all: [{ type: "photo", url: "https://pbs.twimg.com/x.jpg" }] },
        poll: { options: [{ label: "yes", votes: 5 }] },
        quote: { text: "quoted", author: { name: "Bob", screen_name: "bob" } },
      },
      "https://x.com/alice/status/123",
    );
    assert.match(markdown, /^# Alice \(@alice\)/);
    assert.match(markdown, /- Posted: 2026-08-01T00:00:00\.000Z/);
    assert.match(markdown, /- Stats: 3 likes, 2 retweets, 1 replies/);
    assert.match(markdown, /- Media: https:\/\/pbs\.twimg\.com\/x\.jpg/);
    assert.match(markdown, /## Poll\n\n- yes: 5/);
    assert.match(markdown, /## Quoted tweet\n\n- Author: Bob \(@bob\)/);
  });
});
