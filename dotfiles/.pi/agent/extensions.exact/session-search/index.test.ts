import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "bun:test";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { quote, parse } from "shell-quote";
import piSessionsExtension from "./index";
import guardrailExtension from "../guardrail/index";

type Outcome = AgentToolResult;
type ExecuteTool = (
  name: string,
  args: unknown,
  options?: { signal?: AbortSignal },
) => Promise<Outcome>;

function captureTool(): ToolDefinition {
  const tools: ToolDefinition[] = [];
  piSessionsExtension({
    registerTool(tool: ToolDefinition) {
      tools.push(tool);
    },
  } as ExtensionAPI);
  assert.equal(tools.length, 1);
  return tools[0]!;
}

function bashOutput(output: string, overrides: Partial<Outcome> = {}): Outcome {
  return {
    content: [{ type: "text", text: output || "(no output)" }],
    details: undefined,
    structuredContent: { output, truncated: false, exit_code: 0, wall_time_seconds: 0 },
    isError: false,
    ...overrides,
  };
}

async function execute(
  input: Record<string, unknown>,
  outcome: Outcome = bashOutput(""),
  options: {
    cwd?: string;
    signal?: AbortSignal;
    executeTool?: ExecuteTool;
    nestedIsError?: boolean;
  } = {},
) {
  const calls: { name: string; args: unknown; signal?: AbortSignal }[] = [];
  const ctx = {
    cwd: options.cwd ?? "/tmp",
    async executeTool(name, args, nestedOptions) {
      calls.push({ name, args, signal: nestedOptions?.signal });
      const result = options.executeTool
        ? await options.executeTool(name, args, nestedOptions)
        : outcome;
      return {
        toolCall: { type: "toolCall", id: "test/1", name, arguments: args },
        result,
        isError: options.nestedIsError ?? result.isError === true,
      };
    },
  } as ExtensionToolContext;
  const result = await captureTool().execute("test", input, options.signal, undefined, ctx);
  return {
    result: {
      ...result,
      structuredContent: result.structuredContent as Record<string, unknown> | undefined,
    },
    calls,
  };
}

function commandArguments(command: string): string[] {
  const tokens = parse(command);
  assert.deepEqual(tokens.slice(0, 2), ["cd", "--"]);
  assert.deepEqual(tokens[3], { op: "&&" });
  assert.equal(tokens[4], join(homedir(), ".agents", "cli", "session-search"));
  return tokens.slice(5) as string[];
}

