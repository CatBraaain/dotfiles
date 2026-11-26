import assert from "node:assert/strict";
import { afterEach, describe, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createBashTool,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import ticketsExtension, {
  appendJsonFlag,
  buildCreateArgs,
  buildEditArgs,
  buildListArgs,
  buildSetArgs,
  buildShowArgs,
  spawnTicketCli,
  ticketToolDescriptions,
  ticketToolPromptSnippets,
  type TicketsExtensionDeps,
} from "./index";

// Session cwd passed to execute() in tests; execute must forward it to the runner.
const SESSION_CWD = "/tmp/ticket-session";

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  details: unknown;
}

interface CapturedTool {
  name: string;
  description: string;
  promptSnippet?: string;
  parameters?: unknown;
  executionMode?: string;
  prepareLoadout?: () => { hiddenDeclarations?: string[] };
  execute?: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: Pick<ExtensionToolContext, "cwd" | "executeTool">,
  ) => Promise<ToolResult>;
}

function captureTools(deps: TicketsExtensionDeps = {}): CapturedTool[] {
  const tools: CapturedTool[] = [];
  ticketsExtension(
    {
      registerTool: (tool: CapturedTool) => tools.push(tool),
    } as never,
    deps,
  );
  return tools;
}

function findTool(tools: CapturedTool[], name: string): CapturedTool {
  const tool = tools.find((entry) => entry.name === name);
  assert.ok(tool, `${name} is registered`);
  return tool;
}

// Invokes a captured tool's execute with a fixed ctx.cwd.
function exec(tool: CapturedTool, params: Record<string, unknown>): Promise<ToolResult> {
  return tool.execute!("toolCall", params, undefined, undefined, {
    cwd: SESSION_CWD,
    sessionManager: { getSessionId: () => "pi-session" },
  } as never);
}

// Fake CLI runner resolving with `resolved` and recording every call. A
// function form answers per call, keyed by the CLI args — used to branch the
// truncation refetch (--json) from the ordinary text run.
function fakeRunner(resolved: string | ((args: string[]) => string)): TicketsExtensionDeps & {
  calls: Array<{ args: string[]; cwd: string }>;
} {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  return {
    calls,
    runCli: (args, cwd) => {
      calls.push({ args, cwd });
      return Promise.resolve(typeof resolved === "function" ? resolved(args) : resolved);
    },
  };
}

describe("ticket_list args", () => {
  it("builds bare list args without options", () => {
    assert.deepEqual(buildListArgs({}), ["list"]);
  });

  it("appends --all when all is true", () => {
    assert.deepEqual(buildListArgs({ all: true }), ["list", "--all"]);
    assert.deepEqual(buildListArgs({ all: false }), ["list"]);
  });

  it("joins statuses into one --status value", () => {
    assert.deepEqual(buildListArgs({ status: ["open", "blocked"] }), [
      "list",
      "--status",
      "open,blocked",
    ]);
  });

  it("omits --status for an empty status array", () => {
    assert.deepEqual(buildListArgs({ status: [] }), ["list"]);
  });

  it("appends --project when given", () => {
    assert.deepEqual(buildListArgs({ project: "proj" }), ["list", "--project", "proj"]);
  });

  it("combines all options in CLI order", () => {
    assert.deepEqual(buildListArgs({ status: ["open", "closed"], project: "proj", all: true }), [
      "list",
      "--all",
      "--status",
      "open,closed",
      "--project",
      "proj",
    ]);
  });
});

describe("ticket_show args", () => {
  it("omits the selector so the CLI defaults to next", () => {
    assert.deepEqual(buildShowArgs({}), ["show"]);
  });

  it("builds show args with the selector", () => {
    assert.deepEqual(buildShowArgs({ selector: "20260101-000000" }), ["show", "20260101-000000"]);
  });

  it("appends --project when given", () => {
    assert.deepEqual(buildShowArgs({ selector: "abc", project: "proj" }), [
      "show",
      "abc",
      "--project",
      "proj",
    ]);
  });
});

describe("ticket_create args", () => {
  it("builds create args with a title-only JSON object", () => {
    assert.deepEqual(buildCreateArgs({ title: "Fix the bug" }), [
      "create",
      '{"title":"Fix the bug"}',
    ]);
  });

  it("serializes every given key into the JSON object", () => {
    const args = buildCreateArgs({
      title: "Fix the bug",
      status: "blocked",
      after: "20260101-000000",
      body: "detail",
      project: "proj",
    });
    assert.deepEqual(args, [
      "create",
      JSON.stringify({
        title: "Fix the bug",
        status: "blocked",
        after: "20260101-000000",
        body: "detail",
      }),
      "--project",
      "proj",
    ]);
  });

  it("omits absent optional keys from the JSON object", () => {
    const args = buildCreateArgs({ title: "t", status: "draft" });
    assert.deepEqual(args, ["create", '{"title":"t","status":"draft"}']);
  });

  it("passes an empty body through as a JSON key", () => {
    const args = buildCreateArgs({ title: "t", body: "" });
    assert.deepEqual(args, ["create", '{"title":"t","body":""}']);
  });
});

