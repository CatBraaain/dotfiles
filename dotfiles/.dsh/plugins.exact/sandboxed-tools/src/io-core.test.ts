import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import {
  BASH_MAX_OUTPUT_BYTES,
  GREP_MAX_LINE_BYTES,
  LS_MAX_BYTES,
  applyEditLiteral,
  buildGlobArgv,
  buildLsOutput,
  buildReadWindow,
  capBashStreams,
  formatEditOutput,
  formatGrepOutput,
  formatReadOutput,
  formatWriteOutput,
  parseGrepMatches,
  previewGrepLine,
  readFooter,
  renderGlobPaths,
  retainGrepMatches,
  sniffImageMediaType,
  validateGrepInclude,
} from "./io-core";

describe("§1 read ウィンドウ", () => {
  it("1-based offset と limit で行番号を付ける", () => {
    const window = buildReadWindow("a\nb\nc\nd\n", 2, 2);
    assert.deepEqual(window.lines, [
      { number: 2, text: "b" },
      { number: 3, text: "c" },
    ]);
    assert.equal(window.totalLines, 4);
  });

  it("limit の既定・上限は呼び出し側が 2000 を強制する（ここでは既定引数なしの動作のみ）", () => {
    const single = buildReadWindow("x", 1, 2000);
    assert.equal(single.lines.length, 1);
  });

  it("1 行を 2000 文字で切り詰め、その旨を付ける", () => {
    const longLine = "a".repeat(2500);
    const window = buildReadWindow(longLine, 1, 10);
    assert.equal(window.lines[0]?.text, `${"a".repeat(2000)}... (line truncated to 2000 chars)`);
  });

  it("\\r を取り除く", () => {
    const window = buildReadWindow("a\r\nb\r\n", 1, 10);
    assert.deepEqual(window.lines, [
      { number: 1, text: "a" },
      { number: 2, text: "b" },
    ]);
  });

  it("offset が総行数を超えるとエラー", () => {
    assert.throws(() => buildReadWindow("a\nb\n", 3, 10), /offset 3 is out of range \(2 lines\)/);
  });

  it("空ファイルの offset=1 はエラーにしない", () => {
    const window = buildReadWindow("", 1, 10);
    assert.equal(window.totalLines, 0);
    assert.equal(window.lines.length, 0);
  });
});

describe("§1 read の続き行フッター", () => {
  it("続きがあるとき次の offset を示す", () => {
    const window = { lines: [{ number: 2, text: "b" }], totalLines: 5 };
    assert.equal(readFooter(window, 2), "(Showing lines 2-2 of 5. Use offset=3 to continue.)");
  });

  it("末尾に達したとき total を示す", () => {
    const window = { lines: [{ number: 5, text: "e" }], totalLines: 5 };
    assert.equal(readFooter(window, 1), "(End of file - total 5 lines)");
  });

  it("envelope は <path>/<type>/<content> 形式", () => {
    const window = { lines: [{ number: 1, text: "hello" }], totalLines: 1 };
    assert.equal(
      formatReadOutput("/tmp/a.txt", window, 1),
      "<path>/tmp/a.txt</path>\n<type>file</type>\n<content>\n1: hello\n\n(End of file - total 1 lines)\n</content>",
    );
  });
});

describe("§1 write/edit の確認文", () => {
  it("write は Created file / Updated file", () => {
    assert.equal(
      formatWriteOutput("/a", "create"),
      "<path>/a</path>\n<type>file</type>\n<content>\nCreated file\n</content>",
    );
    assert.equal(
      formatWriteOutput("/a", "update"),
      "<path>/a</path>\n<type>file</type>\n<content>\nUpdated file\n</content>",
    );
  });

  it("edit は単一置換と全置換で文言が変わる", () => {
    assert.equal(formatEditOutput("/a", false), "The file /a has been updated successfully.");
    assert.equal(
      formatEditOutput("/a", true),
      "The file /a has been updated. All occurrences were successfully replaced.",
    );
  });
});

