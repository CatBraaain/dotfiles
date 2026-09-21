// Tests for dotfiles-dsh-tickets. Cases follow the oracle spec
// (dotfiles/.agents/cli/ticket-tools.spec.md): argument mapping, session cwd,
// TicketCliError conversion, tool descriptions (wrapped CLI subcommand,
// argument meanings, next-default selector, ticket_set / ticket_edit
// pre-CLI validation), compiled parameter schemas, and result formatting
// through the shared lib helpers (used as-is, never mocked). The CLI itself
// is never spawned.
import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  TicketCliError,
  formatTicketCreated,
  formatTicketList,
  formatTicketShow,
  formatTicketUpdated,
} from "@dotfiles/agent-lib/ticket";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import {
  apply,
  buildCreateArgs,
  buildEditArgs,
  buildListArgs,
  buildSetArgs,
  buildShowArgs,
  createTicketTools,
  inject,
  name,
  sessionCwd,
  toToolError,
} from "./index.ts";

// CLI-shaped --json fixtures (ticket.spec.md `--json` の共通フィールド).
const LIST_JSON = [
  {
    id: "20260918-010000",
    status: "open",
    title: "First ticket",
    after: null,
    path: "/home/x/.agents/tickets/demo/20260918-010000.md",
    project: "demo",
  },
  {
    id: "20260918-020000",
    status: "blocked",
    title: "Second ticket",
    after: "20260918-010000",
    path: "/home/x/.agents/tickets/demo/20260918-020000.md",
    project: "demo",
  },
];

const SHOW_JSON = {
  id: "20260918-010000",
  status: "open",
  title: "First ticket",
  after: null,
  path: "/home/x/.agents/tickets/demo/20260918-010000.md",
  body: "# First ticket\n\nSome body text.",
};

const CREATED_JSON = {
  id: "20260918-030000",
  status: "blocked",
  title: "New ticket",
  after: "20260918-010000",
  path: "/home/x/.agents/tickets/demo/20260918-030000.md",
};

// Minimal exec fixtures: session cwd comes from the agent's session header.
function fakeExec(cwd?: string): ToolRunContext {
  return {
    agent: cwd === undefined ? undefined : { session: { header: { cwd } } },
    signal: new AbortController().signal,
  } as unknown as ToolRunContext;
}

type RunCli = (args: string[], cwd: string, signal?: AbortSignal) => Promise<unknown>;

function fakeRunner(result: unknown = LIST_JSON): { runCli: RunCli; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const runCli: RunCli = async (args, cwd, signal) => {
    calls.push([args, cwd, signal]);
    return result;
  };
  return { runCli, calls };
}

function toolByName(tools: ReturnType<typeof createTicketTools>, toolName: string) {
  const tool = tools.find((definition) => definition.name === toolName);
  assert.ok(tool, `tool ${toolName} is registered`);
  return tool;
}

function descriptionOf(toolName: string): string {
  return toolByName(createTicketTools(), toolName).description;
}

// defineTool compiles the author-facing per-property spec into a raw JSON
// Schema: an object root with `properties`, plus a `required` name array
// that is present only when at least one property is required.
interface CompiledParameterNode {
  type?: string;
  items?: { type?: string };
  oneOf?: Array<{ type?: string }>;
}

interface CompiledParameters {
  type?: string;
  properties?: Record<string, CompiledParameterNode>;
  required?: string[];
}

function parametersOf(toolName: string): CompiledParameters {
  return toolByName(createTicketTools(), toolName).parameters as CompiledParameters;
}

// --- tool args -> CLI args ---

