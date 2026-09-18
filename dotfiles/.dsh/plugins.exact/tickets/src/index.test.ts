// Tests for dotfiles-dsh-tickets. Cases follow the oracle spec
// (dotfiles/.agents/cli/ticket-tools.spec.md): argument mapping, session cwd,
// TicketCliError conversion, tool descriptions (wrapped CLI subcommand,
// argument meanings, unique-prefix id resolution, ticket_update failure
// modes), compiled parameter schemas, and result formatting through the
// shared lib helpers (used as-is, never mocked). The CLI itself is never
// spawned.
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
  assertUpdatable,
  buildCreateArgs,
  buildListArgs,
  buildShowArgs,
  buildUpdateArgs,
  createTicketTools,
  inject,
  name,
  sessionCwd,
  toToolError,
} from "./index.ts";

// CLI-shaped --json fixtures (ticket.spec.md `--json` のフィールド).
const LIST_JSON = [
  {
    id: "20260918-010000_first",
    status: "open",
    title: "First ticket",
    depends_on: [],
    path: "/home/x/.agents/tickets/demo/20260918-010000_first.md",
    project: "demo",
  },
  {
    id: "20260918-020000_second",
    status: "blocked",
    title: "Second ticket",
    depends_on: ["20260918-010000_first"],
    path: "/home/x/.agents/tickets/demo/20260918-020000_second.md",
    project: "demo",
  },
];

const SHOW_JSON = {
  id: "20260918-010000_first",
  status: "open",
  title: "First ticket",
  depends_on: [],
  path: "/home/x/.agents/tickets/demo/20260918-010000_first.md",
  body: "Some body text.",
};