describe("§1 edit のリテラル置換", () => {
  it("単一一致は置換する", () => {
    assert.deepEqual(applyEditLiteral("a X b", "X", "Y", false, "/a"), {
      content: "a Y b",
      replacements: 1,
    });
  });

  it("不一致はエラー", () => {
    assert.throws(
      () => applyEditLiteral("abc", "X", "Y", false, "/a"),
      /old_string was not found in "\/a"/,
    );
  });

  it("replace_all 無しの複数一致はエラー", () => {
    assert.throws(
      () => applyEditLiteral("X X", "X", "Y", false, "/a"),
      /old_string matched 2 times in "\/a"; provide a more specific old_string or set replace_all to true/,
    );
  });

  it("replace_all ありは全置換する", () => {
    assert.deepEqual(applyEditLiteral("X X X", "X", "Y", true, "/a"), {
      content: "Y Y Y",
      replacements: 3,
    });
  });

  it("空の old_string はエラー", () => {
    assert.throws(
      () => applyEditLiteral("a", "", "Y", false, "/a"),
      /old_string must be a non-empty string/,
    );
  });

  it("CRLF は LF に正規化してマッチする", () => {
    assert.deepEqual(applyEditLiteral("a\r\nb\r\n", "a\nb", "X", false, "/a"), {
      content: "X\n",
      replacements: 1,
    });
  });
});

describe("§2.1 画像の形式判定", () => {
  it("シグネチャで PNG/JPEG/GIF/WebP を判定する", () => {
    assert.equal(
      sniffImageMediaType(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])),
      "image/png",
    );
    assert.equal(sniffImageMediaType(Buffer.from([255, 216, 255, 224])), "image/jpeg");
    assert.equal(sniffImageMediaType(Buffer.from("GIF89a", "ascii")), "image/gif");
    const webp = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      Buffer.alloc(4),
      Buffer.from("WEBP", "ascii"),
    ]);
    assert.equal(sniffImageMediaType(webp), "image/webp");
  });

  it("非画像バイトは undefined", () => {
    assert.equal(sniffImageMediaType(Buffer.from("hello world!")), undefined);
  });
});

describe("§1 glob", () => {
  it("argv は --files + glob + 修正時刻降順ソート + hidden + VCS 除外", () => {
    const argv = buildGlobArgv("*.ts");
    assert.equal(argv[0], "--files");
    assert.equal(argv[1], "--glob=*.ts");
    assert.equal(argv.includes("--sortr=modified"), true);
    assert.equal(argv.includes("--no-ignore"), true);
    assert.equal(argv.includes("--hidden"), true);
    assert.equal(argv.includes("--glob=!**/.git/**"), true);
  });

  it("0 件は No files found", () => {
    assert.equal(renderGlobPaths([]), "No files found");
  });

  it("100 件を超えたら切り詰めて件数を伝える", () => {
    const paths = Array.from({ length: 150 }, (_, i) => `f${i}.ts`);
    const text = renderGlobPaths(paths);
    assert.equal(text.split("\n")[0], "f0.ts");
    assert.ok(text.includes("(Showing 100 of 150 paths."));
  });

  it("100 件ちょうどは切り詰めない", () => {
    const paths = Array.from({ length: 100 }, (_, i) => `f${i}.ts`);
    assert.equal(renderGlobPaths(paths).includes("Showing 100 of"), false);
  });
});