describe("argument mapping", () => {
  it("buildListArgs: list plus optional --all, --status, --project", () => {
    assert.deepEqual(buildListArgs({}), ["list"]);
    assert.deepEqual(buildListArgs({ all: true }), ["list", "--all"]);
    assert.deepEqual(buildListArgs({ all: false }), ["list"]);
    assert.deepEqual(buildListArgs({ status: ["open", "blocked"] }), [
      "list",
      "--status",
      "open,blocked",
    ]);
    assert.deepEqual(buildListArgs({ status: [] }), ["list"]);
    assert.deepEqual(buildListArgs({ project: "demo" }), ["list", "--project", "demo"]);
    assert.deepEqual(buildListArgs({ all: true, status: ["open"], project: "demo" }), [
      "list",
      "--all",
      "--status",
      "open",
      "--project",
      "demo",
    ]);
  });

  it("buildShowArgs: show with an optional selector (omitted means next) and --project", () => {
    assert.deepEqual(buildShowArgs({}), ["show"]);
    assert.deepEqual(buildShowArgs({ selector: "20260918" }), ["show", "20260918"]);
    assert.deepEqual(buildShowArgs({ selector: "20260918", project: "demo" }), [
      "show",
      "20260918",
      "--project",
      "demo",
    ]);
  });

  it("buildCreateArgs: create with a title-only JSON object", () => {
    assert.deepEqual(buildCreateArgs({ title: "New ticket" }), [
      "create",
      '{"title":"New ticket"}',
    ]);
    assert.deepEqual(buildCreateArgs({ title: "T", body: "" }), [
      "create",
      '{"title":"T","body":""}',
      // JSON.stringify keeps only present keys; absent optionals are omitted.
    ]);
  });

  it("buildCreateArgs: serializes status, after, body, project in CLI order", () => {
    assert.deepEqual(
      buildCreateArgs({
        title: "New ticket",
        status: "blocked",
        after: "20260918-010000",
        body: "Body text",
        project: "demo",
      }),
      [
        "create",
        JSON.stringify({
          title: "New ticket",
          status: "blocked",
          after: "20260918-010000",
          body: "Body text",
        }),
        "--project",
        "demo",
      ],
    );
  });

  it("buildSetArgs: set with a status-only JSON object and no selector (next)", () => {
    assert.deepEqual(buildSetArgs({ status: "closed" }), ["set", '{"status":"closed"}']);
  });

  it("buildSetArgs: serializes selector, after null, and project in CLI order", () => {
    assert.deepEqual(buildSetArgs({ selector: "x", after: null, project: "demo" }), [
      "set",
      "x",
      '{"after":null}',
      "--project",
      "demo",
    ]);
  });

  it("buildSetArgs: throws without a CLI run when status and after are both absent", () => {
    assert.throws(() => buildSetArgs({ selector: "x" }), /nothing to set/);
  });

  it("buildEditArgs: edit uses an option terminator before old and new", () => {
    assert.deepEqual(buildEditArgs({ old: "- old", new: "- new" }), [
      "edit",
      "--",
      "- old",
      "- new",
    ]);
    assert.deepEqual(buildEditArgs({ selector: "x", old: "a", new: "b", project: "demo" }), [
      "edit",
      "--project",
      "demo",
      "x",
      "--",
      "a",
      "b",
    ]);
    assert.deepEqual(buildEditArgs({ selector: "x", old: "a", new: "" }), [
      "edit",
      "x",
      "--",
      "a",
      "",
    ]);
  });

  it("buildEditArgs: throws without a CLI run when old is empty", () => {
    assert.throws(() => buildEditArgs({ old: "", new: "b" }), /old must be a non-empty string/);
  });
});

// --- session cwd and error conversion ---

describe("execution helpers", () => {
  it("sessionCwd: the agent's session header cwd, else the process cwd", () => {
    assert.equal(sessionCwd(fakeExec("/work/repo")), "/work/repo");
    assert.equal(sessionCwd(fakeExec(undefined)), process.cwd());
    assert.equal(
      sessionCwd({ agent: { session: { header: {} } } } as unknown as ToolRunContext),
      process.cwd(),
    );
  });

  it("toToolError: TicketCliError becomes an Error carrying stderr", () => {
    const converted = toToolError(new TicketCliError("candidate ids: a, b", "exited 1"));
    assert.ok(converted instanceof Error);
    assert.equal((converted as Error).message, "candidate ids: a, b");
  });

  it("toToolError: empty stderr falls back to the error message", () => {
    const converted = toToolError(new TicketCliError("", "ticket CLI is not available: ENOENT"));
    assert.ok(converted instanceof Error);
    assert.equal((converted as Error).message, "ticket CLI is not available: ENOENT");
  });

  it("toToolError: other errors pass through unchanged", () => {
    const original = new Error("unrelated");
    assert.equal(toToolError(original), original);
  });
});

