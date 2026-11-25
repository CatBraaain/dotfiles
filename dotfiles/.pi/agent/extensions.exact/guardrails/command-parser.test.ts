import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { parseCommandSegments } from "./command-parser.ts";

describe("Bash syntax adapter", () => {
  it("decodes supported ANSI-C escapes into the same argument Bash passes", () => {
    const words = [
      ["$'\\r'", "\r"],
      ["'a'$'\\r\\n''b'", "a\r\nb"],
      ["'c'$'\\r''d'", "c\rd"],
      ["$'\\n\\t'", "\n\t"],
      ["$'a b'", "a b"],
      ["$'\\e\\a'", "\x1b\x07"],
      ["$'x$y\\\\z'", "x$y\\z"],
      ["$''", ""],
    ];
    for (const [word, token] of words) {
      assert.deepEqual(
        parseCommandSegments(`tool ${word}`).map((s) => s.tokens),
        [["tool", token]],
      );
    }
  });

  it("rejects ANSI-C escapes whose value the parser does not define", () => {
    for (const word of [
      "$'\\x0d'",
      "$'\\u3042'",
      "$'\\U0001F600'",
      "$'\\cM'",
      "$'\\101'",
      "$'\\'",
      "$'a\\'b'",
      "$'\\d'",
      "$'a\\\nb'",
      "$'\\$'",
      "$'\\`'",
    ]) {
      assert.throws(
        () => parseCommandSegments(`tool ${word}`),
        /Unable to parse Bash command/,
        word,
      );
    }
  });

  it("retains builtin command tokens without treating declaration values as executable commands", () => {
    const segments = parseCommandSegments("export A=b; unset x; [ -n foo ]; [[ foo == foo ]]");
    assert.deepEqual(
      segments.map((segment) => segment.tokens),
      [
        ["export", "A=b"],
        ["unset", "x"],
        ["[", "-n", "foo", "]"],
        ["[[", "foo", "==", "foo", "]]"],
      ],
    );
  });

  it("can parse a new command after disposing a rejected recovery tree", () => {
    assert.throws(() => parseCommandSegments("echo $("), /Unable to parse Bash command/);
    assert.deepEqual(parseCommandSegments("git push"), [
      {
        tokens: ["git", "push"],
        ranges: [
          { index: 0, length: 3 },
          { index: 4, length: 4 },
        ],
      },
    ]);
  });

  it("retains literal arguments after a heredoc redirect", () => {
    const segments = parseCommandSegments("cat <<EOF 'a b'\nbody\nEOF");
    assert.deepEqual(segments[0], {
      tokens: ["cat", "a b"],
      ranges: [
        { index: 0, length: 3 },
        { index: 10, length: 5 },
      ],
    });
  });

  for (const substitution of ["$(echo `git push`)", "`echo $(git push)`"]) {
    it(`collects each executable part once: ${substitution}`, () => {
      const segments = parseCommandSegments(`cat <<EOF\n${substitution}\nEOF`);
      assert.deepEqual(
        segments.map((segment) => segment.tokens),
        [["cat"], ["echo"], ["git", "push"]],
      );
    });
  }

  it("rejects a parameter expansion whose nested backtick produces a recovery tree", () => {
    assert.throws(
      () => parseCommandSegments("cat <<EOF\n${value:-`echo $(git push)`}\nEOF"),
      /Unable to parse Bash command/,
    );
  });

  it("does not inspect a quoted literal or comment inside a decoded backtick", () => {
    const segments = parseCommandSegments("cat <<EOF\n`echo '$(stop)' # $(stop)\n`\nEOF");
    assert.deepEqual(
      segments.map((segment) => segment.tokens),
      [["cat"], ["echo", "$(stop)"]],
    );
  });

  it("does not interpret shell script strings or wrapper arguments as executable source", () => {
    const segments = parseCommandSegments("bash -c 'git push'; eval 'git push'; nohup tool");
    assert.deepEqual(
      segments.map((segment) => segment.tokens),
      [
        ["bash", "-c", "git push"],
        ["eval", "git push"],
        ["nohup", "tool"],
      ],
    );
  });
});
