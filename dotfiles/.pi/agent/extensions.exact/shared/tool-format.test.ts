import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { homedir } from "node:os";
import {
  CALL_PREVIEW_LIMIT,
  DENIED_REASON_PREVIEW_LIMIT,
  formatFallbackCall,
  formatPath,
  formatToolCall,
  formatToolResultSummary,
  resultText,
  type ToolTheme,
} from "./tool-format.ts";

const plainTheme: ToolTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

describe("formatPath", () => {
  it("cwd 配下のパスを ./ から始まる相対パスで表示する", () => {
    const renderedPath = formatPath("childfolder/a.ts", "/workspace/project");
    assert.equal(renderedPath, "./childfolder/a.ts");
  });

  it("cwd 自体を . で表示する", () => {
    const renderedPath = formatPath("/workspace/project", "/workspace/project");
    assert.equal(renderedPath, ".");
  });

  it("親ディレクトリ経由のパスを絶対パスで表示する", () => {
    const renderedPath = formatPath("../README.md", "/workspace/project");
    assert.equal(renderedPath, "/workspace/README.md");
  });

  it("ホームディレクトリを ~ で表示する", () => {
    const renderedPath = formatPath(homedir(), "/workspace/project");
    assert.equal(renderedPath, "~");
  });

  it("ホームディレクトリ配下のパスを ~ から始めて表示する", () => {
    const renderedPath = formatPath(`${homedir()}/documents/report.md`, "/workspace/project");
    assert.equal(renderedPath, "~/documents/report.md");
  });
});

describe("formatToolCall", () => {
  it("bash は $ 付きコマンドを表示する", () => {
    const call = formatToolCall("bash", { command: "git status" }, "/cwd", plainTheme);
    assert.equal(call, "$ git status");
  });

  it("read は cwd 配下のパスを ./ から始めて表示する", () => {
    const call = formatToolCall("read", { path: "src/a.ts" }, "/cwd", plainTheme);
    assert.equal(call, "read ./src/a.ts");
  });

  it("read は SKILL.md をスキル名で表示する", () => {
    const call = formatToolCall("read", { path: "/skills/my-skill/SKILL.md" }, "/cwd", plainTheme);
    assert.ok(call.includes("[skill]"));
    assert.ok(call.includes("my-skill"));
  });

  it("write は cwd 配下の絶対パスを ./ から始めて表示する", () => {
    const call = formatToolCall("write", { path: "/cwd/a.ts" }, "/cwd", plainTheme);
    assert.equal(call, "write ./a.ts");
  });

  it("edit は cwd の親にあるパスを絶対表示する", () => {
    const call = formatToolCall("edit", { path: "/parent/b.ts" }, "/cwd", plainTheme);
    assert.equal(call, "edit /parent/b.ts");
  });

  it("grep は path 未指定時に cwd を表示する", () => {
    const call = formatToolCall("grep", { pattern: "TODO" }, "/cwd", plainTheme);
    assert.equal(call, "grep TODO in .");
  });

  it("grep は cwd 配下の path を表示する", () => {
    const call = formatToolCall("grep", { pattern: "TODO", path: "src" }, "/cwd", plainTheme);
    assert.equal(call, "grep TODO in ./src");
  });

  it("find は path 未指定時に cwd を表示する", () => {
    const call = formatToolCall("find", { pattern: "*.ts" }, "/cwd", plainTheme);
    assert.equal(call, "find *.ts in .");
  });

  it("find は cwd 配下の path を表示する", () => {
    const call = formatToolCall("find", { pattern: "*.ts", path: "src" }, "/cwd", plainTheme);
    assert.equal(call, "find *.ts in ./src");
  });

  it("ls はパス未指定で . を表示する", () => {
    const call = formatToolCall("ls", {}, "/cwd", plainTheme);
    assert.equal(call, "ls .");
  });

  it("ls は cwd 自体を . で表示する", () => {
    const call = formatToolCall("ls", { path: "/cwd" }, "/cwd", plainTheme);
    assert.equal(call, "ls .");
  });

  it("未知ツールは引数 JSON の先頭100文字で表示する", () => {
    const call = formatToolCall("custom", { data: "x".repeat(95) }, "/cwd", plainTheme);
    const expectedJson = JSON.stringify({ data: "x".repeat(95) });
    assert.equal(call, `custom ${expectedJson.slice(0, CALL_PREVIEW_LIMIT)}...`);
  });
});

