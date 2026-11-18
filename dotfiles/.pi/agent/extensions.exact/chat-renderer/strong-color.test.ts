import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import chatRendererExtension, { colorizeStrongText } from "./index.ts";

const ESC = "\x1b";
const STRONG_COLOR = `${ESC}[38;2;245;167;66m`;
const DEFAULT_FG = `${ESC}[39m`;

describe("strong トークンの着色", () => {
  it("bold の内側だけに前景色を注入し、マーカーを保持する", () => {
    const markdown = "a **bold** b";
    assert.equal(colorizeStrongText(markdown), `a **${STRONG_COLOR}bold${DEFAULT_FG}** b`);
  });

  it("bold 内のインラインコードは着色せず、コード後の本文で色を復帰する", () => {
    const markdown = "**a `code` b**";
    assert.equal(
      colorizeStrongText(markdown),
      `**${STRONG_COLOR}a \`code\`${STRONG_COLOR} b${DEFAULT_FG}**`,
    );
  });

  it("bold 内のリンク後の本文でも色を復帰する", () => {
    const markdown = "**a [link](https://example.com) b**";
    assert.equal(
      colorizeStrongText(markdown),
      `**${STRONG_COLOR}a [link](https://example.com)${STRONG_COLOR} b${DEFAULT_FG}**`,
    );
  });

  it("fenced コード内の ** は着色しない", () => {
    const markdown = '```ts\nconst s = "**x**";\n```';
    assert.equal(colorizeStrongText(markdown), markdown);
  });

  it("インラインコード内の ** は着色しない", () => {
    const markdown = "run `**x**` now";
    assert.equal(colorizeStrongText(markdown), markdown);
  });

  it("閉じない ** は着色しない", () => {
    const markdown = "a **unclosed";
    assert.equal(colorizeStrongText(markdown), markdown);
  });

  it("本文だけの bold は着色対象から外す", () => {
    const markdown = "**`only code`**";
    assert.equal(colorizeStrongText(markdown), markdown);
  });

  it("複数の bold をそれぞれ着色する", () => {
    const markdown = "first **one** and **two**";
    assert.equal(
      colorizeStrongText(markdown),
      `first **${STRONG_COLOR}one${DEFAULT_FG}** and **${STRONG_COLOR}two${DEFAULT_FG}**`,
    );
  });
});

describe("strong 着色の登録", () => {
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

  it("ansi リテラル変換と strong 着色を同じ変換で適用する", () => {
    const transformer = captureTransformer();
    assert.notEqual(transformer, undefined);
    const markdown = "```ansi\n\\x1b[31mRed\\x1b[0m\n```\n\nSee **note** here.";
    const converted = transformer!(markdown, { messageType: "assistant" });
    assert.ok(converted.includes(`${ESC}[31mRed${ESC}[0m`), converted);
    assert.ok(converted.includes(`**${STRONG_COLOR}note${DEFAULT_FG}**`), converted);
  });

  it("assistant 以外の本文は着色しない", () => {
    const transformer = captureTransformer();
    const markdown = "See **note** here.";
    assert.equal(transformer!(markdown, { messageType: "user" }), markdown);
    assert.equal(transformer!(markdown, { messageType: "assistant-thinking" }), markdown);
  });
});