// --- execute: runner wiring, cwd, signal, error conversion ---

describe("tool execution", () => {
  it("registers the five ticket tools", () => {
    const tools = createTicketTools();
    assert.deepEqual(
      tools.map((definition) => definition.name),
      ["ticket_list", "ticket_show", "ticket_create", "ticket_set", "ticket_edit"],
    );
  });

  it("execute runs the CLI with the mapped args, the session cwd, and the signal", async () => {
    const { runCli, calls } = fakeRunner(LIST_JSON);
    const tool = toolByName(createTicketTools({ runCli }), "ticket_list");
    const exec = fakeExec("/work/repo");

    const value = await tool.execute({ all: true, project: "demo" }, exec);

    assert.equal(value, LIST_JSON);
    assert.deepEqual(calls, [[["list", "--all", "--project", "demo"], "/work/repo", exec.signal]]);
  });

  it("execute falls back to the process cwd without an agent", async () => {
    const { runCli, calls } = fakeRunner(CREATED_JSON);
    const tool = toolByName(createTicketTools({ runCli }), "ticket_create");
    const exec = fakeExec(undefined);
    await tool.execute({ title: "T" }, exec);
    assert.deepEqual(calls, [[["create", '{"title":"T"}'], process.cwd(), exec.signal]]);
  });

  it("execute converts TicketCliError into a tool failure with the CLI stderr", async () => {
    const runCli: RunCli = async () => {
      throw new TicketCliError("no such ticket", "exited 1");
    };
    const tool = toolByName(createTicketTools({ runCli }), "ticket_show");
    await assert.rejects(tool.execute({ selector: "missing" }, fakeExec("/w")), /no such ticket/);
  });

  it("ticket_set rejects before spawning the CLI when nothing to set", async () => {
    const { runCli, calls } = fakeRunner();
    const tool = toolByName(createTicketTools({ runCli }), "ticket_set");
    await assert.rejects(
      () => Promise.resolve(tool.execute({ selector: "x" }, fakeExec("/w"))),
      /nothing to set/,
    );
    assert.equal(calls.length, 0);
  });

  it("ticket_set maps selector, status, and after to the CLI JSON argument", async () => {
    const { runCli, calls } = fakeRunner(CREATED_JSON);
    const tool = toolByName(createTicketTools({ runCli }), "ticket_set");
    await tool.execute({ selector: "x", status: "open", after: null }, fakeExec("/w"));
    assert.deepEqual(calls[0]?.[0], ["set", "x", '{"status":"open","after":null}']);
  });

  it("ticket_edit maps selector, old, and new to the CLI args", async () => {
    const { runCli, calls } = fakeRunner(CREATED_JSON);
    const tool = toolByName(createTicketTools({ runCli }), "ticket_edit");
    await tool.execute({ selector: "x", old: "a", new: "b" }, fakeExec("/w"));
    assert.deepEqual(calls[0]?.[0], ["edit", "x", "--", "a", "b"]);
  });
});

// --- descriptions / parameter schemas: the model-facing tool surface ---

