import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import cdExtension, {
  CD_COMMAND_NAME,
  RESUME_MESSAGE,
  resolveTargetPath,
  type ForkSession,
} from "./index.ts";

type Notification = { message: string; level: string };

function createCommandContext(options: { cwd: string; sessionFile?: string }): {
  ctx: unknown;
  handlerNotifications: Notification[];
  switches: Array<{
    sessionFile: string;
    notifications: Notification[];
    sentMessages: string[];
  }>;
} {
  const handlerNotifications: Notification[] = [];
  const switches: Array<{
    sessionFile: string;
    notifications: Notification[];
    sentMessages: string[];
  }> = [];
  const ctx = {
    cwd: options.cwd,
    sessionManager: { getSessionFile: () => options.sessionFile },
    ui: {
      notify: (message: string, level: string) => {
        handlerNotifications.push({ message, level });
      },
    },
    switchSession: async (sessionFile: string, switchOptions?: { withSession?: unknown }) => {
      const notifications: Notification[] = [];
      const sentMessages: string[] = [];
      switches.push({ sessionFile, notifications, sentMessages });
      const withSession = switchOptions?.withSession as
        | ((context: unknown) => Promise<void>)
        | undefined;
      if (withSession) {
        await withSession({
          ui: {
            notify: (message: string, level: string) => {
              notifications.push({ message, level });
            },
          },
          sendUserMessage: async (message: string) => {
            sentMessages.push(message);
          },
        });
      }
      return { cancelled: false };
    },
  };
  return { ctx, handlerNotifications, switches };
}

function captureExtension(options: { forkSession?: ForkSession } = {}): {
  runCommand: (args: string, ctx: unknown) => Promise<void>;
  tools: Map<
    string,
    {
      promptSnippet?: string;
      promptGuidelines?: string[];
      execute: (...args: unknown[]) => Promise<unknown>;
    }
  >;
  sentUserMessages: Array<{ content: string; options: Record<string, unknown> }>;
} {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const tools = new Map<
    string,
    {
      promptSnippet?: string;
      promptGuidelines?: string[];
      execute: (...args: unknown[]) => Promise<unknown>;
    }
  >();
  const sentUserMessages: Array<{ content: string; options: Record<string, unknown> }> = [];

  cdExtension(
    {
      registerCommand: (
        name: string,
        definition: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) => {
        commands.set(name, definition);
      },
      registerTool: (definition: { name: string }) => {
        tools.set(
          definition.name,
          definition as unknown as {
            promptSnippet?: string;
            promptGuidelines?: string[];
            execute: (...args: unknown[]) => Promise<unknown>;
          },
        );
      },
      sendUserMessage: (content: string, sendOptions: Record<string, unknown>) => {
        sentUserMessages.push({ content, options: sendOptions });
      },
    } as never,
    { forkSession: options.forkSession ?? (() => "/sessions/forked.jsonl") },
  );

  return {
    async runCommand(args, ctx) {
      const command = commands.get(CD_COMMAND_NAME);
      if (!command) throw new Error(`command not registered: ${CD_COMMAND_NAME}`);
      await command.handler(args, ctx);
    },
    tools,
    sentUserMessages,
  };
}

/** Creates a temp directory and a plain file inside it for path validation tests. */
function createTempDir(): { dir: string; file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "cd-extension-"));
  const file = join(dir, "plain-file.txt");
  writeFileSync(file, "x");
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function sessionCtx(cwd: string) {
  return createCommandContext({ cwd, sessionFile: "/sessions/source.jsonl" });
}

describe("パス解決", () => {
  it("expands a leading ~ to the home directory", () => {
    assert.equal(resolveTargetPath("~", "/any/cwd"), homedir());
    assert.equal(resolveTargetPath("~/projects", "/any/cwd"), join(homedir(), "projects"));
  });

  it("resolves relative paths against the current cwd and keeps absolute paths", () => {
    assert.equal(resolveTargetPath("sub/dir", "/home/user/work"), "/home/user/work/sub/dir");
    assert.equal(resolveTargetPath("/elsewhere", "/home/user/work"), "/elsewhere");
  });
});

describe("cd ツール", () => {
  function captureTool(extension: ReturnType<typeof captureExtension>) {
    const tool = extension.tools.get("cd");
    if (!tool) throw new Error("cd tool not registered");
    return tool;
  }

  it("queues /cd <path> as a follow-up message", async () => {
    const extension = captureExtension();
    const result = await captureTool(extension).execute("call-1", { path: "/tmp/wt" });

    assert.deepEqual(extension.sentUserMessages, [
      {
        content: "/cd /tmp/wt",
        options: { deliverAs: "followUp", expandPromptTemplates: true },
      },
    ]);
    const text = (result as { content: Array<{ type: string; text: string }> }).content[0]?.text;
    assert.match(text ?? "", /Queued \/cd \/tmp\/wt/);
  });

  it("exposes a one-line prompt snippet and single guideline covering bash cd and worktree", () => {
    const extension = captureExtension();
    const registered = extension.tools.get("cd");
    if (!registered) throw new Error("cd tool not registered");

    assert.ok(!registered.promptSnippet?.includes("\n"));
    assert.equal(registered.promptGuidelines?.length, 1);
    const guideline = registered.promptGuidelines?.[0] ?? "";
    assert.match(guideline, /bash/);
    assert.match(guideline, /worktree/);
  });
});

