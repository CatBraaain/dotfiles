// 実行: bun --install=auto run index.test.ts

import assert from "node:assert/strict";
import webSearchExtension, {
  __backendFailures,
  __resetBackendFailures,
  BACKEND_COOLDOWN_MS,
  BACKEND_TIMEOUT_MS,
  defaultFetchBackends,
  defaultSearchBackends,
  fetchOne,
  formatBackendLine,
  formatBackendLines,
  isAvailable,
  markFailed,
  openserpError,
  pageTitle,
  SEARCH_RESULT_LIMIT,
  searchOne,
  type Attempt,
  type BackendEntry,
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

type Tool = {
  name: string;
  parameters: { properties: Record<string, unknown> };
  execute: (...args: any[]) => Promise<unknown>;
  renderCall: (...args: any[]) => { render(width: number): string[] };
  renderResult: (...args: any[]) => { render(width: number): string[] };
};

function captureTools(): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  webSearchExtension({ registerTool: (tool: Tool) => tools.set(tool.name, tool) } as never);
  return tools;
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return content.find((item) => item.type === "text")?.text ?? "";
}

function okBackend(name: string, text = `text from ${name}`): BackendEntry {
  return [name, async () => text];
}

function failBackend(name: string, message = `${name} error`): BackendEntry {
  return [
    name,
    async () => {
      throw new Error(message);
    },
  ];
}

function renderedLines(component: { render(width: number): string[] }): string[] {
  return component.render(80).map((line) => line.trim());
}

const identityTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

const tools = captureTools();
const search = tools.get("web_search")!;
const fetchTool = tools.get("web_fetch")!;

const executionContext = { hasUI: true, ui: { notify: () => {} } };

async function callSearch(
  query: string,
  signal: AbortSignal = AbortSignal.timeout(30_000),
): Promise<unknown> {
  return search.execute("call", { query }, signal, undefined, executionContext);
}

async function callFetch(
  url: string,
  signal: AbortSignal = AbortSignal.timeout(30_000),
): Promise<unknown> {
  return fetchTool.execute("call", { url }, signal, undefined, executionContext);
}

describe("web_search 単体（searchOne・モックバックエンド）", () => {
  it("失敗バックエンドを順に飛ばし、最初の成功バックエンドで本文とその名前を返す", async () => {
    __resetBackendFailures();
    const backends = [failBackend("A"), failBackend("B"), okBackend("C"), okBackend("D")];
    const result = await searchOne("query", undefined, backends);
    assert.equal(result.backend, "C");
    assert.equal(result.text, "text from C");
  });

  it("試行ごとの成否を attempts に記録し、最後は成功バックエンドになる", async () => {
    __resetBackendFailures();
    const backends = [failBackend("A"), failBackend("B"), okBackend("C")];
    const result = await searchOne("query", undefined, backends);
    assert.deepEqual(result.attempts, [
      { backend: "A", ok: false, error: "A error" },
      { backend: "B", ok: false, error: "B error" },
      { backend: "C", ok: true },
    ]);
  });

  it("失敗バックエンドのエラー文は本文に含まず、attempts だけに含む", async () => {
    __resetBackendFailures();
    const backends = [failBackend("A", "致命的エラー文"), okBackend("B", "成功本文")];
    const result = await searchOne("query", undefined, backends);
    assert.equal(result.text, "成功本文");
    assert.ok(!result.text.includes("致命的エラー文"));
    assert.ok(
      result.attempts.some((attempt) => !attempt.ok && attempt.error.includes("致命的エラー文")),
    );
  });

  it("全バックエンドが失敗したら例外を出す", async () => {
    __resetBackendFailures();
    const backends = [failBackend("A"), failBackend("B")];
    await assert.rejects(searchOne("query", undefined, backends), /All web search backends failed/);
  });

  it("成功バックエンドの本文をそのまま返す", async () => {
    __resetBackendFailures();
    const expectedText = "そのまま渡される本文";
    const backends = [okBackend("A", expectedText)];
    const result = await searchOne("query", undefined, backends);
    assert.equal(result.text, expectedText);
  });

  it("デフォルトのバックエンド順序は openserp(google)→duckduckgo→bing→markdown.new", () => {
    const backendNames = defaultSearchBackends("query").map(([name]) => name);
    assert.deepEqual(backendNames, [
      "openserp(google)",
      "openserp(duckduckgo)",
      "openserp(bing)",
      "markdown.new",
    ]);
  });
});

