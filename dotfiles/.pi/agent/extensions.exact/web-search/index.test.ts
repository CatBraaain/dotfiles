import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import webSearchExtension, {
  browseCliDir,
  browseScript,
  formatSearchText,
  type WebCliDeps,
  type WebCliResult,
} from "./index";

type Tool = {
  name: string;
  parameters: { properties: Record<string, unknown> };
  execute: (...args: any[]) => Promise<unknown>;
  renderCall: (...args: any[]) => { render(width: number): string[] };
  renderResult: (...args: any[]) => { render(width: number): string[] };
};

function captureTools(deps?: WebCliDeps): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  webSearchExtension(
    {
      registerTool: (tool: Tool) => tools.set(tool.name, tool),
    } as never,
    deps,
  );
  return tools;
}

type RecordedCall = { command: string; args: string[] };

// Records what the tool spawned and replies with a canned CLI result. The
// BROWSE_CLI_DIR env keeps path resolution away from the real filesystem.
function fakeCli(output: { code?: number; stdout?: string; stderr?: string }) {
  const calls: RecordedCall[] = [];
  const runCli = async (command: string, args: readonly string[]): Promise<WebCliResult> => {
    calls.push({ command, args: [...args] });
    return { stdout: output.stdout ?? "", stderr: output.stderr ?? "", code: output.code ?? 0 };
  };
  return { calls, deps: { runCli, env: { BROWSE_CLI_DIR: "/nonexistent-test-cli" } } };
}

const searchJsonOutput = JSON.stringify({
  query: "pi coding agent",
  engine: "google",
  tookMs: 2100,
  results: [
    {
      rank: 1,
      title: "Pi",
      url: "https://example.com/1",
      display_url: "example.com",
      type: "organic",
      snippet: "snip",
    },
  ],
});

const fetchJsonOutput = JSON.stringify({
  url: "https://example.com/",
  backend: "camoufox+trafilatura",
  title: "Example",
  body: "# Example\n\nbody",
  tookMs: 1200,
});

const executionContext = { hasUI: true, ui: { notify: () => {} } };

function callSearch(tool: Tool, params: Record<string, string>): Promise<unknown> {
  return tool.execute("call", params, AbortSignal.timeout(5_000), undefined, executionContext);
}

function callFetch(tool: Tool, url: string): Promise<unknown> {
  return tool.execute("call", { url }, AbortSignal.timeout(5_000), undefined, executionContext);
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return content.find((item) => item.type === "text")?.text ?? "";
}

function detailsOf(result: unknown): Record<string, unknown> {
  return (result as { details: Record<string, unknown> }).details;
}

function renderedLines(component: { render(width: number): string[] }): string[] {
  return component.render(80).map((line) => line.trim());
}

const identityTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

describe("tool spawning", () => {
  it("spawns `browse search` with the query and --json via bun", async () => {
    const cli = fakeCli({ stdout: searchJsonOutput });
    const search = captureTools(cli.deps).get("web_search")!;

    await callSearch(search, { query: "pi coding agent" });

    assert.equal(cli.calls.length, 1);
    assert.equal(cli.calls[0]!.command, process.execPath);
    assert.deepEqual(cli.calls[0]!.args, [
      join("/nonexistent-test-cli", "browse"),
      "search",
      "pi coding agent",
      "--json",
    ]);
  });

  it("passes --lang when the search request has a language hint", async () => {
    const cli = fakeCli({ stdout: searchJsonOutput });
    const search = captureTools(cli.deps).get("web_search")!;

    await callSearch(search, { query: "pi", lang: "JA" });

    assert.deepEqual(cli.calls[0]!.args.slice(1), ["search", "pi", "--lang", "JA", "--json"]);
  });

  it("omits --lang when no language hint is given", async () => {
    const cli = fakeCli({ stdout: searchJsonOutput });
    const search = captureTools(cli.deps).get("web_search")!;

    await callSearch(search, { query: "pi" });

    assert.ok(!cli.calls[0]!.args.includes("--lang"));
  });

  it("spawns `browse fetch` with the url and --json", async () => {
    const cli = fakeCli({ stdout: fetchJsonOutput });
    const fetchTool = captureTools(cli.deps).get("web_fetch")!;

    await callFetch(fetchTool, "https://example.com/");

    assert.equal(cli.calls.length, 1);
    assert.equal(cli.calls[0]!.command, process.execPath);
    assert.deepEqual(cli.calls[0]!.args, [
      join("/nonexistent-test-cli", "browse"),
      "fetch",
      "https://example.com/",
      "--json",
    ]);
  });
});

