import assert from "node:assert/strict";
import { afterEach, describe, it } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  formatTicketCreated,
  formatTicketList,
  formatTicketShow,
  formatTicketUpdated,
  runTicketCli,
  ticketCliArgs,
  ticketCliPath,
  TicketCliError,
} from "@dotfiles/agent-lib/ticket";
import ticketsExtension, {
  buildCreateArgs,
  buildEditArgs,
  buildListArgs,
  buildSetArgs,
  buildShowArgs,
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
  it("omits the selector so the CLI defaults to next", () => {
    assert.deepEqual(buildShowArgs({}), ["show"]);
  });

  it("builds show args with the selector", () => {
    assert.deepEqual(buildShowArgs({ selector: "20260101-000000" }), [
      "show",
      "20260101-000000",
    ]);
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
    assert.deepEqual(buildCreateArgs({ title: "Fix the bug" }), ["create", '{"title":"Fix the bug"}']);
  });

  it("serializes every given key into the JSON object", () => {
    const args = buildCreateArgs({
      title: "Fix the bug",
      status: "blocked",
      after: "20260101-000000",
      body: "detail",
      project: "proj",
    });
    assert.deepEqual(args, ["create", JSON.stringify({
      title: "Fix the bug",
      status: "blocked",
      after: "20260101-000000",
      body: "detail",
    }), "--project", "proj"]);
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
  it("builds edit args without a selector (next)", () => {
    assert.deepEqual(buildEditArgs({ old: "a", new: "b" }), ["edit", "a", "b"]);
  });

  it("combines selector, old, new, and project in CLI order", () => {
    assert.deepEqual(buildEditArgs({ selector: "abc", old: "a", new: "b", project: "proj" }), [
      "edit",
      "abc",
      "a",
      "b",
      "--project",
      "proj",
    ]);
  });

  it("passes an empty new through (deletion)", () => {
    assert.deepEqual(buildEditArgs({ selector: "abc", old: "a", new: "" }), [
      "edit",
      "abc",
      "a",
      "",
    ]);
  });

  it("throws without running the CLI when old is empty", () => {
    assert.throws(() => buildEditArgs({ old: "", new: "b" }), /old must be a non-empty string/);
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
      assert.match(description, /prefix/i); // "ID / unique prefix / next" (SPEC: common selector wording)
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

    const set = ticketToolDescriptions.ticket_set;
    assert.match(set, /status/);
    assert.match(set, /after/);
    assert.match(set, /selector/);

    const edit = ticketToolDescriptions.ticket_edit;
    assert.match(edit, /\bold\b/);
    assert.match(edit, /\bnew\b/);
    assert.match(edit, /selector/);
  });

  it("describes ticket_set behavior: linkage, explicit status, closed release, and validation", () => {
    const description = ticketToolDescriptions.ticket_set;
    assert.match(description, /linkage|blocks/i);
    assert.match(description, /closed/);
    assert.match(description, /release/i);
    assert.match(description, /cycle/i);
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

describe("tool parameter schemas (SPEC: ticket-tools.spec.md per-tool args)", () => {
  interface SchemaNode {
    type?: string;
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
    assertOptionalProps(schema, { body: "string", status: "string", after: "string", project: "string" });
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
    assert.equal(schema.properties?.new?.type, "string");
  });
});

describe("tool execute", () => {
  const TICKET_JSON = {
    id: "20260101-000000",
    status: "open",
    title: "A",
    after: null,
    path: "/p/a.md",
    body: "", // formatTicketShow reads it (ticket_show only)
  };

  it("ticket_list formats the runner JSON into content and returns it as details", async () => {
    const json = [
      { id: "20260101-000000", status: "open", title: "A", after: null, path: "/p/a.md" },
    ];
    const result = await exec(findTool(captureTools(fakeRunner(json)), "ticket_list"), {});
    assert.deepEqual(result.details, json);
    assert.deepEqual(result.content, [{ type: "text", text: formatTicketList(json, false) }]);

    const allJson = [
      {
        id: "20260101-000000",
        status: "open",
        title: "A",
        after: "20260101-000001",
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
      id: "20260101-000000",
      status: "open",
      title: "A",
      after: "20260101-000001",
      path: "/p/a.md",
      body: "ticket body\n",
    };
    const result = await exec(findTool(captureTools(fakeRunner(json)), "ticket_show"), { selector: "a" });
    assert.deepEqual(result.details, json);
    assert.deepEqual(result.content, [{ type: "text", text: formatTicketShow(json) }]);
  });

  it("ticket_create formats the runner JSON into content and returns it as details", async () => {
    const result = await exec(
      findTool(captureTools(fakeRunner(TICKET_JSON)), "ticket_create"),
      { title: "A" },
    );
    assert.deepEqual(result.details, TICKET_JSON);
    assert.deepEqual(result.content, [{ type: "text", text: formatTicketCreated(TICKET_JSON) }]);
  });

  it("ticket_set formats the runner JSON into content and returns it as details", async () => {
    const result = await exec(
      findTool(captureTools(fakeRunner(TICKET_JSON)), "ticket_set"),
      { selector: "a", status: "closed" },
    );
    assert.deepEqual(result.details, TICKET_JSON);
    assert.deepEqual(result.content, [{ type: "text", text: formatTicketUpdated(TICKET_JSON) }]);
  });

  it("ticket_edit formats the runner JSON into content and returns it as details", async () => {
    const result = await exec(
      findTool(captureTools(fakeRunner(TICKET_JSON)), "ticket_edit"),
      { selector: "a", old: "a", new: "b" },
    );
    assert.deepEqual(result.details, TICKET_JSON);
    assert.deepEqual(result.content, [{ type: "text", text: formatTicketUpdated(TICKET_JSON) }]);
  });

  it("ticket_set rejects without calling the runner when status and after are both absent", async () => {
    const fake = fakeRunner({});
    const tool = findTool(captureTools(fake), "ticket_set");
    await assert.rejects(() => exec(tool, { selector: "a" }), /nothing to set/);
    assert.equal(fake.calls.length, 0);
  });

  it("ticket_edit rejects without calling the runner when old is empty", async () => {
    const fake = fakeRunner({});
    const tool = findTool(captureTools(fake), "ticket_edit");
    await assert.rejects(() => exec(tool, { old: "", new: "b" }), /old must be a non-empty string/);
    assert.equal(fake.calls.length, 0);
  });

  it("rejects with the CLI stderr when the runner throws TicketCliError with stderr", async () => {
    const tool = findTool(
      captureTools({
        runCli: () => Promise.reject(new TicketCliError("error: unknown id prefix", "error: unknown id prefix")),
      }),
      "ticket_show",
    );
    await assert.rejects(() => exec(tool, { selector: "nope" }), /error: unknown id prefix/);
  });

  it("falls back to the TicketCliError message when stderr is empty (CLI not executable)", async () => {
    const tool = findTool(
      captureTools({
        runCli: () =>
          Promise.reject(new TicketCliError("", "ticket CLI is not available: spawn ticket ENOENT")),
      }),
      "ticket_show",
    );
    await assert.rejects(
      () => exec(tool, { selector: "a" }),
      /ticket CLI is not available: spawn ticket ENOENT/,
    );
  });

  it("passes ctx.cwd to the runner for every tool", async () => {
    const cases: Array<[string, Record<string, unknown>, unknown]> = [
      ["ticket_list", {}, []],
      ["ticket_show", { selector: "a" }, TICKET_JSON],
      ["ticket_create", { title: "t" }, TICKET_JSON],
      ["ticket_set", { status: "closed" }, TICKET_JSON],
      ["ticket_edit", { old: "a", new: "b" }, TICKET_JSON],
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

  // SPEC-pinned formatter output (not self-referencing the lib call result).
  it("renders the spec-pinned text for list, show, create, and set", async () => {
    const ticket = { id: "20260101-000000", status: "blocked", title: "A", after: null, path: "/p/a.md" };
    const listed = await exec(findTool(captureTools(fakeRunner([ticket])), "ticket_list"), {});
    assert.deepEqual(listed.content, [{ type: "text", text: "20260101-000000\tblocked\tA" }]);

    const listedAll = await exec(
      findTool(captureTools(fakeRunner([{ ...ticket, project: "proj" }])), "ticket_list"),
      { all: true },
    );
    assert.deepEqual(listedAll.content, [{ type: "text", text: "proj\t20260101-000000\tblocked\tA" }]);
    const show = await exec(
      findTool(
        captureTools(
          fakeRunner({
            id: "20260101-000000",
            status: "open",
            title: "A",
            after: "20260101-000001",
            path: "/p/a.md",
            body: "body line\n",
          }),
        ),
        "ticket_show",
      ),
      {},
    );
    assert.deepEqual(show.content, [
      {
        type: "text",
        text: "20260101-000000\nstatus: open\nafter: 20260101-000001\n\n# A\n\nbody line",
      },
    ]);

    const created = await exec(findTool(captureTools(fakeRunner(ticket)), "ticket_create"), { title: "A" });
    assert.deepEqual(created.content, [
      { type: "text", text: "created 20260101-000000\nstatus: blocked\nafter: -\npath: /p/a.md" },
    ]);

    const updated = await exec(
      findTool(captureTools(fakeRunner(ticket)), "ticket_set"),
      { status: "blocked" },
    );
    assert.deepEqual(updated.content, [
      { type: "text", text: "updated 20260101-000000\nstatus: blocked\nafter: -\npath: /p/a.md" },
    ]);
  });
});

// The wrapper tools above mock the runner; these cases run the lib's real
// runTicketCli against a stub executable (injected via deps.cliPath) so the
// spawn path (--json, cwd, exit-code classification, non-JSON output, spawn
// failure) is covered without depending on the caller's HOME.
describe("lib runTicketCli real spawn (SPEC: common behavior)", () => {
  const stubDirs: string[] = [];

  // Writes the stub script to a temp dir and returns its path.
  async function installStub(script: string, executable: boolean): Promise<string> {
    const dir = await mkdtemp("/tmp/ticket-cli-stub-");
    stubDirs.push(dir);
    const path = join(dir, "ticket");
    await writeFile(path, script);
    if (executable) await chmod(path, 0o755);
    return path;
  }

  afterEach(async () => {
    for (const dir of stubDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it("spawns the CLI with --json and the given cwd, resolving its JSON", async () => {
    const cliPath = await installStub(
      '#!/usr/bin/env bun\nconsole.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n',
      true,
    );
    const result = (await runTicketCli(["list"], "/tmp", undefined, { cliPath })) as {
      argv: string[];
      cwd: string;
    };
    assert.deepEqual(result.argv, ["list", "--json"]);
    assert.equal(result.cwd, "/tmp");
  });

  it("rejects with the CLI stderr when it exits non-zero", async () => {
    const cliPath = await installStub(
      '#!/usr/bin/env bun\nif (process.argv.includes("--fail")) { console.error("stub error: boom"); process.exit(1); }\nconsole.log("{}");\n',
      true,
    );
    await assert.rejects(
      () => runTicketCli(["show", "--fail"], "/tmp", undefined, { cliPath }),
      (error: unknown) => {
        assert.ok(error instanceof TicketCliError);
        assert.equal(error.stderr, "stub error: boom");
        return true;
      },
    );
  });

  it("rejects when the CLI outputs non-JSON on a zero exit", async () => {
    const cliPath = await installStub('#!/usr/bin/env bun\nconsole.log("not json at all");\n', true);
    await assert.rejects(
      () => runTicketCli(["list"], "/tmp", undefined, { cliPath }),
      /non-JSON output/,
    );
  });

  it("reports the CLI as unavailable when it is not executable", async () => {
    const cliPath = await installStub("#!/usr/bin/env bun\nconsole.log('{}');\n", false); // no exec bit -> spawn failure
    await assert.rejects(
      () => runTicketCli(["list"], "/tmp", undefined, { cliPath }),
      /not available/,
    );
  });
});
