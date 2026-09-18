import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import {
  formatTicketCreated,
  formatTicketList,
  formatTicketShow,
  formatTicketUpdated,
  ticketCliArgs,
  TicketCliError,
} from "@dotfiles/agent-lib/ticket";
import ticketsExtension, {
  buildCreateArgs,
  buildListArgs,
  buildShowArgs,
  buildUpdateArgs,
  ticketToolDescriptions,
  ticketToolPromptSnippets,
  type TicketsExtensionDeps,
} from "./index";

// Session cwd passed to execute() in tests; execute must forward it to the runner.
const SESSION_CWD = "/tmp/ticket-session";

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: unknown;
}

interface CapturedTool {
  name: string;
  description: string;
  promptSnippet?: string;
  parameters?: unknown;
  execute?: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: { cwd: string },
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
  return tool.execute!("toolCall", params, undefined, undefined, { cwd: SESSION_CWD });
}

// Fake CLI runner resolving with `resolved` and recording every call.
function fakeRunner(resolved: unknown): TicketsExtensionDeps & {
  calls: Array<{ args: string[]; cwd: string }>;
} {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  return {
    calls,
    runCli: (args, cwd) => {
      calls.push({ args, cwd });
      return Promise.resolve(resolved);
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
  it("builds show args with the id", () => {
    assert.deepEqual(buildShowArgs({ id: "20260101-000000_slug" }), [
      "show",
      "20260101-000000_slug",
    ]);
  });

  it("appends --project when given", () => {
    assert.deepEqual(buildShowArgs({ id: "abc", project: "proj" }), [
      "show",
      "abc",
      "--project",
      "proj",
    ]);
  });
});

describe("ticket_create args", () => {
  it("builds create args with title only", () => {
    assert.deepEqual(buildCreateArgs({ title: "Fix the bug" }), ["create", "Fix the bug"]);
  });

  it("combines all options in CLI order", () => {
    assert.deepEqual(
      buildCreateArgs({
        title: "Fix the bug",
        status: "blocked",
        depends_on: ["20260101-000000_a", "b"],
        body: "detail",
        project: "proj",
      }),
      [
        "create",
        "Fix the bug",
        "--status",
        "blocked",
        "--depends-on",
        "20260101-000000_a,b",
        "--body",
        "detail",
        "--project",
        "proj",
      ],
    );
  });

  it("omits --depends-on for an empty array", () => {
    assert.deepEqual(buildCreateArgs({ title: "t", depends_on: [] }), ["create", "t"]);
  });

  it("passes an empty body through as --body", () => {
    assert.deepEqual(buildCreateArgs({ title: "t", body: "" }), ["create", "t", "--body", ""]);
  });
});

describe("ticket_update args", () => {
  it("serializes metadata to --metadata as JSON", () => {
    assert.deepEqual(buildUpdateArgs({ id: "abc", metadata: { status: "closed" } }), [
      "update",
      "abc",
      "--metadata",
      JSON.stringify({ status: "closed" }),
    ]);
  });

  it("builds body-only update args", () => {
    assert.deepEqual(buildUpdateArgs({ id: "abc", body: "new body" }), [
      "update",
      "abc",
      "--body",
      "new body",
    ]);
  });

  it("combines metadata, body, and project in CLI order", () => {
    assert.deepEqual(
      buildUpdateArgs({
        id: "abc",
        metadata: { depends_on: ["x"] },
        body: "b",
        project: "proj",
      }),
      ["update", "abc", "--metadata", JSON.stringify({ depends_on: ["x"] }), "--body", "b", "--project", "proj"],
    );
  });

  it("passes an empty metadata object through as --metadata", () => {
    assert.deepEqual(buildUpdateArgs({ id: "abc", metadata: {} }), [
      "update",
      "abc",
      "--metadata",
      "{}",
    ]);
  });

  it("throws without running the CLI when metadata and body are both absent", () => {
    assert.throws(() => buildUpdateArgs({ id: "abc" }), /nothing to update/);
  });
});

describe("CLI invocation (SPEC: the CLI is spawned with --json)", () => {
  it("ticketCliArgs appends --json to the tool args", () => {
    assert.deepEqual(ticketCliArgs(["list"]), ["list", "--json"]);
  });
});

describe("tool descriptions", () => {
  it("names the CLI subcommand for each tool", () => {
    assert.match(ticketToolDescriptions.ticket_list, /`ticket list`/);
    assert.match(ticketToolDescriptions.ticket_show, /`ticket show`/);
    assert.match(ticketToolDescriptions.ticket_create, /`ticket create`/);
    assert.match(ticketToolDescriptions.ticket_update, /`ticket update`/);
  });

  it("mentions unique-prefix ID resolution in every description", () => {
    for (const description of Object.values(ticketToolDescriptions)) {
      assert.match(description, /prefix/i);
    }
  });

  it("describes ticket_update failure modes: locked exclusivity and open dependency resolution", () => {
    const description = ticketToolDescriptions.ticket_update;
    assert.match(description, /locked/i);
    assert.match(description, /exclusivity/i);
    assert.match(description, /open ticket/i);
    assert.match(description, /depend/i);
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
      name: "ticket_update",
      description: ticketToolDescriptions.ticket_update,
      promptSnippet: ticketToolPromptSnippets.ticket_update,
    },
  ];

  it("registers the four ticket tools in order", () => {
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

describe("tool parameter schemas (SPEC: ticket-tools.spec.md per-tool args)", () => {
  interface SchemaNode {
    type?: string;
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

  it("ticket_show: id required string, project optional", () => {
    const schema = schemaOf("ticket_show");
    assert.equal(schema.properties?.id?.type, "string");
    assert.deepEqual(schema.required, ["id"]);
    assertOptionalProps(schema, { project: "string" });
  });

  it("ticket_create: title required, body/status/depends_on/project optional", () => {
    const schema = schemaOf("ticket_create");
    assert.equal(schema.properties?.title?.type, "string");
    assert.deepEqual(schema.required, ["title"]);
    assertOptionalProps(schema, { body: "string", status: "string", depends_on: "array", project: "string" });
    assert.equal(schema.properties?.depends_on?.items?.type, "string");
  });

  it("ticket_update: id required, metadata/body/project optional", () => {
    const schema = schemaOf("ticket_update");
    assert.equal(schema.properties?.id?.type, "string");
    assert.deepEqual(schema.required, ["id"]);
    assertOptionalProps(schema, { metadata: "object", body: "string", project: "string" });
  });
});

describe("tool execute", () => {
  it("ticket_list formats the runner JSON into content and returns it as details", async () => {
    const json = [
      { id: "20260101-000000_a", status: "open", title: "A", depends_on: [], path: "/p/a.md" },
    ];
    const result = await exec(findTool(captureTools(fakeRunner(json)), "ticket_list"), {});
    assert.deepEqual(result.details, json);
    assert.deepEqual(result.content, [{ type: "text", text: formatTicketList(json, false) }]);

    const allJson = [
      {
        id: "20260101-000000_a",
        status: "open",
        title: "A",
        depends_on: [],
        path: "/p/a.md",
        project: "proj",
      },
    ];
    const allResult = await exec(findTool(captureTools(fakeRunner(allJson)), "ticket_list"), {
      all: true,
    });
    assert.deepEqual(allResult.content, [{ type: "text", text: formatTicketList(allJson, true) }]);
  });

  it("ticket_show formats the runner JSON into content and returns it as details", async () => {
    const json = {
      id: "20260101-000000_a",
      status: "open",
      title: "A",
      depends_on: ["20260101-000000_b"],
      path: "/p/a.md",
      body: "ticket body\n",
    };
    const result = await exec(findTool(captureTools(fakeRunner(json)), "ticket_show"), { id: "a" });
    assert.deepEqual(result.details, json);
    assert.deepEqual(result.content, [{ type: "text", text: formatTicketShow(json) }]);
  });

  it("ticket_create formats the runner JSON into content and returns it as details", async () => {
    const json = { id: "20260101-000000_a", status: "open", title: "A", depends_on: [], path: "/p/a.md" };
    const result = await exec(findTool(captureTools(fakeRunner(json)), "ticket_create"), { title: "A" });
    assert.deepEqual(result.details, json);
    assert.deepEqual(result.content, [{ type: "text", text: formatTicketCreated(json) }]);
  });

  it("ticket_update formats the runner JSON into content and returns it as details", async () => {
    const json = { id: "20260101-000000_a", status: "closed", title: "A", depends_on: [], path: "/p/a.md" };
    const result = await exec(
      findTool(captureTools(fakeRunner(json)), "ticket_update"),
      { id: "a", body: "new body" },
    );
    assert.deepEqual(result.details, json);
    assert.deepEqual(result.content, [{ type: "text", text: formatTicketUpdated(json) }]);
  });

  it("ticket_update rejects without calling the runner when metadata and body are both absent", async () => {
    const fake = fakeRunner({});
    const tool = findTool(captureTools(fake), "ticket_update");
    await assert.rejects(() => exec(tool, { id: "a" }), /nothing to update/);
    assert.equal(fake.calls.length, 0);
  });

  it("rejects with the CLI stderr when the runner throws TicketCliError with stderr", async () => {
    const tool = findTool(
      captureTools({
        runCli: () => Promise.reject(new TicketCliError("error: unknown id prefix", "error: unknown id prefix")),
      }),
      "ticket_show",
    );
    await assert.rejects(() => exec(tool, { id: "nope" }), /error: unknown id prefix/);
  });

  it("falls back to the TicketCliError message when stderr is empty (CLI not executable)", async () => {
    const tool = findTool(
      captureTools({
        runCli: () =>
          Promise.reject(new TicketCliError("", "ticket CLI is not available: spawn ticket ENOENT")),
      }),
      "ticket_show",
    );
    await assert.rejects(() => exec(tool, { id: "a" }), /ticket CLI is not available: spawn ticket ENOENT/);
  });

  it("passes ctx.cwd to the runner for every tool", async () => {
    const ticket = { id: "a", status: "open", title: "t", depends_on: [], path: "/p/a.md", body: "" };
    const cases: Array<[string, Record<string, unknown>, unknown]> = [
      ["ticket_list", {}, []],
      ["ticket_show", { id: "a" }, ticket],
      ["ticket_create", { title: "t" }, ticket],
      ["ticket_update", { id: "a", body: "b" }, ticket],
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