describe("formatToolResultSummary", () => {
  const textResult = (text: string) => ({ content: [{ type: "text", text }] });

  it("bash は実行秒数を表示する", () => {
    const summary = formatToolResultSummary(
      "bash",
      { command: "ls" },
      textResult(""),
      { durationMs: 1200 },
      plainTheme,
    );
    assert.equal(summary, "1.2s");
  });

  it("bash は duration がないとき done を表示する", () => {
    const summary = formatToolResultSummary(
      "bash",
      { command: "ls" },
      textResult(""),
      {},
      plainTheme,
    );
    assert.equal(summary, "done");
  });

  it("write は書き込みサイズを表示する", () => {
    const summary = formatToolResultSummary(
      "write",
      { path: "a.ts", content: "x".repeat(1536) },
      textResult(""),
      {},
      plainTheme,
    );
    assert.equal(summary, "wrote 1.5KB");
  });

  it("edit はブロック数を表示する", () => {
    const summary = formatToolResultSummary(
      "edit",
      {
        path: "a.ts",
        edits: [
          { oldText: "x", newText: "y" },
          { oldText: "a", newText: "b" },
        ],
      },
      textResult(""),
      {},
      plainTheme,
    );
    assert.equal(summary, "edited 2 block(s)");
  });

  it("read は結果テキストの行数を表示する", () => {
    const summary = formatToolResultSummary(
      "read",
      { path: "a.ts" },
      textResult("a\nb\n"),
      {},
      plainTheme,
    );
    assert.equal(summary, "2 lines");
  });

  it("read は画像を新規抽出したときOCR抽出を行数に添える", () => {
    const summary = formatToolResultSummary(
      "read",
      { path: "a.png" },
      { content: [{ type: "text", text: "a\nb\n" }], details: { generated: true } },
      {},
      plainTheme,
    );
    assert.equal(summary, "OCR extracted, 2 lines");
  });

  it("grep はマッチ行だけを数えて matches を表示する", () => {
    const output = ["a.txt-1- before", "a.txt:2: match", "b.txt:3- context", "b.txt:4: match"].join(
      "\n",
    );
    const summary = formatToolResultSummary(
      "grep",
      { pattern: "match" },
      textResult(output),
      {},
      plainTheme,
    );
    assert.equal(summary, "2 matches");
  });

  it("find はファイル数を表示する", () => {
    const summary = formatToolResultSummary(
      "find",
      { pattern: "*.ts" },
      textResult("a\nb"),
      {},
      plainTheme,
    );
    assert.equal(summary, "2 files");
  });

  it("ls はエントリ数を表示する", () => {
    const summary = formatToolResultSummary(
      "ls",
      { path: "." },
      textResult("a\nb\nc"),
      {},
      plainTheme,
    );
    assert.equal(summary, "3 entries");
  });

  it("ask_permission は許可状態を表示する", () => {
    const summary = (details: unknown) =>
      formatToolResultSummary("ask_permission", {}, { content: [], details }, {}, plainTheme);
    assert.equal(summary({ status: "granted" }), "granted");
    assert.equal(summary({ status: "denied" }), "denied");
    assert.equal(summary({ status: "already granted" }), "already granted");
    assert.equal(summary({ status: "unknown" }), undefined);
  });

  it("ask_permission は拒否理由を併記する", () => {
    const summary = formatToolResultSummary(
      "ask_permission",
      {},
      { content: [], details: { status: "denied", reason: "not now" } },
      {},
      plainTheme,
    );
    assert.equal(summary, "denied — not now");
  });

  it("ask_permission は拒否理由を80文字に切り詰めて併記する", () => {
    const summary = formatToolResultSummary(
      "ask_permission",
      {},
      { content: [], details: { status: "denied", reason: "x".repeat(90) } },
      {},
      plainTheme,
    );
    assert.equal(summary, `denied — ${"x".repeat(DENIED_REASON_PREVIEW_LIMIT - 3)}...`);
  });

  it("ask_permission は空欄の拒否理由を併記しない", () => {
    const summary = formatToolResultSummary(
      "ask_permission",
      {},
      { content: [], details: { status: "denied", reason: "" } },
      {},
      plainTheme,
    );
    assert.equal(summary, "denied");
  });

  it("エラー時は結果テキスト全体を返す", () => {
    const summary = formatToolResultSummary(
      "read",
      { path: "a.ts" },
      textResult("File not found"),
      { isError: true },
      plainTheme,
    );
    assert.equal(summary, "File not found");
  });

  it("未知ツールはサマリーを返さない", () => {
    const summary = formatToolResultSummary("custom", {}, textResult("output"), {}, plainTheme);
    assert.equal(summary, undefined);
  });
});

describe("resultText", () => {
  it("最初の text パートを取り出す", () => {
    const output = resultText({ content: [{ type: "text", text: "hello" }] });
    assert.equal(output, "hello");
  });

  it("text パートがないとき空文字を返す", () => {
    const output = resultText({ content: [{ type: "image" }] });
    assert.equal(output, "");
  });
});

describe("formatFallbackCall", () => {
  it("引数がないツールは {} で表示する", () => {
    const call = formatFallbackCall("notify", {}, plainTheme);
    assert.equal(call, "notify {}");
  });
});