describe("stdout to tool result", () => {
  it("renders the search JSON as markdown text with engine and tookMs details", async () => {
    const cli = fakeCli({ stdout: searchJsonOutput });
    const search = captureTools(cli.deps).get("web_search")!;

    const result = await callSearch(search, { query: "pi coding agent" });

    assert.equal(
      textOf(result),
      '**Query:** "pi coding agent" - **Engines:** google - **Took:** 2.1s\n\n### 1. Pi\n\n**example.com** - organic\n\nsnip\n\n-> https://example.com/1',
    );
    assert.deepEqual(detailsOf(result), { engine: "google", tookMs: 2100 });
  });

  it("uses the fetch body as text with backend, title and tookMs details", async () => {
    const cli = fakeCli({ stdout: fetchJsonOutput });
    const fetchTool = captureTools(cli.deps).get("web_fetch")!;

    const result = await callFetch(fetchTool, "https://example.com/");

    assert.equal(textOf(result), "# Example\n\nbody");
    assert.deepEqual(detailsOf(result), {
      backend: "camoufox+trafilatura",
      title: "Example",
      tookMs: 1200,
    });
  });

  it("omits the title detail when the fetch JSON has no title", async () => {
    const output = JSON.stringify({
      url: "https://example.com/",
      backend: "Reddit",
      body: "markdown",
      tookMs: 500,
    });
    const cli = fakeCli({ stdout: output });
    const fetchTool = captureTools(cli.deps).get("web_fetch")!;

    const result = await callFetch(fetchTool, "https://example.com/");

    assert.deepEqual(detailsOf(result), { backend: "Reddit", tookMs: 500 });
  });

  it("keeps the schema: query required + lang optional, url required", () => {
    const tools = captureTools();
    assert.deepEqual(Object.keys(tools.get("web_search")!.parameters.properties), [
      "query",
      "lang",
    ]);
    assert.deepEqual(Object.keys(tools.get("web_fetch")!.parameters.properties), ["url"]);
  });
});

describe("CLI error propagation", () => {
  it("throws the CLI's stderr as the tool error and reports it via onUpdate", async () => {
    const stderr = "All web search backends failed: camoufox+openserp(google): boom";
    const cli = fakeCli({ code: 1, stderr });
    const search = captureTools(cli.deps).get("web_search")!;
    const updates: unknown[] = [];

    await assert.rejects(
      search.execute(
        "call",
        { query: "q" },
        AbortSignal.timeout(5_000),
        (update: unknown) => updates.push(update),
        executionContext,
      ),
      new Error(stderr),
    );
    assert.deepEqual(updates, [{ content: [], details: { error: stderr } }]);
  });

  it("falls back to an exit-code message when stderr is empty", async () => {
    const cli = fakeCli({ code: 1 });
    const fetchTool = captureTools(cli.deps).get("web_fetch")!;

    await assert.rejects(
      callFetch(fetchTool, "https://example.com/"),
      new Error("web-fetch exited with code 1"),
    );
  });

  it("rejects non-JSON stdout on success exit", async () => {
    const cli = fakeCli({ stdout: "not json" });
    const search = captureTools(cli.deps).get("web_search")!;

    await assert.rejects(
      callSearch(search, { query: "q" }),
      new Error("web-search: CLI stdout is not JSON"),
    );
  });

  it("wraps spawn failures with the CLI name", async () => {
    const runCli = async (): Promise<WebCliResult> => {
      throw new Error("spawn bun ENOENT");
    };
    const search = captureTools({ runCli, env: { BROWSE_CLI_DIR: "/nonexistent-test-cli" } }).get(
      "web_search",
    )!;

    await assert.rejects(
      callSearch(search, { query: "q" }),
      new Error("web-search: spawn bun ENOENT"),
    );
  });
});

