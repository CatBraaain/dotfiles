// 実行: bun --install=auto run index.test.ts

import assert from "node:assert/strict";
import quietToolsExtension, {
  COMMAND_PREVIEW_LIMIT,
  countResultLines,
  formatDuration,
  formatSize,
  truncateCommand,
} from "./index";

const tests: { name: string; fn: () => Promise<void> | void }[] = [];
let group = "";

function describe(name: string, fn: () => void): void {
  const previousGroup = group;
  group = name;
  fn();
  group = previousGroup;
}

function it(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name: group ? `${group} > ${name}` : name, fn });
}

type Renderable = { render(width: number): string[] };
type Tool = {
  name: string;
  renderCall: (...args: any[]) => Renderable;
  renderResult: (...args: any[]) => Renderable;
};

const identityTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function captureTool(name: string): Tool {
  const tools = new Map<string, Tool>();
  quietToolsExtension({ registerTool: (tool: Tool) => tools.set(tool.name, tool) } as never);
  const tool = tools.get(name);
  assert.ok(tool, `${name} tool not registered`);
  return tool;
}

function renderedLines(component: Renderable): string[] {
  return component.render(80).map((line) => line.trim());
}

function renderBashResult(
  bash: Tool,
  text: string,
  options: { expanded: boolean; isPartial: boolean },
  context: { isError: boolean; state?: { startedAt?: number; endedAt?: number } },
): string[] {
  const result = { content: [{ type: "text" as const, text }], details: undefined };
  return renderedLines(bash.renderResult(result, options, identityTheme, context));
}

function renderWriteResult(
  write: Tool,
  fileContent: string,
  options: { expanded: boolean; isPartial: boolean },
  context: { isError: boolean; args: { path: string; content: string } },
): string[] {
  const successMessage = `Successfully wrote ${fileContent.length} bytes to ${context.args.path}`;
  const result = { content: [{ type: "text" as const, text: successMessage }], details: undefined };
  return renderedLines(write.renderResult(result, options, identityTheme, context));
}

function renderEditResult(
  edit: Tool,
  diff: string,
  editCount: number,
  options: { expanded: boolean; isPartial: boolean },
  context: { isError: boolean; args: { path: string; edits: { oldText: string; newText: string }[] } },
): string[] {
  const successMessage = `Successfully replaced ${editCount} block(s) in ${context.args.path}.`;
  const result = { content: [{ type: "text" as const, text: successMessage }], details: { diff } };
  return renderedLines(edit.renderResult(result, options, identityTheme, context));
}

function renderTextResult(
  tool: Tool,
  text: string,
  options: { expanded: boolean; isPartial: boolean },
  context: { isError: boolean },
): string[] {
  const result = { content: [{ type: "text" as const, text }], details: undefined };
  return renderedLines(tool.renderResult(result, options, identityTheme, context));
}

describe("truncateCommand", () => {
  it("limit以下の文字数はそのまま返す", () => {
    const shortCommand = "ls -la";
    assert.equal(truncateCommand(shortCommand), "ls -la");
  });

  it("limitちょうどの文字数はそのまま返す", () => {
    const exactLengthCommand = "a".repeat(COMMAND_PREVIEW_LIMIT);
    assert.equal(truncateCommand(exactLengthCommand), exactLengthCommand);
  });

  it("limitを超える文字数は末尾を...に切り詰める", () => {
    const longCommand = "a".repeat(COMMAND_PREVIEW_LIMIT + 10);
    const truncated = truncateCommand(longCommand);
    assert.equal(truncated.length, COMMAND_PREVIEW_LIMIT);
    assert.ok(truncated.endsWith("..."));
  });
});

describe("formatDuration", () => {
  it("0ミリ秒は0.0sになる", () => {
    assert.equal(formatDuration(0), "0.0s");
  });

  it("ミリ秒を秒に変換して小数第一位まで表示する", () => {
    assert.equal(formatDuration(1200), "1.2s");
  });

  it("端数は四捨五入される", () => {
    assert.equal(formatDuration(999), "1.0s");
  });
});