describe("ticket_set args", () => {
  it("serializes status into the JSON object without a selector (next)", () => {
    assert.deepEqual(buildSetArgs({ status: "closed" }), ["set", '{"status":"closed"}']);
  });

  it("combines selector, after, and project in CLI order", () => {
    assert.deepEqual(buildSetArgs({ selector: "abc", after: null, project: "proj" }), [
      "set",
      "abc",
      '{"after":null}',
      "--project",
      "proj",
    ]);
  });

  it("serializes status and after together with the explicit-status rule left to the CLI", () => {
    assert.deepEqual(buildSetArgs({ selector: "abc", status: "open", after: "20260101-000000" }), [
      "set",
      "abc",
      '{"status":"open","after":"20260101-000000"}',
    ]);
  });

  it("throws without running the CLI when status and after are both absent", () => {
    assert.throws(() => buildSetArgs({ selector: "abc" }), /nothing to set/);
  });
});

describe("ticket_edit args", () => {
  it("builds edit args with an option terminator before old and new", () => {
    assert.deepEqual(buildEditArgs({ old: "- old", new: "- new" }), [
      "edit",
      "--",
      "- old",
      "- new",
    ]);
  });

  it("places project and selector before the option terminator", () => {
    assert.deepEqual(buildEditArgs({ selector: "abc", old: "a", new: "b", project: "proj" }), [
      "edit",
      "--project",
      "proj",
      "abc",
      "--",
      "a",
      "b",
    ]);
  });

  it("passes an empty new through (deletion)", () => {
    assert.deepEqual(buildEditArgs({ selector: "abc", old: "a", new: "" }), [
      "edit",
      "abc",
      "--",
      "a",
      "",
    ]);
  });

  it("throws without running the CLI when old is empty", () => {
    assert.throws(() => buildEditArgs({ old: "", new: "b" }), /old must be a non-empty string/);
  });
});

describe("CLI invocation (SPEC: tools run the CLI without --json; the details refetch adds it)", () => {
  it("appends --json to ordinary tool args", () => {
    assert.deepEqual(appendJsonFlag(["list"]), ["list", "--json"]);
  });

  it("places --json before an option terminator", () => {
    assert.deepEqual(appendJsonFlag(["edit", "--", "- old", "- new"]), [
      "edit",
      "--json",
      "--",
      "- old",
      "- new",
    ]);
  });
});

describe("tool descriptions", () => {
  it("names the CLI subcommand for each tool", () => {
    assert.match(ticketToolDescriptions.ticket_list, /`ticket list`/);
    assert.match(ticketToolDescriptions.ticket_show, /`ticket show`/);
    assert.match(ticketToolDescriptions.ticket_create, /`ticket create`/);
    assert.match(ticketToolDescriptions.ticket_set, /`ticket set`/);
    assert.match(ticketToolDescriptions.ticket_edit, /`ticket edit`/);
  });

  it("mentions next-default selector resolution in the selector-taking tools", () => {
    for (const description of [
      ticketToolDescriptions.ticket_show,
      ticketToolDescriptions.ticket_set,
      ticketToolDescriptions.ticket_edit,
    ]) {
      assert.match(description, /next/);
      assert.match(description, /一意な接頭辞/);
    }
  });

  it("explains each tool's arguments", () => {
    const list = ticketToolDescriptions.ticket_list;
    assert.match(list, /status/);
    assert.match(list, /all/);
    assert.match(list, /project/);

    const create = ticketToolDescriptions.ticket_create;
    assert.match(create, /title/);
    assert.match(create, /body/);
    assert.match(create, /status/);
    assert.match(create, /after/);
    assert.match(create, /project/);

    const show = ticketToolDescriptions.ticket_show;
    assert.match(show, /project/);

    const set = ticketToolDescriptions.ticket_set;
    assert.match(set, /status/);
    assert.match(set, /after/);
    assert.match(set, /selector/);
    assert.match(set, /project/);

    const edit = ticketToolDescriptions.ticket_edit;
    assert.match(edit, /\bold\b/);
    assert.match(edit, /\bnew\b/);
    assert.match(edit, /selector/);
    assert.match(edit, /ticket_show/);
    assert.match(edit, /改行も含めて/);
  });

  it("describes the cwd-derived project default for every tool", () => {
    for (const description of Object.values(ticketToolDescriptions)) {
      assert.match(
        description,
        /project.*省略時はセッションの作業ディレクトリからプロジェクトを特定/,
      );
    }
  });

  it("describes ticket_set behavior: linkage, explicit status, closed release, and validation", () => {
    const description = ticketToolDescriptions.ticket_set;
    assert.match(description, /status.*明示しない場合.*blocked/);
    assert.match(description, /closed.*blocked.*open/);
    assert.match(description, /循環する依存関係は CLI が拒否/);
  });
});

