import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Sandbox } from "./sandbox";

const runToolsPath = join(dirname(fileURLToPath(import.meta.url)), "run-tools.ts");
const piPackageDir = resolve(
  dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
  "..",
);

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

function runToolsCli(toolName: string, request: unknown) {
  return spawnSync("bun", [runToolsPath, toolName], {
    input: JSON.stringify(request),
    encoding: "utf8",
    env: { ...process.env, GUARDRAILS_PI_PACKAGE_DIR: piPackageDir },
  });
}

function withTempDir(test: (dir: string) => Promise<void> | void): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "run-tools-test-"));
    try {
      await test(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe("run-tools CLI", () => {
  it(
    "read はファイル内容を ok:true の result で返す",
    withTempDir(async (dir) => {
      writeFileSync(join(dir, "note.txt"), "hello guardrails");
      const cliResult = runToolsCli("read", { params: { path: join(dir, "note.txt") } });
      const response = JSON.parse(cliResult.stdout) as {
        ok: boolean;
        result: { content: { type: string; text: string }[] };
      };
      assert.equal(response.ok, true);
      assert.equal(response.result.content[0].text, "hello guardrails");
    }),
  );

  it(
    "read の失敗は ok:false と非 0 exit code で返す",
    withTempDir(async (dir) => {
      const cliResult = runToolsCli("read", { params: { path: join(dir, "missing.txt") } });
      const response = JSON.parse(cliResult.stdout) as { ok: boolean; error: string };
      assert.equal(response.ok, false);
      assert.equal(cliResult.status !== 0, true);
    }),
  );

  it(
    "edit は oldText/newText 置換を sandbox 内の定義に委譲してファイルを更新する",
    withTempDir(async (dir) => {
      const targetFile = join(dir, "config.yml");
      writeFileSync(targetFile, "name: before\n");
      const cliResult = runToolsCli("edit", {
        params: { path: targetFile, edits: [{ oldText: "before", newText: "after" }] },
      });
      const response = JSON.parse(cliResult.stdout) as { ok: boolean };
      assert.equal(response.ok, true);
      assert.equal(readFileSync(targetFile, "utf8"), "name: after\n");
    }),
  );

  it(
    "write はファイルを作成して ok:true を返す",
    withTempDir(async (dir) => {
      const targetFile = join(dir, "created.txt");
      const cliResult = runToolsCli("write", {
        params: { path: targetFile, content: "written by cli" },
      });
      const response = JSON.parse(cliResult.stdout) as { ok: boolean };
      assert.equal(response.ok, true);
      assert.equal(readFileSync(targetFile, "utf8"), "written by cli");
    }),
  );

  it(
    "grep は pi 標準 definition 経由でマッチ行を返す",
    withTempDir(async (dir) => {
      writeFileSync(join(dir, "note.txt"), "needle here\nnothing\n");
      const cliResult = runToolsCli("grep", { params: { pattern: "needle", path: dir } });
      const response = JSON.parse(cliResult.stdout) as {
        ok: boolean;
        result: { content: { type: string; text: string }[] };
      };
      assert.equal(response.ok, true);
      assert.match(response.result.content[0].text, /note\.txt:1: needle here/);
    }),
  );

  it(
    "find は glob パターンに一致するファイルを返す",
    withTempDir(async (dir) => {
      writeFileSync(join(dir, "target.txt"), "");
      const cliResult = runToolsCli("find", { params: { pattern: "*.txt", path: dir } });
      const response = JSON.parse(cliResult.stdout) as {
        ok: boolean;
        result: { content: { type: string; text: string }[] };
      };
      assert.equal(response.ok, true);
      assert.match(response.result.content[0].text, /target\.txt/);
    }),
  );

  it(
    "ls はディレクトリエントリ一覧を返す",
    withTempDir(async (dir) => {
      writeFileSync(join(dir, "entry.txt"), "");
      const cliResult = runToolsCli("ls", { params: { path: dir } });
      const response = JSON.parse(cliResult.stdout) as {
        ok: boolean;
        result: { content: { type: string; text: string }[] };
      };
      assert.equal(response.ok, true);
      assert.match(response.result.content[0].text, /entry\.txt/);
    }),
  );

  it("未知のツール名は ok:false でエラーを返す", () => {
    const cliResult = runToolsCli("unknown-tool", { params: {} });
    const response = JSON.parse(cliResult.stdout) as { ok: boolean; error: string };
    assert.equal(response.ok, false);
    assert.match(response.error, /Unknown tool/);
  });

  it(
    "bash は session 情報から PI_SESSION_ID 環境変数を公開する",
    withTempDir(async (_dir) => {
      const cliResult = runToolsCli("bash", {
        params: { command: "echo session=$PI_SESSION_ID" },
        session: { sessionId: "test-session-42" },
      });
      const response = JSON.parse(cliResult.stdout) as {
        ok: boolean;
        result: { content: { type: string; text: string }[] };
      };
      assert.equal(response.ok, true);
      assert.match(response.result.content[0].text, /session=test-session-42/);
    }),
  );
});

describe("Sandbox.runTool（bwrap 統合）", () => {
  it(
    "bwrap 内で write → read のラウンドトリップができる",
    withTempDir(async (dir) => {
      // Nested user namespaces (e.g. agent bash already inside guardrails bwrap)
      // cannot create uid maps; probe with a real invocation instead of --version.
      const bwrapProbe = spawnSync("bwrap", ["--", "true"], { encoding: "utf8" });
      if (bwrapProbe.status !== 0) {
        console.log("bwrap unusable in this environment, skipping bwrap integration test");
        return;
      }
      const configPath = join(dir, "config.yaml");
      writeFileSync(configPath, `read:\n  allow: ["${dir}"]\nwrite:\n  allow: ["${dir}"]\n`);
      const sandbox = new Sandbox(dir, configPath);
      await sandbox.runTool(
        "write",
        { path: "hello.txt", content: "through bwrap" },
        { mode: "fs" },
      );
      const readResult = (await sandbox.runTool("read", { path: "hello.txt" }, { mode: "fs" })) as {
        content: { type: string; text: string }[];
      };
      assert.equal(readResult.content[0].text, "through bwrap");
    }),
  );
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
