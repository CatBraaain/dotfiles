import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "bun:test";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createGuardrailsAPI } from "./api.ts";

const routes = [
  { tool: "ask_permission", choice: "Yes, allow", directory: true },
  { tool: "ask_permission", choice: undefined, directory: true },
  { tool: "write", choice: "Directory (subtree)", directory: true },
  { tool: "edit", choice: "Directory (subtree)", directory: true },
  { tool: "write", choice: "File only", directory: false },
  { tool: "edit", choice: "File only", directory: false },
  { tool: "write", choice: undefined, directory: false },
  { tool: "edit", choice: undefined, directory: false },
] as const;

function textOf(result: AgentToolResult<unknown>): string {
  return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function fixture(directory: string, layout: "ask ancestor" | "ask files") {
  const work = join(directory, "work");
  const scope = join(work, "asked");
  mkdirSync(scope, { recursive: true });
  const paths = {
    target: join(scope, "target.txt"),
    sibling: join(scope, "sibling.txt"),
    outside: join(work, "outside.txt"),
    denied: join(scope, "denied.txt"),
    credential: join(scope, "credential.txt"),
  };
  for (const path of Object.values(paths)) writeFileSync(path, "original");
  const configPath = join(directory, "config.yaml");
  writeFileSync(
    configPath,
    JSON.stringify({
      read: [{ allow: "*" }],
      write: [
        { allow: work },
        ...(layout === "ask ancestor"
          ? [{ ask: work }]
          : [{ ask: [paths.target, paths.sibling, paths.outside] }]),
        { deny: paths.denied },
      ],
      credentials: [paths.credential],
      commands: [{ ".*": [{ allow: [] }] }],
    }),
  );
  const tools = new Map<string, ToolDefinition>();
  const api = createGuardrailsAPI(
    {
      registerTool(tool: ToolDefinition) {
        tools.set(tool.name, tool);
      },
      on() {},
    } as unknown as ExtensionAPI,
    configPath,
  );
  const context = { hasUI: false } as ExtensionToolContext;
  function execute(toolName: string, params: Record<string, unknown>, ctx = context) {
    return api.execute({ id: toolName, toolName, params, context: ctx });
  }
  function bashWrite(path: string, content: string) {
    return execute("bash", {
      command: `printf %s ${JSON.stringify(content)} > ${JSON.stringify(path)}`,
    });
  }
  return { paths, tools, execute, bashWrite, work, scope };
}

function withDirectory(test: (directory: string) => Promise<void>) {
  return async () => {
    const root = "/tmp/work/dotfiles";
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(join(root, "write-permissions-"));
    try {
      await test(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

describe("approved write permissions through real sandbox execution", () => {
  for (const layout of ["ask ancestor", "ask files"] as const) {
    for (const route of routes) {
      it(
        `${layout}: ${route.tool} ${route.choice ?? "confirm"} shares only the approved scope`,
        withDirectory(async (directory) => {
          const { paths, tools, execute, bashWrite, scope } = fixture(directory, layout);
          const before = await bashWrite(paths.target, "unapproved");
          assert.equal(before.isError, true);
          assert.match(textOf(before), /Read-only file system/);
          assert.equal(readFileSync(paths.target, "utf8"), "original");
          const context = {
            hasUI: true,
            ui: {
              confirm: async () => true,
              ...(route.choice ? { select: async () => route.choice } : {}),
            },
          } as unknown as ExtensionToolContext;
          const params = {
            path: paths.target,
            reason: "update the fixture",
            content: "approved",
            edits: [{ oldText: "original", newText: "approved" }],
          };
          const approval =
            route.tool === "ask_permission"
              ? await tools
                  .get("ask_permission")!
                  .execute("approval", params, undefined, undefined, context)
              : await execute(route.tool, params, context);
          assert.match(
            textOf(approval),
            /valid for the rest of the session for all tools using Guardrails; explicit deny and credentials remain protected/,
          );
          assert.ok(textOf(approval).includes(route.directory ? scope : paths.target));
          await execute("write", { path: paths.target, content: "fs write" });
          assert.equal(readFileSync(paths.target, "utf8"), "fs write");
          const bash = await bashWrite(paths.target, "bash write");
          assert.notEqual(bash.isError, true, textOf(bash));
          assert.equal(readFileSync(paths.target, "utf8"), "bash write");
          await execute("edit", {
            path: paths.target,
            edits: [{ oldText: "bash write", newText: "fs edit" }],
          });
          assert.equal(readFileSync(paths.target, "utf8"), "fs edit");
          const sibling = await bashWrite(paths.sibling, "sibling write");
          if (route.directory) {
            assert.notEqual(sibling.isError, true, textOf(sibling));
            assert.equal(readFileSync(paths.sibling, "utf8"), "sibling write");
            await execute("write", { path: paths.sibling, content: "sibling fs" });
            assert.equal(readFileSync(paths.sibling, "utf8"), "sibling fs");
          } else {
            assert.equal(sibling.isError, true);
            assert.equal(readFileSync(paths.sibling, "utf8"), "original");
            await assert.rejects(
              execute("write", { path: paths.sibling, content: "blocked" }),
              /Access requires confirmation/,
            );
          }
          for (const path of [paths.outside, paths.denied, paths.credential]) {
            const blocked = await bashWrite(path, "blocked");
            assert.equal(blocked.isError, true, path);
            assert.match(textOf(blocked), /Read-only file system/);
            await assert.rejects(
              execute("write", { path, content: "blocked" }),
              path === paths.outside ? /Access requires confirmation/ : /Access denied/,
            );
            assert.equal(readFileSync(path, "utf8"), "original");
          }
        }),
        20_000,
      );
    }
  }

  it(
    "does not turn static allow into a subtree grant",
    withDirectory(async (directory) => {
      const { tools, execute, bashWrite, paths, work } = fixture(directory, "ask files");
      const result = await tools
        .get("ask_permission")!
        .execute("already", { path: work, reason: "already allowed" }, undefined, undefined, {
          hasUI: false,
        } as ExtensionToolContext);
      assert.match(
        textOf(result),
        /Already granted: Guardrails permits writes to the requested path/,
      );
      assert.match(textOf(result), /No new permission was added/);
      await assert.rejects(
        execute("write", { path: paths.target, content: "blocked" }),
        /Access requires confirmation/,
      );
      assert.equal((await bashWrite(paths.target, "blocked")).isError, true);
      assert.equal(readFileSync(paths.target, "utf8"), "original");
    }),
  );
});