describe("§1 grep", () => {
  it("include はカンマ区切りリストを拒否する", () => {
    assert.throws(
      () => validateGrepInclude("*.ts,*.js"),
      /include must be one glob, not a comma-separated list/,
    );
  });

  it("include は否定を拒否する", () => {
    assert.throws(() => validateGrepInclude("!*.ts"), /negated patterns/);
  });

  it("ブレース内のカンマは許可する", () => {
    validateGrepInclude("*.{ts,tsx}");
  });

  it("rg --json の match レコードをパースする", () => {
    const stdout = [
      JSON.stringify({ type: "begin", data: { path: { text: "a.ts" } } }),
      JSON.stringify({
        type: "match",
        data: { path: { text: "a.ts" }, line_number: 3, lines: { text: "let x = 1;\n" } },
      }),
      JSON.stringify({ type: "end", data: { path: { text: "a.ts" } } }),
    ].join("\n");
    assert.deepEqual(parseGrepMatches(stdout), [
      { path: "a.ts", lineNumber: 3, line: "let x = 1;" },
    ]);
  });

  it("preview は UTF-8 境界を保って切り詰める", () => {
    const line = "あ".repeat(1200); // 3600 bytes > 2000
    const preview = previewGrepLine(line);
    assert.ok(preview.endsWith(" (line truncated)"));
    const kept = Buffer.from(preview.replace(" (line truncated)", ""), "utf8");
    assert.ok(kept.byteLength <= GREP_MAX_LINE_BYTES);
  });

  it("250 件を超えたら保持数と総数を報告する", () => {
    const matches = Array.from({ length: 300 }, (_, i) => ({
      path: "a.ts",
      lineNumber: i + 1,
      line: `x${i}`,
    }));
    const retained = retainGrepMatches(matches);
    assert.equal(retained.truncated, true);
    assert.equal(retained.kept, 250);
    assert.equal(retained.seen, 300);
    const text = formatGrepOutput(retained);
    assert.ok(text.startsWith("Found 250 of 300 matches"));
    assert.ok(text.includes("The complete result could not be saved"));
  });

  it("ファイルごとに Line N: <preview> 形式でグループ化する", () => {
    const retained = retainGrepMatches([
      { path: "a.ts", lineNumber: 1, line: "one" },
      { path: "a.ts", lineNumber: 5, line: "two" },
      { path: "b.ts", lineNumber: 2, line: "three" },
    ]);
    const text = formatGrepOutput(retained);
    assert.ok(text.startsWith("Found 3 matches"));
    assert.ok(text.includes("a.ts\nLine 1: one\nLine 5: two\n\nb.ts\nLine 2: three"));
  });
});

describe("§1 ls の出力", () => {
  it("空ディレクトリは (empty directory)", () => {
    assert.equal(buildLsOutput([], 500), "(empty directory)");
  });

  it("limit 超過はエントリ数の注記を付ける", () => {
    const entries = Array.from({ length: 600 }, (_, i) => `e${i}`);
    const text = buildLsOutput(entries, 500);
    assert.ok(text.includes("[500 entries limit reached. Use limit=1000 for more]"));
  });

  it("50KB 超過はサイズの注記を付け、行境界で切る", () => {
    const entries = Array.from({ length: 499 }, () => "x".repeat(200));
    const text = buildLsOutput(entries, 500);
    assert.ok(text.includes("50.0KB limit reached"));
    assert.ok(Buffer.byteLength(text, "utf8") <= LS_MAX_BYTES + 64);
    assert.ok(text.endsWith("]"));
  });
});

describe("§4 bash 出力の合計キャップ", () => {
  it("stdout を優先し stderr に残りを配分する", () => {
    const stdout = Buffer.alloc(60000, "a");
    const stderr = Buffer.alloc(10000, "b");
    const capped = capBashStreams(stdout, stderr, BASH_MAX_OUTPUT_BYTES);
    assert.equal(capped.stdout.byteLength, 60000);
    assert.equal(capped.stderr.byteLength, 4000);
    assert.equal(capped.truncated, true);
  });

  it("合計が上限内なら切り詰めない", () => {
    const capped = capBashStreams(Buffer.from("ok"), Buffer.from("err"), BASH_MAX_OUTPUT_BYTES);
    assert.equal(capped.truncated, false);
    assert.equal(capped.stderr.toString(), "err");
  });
});
