import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createGuardrailsAPI } from "./api.ts";

describe("guardrails API lifetime", () => {
  it(
    "shares a path grant between ask_permission and execution within one instance only",
    withDirectory(async (directory) => {
      const first = fixture(directory);
      const target = join(directory, "requested");
      const ui = {
        hasUI: true,
        ui: { confirm: async () => true },
      } as unknown as ExtensionToolContext;
      await first.tools
        .get("ask_permission")!
        .execute("grant", { path: target, reason: "test" }, undefined, undefined, ui);
      const path = join(target, "file.txt");
      const context = { hasUI: false } as ExtensionToolContext;
      await first.api.execute({
        id: "write",
        toolName: "write",
        params: { path, content: "same owner" },
        context,
      });
      assert.equal(readFileSync(path, "utf8"), "same owner");
      const second = fixture(directory);
      await assert.rejects(
        second.api.execute({
          id: "isolated",
          toolName: "write",
          params: { path, content: "other instance" },
          context,
        }),
        /Access requires confirmation/,
      );
      assert.equal(readFileSync(path, "utf8"), "same owner");
    }),
  );

  it(
    "rejects old execution and permission references after shutdown",
    withDirectory(async (directory) => {
      const { api, tools, handlers } = fixture(directory);
      const context = { hasUI: false } as ExtensionToolContext;
      handlers.get("session_shutdown")!({ reason: "reload" });
      await assert.rejects(
        api.execute({
          id: "old",
          toolName: "read",
          params: { path: join(directory, "config.yaml") },
          context,
        }),
        /API is no longer active/,
      );
      await assert.rejects(
        tools
          .get("ask_permission")!
          .execute(
            "old-permission",
            { path: directory, reason: "old" },
            undefined,
            undefined,
            context,
          ),
        /API is no longer active/,
      );
      const replacement = fixture(directory);
      const result = await replacement.api.execute({
        id: "new",
        toolName: "read",
        params: { path: join(directory, "config.yaml") },
        context,
      });
      assert.equal(result.content[0]?.type, "text");
    }),
  );

  it(
    "expires turn approvals through the lifecycle registered by the public factory",
    withDirectory(async (directory) => {
      const { api, tools, handlers } = fixture(directory);
      const ui = {
        hasUI: true,
        ui: { confirm: async () => true, select: async () => "Allow in this turn" },
      } as unknown as ExtensionToolContext;
      const context = { hasUI: false } as ExtensionToolContext;
      await tools
        .get("ask_permission")!
        .execute(
          "grant-command",
          { command: "echo approved", reason: "test" },
          undefined,
          undefined,
          ui,
        );
      const result = await api.execute({
        id: "allowed",
        toolName: "bash",
        params: { command: "echo approved" },
        context,
      });
      assert.match((result.content[0] as { text: string }).text, /approved/);
      handlers.get("input")!({ source: "interactive", text: "next" });
      await assert.rejects(
        api.execute({
          id: "expired",
          toolName: "bash",
          params: { command: "echo approved" },
          context,
        }),
        /Command requires a reason/,
      );
    }),
  );
});

function fixture(directory: string) {
  const config = join(directory, "config.yaml");
  writeFileSync(
    config,
    `read:\n  - allow: "*"\nwrite:\n  - ask: "${directory}/requested"\ncommands:\n  - echo:\n      - ask_with_reason: []\n`,
  );
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, (event: unknown) => unknown>();
  const extension = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: (event: unknown) => unknown) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  return { api: createGuardrailsAPI(extension, config), tools, handlers };
}

function withDirectory(test: (directory: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), "guardrails-lifetime-"));
    try {
      await test(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}