describe("formatSize", () => {
  it("1023バイト以下はB単位で表示する", () => {
    assert.equal(formatSize(0), "0B");
    assert.equal(formatSize(1023), "1023B");
  });

  it("1024バイト以上はKB単位で小数第一位まで表示する", () => {
    assert.equal(formatSize(1024), "1.0KB");
    assert.equal(formatSize(1536), "1.5KB");
  });

  it("1MiB以上はMB単位で小数第一位まで表示する", () => {
    assert.equal(formatSize(1024 * 1024), "1.0MB");
  });
});

describe("bash renderCall", () => {
  it("コマンドを$プロンプト付きで表示する", () => {
    const bash = captureTool("bash");
    const lines = renderedLines(bash.renderCall({ command: "git status" }, identityTheme, { executionStarted: false }));
    assert.deepEqual(lines, ["$ git status"]);
  });

  it("長すぎるコマンドは切り詰めて表示する", () => {
    const bash = captureTool("bash");
    const longCommand = `echo ${"x".repeat(COMMAND_PREVIEW_LIMIT)}`;
    const lines = renderedLines(bash.renderCall({ command: longCommand }, identityTheme, { executionStarted: false }));
    const rendered = lines.join("");
    assert.ok(rendered.startsWith("$ "));
    assert.ok(rendered.endsWith("..."));
  });
});

describe("bash renderResult", () => {
  it("実行中はRunning...を表示する", () => {
    const bash = captureTool("bash");
    const lines = renderBashResult(
      bash,
      "",
      { expanded: false, isPartial: true },
      { isError: false },
    );
    assert.deepEqual(lines, ["Running..."]);
  });

  it("成功かつ折りたたみ時は実行秒数を表示する", () => {
    const bash = captureTool("bash");
    const lines = renderBashResult(
      bash,
      "huge output here",
      { expanded: false, isPartial: false },
      { isError: false, state: { startedAt: 1_000, endedAt: 2_200 } },
    );
    assert.deepEqual(lines, ["1.2s"]);
  });

  it("実行時刻が不明な成功結果はdoneを表示する", () => {
    const bash = captureTool("bash");
    const lines = renderBashResult(
      bash,
      "huge output here",
      { expanded: false, isPartial: false },
      { isError: false },
    );
    assert.deepEqual(lines, ["done"]);
  });

  it("エラー時はコマンドの出力を表示する", () => {
    const bash = captureTool("bash");
    const errorMessage = "Command exited with code 1";
    const lines = renderBashResult(
      bash,
      errorMessage,
      { expanded: false, isPartial: false },
      { isError: true },
    );
    assert.deepEqual(lines, [errorMessage]);
  });

  it("展開時はコマンドの出力を表示する", () => {
    const bash = captureTool("bash");
    const multiLineOutput = "line1\nline2";
    const lines = renderBashResult(
      bash,
      multiLineOutput,
      { expanded: true, isPartial: false },
      { isError: false },
    );
    assert.deepEqual(lines, ["line1", "line2"]);
  });
});

describe("write renderCall", () => {
  it("パスをwriteプロンプト付きで表示し内容は出さない", () => {
    const write = captureTool("write");
    const multiLineContent = "line1\nline2\nline3";
    const lines = renderedLines(
      write.renderCall({ path: "src/main.ts", content: multiLineContent }, identityTheme, { executionStarted: false }),
    );
    assert.deepEqual(lines, ["write src/main.ts"]);
  });
});