describe("tool descriptions", () => {
  it("names the CLI subcommand each tool wraps", () => {
    assert.match(descriptionOf("ticket_list"), /ticket list/);
    assert.match(descriptionOf("ticket_show"), /ticket show/);
    assert.match(descriptionOf("ticket_create"), /ticket create/);
    assert.match(descriptionOf("ticket_set"), /ticket set/);
    assert.match(descriptionOf("ticket_edit"), /ticket edit/);
  });

  it("explains each tool's arguments", () => {
    const list = descriptionOf("ticket_list");
    assert.match(list, /status/);
    assert.match(list, /project/);
    assert.match(list, /all/);

    assert.match(descriptionOf("ticket_show"), /selector/);

    const create = descriptionOf("ticket_create");
    assert.match(create, /title/);
    assert.match(create, /body/);
    assert.match(create, /status/);
    assert.match(create, /after/);
    assert.match(create, /project/);

    const set = descriptionOf("ticket_set");
    assert.match(set, /status/);
    assert.match(set, /after/);
    assert.match(set, /selector/);

    const edit = descriptionOf("ticket_edit");
    assert.match(edit, /\bold\b/);
    assert.match(edit, /\bnew\b/);
    assert.match(edit, /ticket_show/);
    assert.match(edit, /line breaks/);
  });

  it("mentions the next-default selector for the selector-taking tools", () => {
    // "ID / unique prefix / next" (SPEC: common selector wording)
    for (const description of [
      descriptionOf("ticket_show"),
      descriptionOf("ticket_set"),
      descriptionOf("ticket_edit"),
    ]) {
      assert.match(description, /next/);
      assert.match(description, /prefix/i);
    }
  });

  it("keeps every tool description single-line (SPEC: 1-line summary via description)", () => {
    for (const tool of createTicketTools()) {
      assert.ok(!tool.description.includes("\n"), `${tool.name} description is single-line`);
    }
  });

  it("flags ticket_set behavior: linkage, closed release, and validation failures", () => {
    const description = descriptionOf("ticket_set");
    assert.match(description, /blocks/);
    assert.match(description, /reopens|release/);
    assert.match(description, /closed/);
    assert.match(description, /cyc/);
  });
});

describe("parameter schemas", () => {
  it("ticket_list declares optional status (string array), project, and all", () => {
    const schema = parametersOf("ticket_list");
    assert.equal(schema.type, "object");
    assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), ["all", "project", "status"]);
    assert.equal(schema.properties?.status?.type, "array");
    assert.equal(schema.properties?.status?.items?.type, "string");
    assert.equal(schema.properties?.all?.type, "boolean");
    assert.equal(schema.properties?.project?.type, "string");
    assert.equal(Object.hasOwn(schema, "required"), false);
  });

  it("ticket_show declares optional selector and project", () => {
    const schema = parametersOf("ticket_show");
    assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), ["project", "selector"]);
    assert.equal(Object.hasOwn(schema, "required"), false);
    assert.equal(schema.properties?.selector?.type, "string");
    assert.equal(schema.properties?.project?.type, "string");
  });

  it("ticket_create declares a required title and optional body, status, after, project", () => {
    const schema = parametersOf("ticket_create");
    assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), [
      "after",
      "body",
      "project",
      "status",
      "title",
    ]);
    assert.deepEqual(schema.required, ["title"]);
    assert.equal(schema.properties?.title?.type, "string");
    assert.equal(schema.properties?.after?.type, "string");
    assert.equal(schema.properties?.body?.type, "string");
  });

  it("ticket_set declares optional selector, status, after (string or null), project", () => {
    const schema = parametersOf("ticket_set");
    assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), [
      "after",
      "project",
      "selector",
      "status",
    ]);
    assert.equal(Object.hasOwn(schema, "required"), false);
    assert.deepEqual(schema.properties?.after?.oneOf?.map((variant) => variant.type), [
      "string",
      "null",
    ]);
    assert.equal(schema.properties?.status?.type, "string");
  });

  it("ticket_edit declares required old and new, and optional selector and project", () => {
    const schema = parametersOf("ticket_edit");
    assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), [
      "new",
      "old",
      "project",
      "selector",
    ]);
    assert.deepEqual(schema.required, ["old", "new"]);
    assert.equal(schema.properties?.old?.type, "string");
    assert.equal(schema.properties?.new?.type, "string");
  });
});

// --- render / presentationMeta: formatTicket* wiring with the real lib ---

