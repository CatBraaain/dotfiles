import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
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

  for (const options of [{}, { offset: 2 }, { limit: 1 }, { offset: 99999, limit: 0 }]) {
    it(
      `returns only the complete SKILL.md text for options ${JSON.stringify(options)}`,
      withFixture(async ({ tools, context, directory }) => {
        const path = join(directory, "SKILL.md");
        const body = "\uFEFF# Skill\r\n\r\n日本語 text\r\n";
        writeFileSync(path, body);
        const result = await tools
          .get("read")!
          .execute("skill", { path, ...options }, undefined, undefined, context);
        assert.deepEqual(result.content, [{ type: "text", text: body }]);
        assert.equal(result.structuredContent, body);
        assert.equal(result.details, undefined);
        assert.deepEqual(Object.keys(result).sort(), ["content", "structuredContent"]);
      }),
    );
  }

  for (const [name, body] of [
    ["over 2000 lines", "line\n".repeat(2001)],
    ["over 50 KiB", "日本語 text\n".repeat(6000)],
    ["one line over 50 KiB", "あ".repeat(18000)],
    ["empty", ""],
    ["without a final newline", "first\nlast"],
  ]) {
    it(
      `returns the exact SKILL.md body when ${name}`,
      withFixture(async ({ tools, context, directory }) => {
        const path = join(directory, "SKILL.md");
        writeFileSync(path, body!);
        const result = await tools
          .get("read")!
          .execute("skill-size", { path, offset: 2, limit: 1 }, undefined, undefined, context);
        assert.deepEqual(result.content, [{ type: "text", text: body }]);
        assert.equal(result.structuredContent, body);
        assert.equal(result.details, undefined);
      }),
    );
  }

  it(
    "recognizes normalized absolute, relative, at-prefixed, and home paths",
    withFixture(async ({ tools, context, directory }) => {
      const path = join(directory, "SKILL.md");
      const body = "first\nlast\n";
      writeFileSync(path, body);
      const paths = [
        path,
        `@${path}`,
        relative(process.cwd(), path),
        `${directory}/unused/../SKILL.md`,
        `~/${relative(homedir(), path)}`,
        `@~/${relative(homedir(), path)}`,
      ];
      for (const input of paths) {
        const result = await tools
          .get("read")!
          .execute(
            "skill-path",
            { path: input, offset: 2, limit: 1 },
            undefined,
            undefined,
            context,
          );
        assert.deepEqual(result.content, [{ type: "text", text: body }], input);
        assert.equal(result.structuredContent, body, input);
      }
    }),
  );

  it(
    "reads the complete SKILL.md through environment variable paths",
    withFixture(async ({ tools, context, directory }) => {
      const variableName = "GUARDRAIL_TEST_SKILL_PATH";
      const previousPath = process.env[variableName];
      const path = join(directory, "SKILL.md");
      const body = "first\nlast\n";
      writeFileSync(path, body);
      try {
        process.env[variableName] = path;
        for (const input of [`$${variableName}`, `\${${variableName}}`, `@\${${variableName}}`]) {
          const result = await tools
            .get("read")!
            .execute(
              "skill-env",
              { path: input, offset: 2, limit: 1 },
              undefined,
              undefined,
              context,
            );
          assert.deepEqual(result.content, [{ type: "text", text: body }], input);
          assert.equal(result.structuredContent, body, input);
        }
      } finally {
        if (previousPath === undefined) delete process.env[variableName];
        else process.env[variableName] = previousPath;
      }
    }),
  );

  it(
    "uses the requested filename rather than a symlink target name",
    withFixture(async ({ tools, context, directory }) => {
      const body = "first\nlast";
      const target = join(directory, "reference.md");
      writeFileSync(target, body);
      const skill = join(directory, "SKILL.md");
      symlinkSync(target, skill);
      const full = await tools
        .get("read")!
        .execute("skill-link", { path: skill, offset: 2, limit: 1 }, undefined, undefined, context);
      assert.deepEqual(full.content, [{ type: "text", text: body }]);
      const alias = join(directory, "alias.md");
      symlinkSync(skill, alias);
      const partial = await tools
        .get("read")!
        .execute("alias-link", { path: alias, offset: 2, limit: 1 }, undefined, undefined, context);
      assert.deepEqual(partial.content, [{ type: "text", text: "last" }]);
    }),
  );

  for (const name of ["reference.md", "skill.md", "SKILL.md.txt"]) {
    it(
      `preserves standard partial reads for ${name}`,
      withFixture(async ({ tools, context, directory }) => {
        const path = join(directory, name);
        writeFileSync(path, "first\nlast");
        const result = await tools.get("read")!.execute(
          "partial",
          {
            path,
            offset: 2,
            limit: 1,
            readMode: "full",
            executor: { entrypoint: "/missing.ts" },
            entrypoint: "/missing.ts",
          },
          undefined,
          undefined,
          context,
        );
        assert.deepEqual(result.content, [{ type: "text", text: "last" }]);
        assert.equal(result.details, undefined);
      }),
    );
  }

  for (const body of ["line\n".repeat(2001), "a".repeat(52000)]) {
    it(
      `preserves standard truncation for a reference file of ${body.length} characters`,
      withFixture(async ({ tools, context, directory }) => {
        const path = join(directory, "reference.md");
        writeFileSync(path, body);
        const result = await tools
          .get("read")!
          .execute("truncated", { path }, undefined, undefined, context);
        assert.notDeepEqual(result.content, [{ type: "text", text: body }]);
        assert.equal(
          (result.details as { truncation: { truncated: boolean } }).truncation.truncated,
          true,
        );
      }),
    );
  }

  for (const denied of ["denied", "credential"]) {
    it(
      `rejects a SKILL.md read under ${denied}`,
      withFixture(async ({ tools, context, directory }) => {
        mkdirSync(join(directory, denied));
        const path = join(directory, denied, "SKILL.md");
        writeFileSync(path, "never disclose");
        await assert.rejects(
          tools
            .get("read")!
            .execute("denied-skill", { path, offset: 2, limit: 1 }, undefined, undefined, context),
          /Access denied(?::| for credential path:)/,
        );
      }),
    );
  }

  it(
    "keeps sandbox masks on a full read through an allowed symlink",
    withFixture(async ({ tools, context, directory }) => {
      const target = join(directory, "denied");
      writeFileSync(target, "never disclose");
      const path = join(directory, "SKILL.md");
      symlinkSync(target, path);
      await assert.rejects(
        tools.get("read")!.execute("masked-skill", { path }, undefined, undefined, context),
        /EACCES|ENOENT/,
      );
    }),
  );

  it(
    "does not read SKILL.md when already cancelled",
    withFixture(async ({ tools, context, directory }) => {
      const controller = new AbortController();
      controller.abort(new Error("cancelled skill"));
      await assert.rejects(
        tools
          .get("read")!
          .execute(
            "cancel-skill",
            { path: join(directory, "SKILL.md") },
            controller.signal,
            undefined,
            context,
          ),
        /cancelled skill/,
      );
    }),
  );

  it(
    "cancels a full read after the real sandbox opens the file",
    withFixture(async ({ tools, context, directory }) => {
      const path = join(directory, "SKILL.md");
      assert.equal(spawnSync("mkfifo", [path]).status, 0);
      const controller = new AbortController();
      const pending = tools
        .get("read")!
        .execute("running-skill", { path }, controller.signal, undefined, context);
      const writer = spawn("sh", [
        "-c",
        'exec 3>"$1"; printf connected; cat >/dev/null',
        "writer",
        path,
      ]);
      const connected = new Promise<void>((resolveConnected, rejectConnected) => {
        writer.stdout.once("data", () => resolveConnected());
        writer.once("error", rejectConnected);
      });
      try {
        await Promise.race([
          connected,
          pending.then(() => {
            throw new Error("full read ended before cancellation");
          }),
        ]);
        controller.abort();
        await assert.rejects(pending, /aborted/);
      } finally {
        controller.abort();
        writer.kill("SIGKILL");
      }
    }),
  );

  it(
    "keeps image reads ahead of the Tools worker even with a SKILL.md filename",
    withFixture(async ({ tools, context, directory }) => {
      const path = join(directory, "SKILL.md");
      const image = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        "base64",
      );
      writeFileSync(path, image);
      const result = await tools
        .get("read")!
        .execute("image-skill", { path, offset: 2, limit: 1 }, undefined, undefined, {
          ...context,
          model: { input: ["text", "image"] },
        } as ExtensionToolContext);
      assert.deepEqual(result.content, [
        { type: "image", data: image.toString("base64"), mimeType: "image/png" },
      ]);
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

  it(
    "does not adopt model executor fields for SKILL.md",
    withFixture(async ({ tools, context, directory }) => {
      const path = join(directory, "SKILL.md");
      const body = "first\nlast";
      writeFileSync(path, body);
      const result = await tools.get("read")!.execute(
        "injection",
        {
          path,
          offset: 2,
          limit: 1,
          executor: { entrypoint: "/missing.ts" },
          entrypoint: "/missing.ts",
          readMode: "standard",
        },
        undefined,
        undefined,
        context,
      );
      assert.deepEqual(result.content, [{ type: "text", text: body }]);
      assert.equal(result.structuredContent, body);
    }),
  );

  it("keeps Guardrails independent of Tools workers and full-read policy", () => {
    const directory = new URL("../guardrails/", import.meta.url);
    const implementations = readdirSync(directory).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    );
    for (const name of implementations) {
      const source = readFileSync(new URL(name, directory), "utf8");
      assert.doesNotMatch(source, /readMode|SKILL\.md|full-read|from ["']\.\.\/tools\//, name);
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
        `read:\n  - allow: "*"\n  - deny: "${directory}/denied"\ncredentials:\n  - "${directory}/credential"\ncommands:\n  - .*:\n      - allow: []\n`,
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
