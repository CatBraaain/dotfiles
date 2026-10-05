import { describe, it } from "bun:test";
import { strict as assert } from "node:assert";
import { renderTwikitTweetMarkdown, renderTwitterTweets } from "./twitter-auth";

describe("renderTwikitTweetMarkdown", () => {
  it("renders the tweet and replies", () => {
    const markdown = renderTwikitTweetMarkdown(
      {
        text: "main text",
        author: "Alice",
        screenName: "alice",
        createdAt: "Sat Aug 01 00:00:00 +0000 2026",
        likes: 3,
        retweets: 2,
        replies: 1,
        mediaUrls: ["https://pbs.twimg.com/x.jpg"],
      },
      [{ text: "a reply", author: "Bob", screenName: "bob" }],
      "https://x.com/alice/status/123",
    );
    assert.match(markdown, /^# Alice \(@alice\)/);
    assert.match(markdown, /- URL: https:\/\/x\.com\/alice\/status\/123/);
    assert.match(markdown, /- Stats: 3 likes, 2 retweets, 1 replies/);
    assert.match(markdown, /## Replies \(1 retrieved\)/);
    assert.match(markdown, /### 1\. Bob \(@bob\)/);
  });
});

describe("renderTwitterTweets", () => {
  it("renders a user header when user info is present", () => {
    const markdown = renderTwitterTweets(
      { title: "Alice (@alice)", url: "https://x.com/alice" },
      [{ text: "tweet", author: "Alice", screenName: "alice" }],
    );
    assert.match(markdown, /^# Alice \(@alice\)/);
    assert.match(markdown, /## Tweets \(1 retrieved\)/);
    assert.match(markdown, /### 1\. Alice \(@alice\)/);
  });

  it("renders a search header", () => {
    const markdown = renderTwitterTweets(
      { title: "Twitter search: browse cli", url: "https://x.com/search?q=browse+cli" },
      [],
    );
    assert.match(markdown, /^# Twitter search: browse cli/);
    assert.match(markdown, /## Tweets \(0 retrieved\)/);
  });
});