describe("registration", () => {
  const expectedTools = [
    {
      name: "ticket_list",
      description: ticketToolDescriptions.ticket_list,
      promptSnippet: ticketToolPromptSnippets.ticket_list,
    },
    {
      name: "ticket_show",
      description: ticketToolDescriptions.ticket_show,
      promptSnippet: ticketToolPromptSnippets.ticket_show,
    },
    {
      name: "ticket_create",
      description: ticketToolDescriptions.ticket_create,
      promptSnippet: ticketToolPromptSnippets.ticket_create,
    },
    {
      name: "ticket_set",
      description: ticketToolDescriptions.ticket_set,
      promptSnippet: ticketToolPromptSnippets.ticket_set,
    },
    {
      name: "ticket_edit",
      description: ticketToolDescriptions.ticket_edit,
      promptSnippet: ticketToolPromptSnippets.ticket_edit,
    },
  ];

  it("registers the five ticket tools in order", () => {
    assert.deepEqual(
      captureTools().map((tool) => tool.name),
      expectedTools.map((tool) => tool.name),
    );
  });

  it("gives every tool its description and a single-line promptSnippet", () => {
    const tools = captureTools();
    assert.deepEqual(
      tools.map(({ name, description, promptSnippet, parameters }) => ({
        name,
        description,
        promptSnippet,
        hasParameters: parameters !== undefined,
      })),
      expectedTools.map((tool) => ({ ...tool, hasParameters: true })),
    );
    for (const tool of tools) {
      assert.ok(!tool.promptSnippet?.includes("\n"));
    }
  });
});

describe("tool parameter schemas (SPEC: ticket/SPEC.md per-tool args)", () => {
  interface SchemaNode {
    type?: string;
    minLength?: number;
    anyOf?: SchemaNode[];
    properties?: Record<string, SchemaNode>;
    items?: SchemaNode;
    required?: string[];
  }

  function schemaOf(name: string): SchemaNode {
    const tool = findTool(captureTools(), name);
    assert.ok(tool.parameters, `${name} has a parameters schema`);
    return tool.parameters as SchemaNode;
  }

  // Asserts each property exists with the given type and is not required.
  function assertOptionalProps(schema: SchemaNode, expected: Record<string, string>): void {
    const required = schema.required ?? [];
    for (const [name, type] of Object.entries(expected)) {
      const property = schema.properties?.[name];
      assert.ok(property, `${name} is defined`);
      assert.equal(property.type, type);
      assert.ok(!required.includes(name), `${name} is optional`);
    }
  }

  it("ticket_list: status (string array), project, all — all optional", () => {
    const schema = schemaOf("ticket_list");
    assert.equal(schema.type, "object");
    assertOptionalProps(schema, { status: "array", project: "string", all: "boolean" });
    assert.equal(schema.properties?.status?.items?.type, "string");
  });

  it("ticket_show: selector and project optional", () => {
    const schema = schemaOf("ticket_show");
    assertOptionalProps(schema, { selector: "string", project: "string" });
    assert.equal(schema.required, undefined);
  });

  it("ticket_create: title required, body/status/after/project optional strings", () => {
    const schema = schemaOf("ticket_create");
    assert.equal(schema.properties?.title?.type, "string");
    assert.deepEqual(schema.required, ["title"]);
    assertOptionalProps(schema, {
      body: "string",
      status: "string",
      after: "string",
      project: "string",
    });
  });

  it("ticket_set: selector, status, after (string or null), project optional", () => {
    const schema = schemaOf("ticket_set");
    assertOptionalProps(schema, { selector: "string", status: "string", project: "string" });
    const after = schema.properties?.after;
    assert.ok(after?.anyOf, "after is a string-or-null union");
    assert.deepEqual(
      after.anyOf.map((variant) => variant.type),
      ["string", "null"],
    );
  });

  it("ticket_edit: selector optional, old and new required strings", () => {
    const schema = schemaOf("ticket_edit");
    assert.deepEqual(schema.required, ["old", "new"]);
    assertOptionalProps(schema, { selector: "string", project: "string" });
    assert.equal(schema.properties?.old?.type, "string");
    assert.equal(schema.properties?.old?.minLength, 1);
    assert.equal(schema.properties?.new?.type, "string");
    assert.equal(schema.properties?.new?.minLength, undefined);
  });
});