describe("write renderResult", () => {
  it("実行中はRunning...を表示する", () => {
    const write = captureTool("write");
    const lines = renderWriteResult(
      write,
      "",
      { expanded: false, isPartial: true },
      { isError: false, args: { path: "a.txt", content: "" } },
    );
    assert.deepEqual(lines, ["Running..."]);
  });

  it("成功かつ折りたたみ時は書き込んだサイズを表示する", () => {
    const write = captureTool("write");
    const fiveBytesContent = "hello";
    const lines = renderWriteResult(
      write,
      fiveBytesContent,
      { expanded: false, isPartial: false },
      { isError: false, args: { path: "a.txt", content: fiveBytesContent } },
    );
    assert.deepEqual(lines, ["wrote 5B"]);
  });

  it("エラー時はエラーメッセージを表示する", () => {
    const write = captureTool("write");
    const errorMessage = "EACCES: permission denied";
    const result = { content: [{ type: "text" as const, text: errorMessage }], details: undefined };
    const lines = renderedLines(
      write.renderResult(result, { expanded: false, isPartial: false }, identityTheme, {
        isError: true,
        args: { path: "a.txt", content: "" },
      }),
    );
    assert.deepEqual(lines, [errorMessage]);
  });

  it("展開時は書き込んだ内容を表示する", () => {
    const write = captureTool("write");
    const multiLineContent = "line1\nline2";
    const lines = renderWriteResult(
      write,
      multiLineContent,
      { expanded: true, isPartial: false },
      { isError: false, args: { path: "a.txt", content: multiLineContent } },
    );
    assert.deepEqual(lines, ["line1", "line2"]);
  });
});


describe("edit renderCall", () => {
  it("パスをeditプロンプト付きで表示し編集内容は出さない", () => {
    const edit = captureTool("edit");
    const edits = [{ oldText: "line1", newText: "line1-changed" }];
    const lines = renderedLines(
      edit.renderCall({ path: "src/main.ts", edits }, identityTheme, { executionStarted: false }),
    );
    assert.deepEqual(lines, ["edit src/main.ts"]);
  });
});

describe("edit renderResult", () => {
  it("実行中はRunning...を表示する", () => {
    const edit = captureTool("edit");
    const lines = renderEditResult(
      edit,
      "",
      1,
      { expanded: false, isPartial: true },
      { isError: false, args: { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] } },
    );
    assert.deepEqual(lines, ["Running..."]);
  });

  it("成功かつ折りたたみ時は置換ブロック数を表示する", () => {
    const edit = captureTool("edit");
    const threeEdits = [
      { oldText: "a", newText: "b" },
      { oldText: "c", newText: "d" },
      { oldText: "e", newText: "f" },
    ];
    const lines = renderEditResult(
      edit,
      "@@ diff @@",
      threeEdits.length,
      { expanded: false, isPartial: false },
      { isError: false, args: { path: "a.ts", edits: threeEdits } },
    );
    assert.deepEqual(lines, ["edited 3 block(s)"]);
  });

  it("エラー時はエラーメッセージを表示する", () => {
    const edit = captureTool("edit");
    const errorMessage = "oldText not found in file";
    const result = { content: [{ type: "text" as const, text: errorMessage }], details: undefined };
    const lines = renderedLines(
      edit.renderResult(result, { expanded: false, isPartial: false }, identityTheme, {
        isError: true,
        args: { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] },
      }),
    );
    assert.deepEqual(lines, [errorMessage]);
  });

  it("展開時は差分を表示する", () => {
    const edit = captureTool("edit");
    const diff = "-old\n+new";
    const lines = renderEditResult(
      edit,
      diff,
      1,
      { expanded: true, isPartial: false },
      { isError: false, args: { path: "a.ts", edits: [{ oldText: "old", newText: "new" }] } },
    );
    assert.deepEqual(lines, ["-old", "+new"]);
  });
});

describe("countResultLines", () => {
  it("空文字は0を返す", () => {
    assert.equal(countResultLines(""), 0);
  });

  it("1行は1を返す", () => {
    assert.equal(countResultLines("a"), 1);
  });

  it("複数行は行数を返す", () => {
    assert.equal(countResultLines("a\nb\nc"), 3);
  });

  it("末尾の改行は行数に含めない", () => {
    assert.equal(countResultLines("a\nb\n"), 2);
  });
});

describe("read renderCall", () => {
  it("パスをreadプロンプト付きで表示する", () => {
    const read = captureTool("read");
    const lines = renderedLines(read.renderCall({ path: "src/main.ts" }, identityTheme, { executionStarted: false }));
    assert.deepEqual(lines, ["read src/main.ts"]);
  });
});