describe("session_search CLI boundary", () => {
  it("registers one tool and declares its nested bash dependency and untrusted logs", () => {
    const tool = captureTool();
    assert.equal(tool.name, "session_search");
    assert.deepEqual(
      (
        tool as ToolDefinition & { reachesTools(input: Record<string, unknown>): string[] }
      ).reachesTools({}),
      ["bash"],
    );
    assert.match(tool.description, /untrusted reference data/);
  });

  const operationCases = [
    {
      input: {
        action: "search",
        query: "needle",
        project: "repo",
        since: "2026-01-01",
        until: "2026-10-22",
        limit: 3,
        role: "user",
      },
      argv: [
        "search",
        "--json",
        "needle",
        "--project",
        "repo",
        "--since",
        "2026-01-01",
        "--until",
        "2026-10-22",
        "--limit",
        "3",
        "--role",
        "user",
      ],
      output: '{"text":"needle","line":3}\n',
      result: [{ text: "needle", line: 3 }],
    },
    {
      input: { action: "list", limit: 2 },
      argv: ["list", "--json", "--limit", "2"],
      output: '{"id":"one"}\n{"id":"two"}\n',
      result: [{ id: "one" }, { id: "two" }],
    },
    {
      input: { action: "show", id: "abc", query: "needle", offset: 2, limit: 1, role: "assistant" },
      argv: [
        "show",
        "--json",
        "abc",
        "--limit",
        "1",
        "--offset",
        "2",
        "--role",
        "assistant",
        "--query",
        "needle",
      ],
      output:
        '{"records":[{"text":"full body","source":"subagent","eventIndex":4}],"total":3,"offset":2,"returned":1,"nextOffset":3}',
      result: {
        records: [{ text: "full body", source: "subagent", eventIndex: 4 }],
        total: 3,
        offset: 2,
        returned: 1,
        nextOffset: 3,
      },
    },
  ];
  for (const sample of operationCases) {
    it(`forwards ${sample.input.action} arguments and preserves its CLI output`, async () => {
      const { result, calls } = await execute(sample.input, bashOutput(sample.output));
      assert.equal(calls[0]?.name, "bash");
      assert.deepEqual(
        commandArguments((calls[0]!.args as { command: string }).command),
        sample.argv,
      );
      assert.deepEqual(result.structuredContent, {
        status: "complete",
        action: sample.input.action,
        result: sample.result,
      });
      assert.equal(result.content[0]?.type === "text" && result.content[0].text, sample.output);
    });
  }

  for (const action of ["search", "list"]) {
    it(`preserves a successful empty ${action} as an empty array`, async () => {
      const { result } = await execute({
        action,
        ...(action === "search" ? { query: "absent" } : {}),
      });
      assert.deepEqual(result.structuredContent, { status: "complete", action, result: [] });
      assert.notEqual(result.isError, true);
    });
  }

  it("preserves an empty show page and its pagination", async () => {
    const page = {
      sessionId: "abc",
      records: [],
      total: 0,
      returned: 0,
      offset: 1,
      nextOffset: null,
    };
    const { result } = await execute(
      { action: "show", id: "abc" },
      bashOutput(JSON.stringify(page)),
    );
    assert.deepEqual(result.structuredContent?.result, page);
  });

  it("passes the current context cwd as the working directory", async () => {
    const cwd = "/tmp/a 'quote' $(touch marker)\nproject";
    const { calls } = await execute({ action: "list" }, bashOutput("[]"), { cwd });
    const command = (calls[0]!.args as { command: string }).command;
    assert.equal(parse(command)[2], cwd);
    assert.deepEqual(commandArguments(command), ["list", "--json"]);
  });

  it("quotes query, id, project and cwd as literal shell arguments", async () => {
    const temp = mkdtempSync(join(tmpdir(), "session-search-quote-"));
    try {
      const marker = join(temp, "injected");
      const unsafe = `x ' " ; $(touch ${marker}) \`touch ${marker}\`\n$HOME & | > * ?`;
      const cwd = join(temp, "cwd 'quoted'\n$()");
      mkdirSync(cwd);
      const { calls } = await execute(
        { action: "show", id: unsafe, query: unsafe, project: unsafe },
        bashOutput("{}"),
        { cwd },
      );
      const command = (calls[0]!.args as { command: string }).command;
      const fixedCli = quote([join(homedir(), ".agents", "cli", "session-search")]);
      const echoArgv = quote([
        process.execPath,
        "-e",
        "console.log(JSON.stringify({cwd:process.cwd(),argv:process.argv.slice(1)}))",
      ]);
      const shellCommand = command.replace(fixedCli, echoArgv);
      const received = JSON.parse(execFileSync("bash", ["-c", shellCommand], { encoding: "utf8" }));
      assert.equal(received.cwd, cwd);
      assert.deepEqual(received.argv, [
        "show",
        "--json",
        unsafe,
        "--project",
        unsafe,
        "--query",
        unsafe,
      ]);
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  for (const input of [
    { action: "search" },
    { action: "show" },
    { action: "list", role: "user" },

    { action: "list", query: "x" },
    { action: "search", query: "x", id: "abc" },
    { action: "search", query: "x\0y" },
  ]) {
    it(`rejects invalid input before bash: ${JSON.stringify(input)}`, async () => {
      let called = false;
      await assert.rejects(
        execute(input, bashOutput(""), {
          async executeTool() {
            called = true;
            return bashOutput("");
          },
        }),
      );
      assert.equal(called, false);
    });
  }

  for (const sample of [
    {
      name: "denied",
      outcome: bashOutput("Command denied by user", {
        isError: true,
        structuredContent: undefined,
      }),
    },
    {
      name: "permission reason required",
      outcome: bashOutput("Command requires a reason", {
        isError: true,
        structuredContent: undefined,
      }),
    },
    {
      name: "CLI unavailable",
      outcome: bashOutput("not found", {
        isError: true,
        structuredContent: { output: "not found", exit_code: 127, truncated: false },
      }),
    },
    {
      name: "nonzero exit",
      outcome: bashOutput("usage", {
        structuredContent: { output: "usage", exit_code: 1, truncated: false },
      }),
    },
    {
      name: "aborted",
      outcome: bashOutput("Command aborted", { isError: true, structuredContent: undefined }),
    },
  ]) {
    it(`does not convert ${sample.name} to a successful empty result`, async () => {
      const { result } = await execute({ action: "list" }, sample.outcome);
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent?.status, "error");
      assert.deepEqual(result.details, { bash: sample.outcome });
      if (sample.name === "CLI unavailable")
        assert.match(String(result.structuredContent?.error), /CLI unavailable/);
    });
  }

  for (const sample of [
    { action: "list", raw: '{"valid":1}\ninvalid' },
    { action: "show", id: "abc", raw: "" },
  ]) {
    it(`reports invalid JSON for ${sample.action}`, async () => {
      const { raw, ...input } = sample;
      const { result } = await execute(input, bashOutput(raw));
      assert.equal(result.isError, true);
      assert.match(String(result.structuredContent?.error), /invalid JSON/);
      assert.equal(result.structuredContent?.result, undefined);
    });
  }

  it("honors the nested outcome error flag even when its result is otherwise empty", async () => {
    const { result } = await execute({ action: "list" }, bashOutput(""), { nestedIsError: true });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.status, "error");
  });

  it("marks truncated failures as errors with incomplete output", async () => {
    const failed = bashOutput("tail", {
      isError: true,
      details: { truncation: { truncated: true }, fullOutputPath: "/tmp/full" },
    });
    const { result } = await execute({ action: "list" }, failed);
    assert.equal(result.isError, true);
    assert.match(
      result.content[0]?.type === "text" ? result.content[0].text : "",
      /output incomplete/,
    );
    assert.deepEqual(result.details, { bash: failed });
  });

  it("fails closed when a hook removes the structured bash envelope", async () => {
    const { result } = await execute(
      { action: "list" },
      bashOutput("redacted", { structuredContent: undefined }),
    );
    assert.equal(result.isError, true);
    assert.match(String(result.structuredContent?.error), /missing bash output envelope/);
  });

  it("forwards the abort signal and reports an interrupted nested call", async () => {
    const controller = new AbortController();
    const { result, calls } = await execute({ action: "list" }, bashOutput(""), {
      signal: controller.signal,
      async executeTool() {
        controller.abort();
        return bashOutput("");
      },
    });
    assert.equal(calls[0]?.signal, controller.signal);
    assert.equal(result.isError, true);
    assert.match(String(result.structuredContent?.error), /interrupted/);
  });

  it("does not start bash when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      execute({ action: "list" }, bashOutput(""), { signal: controller.signal }),
      /abort/i,
    );
  });

  const truncationCases: Partial<Outcome>[] = [
    {
      details: {
        truncation: { truncated: true, lastLinePartial: true },
        fullOutputPath: "/tmp/full",
      },
      structuredContent: { output: '{"completeButTooLarge":true}', exit_code: 0, truncated: false },
    },
    {
      details: undefined,
      structuredContent: {
        output: "partial",
        exit_code: 0,
        truncated: true,
        full_output_path: "/tmp/full",
      },
    },
  ];
  for (const sample of truncationCases) {
    it(`keeps truncation metadata without parsing or rerunning (${JSON.stringify(sample.details)})`, async () => {
      const outcome = bashOutput("partial tail", sample);
      const { result, calls } = await execute({ action: "list" }, outcome);
      assert.deepEqual(result.structuredContent, { status: "incomplete", action: "list" });
      assert.deepEqual(result.details, { bash: outcome });
      assert.equal(calls.length, 1);
      assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /incomplete/);
    });
  }

  it("detects the real bash byte limit on a giant JSON line", async () => {
    const bash = createBashTool("/tmp");
    const { result } = await execute({ action: "show", id: "abc" }, bashOutput(""), {
      async executeTool() {
        return (await bash.execute("large", {
          command: `${quote([process.execPath])} -e 'console.log(JSON.stringify({text:"x".repeat(60000)}))'`,
        })) as Outcome;
      },
    });
    assert.equal(result.structuredContent?.status, "incomplete");
    const original = (result.details as { bash: Outcome }).bash;
    assert.equal(
      (original.details as { truncation: { lastLinePartial: boolean } }).truncation.lastLinePartial,
      true,
    );
  });
});