const LIST_ENTRY = {
  id: "20260101-000000",
  status: "open",
  title: "A",
  after: null,
  path: "/p/a.md",
};
const LIST_JSON = JSON.stringify([LIST_ENTRY]);
const LIST_TEXT = "20260101-000000\topen\tA\n";
const ALL_LIST_JSON = JSON.stringify([{ ...LIST_ENTRY, project: "proj" }]);
const ALL_LIST_TEXT = `proj\t${LIST_TEXT}`;

describe("ticket tool results", () => {
  const SHOW_TEXT = "id: 20260101-000000\nstatus: open\nafter: -\ntitle: A\n\nbody:\n# A\n";
  const CREATED_TEXT = "created 20260101-000000\nstatus: open\nafter: -\npath: /p/a.md";
  const UPDATED_TEXT = "updated 20260101-000000\nstatus: open\nafter: -\npath: /p/a.md";

  it("ticket_list keeps the CLI text format and order without details", async () => {
    const latest = { ...LIST_ENTRY, id: "20260101-000001", title: "日本語\tTitle" };
    const fake = fakeRunner(JSON.stringify([latest, LIST_ENTRY]));
    const result = await exec(findTool(captureTools(fake), "ticket_list"), {});
    assert.deepEqual(fake.calls, [{ args: ["list", "--json"], cwd: SESSION_CWD }]);
    assert.deepEqual(result.content, [
      { type: "text", text: `20260101-000001\topen\t日本語\tTitle\n${LIST_TEXT}` },
    ]);
    assert.equal(result.details, undefined);
  });

  it("ticket_list keeps the project column when using --all", async () => {
    const fake = fakeRunner(ALL_LIST_JSON);
    const result = await exec(findTool(captureTools(fake), "ticket_list"), { all: true });
    assert.deepEqual(fake.calls[0]?.args, ["list", "--all", "--json"]);
    assert.deepEqual(result.content, [{ type: "text", text: ALL_LIST_TEXT }]);
  });

  it("ticket_list keeps the empty message and trailing newline", async () => {
    const result = await exec(findTool(captureTools(fakeRunner("[]")), "ticket_list"), {});
    assert.deepEqual(result.content, [{ type: "text", text: "no tickets\n" }]);
    assert.equal(result.details, undefined);
  });

  it("ticket_list rejects invalid result shapes without retrying", async () => {
    const cases = [
      { stdout: "{}", params: {} },
      { stdout: '[{"id":"missing fields"}]', params: {} },
      { stdout: LIST_JSON, params: { all: true } },
      { stdout: ALL_LIST_JSON, params: {} },
    ];
    for (const { stdout, params } of cases) {
      const fake = fakeRunner(stdout);
      const tool = findTool(captureTools(fake), "ticket_list");
      await assert.rejects(() => exec(tool, params), /Invalid ticket list JSON/);
      assert.equal(fake.calls.length, 1);
    }
  });

  it("ticket_show returns the CLI stdout as content without details", async () => {
    const fake = fakeRunner(SHOW_TEXT);
    const result = await exec(findTool(captureTools(fake), "ticket_show"), { selector: "a" });
    assert.deepEqual(
      fake.calls.map((call) => call.args),
      [["show", "a"]],
    );
    assert.deepEqual(result.content, [{ type: "text", text: SHOW_TEXT }]);
    assert.equal(result.details, undefined);
  });

  it("truncates oversized ticket_list content and returns the complete JSON from one call", async () => {
    const listJson = Array.from({ length: 2_100 }, (_, index) => ({
      id: `20260101-${String(index).padStart(6, "0")}`,
      status: "open",
      title: "A",
      after: null,
      path: `/p/${index}.md`,
    }));
    const fake = fakeRunner(JSON.stringify(listJson));
    const result = await exec(findTool(captureTools(fake), "ticket_list"), {});
    const text = result.content[0]!.text;
    assert.match(text, /Output truncated/);
    assert.ok(Buffer.byteLength(text, "utf8") <= DEFAULT_MAX_BYTES);
    assert.ok(text.split("\n").length <= DEFAULT_MAX_LINES);
    assert.deepEqual(result.details, listJson);
    assert.deepEqual(fake.calls, [{ args: ["list", "--json"], cwd: SESSION_CWD }]);
  });

  it("truncates oversized ticket_show content and refetches the complete JSON as details", async () => {
    const body = "line\n".repeat(2_100);
    const showJson = {
      id: "20260101-000000",
      status: "open",
      title: "A",
      after: null,
      path: "/p/a.md",
      body,
    };
    const fake = fakeRunner((args) =>
      args.includes("--json")
        ? JSON.stringify(showJson)
        : `id: 20260101-000000\nstatus: open\nafter: -\ntitle: A\n\nbody:\n${body}`,
    );
    const result = await exec(findTool(captureTools(fake), "ticket_show"), {});
    const text = result.content[0]!.text;
    assert.match(text, /Output truncated/);
    assert.ok(Buffer.byteLength(text, "utf8") <= DEFAULT_MAX_BYTES);
    assert.ok(text.split("\n").length <= DEFAULT_MAX_LINES);
    assert.deepEqual(result.details, showJson);
    assert.deepEqual(fake.calls[1]?.args, ["show", "--json"]);
  });

  it("keeps the byte limit when ticket_show truncates a large body", async () => {
    const body = `${"x".repeat(200)}\n`.repeat(400);
    const fake = fakeRunner((args) =>
      args.includes("--json")
        ? JSON.stringify({ body })
        : `id: 20260101-000000\nstatus: open\nafter: -\ntitle: A\n\nbody:\n${body}`,
    );
    const result = await exec(findTool(captureTools(fake), "ticket_show"), {});
    const text = result.content[0]!.text;
    assert.match(text, /Output truncated/);
    assert.ok(Buffer.byteLength(text, "utf8") <= DEFAULT_MAX_BYTES);
    assert.ok(text.split("\n").length <= DEFAULT_MAX_LINES);
  });

  it("write tools return the CLI stdout as content without refetching", async () => {
    const cases: Array<[string, Record<string, unknown>, string[]]> = [
      ["ticket_create", { title: "t" }, ["create", '{"title":"t"}']],
      ["ticket_set", { status: "closed" }, ["set", '{"status":"closed"}']],
      ["ticket_edit", { old: "a", new: "b" }, ["edit", "--", "a", "b"]],
    ];
    for (const [name, params, args] of cases) {
      const fake = fakeRunner(UPDATED_TEXT);
      const result = await exec(findTool(captureTools(fake), name), params);
      assert.deepEqual(
        fake.calls.map((call) => call.args),
        [args],
      );
      assert.deepEqual(result.content, [{ type: "text", text: UPDATED_TEXT }]);
      assert.equal(result.details, undefined);
    }
  });

  it("ticket_create returns the created text from the CLI", async () => {
    const result = await exec(findTool(captureTools(fakeRunner(CREATED_TEXT)), "ticket_create"), {
      title: "A",
    });
    assert.deepEqual(result.content, [{ type: "text", text: CREATED_TEXT }]);
  });

  it("ticket_set rejects without calling the runner when status and after are both absent", async () => {
    const fake = fakeRunner(UPDATED_TEXT);
    const tool = findTool(captureTools(fake), "ticket_set");
    await assert.rejects(() => exec(tool, { selector: "a" }), /nothing to set/);
    assert.equal(fake.calls.length, 0);
  });

  it("ticket_edit rejects without calling the runner when old is empty", async () => {
    const fake = fakeRunner(UPDATED_TEXT);
    const tool = findTool(captureTools(fake), "ticket_edit");
    await assert.rejects(() => exec(tool, { old: "", new: "b" }), /old must be a non-empty string/);
    assert.equal(fake.calls.length, 0);
  });

  it("propagates the runner error text as the tool failure", async () => {
    const tool = findTool(
      captureTools({ runCli: () => Promise.reject(new Error("error: unknown id prefix")) }),
      "ticket_show",
    );
    await assert.rejects(() => exec(tool, { selector: "nope" }), /error: unknown id prefix/);
  });

  it("passes ctx.cwd to the runner", async () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["ticket_list", {}, LIST_JSON],
      ["ticket_show", { selector: "a" }, SHOW_TEXT],
      ["ticket_create", { title: "t" }, CREATED_TEXT],
      ["ticket_set", { status: "closed" }, UPDATED_TEXT],
      ["ticket_edit", { old: "a", new: "b" }, UPDATED_TEXT],
    ];
    for (const [name, params, resolved] of cases) {
      const fake = fakeRunner(resolved);
      const tool = findTool(captureTools(fake), name);
      await exec(tool, params);
      assert.deepEqual(
        fake.calls.map((call) => call.cwd),
        [SESSION_CWD],
      );
    }
  });
});

