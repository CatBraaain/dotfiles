import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderersOf } from "../tool-renderer/index.ts";
import webSearchExtension, {
  browseCliDir,
  browseScript,
  formatSearchText,
  runWebCli,
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

type TestDeps = WebCliDeps & {
  runCli?: (command: string, args: readonly string[]) => Promise<WebCliResult>;
};

function captureTools(deps?: TestDeps): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  webSearchExtension(
    {
      registerTool: (tool: Tool) => {
        const execute = tool.execute;
        tool.execute = (...args: any[]) => {
          const context = deps?.runCli
            ? {
                executeTool: async (name: string, input: unknown) => {
                  assert.equal(name, "bash");
                  const command = (input as { command: string }).command;
                  const line = command
                    .split("\n")
                    .find((line) => line.startsWith("'/nonexistent-test-cli/browse'"))!;
                  const tokens = line
                    .split(" >")[0]!
                    .split("'")
                    .filter((_, index) => index % 2 === 1);
                  const result = await deps.runCli!(tokens[0]!, tokens.slice(1));
                  return bashOutcome(frameOutput(result.stdout, result.stderr, result.code ?? 1));
                },
              }
            : args[4];
          args[4] = context;
          return execute(...args);
        };
        tools.set(tool.name, tool);
      },
    } as never,
    deps,
  );
  return tools;
}

type RecordedCall = { command: string; args: string[] };