describe("web_search 統合（execute 経由・実バックエンド）", () => {
  it("パラメータは query と lang（任意）で、複数一括クエリはサポートしない", () => {
    const parameterKeys = Object.keys(search.parameters.properties);
    assert.deepEqual(parameterKeys, ["query", "lang"]);
  });

  it(`検索結果は${SEARCH_RESULT_LIMIT}件出力する`, async () => {
    __resetBackendFailures();
    const resultText = textOf(await callSearch("pi coding agent"));
    const headings = resultText.match(/^#{2,3} \d+\./gm) ?? [];
    assert.equal(headings.length, SEARCH_RESULT_LIMIT);
  });

  it("エラーを起こしたバックエンドは30分間スキップし、セッション内で共有される", () => {
    __resetBackendFailures();
    assert.equal(BACKEND_COOLDOWN_MS, 30 * 60 * 1000);

    markFailed("openserp(google)");
    assert.equal(isAvailable("openserp(google)"), false);
    assert.equal(isAvailable("openserp(duckduckgo)"), true);

    const expiredTimestamp = Date.now() - BACKEND_COOLDOWN_MS - 1;
    __backendFailures.set("openserp(google)", expiredTimestamp);
    assert.equal(isAvailable("openserp(google)"), true);
  });

  it("実バックエンドで検索が成功する", async () => {
    __resetBackendFailures();
    const resultText = textOf(await callSearch("hello world"));
    assert.ok(resultText.length > 0);
  });
});

describe("web_search 表示", () => {
  it("コール行は入力を添えて 'web_search - \"<query>\"' を出す", () => {
    const lines = renderedLines(search.renderCall({ query: "pi coding agent" }, identityTheme));
    assert.equal(lines[0], 'web_search - "pi coding agent"');
  });

  it("コール行は lang 指定時に [lang=<lang>] を付ける", () => {
    const lines = renderedLines(search.renderCall({ query: "pi", lang: "JA" }, identityTheme));
    assert.equal(lines[0], 'web_search - "pi" [lang=JA]');
  });

  it("結果行は試したバックエンドごとに ✓/✗ 行を出す", () => {
    const attempts: Attempt[] = [
      { backend: "openserp(google)", ok: false, error: "captcha detected" },
      { backend: "openserp(bing)", ok: true },
    ];
    const result = {
      content: [{ type: "text", text: "結果本文" }],
      details: { backend: "openserp(bing)", attempts },
    };
    const lines = renderedLines(search.renderResult(result));
    assert.deepEqual(lines, ['✗ openserp(google) - "captcha detected"', "✓ openserp(bing)"]);
  });
});

describe("web_fetch 単体（fetchOne・モックバックエンド）", () => {
  it("失敗バックエンドを順に飛ばし、最初の成功バックエンドで本文とその名前を返す", async () => {
    const backends = [failBackend("A"), failBackend("B"), okBackend("C"), okBackend("D")];
    const result = await fetchOne("https://example.com/", undefined, backends);
    assert.equal(result.backend, "C");
    assert.equal(result.text, "text from C");
  });

  it("試行ごとの成否を attempts に記録し、最後は成功バックエンドになる", async () => {
    const backends = [failBackend("A"), failBackend("B"), okBackend("C")];
    const result = await fetchOne("https://example.com/", undefined, backends);
    assert.deepEqual(result.attempts, [
      { backend: "A", ok: false, error: "A error" },
      { backend: "B", ok: false, error: "B error" },
      { backend: "C", ok: true },
    ]);
  });

  it("失敗フェッチャーのエラー文は本文に含まず、attempts だけに含む", async () => {
    const backends = [failBackend("A", "致命的エラー文"), okBackend("B", "成功本文")];
    const result = await fetchOne("https://example.com/", undefined, backends);
    assert.equal(result.text, "成功本文");
    assert.ok(!result.text.includes("致命的エラー文"));
    assert.ok(
      result.attempts.some((attempt) => !attempt.ok && attempt.error.includes("致命的エラー文")),
    );
  });

  it("web_fetch の失敗はクールダウンに入れない", async () => {
    __resetBackendFailures();
    const backends = [failBackend("X"), failBackend("Y")];
    await assert.rejects(
      fetchOne("https://example.com/", undefined, backends),
      /All web fetch backends failed/,
    );
    assert.equal(isAvailable("X"), true);
    assert.equal(isAvailable("Y"), true);
  });

  it("デフォルトのバックエンド順序は trafilatura→Jina Reader→md.dhr.wtf", () => {
    const backendNames = defaultFetchBackends("https://example.com/").map(([name]) => name);
    assert.deepEqual(backendNames, ["trafilatura", "Jina Reader", "md.dhr.wtf"]);
  });
});

describe("web_fetch 統合（execute 経由・実バックエンド）", () => {
  it("パラメータは url のみで、複数一括フェッチはサポートしない", () => {
    const parameterKeys = Object.keys(fetchTool.parameters.properties);
    assert.deepEqual(parameterKeys, ["url"]);
  });

  it("実バックエンドでフェッチが成功する", async () => {
    const resultText = textOf(await callFetch("https://example.com/"));
    assert.ok(resultText.length > 0);
  });
});

describe("バックエンド結果行のフォーマット", () => {
  it("成功（タイトルなし）は '✓ <バックエンド>' を返す", () => {
    assert.equal(formatBackendLine({ backend: "openserp(bing)", ok: true }), "✓ openserp(bing)");
  });

  it("成功（タイトルあり）は '✓ <バックエンド> - \"<タイトル>\"' を返す", () => {
    const line = formatBackendLine({ backend: "trafilatura", ok: true }, "Example");
    assert.equal(line, '✓ trafilatura - "Example"');
  });

  it("失敗はタイトルの有無に関わらず '✗ <バックエンド> - \"<エラー>\"' を返す", () => {
    const line = formatBackendLine(
      { backend: "openserp(google)", ok: false, error: "captcha detected" },
      "Example",
    );
    assert.equal(line, '✗ openserp(google) - "captcha detected"');
  });

  it("formatBackendLines は成功にだけタイトルを付け、失敗行には付けない", () => {
    const attempts: Attempt[] = [
      { backend: "openserp(google)", ok: false, error: "captcha detected" },
      { backend: "openserp(bing)", ok: true },
    ];
    assert.deepEqual(formatBackendLines(attempts, "成功タイトル"), [
      '✗ openserp(google) - "captcha detected"',
      '✓ openserp(bing) - "成功タイトル"',
    ]);
  });

  it("pageTitle は title 要素がある HTML からタイトルを取り出す", async () => {
    const htmlWithTitle = "<html><head><title>Example</title></head><body></body></html>";
    const title = await pageTitle("https://example.com/", undefined, async () => htmlWithTitle);
    assert.equal(title, "Example");
  });

  it("pageTitle は title 要素がない HTML で null を返す", async () => {
    const htmlWithoutTitle = "<html><body>no title</body></html>";
    const title = await pageTitle("https://example.com/", undefined, async () => htmlWithoutTitle);
    assert.equal(title, null);
  });
});

describe("openserp のエラー抽出", () => {
  it("stderr から Error: 行だけを取り出しプレフィックスを外す", () => {
    const openserpStderr = [
      'time="2026-08-08T13:41:14+09:00" level=warning msg="cannot read config"',
      '[2026-08-08 13:41:15][error][engine=google][query_hash=e43c51c2b000]["Page classified as captcha detected"]',
      "Error: google search: captcha detected",
    ].join("\n");
    const execFileError = {
      message: "Command failed: openserp search google chikawa",
      stderr: openserpStderr,
    };
    assert.equal(openserpError(execFileError).message, "google search: captcha detected");
  });

  it("Error: 行が複数あれば最後を使う", () => {
    const execFileError = { stderr: "Error: first attempt failed\nError: second attempt failed" };
    assert.equal(openserpError(execFileError).message, "second attempt failed");
  });

  it("Error: 行がなければ元のエラーメッセージにフォールバックする", () => {
    const timeoutError = new Error("Command failed: openserp timed out");
    assert.equal(openserpError(timeoutError).message, "Command failed: openserp timed out");
  });
});

describe("バックエンドタイムアウト", () => {
  it("1バックエンドあたりの最大待ち時間は15秒で全バックエンド一律", () => {
    assert.equal(BACKEND_TIMEOUT_MS, 15_000);
  });
});

describe("web_fetch 表示", () => {
  it("コール行は入力を添えて 'web_fetch - \"<url>\"' を出す", () => {
    const lines = renderedLines(
      fetchTool.renderCall({ url: "https://example.com/" }, identityTheme),
    );
    assert.equal(lines[0], 'web_fetch - "https://example.com/"');
  });

  it("結果行は成功バックエンドにだけタイトルを付ける", () => {
    const attempts: Attempt[] = [
      { backend: "trafilatura", ok: false, error: "timeout" },
      { backend: "Jina Reader", ok: true },
    ];
    const result = {
      content: [{ type: "text", text: "本文" }],
      details: { backend: "Jina Reader", attempts, title: "Example Page" },
    };
    const lines = renderedLines(fetchTool.renderResult(result));
    assert.deepEqual(lines, ['✗ trafilatura - "timeout"', '✓ Jina Reader - "Example Page"']);
  });

  it("結果行はタイトルがない成功バックエンドにはタイトルを付けない", () => {
    const attempts: Attempt[] = [{ backend: "Jina Reader", ok: true }];
    const result = {
      content: [{ type: "text", text: "本文" }],
      details: { backend: "Jina Reader", attempts, title: null },
    };
    const lines = renderedLines(fetchTool.renderResult(result));
    assert.deepEqual(lines, ["✓ Jina Reader"]);
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