function cliFrame(stdout = "", stderr = "", code = 0): string {
  return [
    "PI_CLI_V1:" + code,
    Buffer.from(stdout).toString("base64"),
    Buffer.from(stderr).toString("base64"),
    "PI_CLI_END",
    "",
  ].join("\n");
}

function bashOutcome(output: string, overrides: Record<string, unknown> = {}) {
  return {
    toolCall: { type: "toolCall" as const, id: "nested", name: "bash", arguments: {} },
    isError: false,
    result: {
      content: [{ type: "text" as const, text: output }],
      details: {},
      structuredContent: { output, truncated: false, exit_code: 0, ...overrides },
    },
  };
}

const toolCases: Array<[string, Record<string, unknown>, string[]]> = [
  [
    "ticket_list",
    { project: "p ' \"\n$HOME", status: ["open", "closed"], all: true },
    ["list", "--all", "--status", "open,closed", "--project", "p ' \"\n$HOME", "--json"],
  ],
  ["ticket_show", { selector: "a'\n$(id)" }, ["show", "a'\n$(id)"]],
  [
    "ticket_create",
    { title: "t'\n`id`", body: "", after: "a" },
    ["create", JSON.stringify({ title: "t'\n`id`", after: "a", body: "" })],
  ],
  ["ticket_set", { selector: "a", after: null }, ["set", "a", '{"after":null}']],
  ["ticket_edit", { old: "-- '\n$(id);", new: "" }, ["edit", "--", "-- '\n$(id);", ""]],
];