function fakeCli(output: { code?: number; stdout?: string; stderr?: string }) {
  const calls: RecordedCall[] = [];
  async function runCli(command: string, args: readonly string[]): Promise<WebCliResult> {
    calls.push({ command, args: [...args] });
    return { stdout: output.stdout ?? "", stderr: output.stderr ?? "", code: output.code ?? 0 };
  }
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

const fetchFallbackJsonOutput = JSON.stringify({
  url: "https://example.com/",
  backend: "camoufox+trafilatura",
  title: "Example",
  body: "# Example\n\nbody",
  tookMs: 1200,
  fallbacks: [{ backend: "camoufox+trafilatura", error: "render: challenge detected" }],
});

function frameOutput(stdout = "", stderr = "", code = 0): string {
  return [
    "PI_WEB_CLI_V1:" + code,
    Buffer.from(stdout).toString("base64"),
    Buffer.from(stderr).toString("base64"),
    "PI_WEB_CLI_END",
    "",
  ].join("\n");
}
const nestedToolCall = { type: "toolCall" as const, id: "nested", name: "bash", arguments: {} };

function bashOutcome(output: string, overrides: Record<string, unknown> = {}) {
  return {
    toolCall: nestedToolCall,
    isError: false,
    result: {
      content: [{ type: "text" as const, text: output }],
      details: {},
      structuredContent: { output, truncated: false, exit_code: 0, ...overrides },
    },
  };
}
const bashTool = createBashTool(tmpdir());
const executionContext = {
  async executeTool(name: string, args: unknown, options?: { signal?: AbortSignal }) {
    assert.equal(name, "bash");
    const result = await bashTool.execute("nested", args as never, options?.signal);
    return { toolCall: nestedToolCall, result, isError: result.isError ?? false };
  },
};

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

function renderedLines(component: { render(width: number): string[] }, width = 80): string[] {
  return component.render(width).map((line) => line.trim());
}

const identityTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

describe("registered bash adapter", () => {
  it("separates stdout, stderr and the CLI exit code", async () => {
    const result = await runWebCli(executionContext, process.execPath, [
      "-e",
      'process.stdout.write("out\\n"); process.stderr.write("err\\n"); process.exit(3);',
    ]);
    assert.deepEqual(result, { stdout: "out\n", stderr: "err\n", code: 3 });
  });

  it("quotes executable paths and arguments without shell expansion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "web'cli-"));
    try {
      const executable = join(dir, "browse");
      writeFileSync(executable, '#!/bin/sh\nprintf "%s" "$1"\n', { mode: 0o755 });
      const argument = "'; $(touch /tmp/pi-web-injected); `id`\n$HOME";
      const result = await runWebCli(executionContext, executable, [argument]);
      assert.equal(result.stdout, argument);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes the abort signal and timeout to registered bash", async () => {
    const signal = new AbortController().signal;
    const ctx = {
      async executeTool(name: string, args: unknown, options?: { signal?: AbortSignal }) {
        assert.equal(name, "bash");
        assert.equal((args as { timeout: number }).timeout, 300);
        assert.equal(options?.signal, signal);
        return bashOutcome(frameOutput());
      },
    };
    await runWebCli(ctx, "/browse", [], signal);
  });

  it("preserves output beyond the model-facing 50KB bash limit", async () => {
    const body = "x".repeat(100_000);
    const result = await runWebCli(executionContext, process.execPath, [
      "-e",
      'process.stdout.write("x".repeat(100000)); process.stderr.write("diagnostic");',
    ]);
    assert.equal(result.stdout, body);
    assert.equal(result.stderr, "diagnostic");
  });

  it("recovers actual structured-output truncation without losing a 2MiB stream", async () => {
    const result = await runWebCli(executionContext, process.execPath, [
      "-e",
      'process.stdout.write("x".repeat(2097152)); process.stderr.write("diagnostic");',
    ]);
    assert.equal(result.stdout, "x".repeat(2_097_152));
    assert.equal(result.stderr, "diagnostic");
  });

  it("makes no recovery calls for complete initial output", async () => {
    let calls = 0;
    const ctx = {
      async executeTool() {
        calls++;
        return bashOutcome(frameOutput("complete"));
      },
    };
    assert.equal((await runWebCli(ctx, "/browse", [])).stdout, "complete");
    assert.equal(calls, 1);
  });

  it("quotes a full output path containing shell syntax when reading real chunks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "web-output-"));
    const path = join(dir, "saved '$(id)' `id` output");
    const output = frameOutput("x".repeat(600_000));
    writeFileSync(path, output);
    let calls = 0;
    try {
      const ctx = {
        async executeTool(name: string, args: unknown, options?: { signal?: AbortSignal }) {
          calls++;
          if (calls === 1)
            return bashOutcome("partial must not be appended", {
              truncated: true,
              full_output_path: path,
            });
          return executionContext.executeTool(name, args, options);
        },
      };
      assert.equal((await runWebCli(ctx, "/browse", [])).stdout, "x".repeat(600_000));
      assert.equal(calls, 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves a 2MiB fetch body and details through the same registered bash", async () => {
    const body = "日本語abcdef".repeat(150_000);
    const payload = { ...JSON.parse(fetchJsonOutput), body };
    const output = frameOutput(JSON.stringify(payload));
    const signal = new AbortController().signal;
    let calls = 0;
    let chunkIndex = 0;
    const ctx = {
      async executeTool(name: string, args: unknown, options?: { signal?: AbortSignal }) {
        assert.equal(name, "bash");
        assert.equal(options?.signal, signal);
        assert.equal((args as { timeout: number }).timeout, 300);
        const command = (args as { command: string }).command;
        calls++;
        if (calls === 1)
          return bashOutcome("partial", { truncated: true, full_output_path: "/tmp/saved-output" });
        if (calls === 2) {
          assert.equal(command, "wc -c < '/tmp/saved-output'");
          return bashOutcome(String(output.length) + "\n");
        }
        assert.equal(
          command,
          `dd if='/tmp/saved-output' bs=524288 skip=${chunkIndex} count=1 status=none`,
        );
        const chunk = output.slice(chunkIndex * 524_288, ++chunkIndex * 524_288);
        return bashOutcome(chunk);
      },
    };
    const tool = captureTools().get("web_fetch")!;
    const result = await tool.execute("call", { url: payload.url }, signal, undefined, ctx);
    assert.equal(textOf(result), body);
    assert.deepEqual(detailsOf(result), {
      backend: payload.backend,
      title: payload.title,
      tookMs: payload.tookMs,
    });
    assert.equal(calls, 2 + Math.ceil(output.length / 524_288));
  });

  for (const path of [undefined, "", "relative", 42, "/tmp/invalid\0path"]) {
    it(`rejects an invalid full output path: ${JSON.stringify(path)}`, async () => {
      let calls = 0;
      const ctx = {
        async executeTool() {
          calls++;
          return bashOutcome("partial", { truncated: true, full_output_path: path });
        },
      };
      await assert.rejects(runWebCli(ctx, "/browse", []), /valid full_output_path/);
      assert.equal(calls, 1);
    });
  }

  for (const streamBytes of [393_192, 393_195]) {
    it(`finishes recovery near a chunk boundary for ${streamBytes} stream bytes`, async () => {
      const stdout = "x".repeat(streamBytes);
      const output = frameOutput(stdout);
      let calls = 0;
      const ctx = {
        async executeTool() {
          calls++;
          if (calls === 1)
            return bashOutcome("partial", { truncated: true, full_output_path: "/tmp/output" });
          if (calls === 2) return bashOutcome(String(output.length));
          return bashOutcome(output.slice((calls - 3) * 524_288, (calls - 2) * 524_288));
        },
      };
      assert.equal((await runWebCli(ctx, "/browse", [])).stdout, stdout);
      assert.equal(calls, 2 + Math.ceil(output.length / 524_288));
    });
  }

  for (const testCase of [
    {
      name: "recovery denial",
      recovery: { ...bashOutcome(""), isError: true },
      error: /Registered bash failed/,
    },
    { name: "recovery timeout", recovery: new Error("Bash timed out"), error: /timed out/ },
    {
      name: "recovery signal exit",
      recovery: bashOutcome("", { exit_code: 143 }),
      error: /code 143/,
    },
    {
      name: "recovery missing structure",
      recovery: { ...bashOutcome(""), result: { content: [], details: {} } },
      error: /invalid structured/,
    },
    {
      name: "recovery truncation",
      recovery: bashOutcome("123", { truncated: true }),
      error: /invalid full output size/,
    },
    {
      name: "invalid file size",
      recovery: bashOutcome("not a size"),
      error: /invalid full output size/,
    },
  ]) {
    it("rejects " + testCase.name, async () => {
      let calls = 0;
      const ctx = {
        async executeTool() {
          if (++calls === 1)
            return bashOutcome("partial", { truncated: true, full_output_path: "/tmp/output" });
          if (testCase.recovery instanceof Error) throw testCase.recovery;
          return testCase.recovery;
        },
      };
      await assert.rejects(runWebCli(ctx, "/browse", []), testCase.error);
      assert.equal(calls, 2);
    });
  }

  for (const testCase of [
    { name: "short chunk", chunk: bashOutcome("short"), error: /incomplete/ },
    {
      name: "truncated chunk",
      chunk: bashOutcome(frameOutput(), { truncated: true }),
      error: /truncated or incomplete/,
    },
    {
      name: "incomplete frame",
      chunk: bashOutcome("x".repeat(frameOutput().length)),
      error: /invalid CLI output frame/,
    },
  ]) {
    it("rejects " + testCase.name, async () => {
      let calls = 0;
      const ctx = {
        async executeTool() {
          calls++;
          if (calls === 1)
            return bashOutcome("partial", { truncated: true, full_output_path: "/tmp/output" });
          if (calls === 2) return bashOutcome(String(frameOutput().length));
          return testCase.chunk;
        },
      };
      await assert.rejects(runWebCli(ctx, "/browse", []), testCase.error);
      assert.equal(calls, 3);
    });
  }

  it("stops recovery when cancellation arrives after the size read", async () => {
    const controller = new AbortController();
    let calls = 0;
    const ctx = {
      async executeTool() {
        if (++calls === 1)
          return bashOutcome("partial", { truncated: true, full_output_path: "/tmp/output" });
        controller.abort();
        return bashOutcome("123");
      },
    };
    await assert.rejects(runWebCli(ctx, "/browse", [], controller.signal), /aborted/);
    assert.equal(calls, 2);
  });

  it("propagates cancellation during registered bash execution", async () => {
    const signal = AbortSignal.timeout(100);
    await assert.rejects(
      runWebCli(executionContext, process.execPath, ["-e", "setTimeout(() => {}, 60000);"], signal),
      /aborted/,
    );
  });

  it("does not call bash for an already aborted signal", async () => {
    let called = false;
    const ctx = {
      async executeTool() {
        called = true;
        return bashOutcome(frameOutput());
      },
    };
    await assert.rejects(runWebCli(ctx, "/browse", [], AbortSignal.abort()), /aborted/);
    assert.equal(called, false);
  });

  for (const testCase of [
    {
      name: "truncated output",
      outcome: bashOutcome(frameOutput(), { truncated: true }),
      error: /[Tt]runcated/,
    },
    {
      name: "nonzero bash exit",
      outcome: bashOutcome(frameOutput(), { exit_code: 7 }),
      error: /code 7/,
    },
    {
      name: "malformed frame",
      outcome: bashOutcome("not a frame"),
      error: /invalid CLI output frame/,
    },
    {
      name: "invalid base64",
      outcome: bashOutcome("PI_WEB_CLI_V1:0\na\n\nPI_WEB_CLI_END\n"),
      error: /encoding/,
    },
    {
      name: "missing structured output",
      outcome: { toolCall: nestedToolCall, isError: false, result: { content: [], details: {} } },
      error: /invalid structured/,
    },
    {
      name: "tool error",
      outcome: {
        toolCall: nestedToolCall,
        isError: true,
        result: { content: [{ type: "text" as const, text: "Command denied" }], details: {} },
      },
      error: /Command denied/,
    },
  ]) {
    it("rejects " + testCase.name, async () => {
      const ctx = {
        async executeTool() {
          return testCase.outcome;
        },
      };
      await assert.rejects(runWebCli(ctx, "/browse", []), testCase.error);
    });
  }

  it("does not launch the CLI when registered bash denies the command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "web-denied-"));
    const marker = join(dir, "launched");
    try {
      const executable = join(dir, "browse");
      writeFileSync(executable, "#!/bin/sh\ntouch '" + marker + "'\n", { mode: 0o755 });
      const ctx = {
        async executeTool() {
          return {
            toolCall: nestedToolCall,
            isError: true,
            result: {
              content: [{ type: "text" as const, text: "Command denied by user" }],
              details: {},
            },
          };
        },
      };
      const tool = captureTools({ env: { BROWSE_CLI_DIR: dir } }).get("web_fetch")!;
      await assert.rejects(
        tool.execute("call", { url: "https://example.com" }, undefined, undefined, ctx),
        /Command denied by user/,
      );
      assert.throws(() => readFileSync(marker), /ENOENT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("registered bash routing", () => {
  it("routes browse search through registered bash", async () => {
    const cli = fakeCli({ stdout: searchJsonOutput });
    const search = captureTools(cli.deps).get("web_search")!;

    await callSearch(search, { query: "pi coding agent" });

    assert.equal(cli.calls.length, 1);
    assert.equal(cli.calls[0]!.command, join("/nonexistent-test-cli", "browse"));
    assert.deepEqual(cli.calls[0]!.args, ["search", "pi coding agent", "--json"]);
  });

  it("passes --lang when the search request has a language hint", async () => {
    const cli = fakeCli({ stdout: searchJsonOutput });
    const search = captureTools(cli.deps).get("web_search")!;

    await callSearch(search, { query: "pi", lang: "JA" });

    assert.deepEqual(cli.calls[0]!.args, ["search", "pi", "--lang", "JA", "--json"]);
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
    assert.equal(cli.calls[0]!.command, join("/nonexistent-test-cli", "browse"));
    assert.deepEqual(cli.calls[0]!.args, ["fetch", "https://example.com/", "--json"]);
  });
});

describe("tool execution with a real browse executable", () => {
  const cases = [
    {
      name: "web_search",
      params: { query: "pi '$(id)' `id`; $HOME", lang: "JA'; $(id)" },
      args: ["search", "pi '$(id)' `id`; $HOME", "--lang", "JA'; $(id)", "--json"],
      output: searchJsonOutput,
    },
    {
      name: "web_fetch",
      params: { url: "https://example.com/?q='$(id)'`id`;" },
      args: ["fetch", "https://example.com/?q='$(id)'`id`;", "--json"],
      output: fetchJsonOutput,
    },
  ];

  for (const testCase of cases) {
    it(`runs ${testCase.name} through an executable path containing spaces`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "web cli-"));
      const argsFile = join(dir, "args");
      try {
        writeFileSync(
          join(dir, "browse"),
          `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nprintf '%s' '${testCase.output}'\n`,
          { mode: 0o755 },
        );
        const tool = captureTools({ env: { BROWSE_CLI_DIR: dir } }).get(testCase.name)!;

        const result = await tool.execute(
          "call",
          testCase.params,
          AbortSignal.timeout(5_000),
          undefined,
          executionContext,
        );

        const receivedArgs = readFileSync(argsFile, "utf8").trimEnd().split("\n");
        assert.deepEqual(receivedArgs, testCase.args);
        const expectedText =
          testCase.name === "web_search"
            ? formatSearchText(JSON.parse(searchJsonOutput))
            : JSON.parse(fetchJsonOutput).body;
        assert.equal(textOf(result), expectedText);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
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

  it("keeps fallback failures in the successful fetch details", async () => {
    const cli = fakeCli({ stdout: fetchFallbackJsonOutput });
    const fetchTool = captureTools(cli.deps).get("web_fetch")!;

    const result = await callFetch(fetchTool, "https://example.com/");

    assert.deepEqual(detailsOf(result), {
      backend: "camoufox+trafilatura",
      title: "Example",
      fallback: "camoufox+trafilatura: render: challenge detected",
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
    const deployedExtensionDir = "/home/example/.pi/agent/extensions/web-search";
    assert.equal(browseCliDir({ BROWSE_CLI_DIR: "/opt/cli" }), "/opt/cli");
    assert.equal(browseCliDir({ BROWSE_CLI_DIR: "/opt/cli" }, deployedExtensionDir), "/opt/cli");
    assert.equal(browseScript({ BROWSE_CLI_DIR: "/opt/cli" }), "/opt/cli/browse");
  });

  it("always returns the CLI project directory name", () => {
    const dir = mkdtempSync(join(tmpdir(), "web-cli-"));
    try {
      writeFileSync(join(dir, "browse.executable"), "");
      assert.equal(browseScript({ BROWSE_CLI_DIR: dir }), join(dir, "browse"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves the deployed project directory name", () => {
    const dir = mkdtempSync(join(tmpdir(), "web-cli-"));
    try {
      writeFileSync(join(dir, "browse"), "");
      assert.equal(browseScript({ BROWSE_CLI_DIR: dir }), join(dir, "browse"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults to source-tree .agents/cli.exact four levels above this extension", () => {
    const extensionDir = dirname(fileURLToPath(import.meta.url));
    assert.equal(
      browseCliDir({}),
      join(extensionDir, "..", "..", "..", "..", ".agents", "cli.exact"),
    );
    assert.equal(browseScript({}), join(browseCliDir({}), "browse"));
  });

  it("defaults to deployed .agents/cli four levels above the deployed extension", () => {
    const extensionDir = "/home/example/.pi/agent/extensions/web-search";
    assert.equal(
      browseCliDir({}, extensionDir),
      join(extensionDir, "..", "..", "..", "..", ".agents", "cli"),
    );
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
    const search = renderersOf("web_search") as unknown as Tool;
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
    const search = renderersOf("web_search") as unknown as Tool;
    const result = {
      content: [{ type: "text", text: "body" }],
      details: { engine: "google", tookMs: 2100 },
    };
    assert.deepEqual(renderedLines(search.renderResult(result, {}, identityTheme)), [
      "✓ google (2.1s)",
    ]);
  });

  it("renders the stderr message when pi replaces the final details with an empty object", () => {
    const search = renderersOf("web_search") as unknown as Tool;
    const state = { details: { error: "All web search backends failed: boom" } };
    const result = { content: [{ type: "text", text: "boom" }], details: {} };

    assert.deepEqual(renderedLines(search.renderResult(result, {}, identityTheme, { state })), [
      '✗ web-search - "All web search backends failed: boom"',
    ]);
  });

  it("renders the error content when the render state is unavailable", () => {
    const search = renderersOf("web_search") as unknown as Tool;
    const result = {
      content: [{ type: "text", text: "web-search: spawn bun ENOENT" }],
      details: {},
    };

    assert.deepEqual(
      renderedLines(search.renderResult(result, {}, identityTheme, { isError: true })),
      ['✗ web-search - "web-search: spawn bun ENOENT"'],
    );
  });
});

describe("web_fetch rendering", () => {
  it("renders the call line with the url", () => {
    const fetchTool = renderersOf("web_fetch") as unknown as Tool;
    assert.equal(
      renderedLines(fetchTool.renderCall({ url: "https://example.com/" }, identityTheme))[0],
      'web_fetch - "https://example.com/"',
    );
  });

  it("renders a success line with backend, quoted title and took seconds", () => {
    const fetchTool = renderersOf("web_fetch") as unknown as Tool;
    const result = {
      content: [{ type: "text", text: "body" }],
      details: { backend: "Reddit", title: "A post", tookMs: 1200 },
    };
    assert.deepEqual(renderedLines(fetchTool.renderResult(result, {}, identityTheme)), [
      '✓ Reddit - "A post" (1.2s)',
    ]);
  });

  it("renders fallback failures in the successful line", () => {
    const fetchTool = renderersOf("web_fetch") as unknown as Tool;
    const result = {
      content: [{ type: "text", text: "body" }],
      details: {
        backend: "camoufox+trafilatura",
        title: "Example",
        fallback: "camoufox+trafilatura: render: challenge detected",
        tookMs: 1200,
      },
    };
    assert.deepEqual(renderedLines(fetchTool.renderResult(result, {}, identityTheme), 200), [
      '✓ camoufox+trafilatura - "Example" (fallback: camoufox+trafilatura: render: challenge detected) (1.2s)',
    ]);
  });

  it("omits the title part when the fetch has no title", () => {
    const fetchTool = renderersOf("web_fetch") as unknown as Tool;
    const result = {
      content: [{ type: "text", text: "body" }],
      details: { backend: "camoufox+trafilatura", tookMs: 1200 },
    };
    assert.deepEqual(renderedLines(fetchTool.renderResult(result, {}, identityTheme)), [
      "✓ camoufox+trafilatura (1.2s)",
    ]);
  });

  it("renders fallback details without a title", () => {
    const fetchTool = renderersOf("web_fetch") as unknown as Tool;
    const result = {
      content: [{ type: "text", text: "body" }],
      details: {
        backend: "camoufox+trafilatura",
        fallback: "camoufox+trafilatura: render: challenge detected",
        tookMs: 1200,
      },
    };
    assert.deepEqual(renderedLines(fetchTool.renderResult(result, {}, identityTheme), 200), [
      "✓ camoufox+trafilatura (fallback: camoufox+trafilatura: render: challenge detected) (1.2s)",
    ]);
  });

  it("renders the stderr message when pi replaces the final details with an empty object", () => {
    const fetchTool = renderersOf("web_fetch") as unknown as Tool;
    const state = { details: { error: "Unable to fetch Reddit post abc123" } };
    const result = { content: [{ type: "text", text: "request failed" }], details: {} };

    assert.deepEqual(renderedLines(fetchTool.renderResult(result, {}, identityTheme, { state })), [
      '✗ web-fetch - "Unable to fetch Reddit post abc123"',
    ]);
  });

  it("renders the error content when the render state is unavailable", () => {
    const fetchTool = renderersOf("web_fetch") as unknown as Tool;
    const result = {
      content: [{ type: "text", text: "web-fetch exited with code 1" }],
      details: {},
    };

    assert.deepEqual(
      renderedLines(fetchTool.renderResult(result, {}, identityTheme, { isError: true })),
      ['✗ web-fetch - "web-fetch exited with code 1"'],
    );
  });
});