const CREATED_JSON = {
  id: "20260918-030000_new",
  status: "open",
  title: "New ticket",
  depends_on: [],
  path: "/home/x/.agents/tickets/demo/20260918-030000_new.md",
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

  it("buildShowArgs: show <id> plus optional --project", () => {
    assert.deepEqual(buildShowArgs({ id: "20260918" }), ["show", "20260918"]);
    assert.deepEqual(buildShowArgs({ id: "20260918", project: "demo" }), [
      "show",
      "20260918",
      "--project",
      "demo",
    ]);
  });

  it("buildCreateArgs: create <title> plus status, depends_on, body, project", () => {
    assert.deepEqual(buildCreateArgs({ title: "New ticket" }), ["create", "New ticket"]);
    assert.deepEqual(
      buildCreateArgs({
        title: "New ticket",
        status: "blocked",
        depends_on: ["a", "b"],
        body: "Body text",
        project: "demo",
      }),
      [
        "create",
        "New ticket",
        "--status",
        "blocked",
        "--depends-on",
        "a,b",
        "--body",
        "Body text",
        "--project",
        "demo",
      ],
    );
    assert.deepEqual(buildCreateArgs({ title: "T", depends_on: [] }), ["create", "T"]);
    assert.deepEqual(buildCreateArgs({ title: "T", body: "" }), ["create", "T", "--body", ""]);
  });

  it("buildUpdateArgs: update <id> plus --metadata JSON, --body, --project", () => {
    assert.deepEqual(buildUpdateArgs({ id: "x", metadata: { status: "closed" } }), [
      "update",
      "x",
      "--metadata",
      '{"status":"closed"}',
    ]);
    assert.deepEqual(
      buildUpdateArgs({ id: "x", metadata: { depends_on: ["a"] }, body: "B", project: "demo" }),
      ["update", "x", "--metadata", '{"depends_on":["a"]}', "--body", "B", "--project", "demo"],
    );
    assert.deepEqual(buildUpdateArgs({ id: "x", body: "B" }), ["update", "x", "--body", "B"]);
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

  it("assertUpdatable: rejects metadata- and body-less updates", () => {
    assert.throws(() => assertUpdatable({ id: "x" }), /nothing to update/);
    assert.doesNotThrow(() => assertUpdatable({ id: "x", metadata: {} }));
    assert.doesNotThrow(() => assertUpdatable({ id: "x", body: "B" }));
  });
});

// --- execute: runner wiring, cwd, signal, error conversion ---

describe("tool execution", () => {
  it("registers the four ticket tools", () => {
    const tools = createTicketTools();
    assert.deepEqual(
      tools.map((definition) => definition.name),
      ["ticket_list", "ticket_show", "ticket_create", "ticket_update"],
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
    assert.deepEqual(calls, [[["create", "T"], process.cwd(), exec.signal]]);
  });

  it("execute converts TicketCliError into a tool failure with the CLI stderr", async () => {
    const runCli: RunCli = async () => {
      throw new TicketCliError("no such ticket", "exited 1");
    };
    const tool = toolByName(createTicketTools({ runCli }), "ticket_show");
    await assert.rejects(tool.execute({ id: "missing" }, fakeExec("/w")), /no such ticket/);
  });

  it("ticket_update rejects before spawning the CLI when nothing to update", async () => {
    const { runCli, calls } = fakeRunner();
    const tool = toolByName(createTicketTools({ runCli }), "ticket_update");
    await assert.rejects(tool.execute({ id: "x" }, fakeExec("/w")), /nothing to update/);
    assert.equal(calls.length, 0);
  });

  it("ticket_update maps metadata and body to the CLI args", async () => {
    const { runCli, calls } = fakeRunner(CREATED_JSON);
    const tool = toolByName(createTicketTools({ runCli }), "ticket_update");
    await tool.execute({ id: "x", metadata: { status: "closed" }, body: "B" }, fakeExec("/w"));
    assert.deepEqual(calls[0]?.[0], [
      "update",
      "x",
      "--metadata",
      '{"status":"closed"}',
      "--body",
      "B",
    ]);
  });
});

// --- descriptions / parameter schemas: the model-facing tool surface ---

describe("tool descriptions", () => {
  it("names the CLI subcommand each tool wraps", () => {
    assert.match(descriptionOf("ticket_list"), /ticket list/);
    assert.match(descriptionOf("ticket_show"), /ticket show/);
    assert.match(descriptionOf("ticket_create"), /ticket create/);
    assert.match(descriptionOf("ticket_update"), /ticket update/);
  });

  it("explains each tool's arguments", () => {
    const list = descriptionOf("ticket_list");
    assert.match(list, /status/);
    assert.match(list, /project/);
    assert.match(list, /all/);

    assert.match(descriptionOf("ticket_show"), /\bid\b/);

    const create = descriptionOf("ticket_create");
    assert.match(create, /title/);
    assert.match(create, /body/);
    assert.match(create, /status/);
    assert.match(create, /depends_on/);
    assert.match(create, /project/);

    const update = descriptionOf("ticket_update");
    assert.match(update, /metadata/);
    assert.match(update, /body/);
    assert.match(update, /\bid\b/);
  });

  it("mentions unique-prefix id resolution for the tools that take an id", () => {
    // ticket_list takes no id argument, so the prefix requirement is out of
    // its scope (the descriptions cover the id arguments each tool has).
    assert.match(descriptionOf("ticket_show"), /prefix/i);
    assert.match(descriptionOf("ticket_create"), /prefix/i);
    assert.match(descriptionOf("ticket_update"), /prefix/i);
  });

  it("flags ticket_update failures: locked exclusivity and open dependency resolution", () => {
    const description = descriptionOf("ticket_update");
    assert.match(description, /fail/i);
    assert.match(description, /locked/);
    assert.match(description, /re-lock/);
    assert.match(description, /open/);
    assert.match(description, /depends_on/);
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

  it("ticket_show declares a required string id and an optional project", () => {
    const schema = parametersOf("ticket_show");
    assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), ["id", "project"]);
    assert.deepEqual(schema.required, ["id"]);
    assert.equal(schema.properties?.id?.type, "string");
    assert.equal(schema.properties?.project?.type, "string");
  });

  it("ticket_create declares a required title and optional body, status, depends_on, project", () => {
    const schema = parametersOf("ticket_create");
    assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), [
      "body",
      "depends_on",
      "project",
      "status",
      "title",
    ]);
    assert.deepEqual(schema.required, ["title"]);
    assert.equal(schema.properties?.title?.type, "string");
    assert.equal(schema.properties?.depends_on?.type, "array");
    assert.equal(schema.properties?.depends_on?.items?.type, "string");
  });

  it("ticket_update declares a required id and optional metadata, body, project", () => {
    const schema = parametersOf("ticket_update");
    assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), [
      "body",
      "id",
      "metadata",
      "project",
    ]);
    assert.deepEqual(schema.required, ["id"]);
    assert.equal(schema.properties?.id?.type, "string");
    assert.equal(schema.properties?.metadata?.type, "object");
    assert.equal(schema.properties?.body?.type, "string");
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
    assert.deepEqual(tool.output.render({ id: "x" }, SHOW_JSON), [
      { type: "text", text: formatTicketShow(SHOW_JSON) },
    ]);
  });

  it("ticket_create and ticket_update render through their formatters", () => {
    const created = toolByName(createTicketTools(), "ticket_create");
    const updated = toolByName(createTicketTools(), "ticket_update");
    assert.deepEqual(created.output.render({ title: "T" }, CREATED_JSON), [
      { type: "text", text: formatTicketCreated(CREATED_JSON) },
    ]);
    assert.deepEqual(updated.output.render({ id: "x" }, CREATED_JSON), [
      { type: "text", text: formatTicketUpdated(CREATED_JSON) },
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

  it("apply registers the four tools on the tool registry", () => {
    const registered: string[] = [];
    const ctx = {
      tools: { register: (definition: { name: string }) => void registered.push(definition.name) },
    };
    apply(ctx as unknown as Parameters<typeof apply>[0]);
    assert.deepEqual(registered, ["ticket_list", "ticket_show", "ticket_create", "ticket_update"]);
  });
});
