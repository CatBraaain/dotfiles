import { describe, it } from "bun:test";
import { strict as assert } from "node:assert";
import { parseGitHubUrl } from "./github";

describe("parseGitHubUrl", () => {
  it("parses repo roots", () => {
    assert.deepEqual(parseGitHubUrl("https://github.com/owner/repo"), {
      kind: "repo",
      owner: "owner",
      repo: "repo",
      permalink: "https://github.com/owner/repo",
    });
  });

  it("parses issue, pull and discussion numbers", () => {
    assert.deepEqual(parseGitHubUrl("https://github.com/owner/repo/issues/12"), {
      kind: "issue",
      owner: "owner",
      repo: "repo",
      number: 12,
      permalink: "https://github.com/owner/repo/issues/12",
    });
    assert.equal(parseGitHubUrl("https://github.com/owner/repo/pull/34")?.kind, "pull");
    assert.equal(parseGitHubUrl("https://github.com/owner/repo/discussions/56")?.kind, "discussion");
  });

  it("rejects nested code paths and garbage numbers", () => {
    assert.equal(parseGitHubUrl("https://github.com/owner/repo/blob/main/a.ts"), undefined);
    assert.equal(parseGitHubUrl("https://github.com/owner/repo/releases/tag/v1"), undefined);
    assert.equal(parseGitHubUrl("https://github.com/owner/repo/issues/abc"), undefined);
    assert.equal(parseGitHubUrl("https://example.com/owner/repo/issues/12"), undefined);
  });
});
