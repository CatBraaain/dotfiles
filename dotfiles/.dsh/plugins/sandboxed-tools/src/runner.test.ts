// Direct tests for the in-sandbox runner's request dispatch (no bwrap
// involved): every tool's IO behavior against tmp fixtures, including the
// §2.4 observed-mtime gate and the §4 bash timeout marker. The bwrap spawn
// itself (Sandbox.runTool) is environment-dependent and stays out of unit
// tests.

import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeRequest } from "./runner";
import { BASH_MAX_OUTPUT_BYTES } from "./io-core";

let fixtureRoot: string | undefined;
const PNG_BYTES = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
const GIF_BYTES = Buffer.from("GIF89a\x01\x00\x01\x00", "binary");

function withFixture(
  build: (dir: string) => void,
  test: (dir: string) => Promise<void> | void,
): () => Promise<void> {
  return async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "sandboxed-tools-runner-"));
    try {
      build(fixtureRoot);
      await test(fixtureRoot);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  };
}

function rgPathFromPackage(): string | undefined {
  // The plugin's own dependency tree carries the platform binary; resolve it
  // the same way the host plugin does (index.ts).
  try {
    const rg = require("@vscode/ripgrep") as { rgPath: string };
    return rg.rgPath;
  } catch {
    return undefined;
  }
}

describe("runner read", () => {
  it(
    "行番号付きウィンドウと mtime を返す",
    withFixture(
      (dir) => writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n"),
      async (dir) => {
        const result = (await executeRequest({
          tool: "read",
          params: { file_path: join(dir, "a.txt"), offset: 2, limit: 1 },
        })) as { lines: { number: number; text: string }[]; totalLines: number; mtimeMs: number };
        assert.deepEqual(result.lines, [{ number: 2, text: "two" }]);
        assert.equal(result.totalLines, 3);
        assert.equal(typeof result.mtimeMs, "number");
      },
    ),
  );

  it(
    "画像シグネチャの read は画像バイトと media type を返す",
    withFixture(
      (dir) => writeFileSync(join(dir, "image"), PNG_BYTES),
      async (dir) => {
        const result = (await executeRequest({
          tool: "read",
          params: { file_path: join(dir, "image"), offset: 10, limit: 2001 },
        })) as { dataBase64: string; mediaType: string };
        assert.equal(result.mediaType, "image/png");
        assert.equal(Buffer.from(result.dataBase64, "base64").equals(PNG_BYTES), true);
      },
    ),
  );

  it(
    "シグネチャを拡張子より優先して media type を判定する",
    withFixture(
      (dir) => writeFileSync(join(dir, "mislabeled.png"), GIF_BYTES),
      async (dir) => {
        const result = (await executeRequest({
          tool: "read",
          params: { file_path: join(dir, "mislabeled.png") },
        })) as { dataBase64: string; mediaType: string };
        assert.equal(result.mediaType, "image/gif");
      },
    ),
  );

  it(
    "対応拡張子でもシグネチャ非対応の read はテキストを返す",
    withFixture(
      (dir) => writeFileSync(join(dir, "plain.png"), "one\ntwo\n"),
      async (dir) => {
        const result = (await executeRequest({
          tool: "read",
          params: { file_path: join(dir, "plain.png") },
        })) as { lines: { number: number; text: string }[]; totalLines: number };
        assert.deepEqual(result.lines, [
          { number: 1, text: "one" },
          { number: 2, text: "two" },
        ]);
      },
    ),
  );

  it(
    "シグネチャ非対応の read は従来どおり行番号付きテキストを返す",
    withFixture(
      (dir) => writeFileSync(join(dir, "plain"), "one\ntwo\n"),
      async (dir) => {
        const result = (await executeRequest({
          tool: "read",
          params: { file_path: join(dir, "plain"), offset: 2, limit: 1 },
        })) as { lines: { number: number; text: string }[]; totalLines: number };
        assert.deepEqual(result.lines, [{ number: 2, text: "two" }]);
        assert.equal(result.totalLines, 2);
      },
    ),
  );

  it(
    "不在ファイルはエラー",
    withFixture(
      () => {},
      async (dir) => {
        await assert.rejects(
          executeRequest({ tool: "read", params: { file_path: join(dir, "missing.txt") } }),
          /not found/,
        );
      },
    ),
  );

  it(
    "limit > 2000 はエラー",
    withFixture(
      (dir) => writeFileSync(join(dir, "a.txt"), "x"),
      async (dir) => {
        await assert.rejects(
          executeRequest({ tool: "read", params: { file_path: join(dir, "a.txt"), limit: 2001 } }),
          /limit must be less than or equal to 2000/,
        );
      },
    ),
  );
});

