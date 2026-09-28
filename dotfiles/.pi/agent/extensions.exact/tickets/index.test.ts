import assert from "node:assert/strict";
import { afterEach, describe, it } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
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
  return tool.execute!("toolCall", params, undefined, undefined, {
    cwd: SESSION_CWD,
    sessionManager: { getSessionId: () => "pi-session" },
  } as never);
}

// Fake CLI runner resolving with `resolved` and recording every call. A
// function form answers per call, keyed by the CLI args — used to branch the
// truncation refetch (--json) from the ordinary text run.
function fakeRunner(
  resolved:
    | string
    | ((args: string[]) => string),
): TicketsExtensionDeps & {
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
    assert.match(edit, /line breaks/);
  });

  it("describes the cwd-derived project default for every tool", () => {
    for (const description of Object.values(ticketToolDescriptions)) {
      assert.match(description, /project.*defaults to the project resolved from the session cwd/i);
    }
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

describe("tool execute (SPEC: content is the CLI text output; truncation refetches --json)", () => {
  const LIST_TEXT = "20260101-000000\topen\tA";
  const SHOW_TEXT = "id: 20260101-000000\nstatus: open\nafter: -\ntitle: A\n\nbody:\n# A\n";
  const CREATED_TEXT = "created 20260101-000000\nstatus: open\nafter: -\npath: /p/a.md";
  const UPDATED_TEXT = "updated 20260101-000000\nstatus: open\nafter: -\npath: /p/a.md";

  it("ticket_list returns the CLI stdout as content without details", async () => {
    const fake = fakeRunner(LIST_TEXT);
    const result = await exec(findTool(captureTools(fake), "ticket_list"), {});
    assert.deepEqual(fake.calls.map((call) => call.args), [["list"]]);
    assert.deepEqual(result.content, [{ type: "text", text: LIST_TEXT }]);
    assert.equal(result.details, undefined);
  });

  it("ticket_list forwards --all and the CLI text keeps the project column", async () => {
    const fake = fakeRunner("proj\t20260101-000000\topen\tA");
    const result = await exec(findTool(captureTools(fake), "ticket_list"), { all: true });
    assert.deepEqual(fake.calls[0]?.args, ["list", "--all"]);
    assert.deepEqual(result.content, [{ type: "text", text: "proj\t20260101-000000\topen\tA" }]);
  });

  it("ticket_show returns the CLI stdout as content without details", async () => {
    const fake = fakeRunner(SHOW_TEXT);
    const result = await exec(findTool(captureTools(fake), "ticket_show"), { selector: "a" });
    assert.deepEqual(fake.calls.map((call) => call.args), [["show", "a"]]);
    assert.deepEqual(result.content, [{ type: "text", text: SHOW_TEXT }]);
    assert.equal(result.details, undefined);
  });

  it("truncates oversized ticket_list content and refetches the complete JSON as details", async () => {
    const listJson = Array.from({ length: 2_100 }, (_, index) => ({
      id: `20260101-${String(index).padStart(6, "0")}`,
      status: "open",
      title: "ticket",
      after: null,
      path: `/p/${index}.md`,
    }));
    const fake = fakeRunner((args) =>
      args.includes("--json")
        ? JSON.stringify(listJson)
        : listJson.map((ticket) => `${ticket.id}\t${ticket.status}\t${ticket.title}`).join("\n"),
    );
    const result = await exec(findTool(captureTools(fake), "ticket_list"), {});
    const text = result.content[0]!.text;
    assert.match(text, /Output truncated/);
    assert.ok(Buffer.byteLength(text, "utf8") <= DEFAULT_MAX_BYTES);
    assert.ok(text.split("\n").length <= DEFAULT_MAX_LINES);
    assert.deepEqual(result.details, listJson);
    assert.deepEqual(fake.calls[1]?.args, ["list", "--json"]);
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
      assert.deepEqual(fake.calls.map((call) => call.args), [args]);
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
      ["ticket_list", {}, LIST_TEXT],
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

// The wrapper tools above mock the runner; these cases run the extension's
// real spawnTicketCli against a stub CLI project dir (injected via deps.cliDir)
// so the spawn path (cwd, exit-code classification, stderr trimming, spawn
// failure) is covered without depending on the caller's HOME.
describe("ticket CLI real spawn (SPEC: common behavior)", () => {
  const stubDirs: string[] = [];

  // Writes a stub CLI project (package.json + main.ts) to a temp dir and
  // returns its dir; bun resolves the main field when spawned with the dir.
  async function installStub(script: string): Promise<string> {
    const dir = await mkdtemp("/tmp/ticket-cli-stub-");
    stubDirs.push(dir);
    await writeFile(join(dir, "package.json"), JSON.stringify({ main: "./main.ts" }));
    await writeFile(join(dir, "main.ts"), script);
    return dir;
  }

  afterEach(async () => {
    for (const dir of stubDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it("resolves the CLI stdout for the given args and cwd", async () => {
    const cliDir = await installStub(
      "console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n",
    );
    const stdout = await spawnTicketCli(["list"], "/tmp", undefined, { cliDir });
    const result = JSON.parse(stdout) as { argv: string[]; cwd: string };
    assert.deepEqual(result.argv, ["list"]);
    assert.equal(result.cwd, "/tmp");
  });

  it("rejects with the CLI stderr when it exits non-zero", async () => {
    const cliDir = await installStub(
      'if (process.argv.includes("--fail")) { console.error("stub error: boom"); process.exit(1); }\nconsole.log("{}");\n',
    );
    await assert.rejects(
      () => spawnTicketCli(["show", "--fail"], "/tmp", undefined, { cliDir }),
      /stub error: boom/,
    );
  });

  it("trims one trailing newline from the CLI stderr", async () => {
    const cliDir = await installStub(
      'process.stderr.write("error: body  \\n\\n"); process.exit(1);\n',
    );
    await assert.rejects(
      () => spawnTicketCli(["edit"], "/tmp", undefined, { cliDir }),
      (error: unknown) => {
        assert.equal((error as Error).message, "error: body  \n");
        return true;
      },
    );
  });

  it("reports the CLI as unavailable when the bun spawn itself fails", async () => {
    // Simulates bun missing from PATH: execFile fails with a string code
    // (ENOENT), which the spawn path classifies as "not available".
    const spawnFails = ((
      _file: string,
      _args: string[],
      _options: never,
      callback: (error: Error) => void,
    ) => {
      callback(Object.assign(new Error("spawn bun ENOENT"), { code: "ENOENT" }));
    }) as unknown as typeof execFile;
    await assert.rejects(
      () => spawnTicketCli(["list"], "/tmp", undefined, { exec: spawnFails }),
      /not available/,
    );
  });
});