describe("/cd の振る舞い", () => {
  it("switches the session and notifies the resolved path on success", async () => {
    const temp = createTempDir();
    try {
      const extension = captureExtension();
      const context = sessionCtx("/old/cwd");
      await extension.runCommand(temp.dir, context.ctx);

      assert.deepEqual(context.handlerNotifications, []);
      assert.equal(context.switches.length, 1);
      assert.equal(context.switches[0]?.sessionFile, "/sessions/forked.jsonl");
      assert.deepEqual(context.switches[0]?.notifications, [
        { message: `moved to ${temp.dir}`, level: "info" },
      ]);
      // human-invoked command: no resume message
      assert.deepEqual(context.switches[0]?.sentMessages, []);
    } finally {
      temp.cleanup();
    }
  });

  it("sends the resume message after a tool-triggered move", async () => {
    const temp = createTempDir();
    try {
      const extension = captureExtension();
      const tool = extension.tools.get("cd");
      if (!tool) throw new Error("cd tool not registered");
      await tool.execute("call-1", { path: temp.dir });

      const context = sessionCtx("/old/cwd");
      await extension.runCommand(temp.dir, context.ctx);

      assert.deepEqual(context.switches[0]?.sentMessages, [RESUME_MESSAGE]);
      // the flag is consumed once
      const second = sessionCtx(temp.dir);
      await extension.runCommand(temp.dir, second.ctx);
      assert.deepEqual(second.switches[0]?.sentMessages, []);
    } finally {
      temp.cleanup();
    }
  });

  it("expands ~ in the command argument before moving", async () => {
    const extension = captureExtension();
    const context = sessionCtx("/old/cwd");
    await extension.runCommand("~/somewhere", context.ctx);

    // homedir/somewhere does not exist: error notification with the resolved path
    assert.equal(context.handlerNotifications.length, 1);
    assert.equal(
      context.handlerNotifications[0]?.message,
      `not a directory: ${join(homedir(), "somewhere")}`,
    );
    assert.equal(context.switches.length, 0);
  });

  it("notifies an error and changes nothing when the path is missing", async () => {
    const extension = captureExtension();
    const context = sessionCtx("/old/cwd");
    await extension.runCommand("/no/such/dir", context.ctx);

    assert.equal(context.handlerNotifications.length, 1);
    assert.equal(context.handlerNotifications[0]?.level, "error");
    assert.match(context.handlerNotifications[0]?.message ?? "", /^not a directory: /);
    assert.equal(context.switches.length, 0);
  });

  it("notifies an error when the path is not a directory", async () => {
    const temp = createTempDir();
    try {
      const extension = captureExtension();
      const context = sessionCtx(temp.dir);
      await extension.runCommand(temp.file, context.ctx);

      assert.equal(context.handlerNotifications.length, 1);
      assert.equal(context.handlerNotifications[0]?.level, "error");
      assert.equal(context.switches.length, 0);
    } finally {
      temp.cleanup();
    }
  });

  it("notifies an error when the path argument is empty", async () => {
    const extension = captureExtension();
    const context = sessionCtx("/old/cwd");
    await extension.runCommand("   ", context.ctx);

    assert.equal(context.handlerNotifications.length, 1);
    assert.equal(context.handlerNotifications[0]?.level, "error");
    assert.equal(context.switches.length, 0);
  });

  it("notifies an error when the session has no session file yet", async () => {
    const temp = createTempDir();
    try {
      const extension = captureExtension();
      const context = createCommandContext({ cwd: "/old/cwd" });
      await extension.runCommand(temp.dir, context.ctx);

      assert.equal(context.handlerNotifications.length, 1);
      assert.equal(context.handlerNotifications[0]?.level, "error");
      assert.equal(context.switches.length, 0);
    } finally {
      temp.cleanup();
    }
  });

  it("notifies an error when forking the session file fails", async () => {
    const temp = createTempDir();
    try {
      const extension = captureExtension({
        forkSession: () => {
          throw new Error("fork failed");
        },
      });
      const context = sessionCtx("/old/cwd");
      await extension.runCommand(temp.dir, context.ctx);

      assert.equal(context.handlerNotifications.length, 1);
      assert.equal(context.handlerNotifications[0]?.level, "error");
      assert.equal(context.switches.length, 0);
    } finally {
      temp.cleanup();
    }
  });
});

describe("セッションファイルの fork", () => {
  it("copies every entry and rewrites the header cwd with a parentSession record", () => {
    const dir = mkdtempSync(join(tmpdir(), "cd-fork-"));
    try {
      const source = join(dir, "source.jsonl");
      writeFileSync(
        source,
        [
          JSON.stringify({
            type: "session",
            version: 3,
            id: "uuid-1",
            timestamp: "2026-09-04T00:00:00.000Z",
            cwd: "/old/cwd",
          }),
          JSON.stringify({
            type: "message",
            id: "a1b2c3d4",
            parentId: null,
            timestamp: "2026-09-04T00:00:01.000Z",
            message: { role: "user", content: "hi" },
          }),
          JSON.stringify({
            type: "message",
            id: "b2c3d4e5",
            parentId: "a1b2c3d4",
            timestamp: "2026-09-04T00:00:02.000Z",
            message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
          }),
        ].join("\n") + "\n",
      );

      const forked = SessionManager.forkFrom(source, "/new/cwd", dir).getSessionFile()!;
      const entries = readFileSync(forked, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      const header = entries.find((entry) => entry.type === "session");
      assert.equal(header?.cwd, "/new/cwd");
      assert.equal(header?.parentSession, source);
      const messages = entries.filter((entry) => entry.type === "message");
      assert.equal(messages.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