describe("registered Bash ticket routing", () => {
  for (const [name, params] of toolCases) {
    it("routes " + name + " through the current registered Bash without a timeout", async () => {
      const signal = new AbortController().signal;
      const stdout = name === "ticket_list" ? ALL_LIST_JSON : " \noutput\n\n";
      const text = name === "ticket_list" ? ALL_LIST_TEXT : stdout;
      const calls: string[] = [];
      const ctx = {
        cwd: "/tmp/session '\n$(id)",
        async executeTool(toolName: string, args: unknown, options?: { signal?: AbortSignal }) {
          assert.equal(toolName, "bash");
          assert.equal(options?.signal, signal);
          assert.equal(Object.hasOwn(args as object, "timeout"), false);
          const command = (args as { command: string }).command;
          assert.match(command, /cd -- /);
          const executable = process.platform === "win32" ? "ticket.exe" : "ticket";
          assert.ok(command.includes(`/.agents/cli/${executable}'`));
          calls.push(command);
          return bashOutcome(cliFrame(stdout));
        },
      };
      const result = await findTool(captureTools(), name).execute!(
        "call",
        params,
        signal,
        undefined,
        ctx,
      );
      assert.deepEqual(result.content, [{ type: "text", text }]);
      assert.equal(calls.length, 1);
    });

    for (const reason of [
      "Unknown tool: bash",
      "Command denied by user",
      "Session context is no longer active",
    ]) {
      it("fails " + name + " without fallback: " + reason, async () => {
        let calls = 0;
        const original = { ...bashOutcome(reason), isError: true };
        const ctx = {
          cwd: SESSION_CWD,
          async executeTool() {
            calls++;
            return original;
          },
        };
        const result = await findTool(captureTools(), name).execute!(
          "call",
          params,
          undefined,
          undefined,
          ctx,
        );
        assert.equal(result.isError, true);
        assert.equal(result.content[0]!.text, reason);
        assert.strictEqual(
          (result.details as { bash: { result: unknown } }).bash.result,
          original.result,
        );
        assert.equal((result.details as { bash: { isError: boolean } }).bash.isError, true);
        assert.equal(calls, 1);
      });
    }
  }

  it("keeps ticket writes sequential and reads parallel", () => {
    const tools = captureTools();
    for (const name of ["ticket_create", "ticket_set", "ticket_edit"]) {
      assert.equal(findTool(tools, name).executionMode, "sequential");
    }
    for (const name of ["ticket_list", "ticket_show"]) {
      assert.equal(findTool(tools, name).executionMode, undefined);
    }
  });

  for (const name of ["ticket_list", "ticket_show"]) {
    it("preserves complete multi-MiB JSON details for " + name, async () => {
      const body = "日本語\n".repeat(150_000);
      const json =
        name === "ticket_list" ? [{ ...LIST_ENTRY, title: "日本語".repeat(150_000) }] : { body };
      const jsonCall = name === "ticket_list" ? 1 : 2;
      const output = cliFrame(JSON.stringify(json));
      const signal = new AbortController().signal;
      const calls: string[] = [];
      const ctx = {
        cwd: SESSION_CWD,
        async executeTool(toolName: string, args: unknown, options?: { signal?: AbortSignal }) {
          assert.equal(toolName, "bash");
          assert.equal(options?.signal, signal);
          assert.equal(Object.hasOwn(args as object, "timeout"), false);
          const command = (args as { command: string }).command;
          calls.push(command);
          if (calls.length < jsonCall) return bashOutcome(cliFrame(body));
          if (calls.length === jsonCall) {
            assert.match(command, /'--json'/);
            return bashOutcome("partial", { truncated: true, full_output_path: "/tmp/output" });
          }
          if (calls.length === jsonCall + 1) return bashOutcome(String(output.length));
          const chunk = calls.length - jsonCall - 2;
          return bashOutcome(output.slice(chunk * 524_288, (chunk + 1) * 524_288));
        },
      };
      const result = await findTool(captureTools(), name).execute!(
        "call",
        {},
        signal,
        undefined,
        ctx,
      );
      assert.deepEqual(result.details, json);
      assert.match(result.content[0]!.text, /Output truncated/);
      assert.ok(Buffer.byteLength(result.content[0]!.text) <= DEFAULT_MAX_BYTES);
      assert.ok(result.content[0]!.text.split("\n").length <= DEFAULT_MAX_LINES);
      assert.equal(calls.length, jsonCall + 1 + Math.ceil(output.length / 524_288));
    });

    it("fails " + name + " if the JSON request is denied or malformed", async () => {
      for (const response of [
        { ...bashOutcome("denied"), isError: true },
        bashOutcome(cliFrame("{bad")),
      ]) {
        let calls = 0;
        const ctx = {
          cwd: SESSION_CWD,
          async executeTool() {
            calls++;
            if (name === "ticket_show" && calls === 1)
              return bashOutcome(cliFrame("line\n".repeat(2_100)));
            return response;
          },
        };
        const pending = findTool(captureTools(), name).execute!(
          "call",
          {},
          undefined,
          undefined,
          ctx,
        );
        if (response.isError) {
          const result = await pending;
          assert.equal(result.isError, true);
          assert.strictEqual(
            (result.details as { bash: { result: unknown } }).bash.result,
            response.result,
          );
        } else await assert.rejects(pending);
        assert.equal(calls, name === "ticket_list" ? 1 : 2);
      }
    });

    it("stops " + name + " when cancellation arrives during output handling", async () => {
      const controller = new AbortController();
      let calls = 0;
      const stdout = name === "ticket_list" ? LIST_JSON : "line\n".repeat(2_100);
      const frame = cliFrame(stdout);
      const output = bashOutcome(frame);
      Object.defineProperty(output.result, "structuredContent", {
        get() {
          controller.abort();
          return { output: frame, truncated: false, exit_code: 0 };
        },
      });
      const ctx = {
        cwd: SESSION_CWD,
        async executeTool() {
          calls++;
          return output;
        },
      };
      const result = await findTool(captureTools(), name).execute!(
        "call",
        {},
        controller.signal,
        undefined,
        ctx,
      );
      assert.equal(result.isError, true);
      assert.match(result.content[0]!.text, /aborted/);
      assert.strictEqual(
        (result.details as { bash: { result: unknown } }).bash.result,
        output.result,
      );
      assert.strictEqual((result.details as { reason: unknown }).reason, controller.signal.reason);
      assert.equal(calls, 1);
    });
  }
});