describe("runner write（§2.4）", () => {
  it(
    "新規ファイルは親ディレクトリを作成して書く",
    withFixture(
      () => {},
      async (dir) => {
        const target = join(dir, "sub", "new.txt");
        const result = (await executeRequest({
          tool: "write",
          params: { file_path: target, content: "hello" },
        })) as { operation: string };
        assert.equal(result.operation, "create");
        assert.equal(readFileSync(target, "utf8"), "hello");
      },
    ),
  );

  it(
    "既存ファイルは observedMtimeMs が無いと拒否",
    withFixture(
      (dir) => writeFileSync(join(dir, "a.txt"), "old"),
      async (dir) => {
        await assert.rejects(
          executeRequest({
            tool: "write",
            params: { file_path: join(dir, "a.txt"), content: "new" },
          }),
          /file has not been read — read the file, then retry/,
        );
      },
    ),
  );

  it(
    "既存ファイルは mtime が変わっていると拒否",
    withFixture(
      (dir) => writeFileSync(join(dir, "a.txt"), "old"),
      async (dir) => {
        await assert.rejects(
          executeRequest({
            tool: "write",
            params: { file_path: join(dir, "a.txt"), content: "new" },
            options: { observedMtimeMs: 1 },
          }),
          /file has changed since it was last read/,
        );
      },
    ),
  );

  it(
    "mtime が一致すれば更新する",
    withFixture(
      (dir) => writeFileSync(join(dir, "a.txt"), "old"),
      async (dir) => {
        const read = (await executeRequest({
          tool: "read",
          params: { file_path: join(dir, "a.txt") },
        })) as { mtimeMs: number };
        const result = (await executeRequest({
          tool: "write",
          params: { file_path: join(dir, "a.txt"), content: "new" },
          options: { observedMtimeMs: read.mtimeMs },
        })) as { operation: string };
        assert.equal(result.operation, "update");
        assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "new");
      },
    ),
  );
});

describe("runner edit（§2.4）", () => {
  it(
    "未読み（observedMtimeMs 無し）は拒否",
    withFixture(
      (dir) => writeFileSync(join(dir, "a.txt"), "x"),
      async (dir) => {
        await assert.rejects(
          executeRequest({
            tool: "edit",
            params: { file_path: join(dir, "a.txt"), old_string: "x", new_string: "y" },
          }),
          /file has not been read/,
        );
      },
    ),
  );

  it(
    "observed 一致で置換し mtime を更新する",
    withFixture(
      (dir) => writeFileSync(join(dir, "a.txt"), "foo bar foo"),
      async (dir) => {
        const read = (await executeRequest({
          tool: "read",
          params: { file_path: join(dir, "a.txt") },
        })) as { mtimeMs: number };
        const result = (await executeRequest({
          tool: "edit",
          params: { file_path: join(dir, "a.txt"), old_string: "bar", new_string: "BAZ" },
          options: { observedMtimeMs: read.mtimeMs },
        })) as { replacements: number };
        assert.equal(result.replacements, 1);
        assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "foo BAZ foo");
      },
    ),
  );

  it(
    "read 後に別の書き込みが入ると stale で拒否",
    withFixture(
      (dir) => writeFileSync(join(dir, "a.txt"), "v1"),
      async (dir) => {
        const read = (await executeRequest({
          tool: "read",
          params: { file_path: join(dir, "a.txt") },
        })) as { mtimeMs: number };
        // Force a different mtime: rewriting within the same millisecond as
        // the read would compare equal, so set an explicit future timestamp
        // (no rewrite — the content change itself is not what we assert).
        const future = new Date(Date.now() + 10000);
        utimesSync(join(dir, "a.txt"), future, future);
        await assert.rejects(
          executeRequest({
            tool: "edit",
            params: { file_path: join(dir, "a.txt"), old_string: "v2-changed", new_string: "v3" },
            options: { observedMtimeMs: read.mtimeMs },
          }),
          /file has changed since it was last read/,
        );
      },
    ),
  );
});

describe("runner ls", () => {
  it(
    "dotfile を含み大文字小文字無視でソートしディレクトリに / を付ける",
    withFixture(
      (dir) => {
        mkdirSync(join(dir, "Beta"));
        writeFileSync(join(dir, "alpha.txt"), "x");
        writeFileSync(join(dir, ".hidden"), "x");
      },
      async (dir) => {
        const result = (await executeRequest({
          tool: "ls",
          params: { path: dir },
        })) as { text: string };
        assert.equal(result.text, ".hidden\nalpha.txt\nBeta/");
      },
    ),
  );

  it(
    "空ディレクトリは (empty directory)",
    withFixture(
      (dir) => mkdirSync(join(dir, "empty")),
      async (dir) => {
        const result = (await executeRequest({
          tool: "ls",
          params: { path: join(dir, "empty") },
        })) as { text: string };
        assert.equal(result.text, "(empty directory)");
      },
    ),
  );
});