describe("result rendering", () => {
  it("ticket_list renders through formatTicketList with the all flag", () => {
    const tool = toolByName(createTicketTools(), "ticket_list");
    const [first] = tool.output.render({ all: true }, LIST_JSON);
    assert.deepEqual([first], [{ type: "text", text: formatTicketList(LIST_JSON, true) }]);
    assert.ok(first.type === "text");
    assert.match(first.text, /^demo\t/);

    const singleProject = tool.output.render({}, LIST_JSON);
    assert.deepEqual(singleProject, [{ type: "text", text: formatTicketList(LIST_JSON, false) }]);

    const empty = tool.output.render({}, []);
    assert.deepEqual(empty, [{ type: "text", text: "no tickets" }]);
  });

  it("ticket_show renders through formatTicketShow", () => {
    const tool = toolByName(createTicketTools(), "ticket_show");
    assert.deepEqual(tool.output.render({ selector: "x" }, SHOW_JSON), [
      { type: "text", text: formatTicketShow(SHOW_JSON) },
    ]);
  });

  it("ticket_create renders through formatTicketCreated", () => {
    const tool = toolByName(createTicketTools(), "ticket_create");
    assert.deepEqual(tool.output.render({ title: "T" }, CREATED_JSON), [
      { type: "text", text: formatTicketCreated(CREATED_JSON) },
    ]);
  });

  it("ticket_set and ticket_edit render through formatTicketUpdated", () => {
    const set = toolByName(createTicketTools(), "ticket_set");
    const edit = toolByName(createTicketTools(), "ticket_edit");
    assert.deepEqual(set.output.render({ status: "closed" }, CREATED_JSON), [
      { type: "text", text: formatTicketUpdated(CREATED_JSON) },
    ]);
    assert.deepEqual(edit.output.render({ old: "a", new: "b" }, CREATED_JSON), [
      { type: "text", text: formatTicketUpdated(CREATED_JSON) },
    ]);
  });

  it("pins the spec-required text for list, show, create, set, and edit (not self-referential)", () => {
    assert.deepEqual(
      toolByName(createTicketTools(), "ticket_list").output.render({ all: true }, LIST_JSON),
      [
        {
          type: "text",
          text:
            "demo\t20260918-010000\topen\tFirst ticket\ndemo\t20260918-020000\tblocked\tSecond ticket",
        },
      ],
    );
    assert.deepEqual(toolByName(createTicketTools(), "ticket_show").output.render({ selector: "x" }, SHOW_JSON), [
      {
        type: "text",
        text: "id: 20260918-010000\nstatus: open\nafter: -\ntitle: First ticket\n\nbody:\n# First ticket\n\nSome body text.",
      },
    ]);
    assert.deepEqual(toolByName(createTicketTools(), "ticket_create").output.render({ title: "T" }, CREATED_JSON), [
      {
        type: "text",
        text: "created 20260918-030000\nstatus: blocked\nafter: 20260918-010000\npath: /home/x/.agents/tickets/demo/20260918-030000.md",
      },
    ]);
    assert.deepEqual(toolByName(createTicketTools(), "ticket_set").output.render({ status: "closed" }, CREATED_JSON), [
      {
        type: "text",
        text: "updated 20260918-030000\nstatus: blocked\nafter: 20260918-010000\npath: /home/x/.agents/tickets/demo/20260918-030000.md",
      },
    ]);
    assert.deepEqual(toolByName(createTicketTools(), "ticket_edit").output.render({ old: "a", new: "b" }, CREATED_JSON), [
      {
        type: "text",
        text: "updated 20260918-030000\nstatus: blocked\nafter: 20260918-010000\npath: /home/x/.agents/tickets/demo/20260918-030000.md",
      },
    ]);
  });

  it("presentationMeta persists the CLI JSON as the result details", () => {
    for (const tool of createTicketTools()) {
      assert.ok(tool.output.presentationMeta);
      assert.equal(tool.output.presentationMeta?.({}, LIST_JSON), LIST_JSON);
    }
  });
});

// --- plugin entry ---

describe("plugin entry", () => {
  it("exports the cordis name and the tools inject", () => {
    assert.equal(name, "dsh-tickets");
    assert.deepEqual(inject, ["tools"]);
  });

  it("apply registers the five tools on the tool registry", () => {
    const registered: string[] = [];
    const ctx = {
      tools: { register: (definition: { name: string }) => void registered.push(definition.name) },
    };
    apply(ctx as unknown as Parameters<typeof apply>[0]);
    assert.deepEqual(registered, [
      "ticket_list",
      "ticket_show",
      "ticket_create",
      "ticket_set",
      "ticket_edit",
    ]);
  });
});
