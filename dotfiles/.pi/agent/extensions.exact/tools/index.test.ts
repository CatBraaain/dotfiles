import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import toolsExtension from "./index.ts";
import { Guardrail } from "../guardrails/guardrail.ts";
import { SandboxRunner } from "../guardrails/sandbox-runner.ts";

describe("tools with the guardrails public API", () => {
  it(
    "registers all tools and permission handling once without the event bus",
    withFixture(async ({ tools, registered }) => {
      assert.deepEqual([...tools.keys()].sort(), [
        "ask_permission",
        "bash",
        "codemode",
        "edit",
        "find",
        "grep",
        "ls",
        "read",
        "write",
      ]);
      assert.equal(registered.length, new Set(registered).size);
    }),
  );

  it(
    "returns text, images, and details without changing the API result",
    withFixture(async ({ tools, context }) => {
      const expected: AgentToolResult<unknown> = {
        content: [
          { type: "text", text: "body" },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ],
        details: { source: "runner" },
      };
      const originalRun = SandboxRunner.prototype.runTool;
      SandboxRunner.prototype.runTool = async () => expected;
      try {
        const result = await tools
          .get("bash")!
          .execute("result", { command: "echo ok" }, undefined, undefined, context);
        assert.strictEqual(result, expected);
      } finally {
        SandboxRunner.prototype.runTool = originalRun;
      }
    }),
  );

  it(
    "forwards cancellation, progress, and each call's fresh context",
    withFixture(async ({ tools }) => {
      const originalRun = SandboxRunner.prototype.runTool;
      const originalAuthorize = Guardrail.prototype.authorizeCommand;
      const contexts: unknown[] = [];
      const updates: unknown[] = [];
      const controller = new AbortController();
      Guardrail.prototype.authorizeCommand = async (_command, context) => {
        contexts.push(context);
        return false;
      };
      SandboxRunner.prototype.runTool = async (_name, _params, options) => {
        assert.strictEqual(options.signal, controller.signal);
        options.onData?.(Buffer.from("progress\n"), "stderr");
        return { content: [], details: {} };
      };
      const first = { hasUI: false } as ExtensionToolContext;
      const second = { hasUI: false } as ExtensionToolContext;
      try {
        for (const context of [first, second]) {
          await tools
            .get("bash")!
            .execute(
              "context",
              { command: "echo ok" },
              controller.signal,
              (update) => updates.push(update),
              context,
            );
        }
        assert.strictEqual(contexts[0], first);
        assert.strictEqual(contexts[1], second);
        assert.equal(updates.length, 2);
        assert.deepEqual(updates[0], {
          content: [{ type: "text", text: "progress" }],
          details: {},
        });
      } finally {
        SandboxRunner.prototype.runTool = originalRun;
        Guardrail.prototype.authorizeCommand = originalAuthorize;
      }
    }),
  );

  it(
    "returns authorization failures as rejected promises",
    withFixture(async ({ tools, context, directory }) => {
      await assert.rejects(
        tools
          .get("read")!
          .execute("deny", { path: join(directory, "denied") }, undefined, undefined, context),
        /Access denied:/,
      );
    }),
  );

  it(
    "keeps parallel results associated with the calling tool",
    withFixture(async ({ tools, context }) => {
      const originalRun = SandboxRunner.prototype.runTool;
      const first = Promise.withResolvers<void>();
      SandboxRunner.prototype.runTool = async (_name, params) => {
        const command = (params as { command: string }).command;
        if (command === "echo first") await first.promise;
        return { content: [{ type: "text", text: command }], details: {} };
      };
      try {
        const pending = tools
          .get("bash")!
          .execute("first", { command: "echo first" }, undefined, undefined, context);
        const second = await tools
          .get("bash")!
          .execute("second", { command: "echo second" }, undefined, undefined, context);
        assert.deepEqual(second.content, [{ type: "text", text: "echo second" }]);
        first.resolve();
        assert.deepEqual((await pending).content, [{ type: "text", text: "echo first" }]);
      } finally {
        first.resolve();
        SandboxRunner.prototype.runTool = originalRun;
      }
    }),
  );

  it(
    "reads through the initialized API and the real sandbox",
    withFixture(async ({ tools, context, directory }) => {
      const path = join(directory, "input.txt");
      writeFileSync(path, "through bwrap\n");
      const result = await tools
        .get("read")!
        .execute("real", { path }, undefined, undefined, context);
      assert.deepEqual(result.content, [{ type: "text", text: "through bwrap\n" }]);
    }),
  );

  it("keeps every overridden tool unavailable when configuration initialization fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "guardrails-invalid-"));
    try {
      const config = join(directory, "invalid.yaml");
      writeFileSync(config, "read: invalid\n");
      const tools = new Map<string, ToolDefinition>();
      const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
      const api = {
        registerTool(tool: ToolDefinition) {
          tools.set(tool.name, tool);
        },
        on(event: string, handler: (event: unknown, context: unknown) => unknown) {
          handlers.set(event, handler);
        },
      } as unknown as ExtensionAPI;
      toolsExtension(api, config);
      for (const toolName of ["read", "write", "edit", "grep", "find", "ls", "bash"]) {
        await assert.rejects(
          tools
            .get(toolName)!
            .execute("invalid", {}, undefined, undefined, {} as ExtensionToolContext),
          /guardrails.yaml.*schema violation/,
        );
      }
      const notifications: unknown[] = [];
      handlers.get("session_start")!(
        {},
        {
          ui: {
            notify(message: string) {
              notifications.push(message);
            },
          },
        },
      );
      assert.equal(notifications.length, 1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("depends only on the guardrails public entry and has no execution event contract", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    assert.match(source, /from "\.\.\/guardrails\/api\.ts"/);
    assert.doesNotMatch(source, /guardrails\/(?:guardrail|execute|sandbox|config)\./);
    assert.doesNotMatch(source, /guardrails:execute|\.events\.|accept\(/);
  });
});

function withFixture(test: (fixture: Fixture) => Promise<void>): () => Promise<void> {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), "guardrails-direct-"));
    try {
      const config = join(directory, "config.yaml");
      writeFileSync(
        config,
        `read:\n  - allow: "*"\n  - deny: "${directory}/denied"\ncommands:\n  - .*:\n      - allow: []\n`,
      );
      const tools = new Map<string, ToolDefinition>();
      const registered: string[] = [];
      const api = {
        registerTool(tool: ToolDefinition) {
          registered.push(tool.name);
          tools.set(tool.name, tool);
        },
        on() {},
      } as unknown as ExtensionAPI;
      toolsExtension(api, config);
      await test({
        tools,
        registered,
        directory,
        context: { hasUI: false } as ExtensionToolContext,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

type Fixture = {
  tools: Map<string, ToolDefinition>;
  registered: string[];
  directory: string;
  context: ExtensionToolContext;
};