describe("runner glob / grep（rg 経由）", () => {
  const rgPath = rgPathFromPackage();

  it(
    "glob は検索基準ディレクトリからの相対パスを返す",
    withFixture(
      (dir) => {
        mkdirSync(join(dir, "src"));
        writeFileSync(join(dir, "src", "a.ts"), "x");
        writeFileSync(join(dir, "b.md"), "y");
      },
      async (dir) => {
        if (rgPath === undefined) return;
        const result = (await executeRequest({
          tool: "glob",
          params: { pattern: "**/*.ts", path: dir },
          options: { rgPath },
        })) as { paths: string[] };
        assert.deepEqual(result.paths, ["src/a.ts"]);
      },
    ),
  );

  it(
    "glob は / を含まない pattern で任意の深度の basename に一致する",
    withFixture(
      (dir) => {
        mkdirSync(join(dir, "nested", "deep"), { recursive: true });
        writeFileSync(join(dir, "a.md"), "x");
        writeFileSync(join(dir, "nested", "b.md"), "x");
        writeFileSync(join(dir, "nested", "deep", "c.md"), "x");
        writeFileSync(join(dir, "a.txt"), "x");
      },
      async (dir) => {
        if (rgPath === undefined) return;
        const result = (await executeRequest({
          tool: "glob",
          params: { pattern: "*.md", path: dir },
          options: { rgPath },
        })) as { paths: string[] };
        assert.deepEqual(result.paths.sort(), ["a.md", "nested/b.md", "nested/deep/c.md"]);
      },
    ),
  );

  it(
    "grep は Line N 形式のマッチを検索基準ディレクトリ相対で返す",
    withFixture(
      (dir) => {
        mkdirSync(join(dir, "src"));
        writeFileSync(join(dir, "src", "a.ts"), "const needle = 1;\n");
        writeFileSync(join(dir, "src", "b.ts"), "nothing\n");
      },
      async (dir) => {
        if (rgPath === undefined) return;
        const result = (await executeRequest({
          tool: "grep",
          params: { pattern: "needle", path: join(dir, "src") },
          options: { rgPath },
        })) as { matches: { path: string; lineNumber: number; line: string }[] };
        assert.deepEqual(result.matches, [
          { path: "a.ts", lineNumber: 1, line: "const needle = 1;" },
        ]);
      },
    ),
  );

  it(
    "grep の include 検証（カンマ区切り拒否）は rg 前に行われる",
    withFixture(
      (dir) => writeFileSync(join(dir, "a.ts"), "needle"),
      async (dir) => {
        await assert.rejects(
          executeRequest({
            tool: "grep",
            params: { pattern: "needle", path: dir, include: "*.ts,*.js" },
            options: { rgPath },
          }),
          /include must be one glob/,
        );
      },
    ),
  );
});

describe("runner bash（§4）", () => {
  it(
    "stdout・非ゼロ終了マーカー情報を返す",
    withFixture(
      () => {},
      async (dir) => {
        const result = (await executeRequest({
          tool: "bash",
          params: { command: "echo out; echo err >&2; exit 3", workdir: dir },
        })) as {
          stdout: { text: string; truncated: boolean };
          stderr: { text: string };
          exitCode: number | null;
          timedOut: boolean;
          timeoutMs: number;
        };
        assert.equal(result.stdout.text.trim(), "out");
        assert.equal(result.stderr.text.trim(), "err");
        assert.equal(result.exitCode, 3);
        assert.equal(result.timedOut, false);
        assert.equal(result.timeoutMs, 120000);
      },
    ),
  );

  it(
    "timeoutMs 後に kill され timedOut を報告する",
    withFixture(
      () => {},
      async (dir) => {
        const result = (await executeRequest({
          tool: "bash",
          params: { command: "sleep 5", workdir: dir, timeoutMs: 200 },
        })) as { timedOut: boolean; timeoutMs: number };
        assert.equal(result.timedOut, true);
        assert.equal(result.timeoutMs, 200);
      },
    ),
  );

  it(
    "timeoutMs は 600000 に上限クランプされる",
    withFixture(
      () => {},
      async (dir) => {
        const result = (await executeRequest({
          tool: "bash",
          params: { command: "true", workdir: dir, timeoutMs: 999999 },
        })) as { timeoutMs: number };
        assert.equal(result.timeoutMs, 600000);
      },
    ),
  );

  it(
    "64000 バイト超過で切り詰め、spill ファイルに全出力を書く",
    withFixture(
      () => {},
      async (dir) => {
        const spillDir = join(dir, "spill");
        const big = "x".repeat(70000);
        const result = (await executeRequest({
          tool: "bash",
          params: { command: `printf %s ${JSON.stringify(big)}`, workdir: dir },
          options: { spillDir, callId: "call-1" },
        })) as {
          stdout: { text: string; truncated: boolean; spillPath?: string };
        };
        assert.equal(result.stdout.truncated, true);
        assert.equal(result.stdout.text.length, BASH_MAX_OUTPUT_BYTES);
        assert.equal(result.stdout.spillPath, join(spillDir, "call-1-stdout.txt"));
        assert.equal(readFileSync(result.stdout.spillPath as string, "utf8").length, 70000);
      },
    ),
  );
});
