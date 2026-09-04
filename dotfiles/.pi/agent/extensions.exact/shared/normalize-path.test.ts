import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeToolPath } from "./normalize-path.ts";

describe("normalizeToolPath", () => {
  it("strips a leading @ from an absolute path", () => {
    assert.equal(normalizeToolPath("@/abs/path"), "/abs/path");
  });

  it("strips a leading @ from a relative path", () => {
    assert.equal(normalizeToolPath("@relative/file.txt"), "relative/file.txt");
  });

  it("expands ~ to the home directory", () => {
    assert.equal(normalizeToolPath("~"), homedir());
  });

  it("expands ~/... to a path under the home directory", () => {
    assert.equal(normalizeToolPath("~/x"), join(homedir(), "x"));
  });

  it("applies @ stripping and ~ expansion together", () => {
    assert.equal(normalizeToolPath("@~/x"), join(homedir(), "x"));
  });

  it("returns plain relative and absolute paths unchanged", () => {
    assert.equal(normalizeToolPath("src/a.ts"), "src/a.ts");
    assert.equal(normalizeToolPath("/abs/path"), "/abs/path");
  });

  it("does not expand a ~ that is not the path head", () => {
    assert.equal(normalizeToolPath("a/~b"), "a/~b");
  });
});
