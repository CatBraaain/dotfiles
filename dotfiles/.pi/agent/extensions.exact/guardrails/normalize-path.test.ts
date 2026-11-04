import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeToolPath } from "./normalize-path.ts";

describe("normalizeToolPath", () => {
  let previousPath: string | undefined;

  beforeEach(() => {
    previousPath = process.env._guardrail_test_path1;
  });

  afterEach(() => {
    if (previousPath === undefined) delete process.env._guardrail_test_path1;
    else process.env._guardrail_test_path1 = previousPath;
  });

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

  for (const reference of ["$_guardrail_test_path1", "${_guardrail_test_path1}"]) {
    it(`expands ${reference} in an absolute path`, () => {
      process.env._guardrail_test_path1 = "/docs with spaces";
      assert.equal(
        normalizeToolPath(`${reference}/extensions.md`),
        "/docs with spaces/extensions.md",
      );
    });

    it(`preserves a relative value in ${reference}`, () => {
      process.env._guardrail_test_path1 = "docs";
      assert.equal(normalizeToolPath(`${reference}/extensions.md`), "docs/extensions.md");
    });

    for (const value of [undefined, ""]) {
      it(`rejects ${reference} when its value is ${JSON.stringify(value)}`, () => {
        if (value === undefined) delete process.env._guardrail_test_path1;
        else process.env._guardrail_test_path1 = value;
        assert.throws(
          () => normalizeToolPath(`${reference}/extensions.md`),
          /environment variable _guardrail_test_path1 is undefined or empty/,
        );
      });
    }
  }

  it("expands every variable reference in the original path", () => {
    process.env._guardrail_test_path1 = "docs";
    assert.equal(normalizeToolPath("$_guardrail_test_path1/${_guardrail_test_path1}"), "docs/docs");
  });

  it("removes @ before variable expansion and expands the resulting home path", () => {
    process.env._guardrail_test_path1 = "~/docs";
    assert.equal(
      normalizeToolPath("@${_guardrail_test_path1}/extensions.md"),
      join(homedir(), "docs/extensions.md"),
    );
  });

  it("expands a variable whose value is exactly ~", () => {
    process.env._guardrail_test_path1 = "~";
    assert.equal(normalizeToolPath("$_guardrail_test_path1"), homedir());
  });

  it("does not expand variable references inside an environment value", () => {
    process.env._guardrail_test_path1 = "$GUARDRAIL_UNDEFINED_NESTED/${GUARDRAIL_UNDEFINED_NESTED}";
    assert.equal(normalizeToolPath("$_guardrail_test_path1"), process.env._guardrail_test_path1);
  });

  it("inserts dollar signs and shell syntax in an environment value literally", () => {
    process.env._guardrail_test_path1 = "$&/$(printf ignored)";
    assert.equal(normalizeToolPath("${_guardrail_test_path1}"), "$&/$(printf ignored)");
  });

  for (const path of ["${_guardrail_test_path1:-fallback}", "$(printf ignored)", "$9/${9}/$"]) {
    it(`leaves unsupported shell syntax unchanged in ${path}`, () => {
      delete process.env._guardrail_test_path1;
      assert.equal(normalizeToolPath(path), path);
    });
  }
});
