import { describe, it } from "bun:test";
import { strict as assert } from "node:assert";
import { fetchRoute } from "./fetch";

describe("fetchRoute", () => {
  it("routes Reddit post permalinks to the camoufox-free Reddit path", () => {
    assert.equal(fetchRoute("https://www.reddit.com/r/bun/comments/1abcdef/title_slug/"), "reddit");
    assert.equal(fetchRoute("https://old.reddit.com/r/bun/comments/1abcdef/"), "reddit");
  });

  it("routes StackOverflow question permalinks to the camoufox-free path", () => {
    assert.equal(fetchRoute("https://stackoverflow.com/questions/12345678/question-title"), "stackoverflow");
    assert.equal(fetchRoute("https://stackoverflow.com/questions/12345678"), "stackoverflow");
  });

  it("routes everything else through camoufox", () => {
    assert.equal(fetchRoute("https://example.com/article"), "camoufox");
    // A subreddit listing is not a post permalink, so it renders via camoufox.
    assert.equal(fetchRoute("https://www.reddit.com/r/bun/"), "camoufox");
    assert.equal(fetchRoute("https://stackoverflow.com/users/12345/someone"), "camoufox");
  });
});
