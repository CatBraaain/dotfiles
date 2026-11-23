import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { realBwrapTest } from "./bwrap-test-support.ts";
import type {
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createGuardrailsAPI } from "./api.ts";
import { Guardrail } from "./guardrail.ts";

describe("guardrails API lifetime", () => {
  it(
    "preflights management paths without granting directory or metadata writes",
    withDirectory(async (directory) => {
      const { api, tools } = fixture(directory);
      const target = join(directory, "target");
      const metadata = join(directory, "metadata", "target");
      api.assertScopedWriteAllowed([target, metadata]);
      assert.equal(existsSync(target), false);
      const permission = tools.get("ask_permission")!;
      for (const path of [target, metadata])
        await assert.rejects(
          permission.execute("check", { path, reason: "test" }, undefined, undefined, {
            hasUI: false,
          } as ExtensionToolContext),
          /Access requires confirmation/,
        );
    }),
  );

  it(
    "checks the existing ancestors of planned paths with and without a sandbox",
    withDirectory(async (directory) => {
      const target = join(directory, "target");
      const alias = join(directory, "alias");
      const config = join(directory, "policy.yaml");
      mkdirSync(target);
      symlinkSync(target, alias, "dir");
      writeFileSync(
        config,
        JSON.stringify({
          read: [{ allow: "*" }],
          write: [{ deny: join(target, "denied") }],
          credentials: [join(target, "credential")],
        }),
      );
      const policy = new Guardrail(directory, config);
      const regularPath = join(target, "new", "file");
      const unresolved = join(directory, "unresolved");
      symlinkSync(join(directory, "missing"), unresolved, "dir");
      for (const sandboxed of [false, true]) {
        assert.deepEqual(policy.planScopedWriteProtection([regularPath], [target], sandboxed), []);
        assert.equal(existsSync(regularPath), false);
        assert.throws(
          () => policy.planScopedWriteProtection([join(target, "denied")], [target], sandboxed),
          /Access denied/,
        );
        assert.throws(
          () => policy.planScopedWriteProtection([join(target, "credential")], [target], sandboxed),
          /Access denied for credential path/,
        );
        assert.throws(
          () =>
            policy.planScopedWriteProtection([join(alias, "new", "file")], [directory], sandboxed),
          /Scoped write path uses an alias/,
        );
        assert.throws(
          () => policy.planScopedWriteProtection([], [alias], sandboxed),
          /Scoped write path uses an alias/,
        );
        assert.throws(
          () => policy.planScopedWriteProtection([join(unresolved, "new")], [directory], sandboxed),
          /Cannot resolve scoped write path/,
        );
      }
    }),
  );

  it(
    "permits only explicit leaf symlink removal without relaxing write protection",
    withDirectory(async (directory) => {
      const parent = join(directory, "parent");
      const alias = join(directory, "alias");
      const file = join(directory, "file");
      const link = join(parent, "link");
      const restricted = join(directory, "restricted");
      const denied = join(restricted, "denied");
      const secret = join(restricted, "secret");
      const config = join(directory, "policy.yaml");
      mkdirSync(parent);
      mkdirSync(restricted);
      writeFileSync(file, "unchanged");
      for (const path of [link, denied, secret]) symlinkSync(file, path, "file");
      symlinkSync(parent, alias, "dir");
      writeFileSync(
        config,
        JSON.stringify({
          read: [{ allow: "*" }],
          write: [{ deny: denied }],
          credentials: [secret],
        }),
      );
      const policy = new Guardrail(directory, config);
      for (const sandboxed of [false, true]) {
        assert.deepEqual(policy.planScopedWriteProtection([link], [parent], sandboxed, [link]), []);
        assert.throws(
          () => policy.planScopedWriteProtection([link], [parent], sandboxed),
          /uses an alias/,
        );
        const indirectLink = join(alias, "link");
        assert.throws(
          () =>
            policy.planScopedWriteProtection([indirectLink], [directory], sandboxed, [
              indirectLink,
            ]),
          /uses an alias/,
        );
        assert.throws(
          () => policy.planScopedWriteProtection([denied], [restricted], sandboxed, [denied]),
          /Access denied/,
        );
        assert.throws(
          () => policy.planScopedWriteProtection([secret], [restricted], sandboxed, [secret]),
          /credential path/,
        );
        const ordinary = join(parent, "ordinary");
        writeFileSync(ordinary, "ordinary");
        assert.throws(
          () => policy.planScopedWriteProtection([ordinary], [parent], sandboxed, [ordinary]),
          /Cannot resolve scoped write path/,
        );
      }
    }),
  );

  it(
    "resolves final write deny and always protects credentials through an alias",
    withDirectory(async (directory) => {
      const target = join(directory, "target");
      const alias = join(directory, "alias");
      mkdirSync(target);
      symlinkSync(target, alias, "dir");
      const { api } = fixture(
        directory,
        [
          '  - deny: "' + alias + '/blocked"',
          '  - ask: "' + target + '/blocked/exception"',
          "credentials:",
          '  - "' + alias + '/**/token.*"',
          "",
        ].join("\n"),
      );
      assert.throws(
        () => api.assertScopedWriteAllowed([join(target, "blocked", "file")]),
        /Access denied/,
      );
      assert.doesNotThrow(() =>
        api.assertScopedWriteAllowed([join(target, "blocked", "exception", "file")]),
      );
      assert.throws(
        () => api.assertScopedWriteAllowed([join(target, "blocked", "exception", "token.txt")]),
        /Access denied for credential path/,
      );
    }),
  );

  it(
    "fails closed when wildcard protection cannot be resolved through a symlink loop",
    withDirectory(async (directory) => {
      const aliases = join(directory, "aliases");
      mkdirSync(aliases);
      const { api } = fixture(
        directory,
        "credentials:\n  - " + JSON.stringify(join(aliases, "*", "token")) + "\n",
      );
      const loop = join(aliases, "loop");
      symlinkSync(loop, loop, "dir");
      assert.throws(() => api.assertScopedWriteAllowed([join(directory, "target")]), /ELOOP/);
    }),
  );

  it(
    "plans read-only mounts for the same alias-resolved paths as mutation preflight",
    withDirectory(async (directory) => {
      const target = join(directory, "target");
      const outside = join(directory, "outside");
      const aliases = join(outside, "aliases");
      mkdirSync(aliases, { recursive: true });
      mkdirSync(target);
      const config = join(directory, "policy.yaml");
      writeFileSync(
        config,
        JSON.stringify({
          read: [{ allow: "*" }],
          write: [{ deny: join(aliases, "*", "protected-*.txt") }],
          credentials: [join(aliases, "*", "**", "token.txt")],
        }),
      );
      const policy = new Guardrail(directory, config);
      const denied = join(target, "protected-data.txt");
      const credentials = join(target, "token.txt");
      writeFileSync(denied, "unrelated fixture");
      writeFileSync(credentials, "fixture credential");
      symlinkSync(target, join(aliases, "late"), "dir");
      assert.throws(() => policy.assertScopedWriteAllowed([denied]), /Access denied/);
      assert.throws(() => policy.assertScopedWriteAllowed([credentials]), /credential path/);
      assert.deepEqual(
        new Set(policy.planScopedWriteProtection([], [target], true)),
        new Set([denied, credentials]),
      );
      assert.deepEqual(policy.planScopedWriteProtection([], [outside], false), []);
      assert.throws(() => policy.planScopedWriteProtection([], [outside], true), /protected alias/);
      const unresolved = join(aliases, "unresolved");
      symlinkSync(unresolved, unresolved, "dir");
      assert.throws(() => policy.planScopedWriteProtection([], [target], true), /ELOOP/);
    }),
  );

  it(
    "rejects a planned file write covered by a read-only mask despite a later allow",
    withDirectory(async (directory) => {
      const common = join(directory, "metadata");
      const protectedRoot = join(common, "records");
      const allowedPath = join(protectedRoot, "planned");
      const other = join(common, "other");
      const config = join(directory, "policy.yaml");
      mkdirSync(protectedRoot, { recursive: true });
      mkdirSync(other);
      writeFileSync(
        config,
        JSON.stringify({
          read: [{ allow: "*" }],
          write: [{ deny: protectedRoot }, { allow: allowedPath }],
        }),
      );
      const policy = new Guardrail(directory, config);
      assert.doesNotThrow(() => policy.assertScopedWriteAllowed([allowedPath]));
      assert.deepEqual(policy.planScopedWriteProtection([], [common], true), [protectedRoot]);
      assert.deepEqual(
        policy.planScopedWriteProtection([join(other, "planned")], [other], true),
        [],
      );
      assert.throws(
        () => policy.planScopedWriteProtection([allowedPath], [common], true),
        (error: Error) =>
          error.message.includes("conflicts with read-only protection") &&
          error.message.includes(allowedPath) &&
          error.message.includes(protectedRoot),
      );
      assert.deepEqual(policy.planScopedWriteProtection([allowedPath], [common], false), []);
    }),
  );

  it(
    "checks an explicit executable basename deny for a Windows path",
    withDirectory(async (directory) => {
      const config = join(directory, "policy.yaml");
      writeFileSync(
        config,
        JSON.stringify({
          commands: [
            { tool: [{ allow: [] }] },
            { "tool\\.exe": [{ deny: ["remove"] }, { ask: ["version"] }] },
          ],
        }),
      );
      const policy = new Guardrail(directory, config);
      const executable = "C:\\Program Files\\Example\\tool.exe";
      assert.throws(
        () => policy.assertScopedCommandAllowed([executable, "remove", "target"]),
        /Command denied: tool\.exe/,
      );
      assert.doesNotThrow(() => policy.assertScopedCommandAllowed([executable, "version"]));
    }),
  );

  realBwrapTest(
    "applies a read-only view and replacement file only to the scoped process",
    withDirectory(async (directory) => {
      const { api } = fixture(directory);
      const view = join(directory, "view");
      const output = join(view, "output");
      const data = join(view, "data");
      const settings = join(view, "settings");
      mkdirSync(output, { recursive: true });
      writeFileSync(data, "shared data");
      writeFileSync(settings, "host settings");
      const signal = new AbortController().signal;
      const plan = {
        executable: "/usr/bin/cat",
        cwd: directory,
        args: [settings, data],
        env: {},
        allowedCodes: [],
        write: {
          directories: [output],
          paths: [],
          readOnlyView: { directory: view, paths: [data] },
          readOnlyFile: { path: settings, contents: "scoped settings" },
          validate() {},
        },
      };
      assert.throws(
        () =>
          api.grantScopedExecution(
            {
              ...plan,
              write: { ...plan.write, readOnlyView: { directory: view, paths: [output] } },
            },
            "parent/1",
            "fixture",
            signal,
          ),
        /Invalid scoped write plan/,
      );
      const grant = api.grantScopedExecution(plan, "parent/1", "fixture", signal);
      try {
        const result = await grant.run(() =>
          api.execute({
            id: "parent/1",
            toolName: "bash",
            params: { command: grant.command },
            signal,
            context: {
              hasUI: false,
              sessionManager: { getSessionId: () => "fixture" },
            } as Parameters<typeof api.execute>[0]["context"],
          }),
        );
        assert.deepEqual(result.details, { output: "scoped settingsshared data" });
        assert.equal(readFileSync(settings, "utf8"), "host settings");
      } finally {
        grant.dispose();
      }
    }),
  );

  realBwrapTest(
    "restricts a scoped write to the exact Bash invocation and never saves a grant",
    withDirectory(async (directory) => {
      const { api } = fixture(directory);
      const target = join(directory, "scoped");
      mkdirSync(target);
      const signal = new AbortController().signal;
      let validations = 0;
      const file = join(target, "created");
      const grant = api.grantScopedExecution(
        {
          cwd: target,
          executable: "/usr/bin/touch",
          args: [file],
          env: {},
          allowedCodes: [],
          write: {
            paths: [target],
            directories: [target],
            validate() {
              validations++;
            },
          },
        },
        "parent/1",
        "fixture",
        signal,
      );
      function execute(id: string, command: string, sessionId = "fixture") {
        return api.execute({
          id,
          toolName: "bash",
          params: { command },
          signal,
          context: {
            hasUI: false,
            sessionManager: {
              getSessionId: () => sessionId,
              getSessionFile: () => undefined,
            },
          } as Parameters<typeof api.execute>[0]["context"],
        });
      }
      await grant.run(async () => {
        await assert.rejects(execute("parent/1", grant.command, "other"), /does not match/);
        await assert.rejects(execute("parent/1", "true"), /does not match/);
        await assert.rejects(execute("other/1", grant.command), /Command denied/);
        assert.equal(existsSync(file), false);
        const write = execute("parent/1", grant.command);
        await assert.rejects(execute("parent/1", grant.command), /does not match/);
        await write;
      });
      assert.equal(validations, 2);
      assert.equal(grant.executed, true);
      assert.equal(existsSync(file), true);
      grant.dispose();
      assert.throws(() => grant.run(() => execute("parent/1", grant.command)), /revoked/);
      await assert.rejects(execute("parent/1", grant.command), /Command denied/);
    }),
  );

  realBwrapTest(
    "rejects explicit command denies without prompting for other scoped calls",
    withDirectory(async (directory) => {
      const { api } = fixture(
        directory,
        "",
        "  - touch:\n      - deny: [-c]\n      - ask_with_reason: [--version]\n",
      );
      const signal = new AbortController().signal;
      const target = join(directory, "target");
      mkdirSync(target);
      const file = join(target, "created");
      async function run(args: string[]) {
        const grant = api.grantScopedExecution(
          {
            executable: "/usr/bin/touch",
            cwd: target,
            args,
            env: {},
            allowedCodes: [],
            write: { paths: [target], directories: [target], validate() {} },
          },
          "parent/1",
          "fixture",
          signal,
        );
        try {
          return await grant.run(() =>
            api.execute({
              id: "parent/1",
              toolName: "bash",
              params: { command: grant.command },
              signal,
              context: {
                hasUI: false,
                sessionManager: { getSessionId: () => "fixture" },
              } as Parameters<typeof api.execute>[0]["context"],
            }),
          );
        } finally {
          grant.dispose();
        }
      }
      await assert.rejects(run(["-c", file]), /Command denied: touch/);
      assert.equal(existsSync(file), false);
      const version = await run(["--version"]);
      assert.match((version.details as { output: string }).output, /^touch /);
    }),
  );

  it(
    "never creates a directory as part of a trusted grant",
    withDirectory(async (directory) => {
      const { api } = fixture(directory);
      const target = join(directory, "missing");
      assert.throws(() => api.grantExistingDirectory(target), /Directory does not exist/);
      assert.equal(existsSync(target), false);
      assert.throws(() => api.grantExistingDirectory("relative"), /absolute directory path/);
      assert.throws(
        () => api.grantExistingDirectory(join(directory, "config.yaml")),
        /Directory does not exist/,
      );
    }),
  );

  it(
    "revokes only the specified grant and leaves confirmed permissions intact",
    withDirectory(async (directory) => {
      const { api, tools } = fixture(directory);
      const target = join(directory, "requested");
      const other = join(directory, "other");
      mkdirSync(other);
      const permission = tools.get("ask_permission")!;
      const confirm = {
        hasUI: true,
        ui: { confirm: async () => true },
      } as unknown as ExtensionToolContext;
      const noUI = { hasUI: false } as ExtensionToolContext;
      await permission.execute(
        "confirmed",
        { path: target, reason: "test" },
        undefined,
        undefined,
        confirm,
      );

      const revokeTarget = api.grantExistingDirectory(target);
      const revokeOther = api.grantExistingDirectory(other);
      const revokeIndependent = api.grantExistingDirectory(other);
      revokeTarget();
      revokeOther();
      for (const path of [target, other]) {
        const outcome = await permission.execute(
          "check",
          { path, reason: "test" },
          undefined,
          undefined,
          noUI,
        );
        assert.deepEqual(outcome.details, { status: "already granted", grantedPath: path });
      }
      revokeIndependent();
      await assert.rejects(
        permission.execute("check", { path: other, reason: "test" }, undefined, undefined, noUI),
        /Access requires confirmation/,
      );
    }),
  );

  it(
    "stops exposing old directory grants on session shutdown",
    withDirectory(async (directory) => {
      const target = join(directory, "target");
      mkdirSync(target);
      const first = fixture(directory);
      const revoke = first.api.grantExistingDirectory(target);
      first.handlers.get("session_shutdown")!({ reason: "reload" });
      assert.throws(() => first.api.grantExistingDirectory(target), /API is no longer active/);
      assert.throws(() => first.api.assertScopedWriteAllowed([target]), /API is no longer active/);

      const replacement = fixture(directory);
      const context = { hasUI: false } as ExtensionToolContext;
      await assert.rejects(
        replacement.tools
          .get("ask_permission")!
          .execute("old-grant", { path: target, reason: "test" }, undefined, undefined, context),
        /Access requires confirmation/,
      );
      revoke();
    }),
  );

  realBwrapTest(
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

  realBwrapTest(
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
      context.executeTool = async (name, args, options) => {
        const result = await replacement.api.execute({
          id: "nested",
          toolName: name,
          params: args as Record<string, unknown>,
          context,
          signal: options?.signal,
        });
        return {
          toolCall: {
            type: "toolCall",
            id: "nested",
            name,
            arguments: { command: (args as { command: string }).command },
          },
          result,
          isError: result.isError === true,
        };
      };
      const result = await replacement.api.execute({
        id: "new",
        toolName: "read",
        params: { path: join(directory, "config.yaml") },
        context,
      });
      assert.equal(result.content[0]?.type, "text");
    }),
  );

  realBwrapTest(
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

function fixture(directory: string, protection = "", commands = "") {
  const config = join(directory, "config.yaml");
  writeFileSync(
    config,
    `read:\n  - allow: "*"\nwrite:\n  - ask: "${directory}/requested"\n${protection}commands:\n  - echo:\n      - ask_with_reason: []\n  - file|bwrap:\n      - allow: []\n${commands}`,
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
