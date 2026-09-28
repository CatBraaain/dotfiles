// Tests for dotfiles-dsh-tickets. Cases follow the oracle spec
// (dotfiles/.agents/cli.exact/ticket/ticket-tools.spec.md): argument mapping, session cwd,
// tool descriptions (wrapped CLI subcommand, argument meanings, next-default
// selector, ticket_set / ticket_edit pre-CLI validation), compiled parameter
// schemas, and result rendering (the CLI's text output passed through). The
// CLI itself is never spawned.
import { describe, it } from "bun:test";
import assert from "node:assert/strict";
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
} from "./index.ts";

// CLI text-output fixtures (ticket.spec.md テキスト出力).
const LIST_TEXT =
  "demo\t20260918-010000\topen\tFirst ticket\ndemo\t20260918-020000\tblocked\tSecond ticket";
const SHOW_TEXT =
  "id: 20260918-010000\nstatus: open\nafter: -\ntitle: First ticket\n\nbody:\n# First ticket\n\nSome body text.";
const CREATED_TEXT =
  "created 20260918-030000\nstatus: blocked\nafter: 20260918-010000\npath: /home/x/.agents/tickets/demo/20260918-030000.md";
const UPDATED_TEXT =
  "updated 20260918-030000\nstatus: blocked\nafter: 20260918-010000\npath: /home/x/.agents/tickets/demo/20260918-030000.md";

// Minimal exec fixtures: session cwd comes from the agent's session header.
function fakeExec(cwd?: string): ToolRunContext {
  return {
    agent: cwd === undefined ? undefined : { session: { header: { cwd, id: "dsh-session" } } },
    signal: new AbortController().signal,
  } as unknown as ToolRunContext;
}

type RunCli = (args: string[], cwd: string, signal?: AbortSignal) => Promise<string>;

function fakeRunner(stdout: string = LIST_TEXT): { runCli: RunCli; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const runCli: RunCli = async (args, cwd, signal) => {
    calls.push([args, cwd, signal]);
    return stdout;
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

// --- session cwd ---

describe("execution helpers", () => {
  it("sessionCwd: the agent's session header cwd, else the process cwd", () => {
    assert.equal(sessionCwd(fakeExec("/work/repo")), "/work/repo");
    assert.equal(sessionCwd(fakeExec(undefined)), process.cwd());
    assert.equal(
      sessionCwd({ agent: { session: { header: {} } } } as unknown as ToolRunContext),
      process.cwd(),
    );
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
    const { runCli, calls } = fakeRunner(LIST_TEXT);
    const tool = toolByName(createTicketTools({ runCli }), "ticket_list");
    const exec = fakeExec("/work/repo");

    const value = await tool.execute({ all: true, project: "demo" }, exec);

    assert.equal(value, LIST_TEXT);
    assert.deepEqual(calls, [[["list", "--all", "--project", "demo"], "/work/repo", exec.signal]]);
  });

  it("read tools fall back to the process cwd without an agent", async () => {
    const { runCli, calls } = fakeRunner(LIST_TEXT);
    const tool = toolByName(createTicketTools({ runCli }), "ticket_list");
    const exec = fakeExec(undefined);
    await tool.execute({}, exec);
    assert.deepEqual(calls, [[["list"], process.cwd(), exec.signal]]);
  });

  it("execute surfaces the runner error text as the tool failure", async () => {
    const runCli: RunCli = async () => {
      throw new Error("no such ticket");
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
    const { runCli, calls } = fakeRunner(UPDATED_TEXT);
    const tool = toolByName(createTicketTools({ runCli }), "ticket_set");
    await tool.execute({ selector: "x", status: "open", after: null }, fakeExec("/w"));
    assert.deepEqual(calls[0]?.[0], ["set", "x", '{"status":"open","after":null}']);
  });

  it("ticket_edit maps selector, old, and new to the CLI args", async () => {
    const { runCli, calls } = fakeRunner(UPDATED_TEXT);
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
    assert.match(descriptionOf("ticket_show"), /project/);

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
    assert.match(set, /project/);

    const edit = descriptionOf("ticket_edit");
    assert.match(edit, /\bold\b/);
    assert.match(edit, /\bnew\b/);
    assert.match(edit, /ticket_show/);
    assert.match(edit, /line breaks/);
  });

  it("describes the cwd-derived project default for every tool", () => {
    for (const tool of createTicketTools()) {
      assert.match(
        tool.description,
        /project.*defaults to the project resolved from the session cwd/i,
      );
    }
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
    assert.deepEqual(
      schema.properties?.after?.oneOf?.map((variant) => variant.type),
      ["string", "null"],
    );
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

// --- render: the CLI's text output passed through as the LLM text ---

describe("result rendering", () => {
  it("every tool renders its string value as one text block", () => {
    for (const tool of createTicketTools()) {
      assert.deepEqual(tool.output.render({}, LIST_TEXT), [{ type: "text", text: LIST_TEXT }]);
    }
  });

  it("pins the spec-required text passthrough for list, show, create, set, and edit (not self-referential)", () => {
    assert.deepEqual(
      toolByName(createTicketTools(), "ticket_list").output.render({ all: true }, LIST_TEXT),
      [{ type: "text", text: LIST_TEXT }],
    );
    assert.deepEqual(
      toolByName(createTicketTools(), "ticket_show").output.render({ selector: "x" }, SHOW_TEXT),
      [{ type: "text", text: SHOW_TEXT }],
    );
    assert.deepEqual(
      toolByName(createTicketTools(), "ticket_create").output.render({ title: "T" }, CREATED_TEXT),
      [{ type: "text", text: CREATED_TEXT }],
    );
    assert.deepEqual(
      toolByName(createTicketTools(), "ticket_set").output.render(
        { status: "closed" },
        UPDATED_TEXT,
      ),
      [{ type: "text", text: UPDATED_TEXT }],
    );
    assert.deepEqual(
      toolByName(createTicketTools(), "ticket_edit").output.render(
        { old: "a", new: "b" },
        UPDATED_TEXT,
      ),
      [{ type: "text", text: UPDATED_TEXT }],
    );
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