describe("read renderResult", () => {
  it("実行中はRunning...を表示する", () => {
    const read = captureTool("read");
    const lines = renderTextResult(read, "", { expanded: false, isPartial: true }, { isError: false });
    assert.deepEqual(lines, ["Running..."]);
  });

  it("成功かつ折りたたみ時は読み込んだ行数を表示する", () => {
    const read = captureTool("read");
    const threeLineFile = "line1\nline2\nline3";
    const lines = renderTextResult(read, threeLineFile, { expanded: false, isPartial: false }, { isError: false });
    assert.deepEqual(lines, ["3 lines"]);
  });

  it("エラー時は結果のメッセージを表示する", () => {
    const read = captureTool("read");
    const errorMessage = "File not found";
    const lines = renderTextResult(read, errorMessage, { expanded: false, isPartial: false }, { isError: true });
    assert.deepEqual(lines, [errorMessage]);
  });

  it("展開時はファイルの内容を表示する", () => {
    const read = captureTool("read");
    const fileContent = "line1\nline2";
    const lines = renderTextResult(read, fileContent, { expanded: true, isPartial: false }, { isError: false });
    assert.deepEqual(lines, ["line1", "line2"]);
  });
});

describe("grep renderCall", () => {
  it("検索パターンをgrepプロンプト付きで表示する", () => {
    const grep = captureTool("grep");
    const lines = renderedLines(grep.renderCall({ pattern: "TODO" }, identityTheme, { executionStarted: false }));
    assert.deepEqual(lines, ["grep TODO"]);
  });
});

describe("grep renderResult", () => {
  it("成功かつ折りたたみ時はマッチ数を表示する", () => {
    const grep = captureTool("grep");
    const twoMatches = "a.ts:1:TODO\nb.ts:5:TODO";
    const lines = renderTextResult(grep, twoMatches, { expanded: false, isPartial: false }, { isError: false });
    assert.deepEqual(lines, ["2 matches"]);
  });
});

describe("find renderCall", () => {
  it("検索パターンをfindプロンプト付きで表示する", () => {
    const find = captureTool("find");
    const lines = renderedLines(find.renderCall({ pattern: "*.ts" }, identityTheme, { executionStarted: false }));
    assert.deepEqual(lines, ["find *.ts"]);
  });
});

describe("find renderResult", () => {
  it("成功かつ折りたたみ時はファイル数を表示する", () => {
    const find = captureTool("find");
    const twoFiles = "src/a.ts\nsrc/b.ts";
    const lines = renderTextResult(find, twoFiles, { expanded: false, isPartial: false }, { isError: false });
    assert.deepEqual(lines, ["2 files"]);
  });
});

describe("ls renderCall", () => {
  it("パスをlsプロンプト付きで表示する", () => {
    const ls = captureTool("ls");
    const lines = renderedLines(ls.renderCall({ path: "src" }, identityTheme, { executionStarted: false }));
    assert.deepEqual(lines, ["ls src"]);
  });

  it("パス未指定時はカレントディレクトリを表示する", () => {
    const ls = captureTool("ls");
    const lines = renderedLines(ls.renderCall({}, identityTheme, { executionStarted: false }));
    assert.deepEqual(lines, ["ls ."]);
  });
});

describe("ls renderResult", () => {
  it("成功かつ折りたたみ時はエントリ数を表示する", () => {
    const ls = captureTool("ls");
    const threeEntries = "a.ts\nb.ts\ndir";
    const lines = renderTextResult(ls, threeEntries, { expanded: false, isPartial: false }, { isError: false });
    assert.deepEqual(lines, ["3 entries"]);
  });
});
let passed = 0;
const failures: string[] = [];
for (const test of tests) {
  try {
    await test.fn();
    passed++;
  } catch (error) {
    failures.push(
      `  ✗ ${test.name}\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} test(s) FAILED:\n${failures.join("\n")}\n`);
  process.exitCode = 1;
}
console.log(`\n${passed} passed, ${failures.length} failed`);