describe("CLI path resolution", () => {
  it("resolves the script under BROWSE_CLI_DIR when set", () => {
    assert.equal(browseCliDir({ BROWSE_CLI_DIR: "/opt/cli" }), "/opt/cli");
    assert.equal(browseScript({ BROWSE_CLI_DIR: "/opt/cli" }), "/opt/cli/browse");
  });

  it("prefers the source-tree .executable suffix", () => {
    const dir = mkdtempSync(join(tmpdir(), "web-cli-"));
    try {
      writeFileSync(join(dir, "browse.executable"), "");
      assert.equal(browseScript({ BROWSE_CLI_DIR: dir }), join(dir, "browse.executable"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the plain deployed file name", () => {
    const dir = mkdtempSync(join(tmpdir(), "web-cli-"));
    try {
      writeFileSync(join(dir, "browse"), "");
      assert.equal(browseScript({ BROWSE_CLI_DIR: dir }), join(dir, "browse"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults to .agents/cli four levels above this extension", () => {
    const extensionDir = dirname(fileURLToPath(import.meta.url));
    assert.equal(browseCliDir({}), join(extensionDir, "..", "..", "..", "..", ".agents", "cli"));
  });
});

describe("formatSearchText", () => {
  const json = (overrides: Partial<Parameters<typeof formatSearchText>[0]> = {}) => ({
    query: "q",
    engine: "google",
    tookMs: 2100,
    results: [
      {
        title: "Pi",
        url: "https://example.com/1",
        display_url: "example.com",
        type: "organic",
        snippet: "snip",
      },
    ],
    ...overrides,
  });

  it("starts with the meta line quoting the query, engine and seconds", () => {
    assert.ok(
      formatSearchText(json()).startsWith('**Query:** "q" - **Engines:** google - **Took:** 2.1s'),
    );
  });

  it("renders each result as a numbered block with source, snippet and url lines", () => {
    const text = formatSearchText(json());
    assert.equal(
      text,
      '**Query:** "q" - **Engines:** google - **Took:** 2.1s\n\n' +
        "### 1. Pi\n\n**example.com** - organic\n\nsnip\n\n-> https://example.com/1",
    );
  });

  it("numbers result blocks sequentially", () => {
    const text = formatSearchText(
      json({
        results: [
          { title: "A", url: "https://a" },
          { title: "B", url: "https://b" },
        ],
      }),
    );
    assert.ok(text.includes("### 1. A"));
    assert.ok(text.includes("### 2. B"));
  });

  it("drops lines for missing fields and falls back title-first to the url, then (no title)", () => {
    const text = formatSearchText(json({ results: [{}, { url: "https://only-url" }] }));
    assert.equal(
      text,
      '**Query:** "q" - **Engines:** google - **Took:** 2.1s\n\n' +
        "### 1. (no title)\n\n" +
        "### 2. https://only-url\n\n-> https://only-url",
    );
  });

  it("outputs only the meta line when the CLI returned no results", () => {
    assert.equal(
      formatSearchText(json({ results: [] })),
      '**Query:** "q" - **Engines:** google - **Took:** 2.1s',
    );
  });
});

describe("web_search rendering", () => {
  it("renders the call line with the query and optional lang suffix", () => {
    const search = captureTools().get("web_search")!;
    assert.equal(
      renderedLines(search.renderCall({ query: "pi coding agent" }, identityTheme))[0],
      'web_search - "pi coding agent"',
    );
    assert.equal(
      renderedLines(search.renderCall({ query: "pi", lang: "JA" }, identityTheme))[0],
      'web_search - "pi" [lang=JA]',
    );
  });

  it("renders a success line with the engine and took seconds", () => {
    const search = captureTools().get("web_search")!;
    const result = {
      content: [{ type: "text", text: "body" }],
      details: { engine: "google", tookMs: 2100 },
    };
    assert.deepEqual(renderedLines(search.renderResult(result, {}, identityTheme)), [
      "✓ google (2.1s)",
    ]);
  });

  it("renders the stderr message as a failure line from the render state", () => {
    const search = captureTools().get("web_search")!;
    const state = { details: { error: "All web search backends failed: boom" } };
    assert.deepEqual(
      renderedLines(search.renderResult({ content: [] }, {}, identityTheme, { state })),
      ['✗ web-search - "All web search backends failed: boom"'],
    );
  });
});

describe("web_fetch rendering", () => {
  it("renders the call line with the url", () => {
    const fetchTool = captureTools().get("web_fetch")!;
    assert.equal(
      renderedLines(fetchTool.renderCall({ url: "https://example.com/" }, identityTheme))[0],
      'web_fetch - "https://example.com/"',
    );
  });

  it("renders a success line with backend, quoted title and took seconds", () => {
    const fetchTool = captureTools().get("web_fetch")!;
    const result = {
      content: [{ type: "text", text: "body" }],
      details: { backend: "Reddit", title: "A post", tookMs: 1200 },
    };
    assert.deepEqual(renderedLines(fetchTool.renderResult(result, {}, identityTheme)), [
      '✓ Reddit - "A post" (1.2s)',
    ]);
  });

  it("omits the title part when the fetch has no title", () => {
    const fetchTool = captureTools().get("web_fetch")!;
    const result = {
      content: [{ type: "text", text: "body" }],
      details: { backend: "camoufox+trafilatura", tookMs: 1200 },
    };
    assert.deepEqual(renderedLines(fetchTool.renderResult(result, {}, identityTheme)), [
      "✓ camoufox+trafilatura (1.2s)",
    ]);
  });

  it("renders the stderr message as a failure line from the render state", () => {
    const fetchTool = captureTools().get("web_fetch")!;
    const state = { details: { error: "Unable to fetch Reddit post abc123" } };
    assert.deepEqual(
      renderedLines(fetchTool.renderResult({ content: [] }, {}, identityTheme, { state })),
      ['✗ web-fetch - "Unable to fetch Reddit post abc123"'],
    );
  });
});