describe("ticket CLI through an actual Bash implementation", () => {
  const stubDirs: string[] = [];
  const cwd = tmpdir();
  const bashTool = createBashTool(cwd);
  const ctx = {
    cwd,
    async executeTool(name: string, args: unknown, options?: { signal?: AbortSignal }) {
      assert.equal(name, "bash");
      const result = await bashTool.execute("nested", args as never, options?.signal);
      return { ...bashOutcome(""), result, isError: result.isError ?? false };
    },
  };

  async function installStub(script: string): Promise<string> {
    const fixtureRoot = process.platform === "win32" ? cwd : "/tmp/work/dotfiles";
    await mkdir(fixtureRoot, { recursive: true });
    const dir = await mkdtemp(join(fixtureRoot, "ticket 日本語 cli'-"));
    stubDirs.push(dir);
    const path = join(dir, "ticket stub'");
    await writeFile(path, `#!/usr/bin/env bun\n${script}`);
    await chmod(path, 0o755);
    return path;
  }

  afterEach(async () => {
    for (const dir of stubDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  for (const [name, params, expectedArgs] of toolCases) {
    it("preserves arguments and cwd for " + name, async () => {
      const cliPath = await installStub(
        `await Bun.write("received.json", JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
console.log(${JSON.stringify(name === "ticket_list" ? ALL_LIST_JSON : "output")});`,
      );
      const cwd = dirname(cliPath);
      const deps: TicketsExtensionDeps = {
        runCli(args, sessionCwd, signal, toolCtx) {
          return spawnTicketCli(args, sessionCwd, signal, toolCtx, { cliPath });
        },
      };
      await findTool(captureTools(deps), name).execute!("call", params, undefined, undefined, {
        ...ctx,
        cwd,
      });
      const received = JSON.parse(await readFile(join(cwd, "received.json"), "utf8"));
      assert.deepEqual(received.argv, expectedArgs);
      assert.equal(received.cwd, cwd);
    });
  }

  it("preserves stdout whitespace and trailing newlines", async () => {
    const cliPath = await installStub('process.stdout.write(" \\nbody  \\n\\n");');
    const stdout = await spawnTicketCli(["show"], cwd, undefined, ctx, { cliPath });
    assert.equal(stdout, " \nbody  \n\n");
  });

  it("removes only one trailing newline from CLI error text", async () => {
    const cliPath = await installStub(
      'process.stderr.write("error: body  \\n\\n"); process.exit(1);',
    );
    await assert.rejects(
      spawnTicketCli(["edit"], cwd, undefined, ctx, { cliPath }),
      new Error("error: body  \n"),
    );
  });

  it("reports an exit code when stderr is empty", async () => {
    const cliPath = await installStub("process.exit(2);");
    await assert.rejects(
      spawnTicketCli(["list"], cwd, undefined, ctx, { cliPath }),
      /ticket exited with code 2/,
    );
  });

  it("fails when the executable is absent", async () => {
    await assert.rejects(
      spawnTicketCli(["list"], cwd, undefined, ctx, { cliPath: join(cwd, "absent-ticket-cli") }),
      /No such file/,
    );
  });

  it("fails without launching the CLI when cwd does not exist", async () => {
    const cliPath = await installStub('console.log("must not succeed");');
    await assert.rejects(
      spawnTicketCli(["list"], "/nonexistent/session", undefined, ctx, { cliPath }),
      /cd:.*No such file/,
    );
  });

  it("cancels an active CLI through Bash", async () => {
    const cliPath = await installStub("setTimeout(() => {}, 60000);");
    await assert.rejects(
      spawnTicketCli(["list"], cwd, AbortSignal.timeout(100), ctx, { cliPath }),
      /aborted/,
    );
  });

  it("retains complete large JSON details through actual Bash output recovery", async () => {
    const cliPath = await installStub(
      'const body = "日本語\\n".repeat(150000); process.stdout.write(process.argv.includes("--json") ? JSON.stringify({ body }) : body);',
    );
    const deps: TicketsExtensionDeps = {
      runCli(args, cwd, signal, toolCtx) {
        return spawnTicketCli(args, cwd, signal, toolCtx, { cliPath });
      },
    };
    const result = await findTool(captureTools(deps), "ticket_show").execute!(
      "call",
      {},
      undefined,
      undefined,
      ctx,
    );
    assert.deepEqual(result.details, { body: "日本語\n".repeat(150_000) });
    assert.match(result.content[0]!.text, /Output truncated/);
  });
});

describe("public ticket failure diagnostics", () => {
  for (const [name, params] of toolCases)
    for (const outer of [false, true]) {
      it(`retains ${name} Bash details and inner/outer errors ${outer}`, async () => {
        const response = {
          ...bashOutcome("denied"),
          isError: outer,
          result: {
            content: [{ type: "text" as const, text: "denied" }],
            isError: !outer,
            details: { evidence: "original" },
            structuredContent: {
              output: "denied",
              exit_code: 2,
              truncated: false,
              full_output_path: "/tmp/original",
            },
          },
        };
        const result = await findTool(captureTools(), name).execute!(
          "failure",
          params,
          undefined,
          undefined,
          {
            cwd: SESSION_CWD,
            async executeTool() {
              return response;
            },
          },
        );
        assert.equal(result.isError, true);
        const details = result.details as { bash: { result: unknown; isError: boolean } };
        assert.strictEqual(details.bash.result, response.result);
        assert.equal(details.bash.isError, outer);
      });
    }
  it("keeps SDK exception identity at the registered tool", async () => {
    const failure = new Error("Expired SDK context");
    await assert.rejects(
      findTool(captureTools(), "ticket_list").execute!("throw", {}, undefined, undefined, {
        cwd: SESSION_CWD,
        async executeTool() {
          throw failure;
        },
      }),
      (error) => error === failure,
    );
  });
});