describe("session_search sandbox fixture integration", () => {
  it("runs all registered actions through the existing sandboxed bash into a compiled fixture CLI", async () => {
    const temp = mkdtempSync(join(tmpdir(), "session-search-integration-"));
    try {
      const cwd = join(temp, "project 'space'");
      mkdirSync(cwd);
      const home = join(temp, "home");
      const project = `--${cwd.replaceAll("/", "-").replace(/^-/, "")}--`;
      const sessions = join(home, ".pi", "agent", "sessions", project);
      mkdirSync(sessions, { recursive: true });
      const id = "12345678-1234-1234-1234-123456789abc";
      writeFileSync(
        join(sessions, `2026-10-22T00-00-00-000Z_${id}.jsonl`),
        [
          { type: "session", id, cwd, timestamp: "2026-10-22T00:00:00Z", version: 3 },
          { type: "message", message: { role: "user", content: "fixture needle" } },
          {
            type: "message",
            message: { role: "assistant", content: [{ type: "text", text: "fixture done" }] },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
      const cliSource = resolve(
        import.meta.dir,
        "../../../../.agents/cli.exact/session-search/src/main.ts",
      );
      const fixtureCli = join(temp, "dist", "session-search");
      execFileSync(process.execPath, ["build", "--compile", cliSource, "--outfile", fixtureCli], {
        stdio: "pipe",
      });
      const wrapper = join(temp, "wrapper");
      writeFileSync(wrapper, `#!/bin/sh\nHOME=${quote([home])} exec ${quote([fixtureCli])} "$@"\n`);
      chmodSync(wrapper, 0o755);
      const config = join(temp, "guardrail.yaml");
      writeFileSync(
        config,
        "read:\n  - allow: '*'\nwrite:\n  - allow:\n      - /tmp\ncommands:\n  - .*:\n      - allow: []\n",
      );
      const tools = new Map<string, ToolDefinition>();
      guardrailExtension(
        {
          registerTool(tool: ToolDefinition) {
            tools.set(tool.name, tool);
          },
          on() {},
        } as unknown as ExtensionAPI,
        config,
      );
      const bash = tools.get("bash")!;
      let nestedCalls = 0;
      const executeTool: ExecuteTool = async (name, args, options) => {
        nestedCalls++;
        assert.equal(name, "bash");
        const command = (args as { command: string }).command.replace(
          quote([join(homedir(), ".agents", "cli", "session-search")]),
          quote([wrapper]),
        );
        return (await bash.execute("integration/bash", { command }, options?.signal, undefined, {
          cwd: process.cwd(),
          hasUI: false,
        } as ExtensionToolContext)) as Outcome;
      };
      const listed = await execute({ action: "list" }, bashOutput(""), { cwd, executeTool });
      assert.equal(
        listed.result.structuredContent?.status,
        "complete",
        JSON.stringify(listed.result),
      );
      assert.equal((listed.result.structuredContent!.result as { id: string }[])[0]?.id, id);
      const searched = await execute({ action: "search", query: "needle" }, bashOutput(""), {
        cwd,
        executeTool,
      });
      assert.equal(
        (searched.result.structuredContent!.result as { text: string }[])[0]?.text,
        "fixture needle",
      );
      const shown = await execute({ action: "show", id, limit: 1 }, bashOutput(""), {
        cwd,
        executeTool,
      });
      assert.equal(
        (shown.result.structuredContent!.result as { nextOffset: number }).nextOffset,
        2,
      );
      assert.equal(nestedCalls, 3);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }, 30000);
});
