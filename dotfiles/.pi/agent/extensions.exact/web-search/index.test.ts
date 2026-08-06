// 実行: bun --install=auto run index.test.ts

import assert from "node:assert/strict";
import webSearchExtension, {
  __backendFailures,
  __resetBackendFailures,
  BACKEND_COOLDOWN_MS,
  defaultFetchBackends,
  defaultSearchBackends,
  fetchOne,
  fetchResultLine,
  isAvailable,
  markFailed,
  pageTitle,
  searchOne,
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
  return [name, async () => {
    throw new Error(message);
  }];
}

function capture(notifications: string[]): (message: string) => void {
  return (message) => notifications.push(message);
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
    const notifications: string[] = [];
    const backends = [failBackend("A"), failBackend("B"), okBackend("C"), okBackend("D")];
    const result = await searchOne("query", undefined, capture(notifications), backends);
    assert.equal(result.backend, "C");
    assert.deepEqual(notifications, ["A: A error", "B: B error"]);
  });

  it("失敗バックエンドのエラー文は本文に含まず、UI 通知だけに含む", async () => {
    __resetBackendFailures();
    const notifications: string[] = [];
    const backends = [failBackend("A", "致命的エラー文"), okBackend("B", "成功本文")];
    const result = await searchOne("query", undefined, capture(notifications), backends);
    assert.equal(result.text, "成功本文");
    assert.ok(!result.text.includes("致命的エラー文"));
    assert.ok(notifications.some((message) => message.includes("致命的エラー文")));
  });

  it("全バックエンドが失敗したら例外を出す", async () => {
    __resetBackendFailures();
    const backends = [failBackend("A"), failBackend("B")];
    await assert.rejects(
      searchOne("query", undefined, () => {}, backends),
      /All web search backends failed/,
    );
  });

  it("成功バックエンドの本文をそのまま返す", async () => {
    __resetBackendFailures();
    const expectedText = "そのまま渡される本文";
    const backends = [okBackend("A", expectedText)];
    const result = await searchOne("query", undefined, () => {}, backends);
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
  it("パラメータは query のみで、複数一括クエリはサポートしない", () => {
    const parameterKeys = Object.keys(search.parameters.properties);
    assert.deepEqual(parameterKeys, ["query"]);
  });

  it("検索結果は5件出力する", async () => {
    __resetBackendFailures();
    const resultText = textOf(await callSearch("pi coding agent"));
    const headings = resultText.match(/^#{2,3} \d+\./gm) ?? [];
    assert.equal(headings.length, 5);
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

  it("コール行は backend 確定前に 'web_search' を出す", () => {
    const context = { state: {}, args: { query: "pi coding agent" }, invalidate: () => {} };
    const lines = search.renderCall({ query: "pi coding agent" }, identityTheme, context).render(80);
    assert.equal(lines[0].trim(), "web_search");
  });

  it("コール行は backend 確定後に 'web_search - <backend>' を出す", () => {
    const context = { state: { backend: "openserp(google)" }, args: { query: "pi coding agent" }, invalidate: () => {} };
    const lines = search.renderCall({ query: "pi coding agent" }, identityTheme, context).render(80);
    assert.equal(lines[0].trim(), "web_search - openserp(google)");
  });

  it("結果行は query をそのまま出す", () => {
    const query = "pi coding agent";
    const result = { content: [{ type: "text", text: "結果本文" }], details: { backend: "openserp(google)" } };
    const context = { state: {}, args: { query }, invalidate: () => {} };
    const lines = search.renderResult(result, {}, identityTheme, context).render(80);
    assert.equal(lines[0].trim(), query);
  });
});

describe("web_fetch 単体（fetchOne・モックバックエンド）", () => {
  it("失敗バックエンドを順に飛ばし、最初の成功バックエンドで本文とその名前を返す", async () => {
    const notifications: string[] = [];
    const backends = [failBackend("A"), failBackend("B"), okBackend("C"), okBackend("D")];
    const result = await fetchOne("https://example.com/", undefined, capture(notifications), backends);
    assert.equal(result.backend, "C");
    assert.deepEqual(notifications, ["A: A error", "B: B error"]);
  });

  it("失敗フェッチャーのエラー文は本文に含まず、UI 通知だけに含む", async () => {
    const notifications: string[] = [];
    const backends = [failBackend("A", "致命的エラー文"), okBackend("B", "成功本文")];
    const result = await fetchOne("https://example.com/", undefined, capture(notifications), backends);
    assert.equal(result.text, "成功本文");
    assert.ok(!result.text.includes("致命的エラー文"));
    assert.ok(notifications.some((message) => message.includes("致命的エラー文")));
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

describe("web_fetch 出力", () => {
  it("fetchResultLine は title があるとき 'url - title' を返す", () => {
    assert.equal(fetchResultLine("Title", "https://example.com/"), "https://example.com/ - Title");
  });

  it("fetchResultLine は title がないとき url のみを返す", () => {
    assert.equal(fetchResultLine(null, "https://example.com/"), "https://example.com/");
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

describe("web_fetch 表示", () => {
  it("コール行は backend 確定前に 'web_fetch' を出す", () => {
    const context = { state: {}, args: { url: "https://example.com/" }, invalidate: () => {} };
    const lines = fetchTool.renderCall({ url: "https://example.com/" }, identityTheme, context).render(80);
    assert.equal(lines[0].trim(), "web_fetch");
  });

  it("コール行は backend 確定後に 'web_fetch - <backend>' を出す", () => {
    const context = { state: { backend: "trafilatura" }, args: { url: "https://example.com/" }, invalidate: () => {} };
    const lines = fetchTool.renderCall({ url: "https://example.com/" }, identityTheme, context).render(80);
    assert.equal(lines[0].trim(), "web_fetch - trafilatura");
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
