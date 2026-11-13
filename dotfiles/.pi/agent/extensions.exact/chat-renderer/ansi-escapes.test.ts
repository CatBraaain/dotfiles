import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import chatRendererExtension, { convertAnsiEscapeLiterals } from "./index.ts";

const ESC = "\x1b";

describe("ansi フェンスのエスケープリテラル変換", () => {
  it("ansi フェンス内の \\x1b を実際の ESC へ置換する", () => {
    const markdown = "```ansi\n\\x1b[31mRed\\x1b[0m\n```";
    const converted = convertAnsiEscapeLiterals(markdown);
    assert.ok(converted.includes(`${ESC}[31mRed${ESC}[0m`), converted);
    assert.equal(converted.includes("\\x1b"), false);
  });

  it("\\u001b も大小を区別せず置換する", () => {
    const markdown = "```ansi\n\\u001b[31mRed\\u001B[0m\n```";
    const converted = convertAnsiEscapeLiterals(markdown);
    assert.ok(converted.includes(`${ESC}[31mRed${ESC}[0m`), converted);
    assert.equal(converted.includes("\\u001b"), false);
    assert.equal(converted.includes("\\u001B"), false);
  });

  it("フェンス外の本文は置換しない", () => {
    const markdown = [
      "See \\x1b below.",
      "",
      "```ansi",
      "\\x1b[31mRed\\x1b[0m",
      "```",
      "",
      "After \\x1b.",
    ].join("\n");
    const converted = convertAnsiEscapeLiterals(markdown);
    assert.ok(converted.includes("See \\x1b below."), converted);
    assert.ok(converted.includes("After \\x1b."), converted);
    assert.ok(converted.includes(`${ESC}[31mRed`), converted);
  });

  it("ansi 以外の言語指定フェンスは置換しない", () => {
    const markdown = '```ts\nconst s = "\\x1b[31m";\n```';
    assert.equal(convertAnsiEscapeLiterals(markdown), markdown);
  });

  it("複数の ansi フェンスを変換し、間の本文を触らない", () => {
    const markdown = [
      "```ansi",
      "\\x1b[31mfirst\\x1b[0m",
      "```",
      "",
      "between \\x1b stays",
      "",
      "```ansi",
      "\\x1b[32msecond\\x1b[0m",
      "```",
    ].join("\n");
    const converted = convertAnsiEscapeLiterals(markdown);
    assert.ok(converted.includes(`${ESC}[31mfirst${ESC}[0m`), converted);
    assert.ok(converted.includes(`${ESC}[32msecond${ESC}[0m`), converted);
    assert.ok(converted.includes("between \\x1b stays"), converted);
  });

  it("閉じフェンスが無いときは本文末尾まで変換する", () => {
    const markdown = "```ansi\n\\x1b[31mRed\\x1b[0m";
    const converted = convertAnsiEscapeLiterals(markdown);
    assert.ok(converted.includes(`${ESC}[31mRed${ESC}[0m`), converted);
  });

  it("既に実 ESC を含む行はそのまま保つ", () => {
    const markdown = "```ansi\n" + ESC + "[31mRed" + ESC + "[0m\n```";
    assert.equal(convertAnsiEscapeLiterals(markdown), markdown);
  });

  it("フェンスのインデントは行頭3スペースまで許可する", () => {
    const markdown = "   ```ansi\n\\x1b[31mRed\\x1b[0m\n   ```";
    const converted = convertAnsiEscapeLiterals(markdown);
    assert.ok(converted.includes(`${ESC}[31mRed${ESC}[0m`), converted);
  });
});

describe("markdown 変換の登録", () => {
  function captureTransformer():
    | ((markdown: string, context: { messageType: string }) => string)
    | undefined {
    let captured: ((markdown: string, context: { messageType: string }) => string) | undefined;
    chatRendererExtension({
      registerMarkdownTransformer: (transformer: unknown) => {
        captured = transformer as typeof captured;
      },
    } as unknown as ExtensionAPI);
    return captured;
  }

  it("assistant 本文だけ変換する", () => {
    const transformer = captureTransformer();
    assert.notEqual(transformer, undefined);
    const markdown = "```ansi\n\\x1b[31mRed\\x1b[0m\n```";
    const converted = transformer!(markdown, { messageType: "assistant" });
    assert.ok(converted.includes(`${ESC}[31mRed${ESC}[0m`), converted);
    assert.equal(converted.includes("\\x1b"), false);
    assert.equal(
      transformer!(markdown, { messageType: "user" }),
      markdown,
      "user messages stay untouched",
    );
    assert.equal(
      transformer!(markdown, { messageType: "assistant-thinking" }),
      markdown,
      "thinking stays untouched",
    );
  });

  it("transformer API が無い環境でもロードできる", () => {
    assert.doesNotThrow(() => chatRendererExtension({} as ExtensionAPI));
  });
});
