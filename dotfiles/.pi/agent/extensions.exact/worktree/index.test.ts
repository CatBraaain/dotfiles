import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import worktreeExtension from "./index.ts";
import {
  PROJECTS_DIR,
  buildWorktreePath,
  generateBranchName,
  migrateSession,
  parseMainWorktreePath,
  WorktreeMigrationError,
  type ExecResult,
  type GitRunner,
} from "./index.ts";

type GitCall = { args: string[]; cwd: string | undefined };

const MAIN = "/home/user/projects/dotfiles";
const WORKTREE = "/home/user/projects/dotfiles-gwt";
const PROJECTS = "/home/user/projects";

const ok: ExecResult = { stdout: "", stderr: "", code: 0 };
const fail = (message: string): ExecResult => ({ stdout: "", stderr: message, code: 128 });

function porcelainOf(mainPath: string, ...otherPaths: string[]): string {
  return [
    `worktree ${mainPath}\nHEAD 0000000`,
    ...otherPaths.map((path) => `\nworktree ${path}\nHEAD 0000001`),
  ].join("\n");
}

/** GitRunner stub that records calls and answers from a per-subcommand table. */
function createStubGit(table: Record<string, ExecResult>): {
  git: GitRunner;
  calls: GitCall[];
} {
  const calls: GitCall[] = [];
  const git: GitRunner = async (args, options) => {
    calls.push({ args, cwd: options?.cwd });
    const key = args.slice(0, 2).join(" ");
    const result = table[key];
    if (!result) throw new Error(`stub git: unexpected call: git ${key}`);
    return result;
  };
  return { git, calls };
}

type Notification = { message: string; level: string };

/** Command handler context stub recording notifications and session switches. */
function createCommandContext(options: { cwd: string; sessionFile?: string }): {
  ctx: unknown;
  handlerNotifications: Notification[];
  switches: Array<{ sessionFile: string; notifications: Notification[] }>;
} {
  const handlerNotifications: Notification[] = [];
  const switches: Array<{ sessionFile: string; notifications: Notification[] }> = [];
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
      switches.push({ sessionFile, notifications });
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
        });
      }
      return { cancelled: false };
    },
  };
  return { ctx, handlerNotifications, switches };
}

/**
 * Starts the extension with stub pi and a git table. The forkSession default
 * here is a stub; the real SessionManager.forkFrom is covered separately.
 */
function captureExtension(
  table: Record<string, ExecResult>,
  options: {
    projectsDir?: string;
    forkSession?: (sourceFile: string, targetCwd: string) => string;
  } = {},
): {
  calls: GitCall[];
  runCommand: (name: string, args: string, ctx: unknown) => Promise<void>;
  tools: Map<string, {
    promptSnippet?: string;
    promptGuidelines?: string[];
    execute: (...args: unknown[]) => Promise<unknown>;
  }>;
  sentUserMessages: Array<{ content: string; options: Record<string, unknown> }>;
  shutdownHandlers: Map<string, (event: { reason: string }, ctx: unknown) => Promise<void>>;
} {
  const { git, calls } = createStubGit(table);
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
  const shutdownHandlers = new Map<
    string,
    (event: { reason: string }, ctx: unknown) => Promise<void>
  >();

  worktreeExtension(
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
      on: (
        event: string,
        handler: (event: { reason: string }, ctx: unknown) => Promise<void>,
      ) => {
        shutdownHandlers.set(event, handler);
      },
      sendUserMessage: (content: string, options: Record<string, unknown>) => {
        sentUserMessages.push({ content, options });
      },
      exec: async () => {
        throw new Error("pi.exec must not be called when a git override is injected");
      },
    } as never,
    {
      git,
      projectsDir: options.projectsDir ?? PROJECTS,
      forkSession: options.forkSession ?? (() => "/sessions/forked.jsonl"),
    },
  );

  return {
    calls,
    async runCommand(name, args, ctx) {
      const command = commands.get(name);
      if (!command) throw new Error(`command not registered: ${name}`);
      await command.handler(args, ctx);
    },
    tools,
    sentUserMessages,
    shutdownHandlers,
  };
}

/** Handler context for a session sitting on the main worktree. */
function mainSessionContext() {
  return createCommandContext({ cwd: MAIN, sessionFile: "/sessions/source.jsonl" });
}

/** Handler context for a session sitting inside a worktree. */
function worktreeSessionContext() {
  return createCommandContext({ cwd: WORKTREE, sessionFile: "/sessions/source.jsonl" });
}

describe("移行先の特定", () => {
  it("builds the worktree path <projectsDir>/<repoName>-<branch> with the default ~/projects dir", () => {
    assert.equal(PROJECTS_DIR, join(homedir(), "projects"));
    assert.equal(buildWorktreePath(PROJECTS, "dotfiles", "gwt"), `${PROJECTS}/dotfiles-gwt`);
  });

  it("uses the given branch argument verbatim and derives the repo name from the repo root", async () => {
    const extension = captureExtension({
      "rev-parse --show-toplevel": { ...ok, stdout: `${MAIN}\n` },
      "worktree list": { ...ok, stdout: porcelainOf(MAIN) },
      "worktree add": ok,
      "status --porcelain": ok,
    });
    const context = mainSessionContext();
    await extension.runCommand("worktree", "gwt", context.ctx);

    const add = extension.calls.find(
      (call) => call.args[0] === "worktree" && call.args[1] === "add",
    );
    assert.equal(add?.args.join(" "), `worktree add ${PROJECTS}/dotfiles-gwt -b gwt`);
  });

  it("generates the fallback branch name wt-<yyyymmdd-hhmmss> from the local time", () => {
    assert.equal(generateBranchName(new Date(2026, 8, 4, 14, 6, 44)), "wt-20260904-140644");
    assert.equal(generateBranchName(new Date(2026, 0, 2, 3, 4, 5)), "wt-20260102-030405");
  });
});

describe("/worktree の振る舞い", () => {
  const mainTable: Record<string, ExecResult> = {
    "rev-parse --show-toplevel": { ...ok, stdout: `${MAIN}\n` },
    "worktree list": { ...ok, stdout: porcelainOf(MAIN) },
  };

  it("switches the session and notifies the branch and worktree path on success", async () => {
    const extension = captureExtension({
      ...mainTable,
      "worktree add": ok,
      "status --porcelain": ok,
    });
    const context = mainSessionContext();
    await extension.runCommand("worktree", "gwt", context.ctx);

    assert.deepEqual(context.handlerNotifications, []);
    assert.equal(context.switches.length, 1);
    assert.equal(context.switches[0]?.sessionFile, "/sessions/forked.jsonl");
    assert.deepEqual(context.switches[0]?.notifications, [
      { message: `worktree session: gwt at ${WORKTREE}`, level: "info" },
    ]);
  });

  it("notifies the carried-changes note when uncommitted changes existed", async () => {
    const extension = captureExtension({
      ...mainTable,
      "worktree add": ok,
      "status --porcelain": { ...ok, stdout: " M src/a.ts\n" },
      "stash push": ok,
      "stash pop": ok,
    });
    const context = mainSessionContext();
    await extension.runCommand("worktree", "gwt", context.ctx);

    assert.deepEqual(context.switches[0]?.notifications, [
      {
        message: `worktree session: gwt at ${WORKTREE} (uncommitted changes carried)`,
        level: "info",
      },
    ]);
  });

  it("notifies an error and changes nothing when already inside a worktree", async () => {
    const extension = captureExtension({
      "rev-parse --show-toplevel": { ...ok, stdout: `${WORKTREE}\n` },
      "worktree list": { ...ok, stdout: porcelainOf(MAIN, WORKTREE) },
      "worktree add": fail("must not be called"),
    });
    const context = worktreeSessionContext();
    await extension.runCommand("worktree", "gwt", context.ctx);

    assert.match(context.handlerNotifications[0]?.message ?? "", /worktree-back/);
    assert.equal(context.switches.length, 0);
    assert.equal(extension.calls.length, 2); // rev-parse + worktree list only
  });

  it("notifies an error when not inside a git repository", async () => {
    const extension = captureExtension({
      "rev-parse --show-toplevel": fail("fatal: not a git repository"),
      "worktree list": fail("must not matter"),
    });
    const context = mainSessionContext();
    await extension.runCommand("worktree", "gwt", context.ctx);

    assert.equal(context.handlerNotifications.length, 1);
    assert.equal(context.handlerNotifications[0]?.level, "error");
    assert.equal(context.switches.length, 0);
  });

  it("notifies an error when git worktree list fails", async () => {
    const extension = captureExtension({
      "rev-parse --show-toplevel": { ...ok, stdout: `${MAIN}\n` },
      "worktree list": fail("fatal: this operation must be run in a work tree"),
      "worktree add": fail("must not be called"),
    });
    const context = mainSessionContext();
    await extension.runCommand("worktree", "gwt", context.ctx);

    assert.equal(context.handlerNotifications.length, 1);
    assert.equal(context.handlerNotifications[0]?.level, "error");
    assert.equal(context.switches.length, 0);
    assert.equal(extension.calls.length, 2);
  });

  it("notifies an error when the porcelain output has no main worktree entry", async () => {
    const extension = captureExtension({
      "rev-parse --show-toplevel": { ...ok, stdout: `${MAIN}\n` },
      "worktree list": { ...ok, stdout: "" },
      "worktree add": fail("must not be called"),
    });
    const context = mainSessionContext();
    await extension.runCommand("worktree", "gwt", context.ctx);

    assert.equal(context.handlerNotifications.length, 1);
    assert.equal(context.handlerNotifications[0]?.level, "error");
    assert.equal(context.switches.length, 0);
    assert.equal(extension.calls.length, 2);
  });

  it("notifies an error when the session has no session file yet", async () => {
    const extension = captureExtension({
      ...mainTable,
      "worktree add": fail("must not be called"),
    });
    const context = createCommandContext({ cwd: MAIN });
    await extension.runCommand("worktree", "gwt", context.ctx);

    assert.equal(context.handlerNotifications.length, 1);
    assert.equal(context.handlerNotifications[0]?.level, "error");
    assert.equal(extension.calls.length, 2);
  });

  it("notifies an error and keeps the session when git worktree add fails", async () => {
    const extension = captureExtension({
      ...mainTable,
      "worktree add": fail("fatal: a branch named 'gwt' already exists"),
      "status --porcelain": fail("must not be called"),
    });
    const context = mainSessionContext();
    await extension.runCommand("worktree", "gwt", context.ctx);

    assert.equal(context.handlerNotifications.length, 1);
    assert.equal(context.handlerNotifications[0]?.level, "error");
    assert.equal(context.switches.length, 0);
    assert.equal(extension.calls.length, 3);
  });
});

describe("移行手順", () => {
  const migrateOptions = {
    sourceCwd: MAIN,
    sessionFile: "/sessions/source.jsonl",
    targetCwd: WORKTREE,
  };

  it("runs add, skips the stash when clean, and forks the session", async () => {
    const { git, calls } = createStubGit({ "worktree add": ok, "status --porcelain": ok });
    let forkedTarget: string | undefined;
    const outcome = await migrateSession(
      { git, forkSession: (_source, target) => (forkedTarget = target) },
      { ...migrateOptions, createBranch: "gwt", stashLabel: "worktree-migration:gwt" },
    );

    assert.equal(forkedTarget, WORKTREE);
    assert.equal(outcome.carriedChanges, false);
    assert.deepEqual(
      calls.map((call) => call.args.join(" ")),
      [`worktree add ${WORKTREE} -b gwt`, "status --porcelain"],
    );
  });

  it("carries uncommitted changes through stash push in the source and pop in the target", async () => {
    const { git, calls } = createStubGit({
      "worktree add": ok,
      "status --porcelain": { ...ok, stdout: " M src/a.ts\n" },
      "stash push": ok,
      "stash pop": ok,
    });
    const outcome = await migrateSession(
      { git, forkSession: () => "/sessions/forked.jsonl" },
      { ...migrateOptions, createBranch: "gwt", stashLabel: "worktree-migration:gwt" },
    );

    assert.equal(outcome.carriedChanges, true);
    assert.equal(outcome.newSessionFile, "/sessions/forked.jsonl");
    const stashPush = calls.find((call) => call.args[1] === "push");
    const stashPop = calls.find((call) => call.args[1] === "pop");
    assert.equal(stashPush?.cwd, MAIN);
    assert.equal(stashPop?.cwd, WORKTREE);
    assert.deepEqual(calls[2]?.args, ["stash", "push", "-u", "-m", "worktree-migration:gwt"]);
  });

  it("copies every entry and rewrites the header cwd when forking the session file", () => {
    const dir = mkdtempSync(join(tmpdir(), "worktree-fork-"));
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
            cwd: MAIN,
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

      const forked = SessionManager.forkFrom(source, WORKTREE, dir).getSessionFile()!;
      const entries = readFileSync(forked, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      const header = entries.find((entry) => entry.type === "session");
      assert.equal(header?.cwd, WORKTREE);
      assert.equal(header?.parentSession, source);
      const messages = entries.filter((entry) => entry.type === "message");
      assert.equal(messages.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("失敗時の保全", () => {
  const migrateOptions = {
    sourceCwd: MAIN,
    sessionFile: "/sessions/source.jsonl",
    targetCwd: WORKTREE,
    stashLabel: "worktree-migration:gwt",
  };

  it("step 1 failure leaves everything untouched (no status/stash/fork calls)", async () => {
    const { git, calls } = createStubGit({
      "worktree add": fail("fatal: invalid reference"),
      "status --porcelain": fail("must not be called"),
    });

    await assert.rejects(
      migrateSession(
        { git, forkSession: () => "/sessions/forked.jsonl" },
        { ...migrateOptions, createBranch: "gwt" },
      ),
      (error: unknown) => {
        assert.ok(error instanceof WorktreeMigrationError);
        return true;
      },
    );
    assert.equal(calls.length, 1);
  });

  it("step 3 failure keeps the changes on the stash stack and skips the fork", async () => {
    const { git, calls } = createStubGit({
      "worktree add": ok,
      "status --porcelain": { ...ok, stdout: " M src/a.ts\n" },
      "stash push": ok,
      "stash pop": fail("CONFLICT (modify/delete)"),
    });
    let forkCalled = false;

    await assert.rejects(
      migrateSession(
        { git, forkSession: () => ((forkCalled = true), "/sessions/forked.jsonl") },
        { ...migrateOptions, createBranch: "gwt" },
      ),
      (error: unknown) => {
        assert.ok(error instanceof WorktreeMigrationError);
        assert.match(error.message, /git stash list/);
        return true;
      },
    );
    assert.equal(forkCalled, false);
    assert.equal(calls.length, 4);
  });

  it("step 4-5 failure propagates the error after the worktree and stash steps are done", async () => {
    const extension = captureExtension(
      {
        "rev-parse --show-toplevel": { ...ok, stdout: `${MAIN}\n` },
        "worktree list": { ...ok, stdout: porcelainOf(MAIN) },
        "worktree add": ok,
        "status --porcelain": ok,
      },
      {
        forkSession: () => {
          throw new Error("fork failed");
        },
      },
    );
    const context = mainSessionContext();
    await extension.runCommand("worktree", "gwt", context.ctx);

    // git side completed (add + status) and the session was never switched.
    assert.equal(extension.calls.length, 4);
    assert.equal(context.switches.length, 0);
    assert.equal(context.handlerNotifications.length, 1);
    assert.equal(context.handlerNotifications[0]?.level, "error");
  });
});

describe("/worktree-back の振る舞い", () => {
  const worktreeTable: Record<string, ExecResult> = {
    "rev-parse --show-toplevel": { ...ok, stdout: `${WORKTREE}\n` },
    "worktree list": { ...ok, stdout: porcelainOf(MAIN, WORKTREE) },
  };

  it("extracts the main worktree path (first entry) from porcelain output", () => {
    const porcelain = porcelainOf(MAIN, WORKTREE);
    assert.equal(parseMainWorktreePath(porcelain), MAIN);
    assert.equal(parseMainWorktreePath(""), undefined);
  });

  it("returns to the main worktree without creating a worktree or branch", async () => {
    const extension = captureExtension({
      ...worktreeTable,
      "status --porcelain": ok,
    });
    const context = worktreeSessionContext();
    await extension.runCommand("worktree-back", "", context.ctx);

    const subcommands = extension.calls.map((call) => call.args[0]);
    assert.deepEqual(subcommands, ["rev-parse", "worktree", "status"]);
    assert.equal(context.switches.length, 1);
    assert.deepEqual(context.switches[0]?.notifications, [
      { message: `back to ${MAIN}`, level: "info" },
    ]);
  });

  it("carries uncommitted changes back with the worktree-migration:back stash label", async () => {
    const extension = captureExtension({
      ...worktreeTable,
      "status --porcelain": { ...ok, stdout: " M src/a.ts\n" },
      "stash push": ok,
      "stash pop": ok,
    });
    const context = worktreeSessionContext();
    await extension.runCommand("worktree-back", "", context.ctx);

    const stashPush = extension.calls.find((call) => call.args[1] === "push");
    assert.deepEqual(stashPush?.args, ["stash", "push", "-u", "-m", "worktree-migration:back"]);
    assert.equal(stashPush?.cwd, WORKTREE);
    assert.deepEqual(context.switches[0]?.notifications, [
      { message: `back to ${MAIN} (uncommitted changes carried)`, level: "info" },
    ]);
  });

  it("notifies an error when already in the main worktree", async () => {
    const extension = captureExtension({
      "rev-parse --show-toplevel": { ...ok, stdout: `${MAIN}\n` },
      "worktree list": { ...ok, stdout: porcelainOf(MAIN) },
      "status --porcelain": fail("must not be called"),
    });
    const context = mainSessionContext();
    await extension.runCommand("worktree-back", "", context.ctx);

    assert.equal(context.handlerNotifications.length, 1);
    assert.equal(context.handlerNotifications[0]?.level, "error");
    assert.equal(context.switches.length, 0);
  });

  it("notifies an error when not inside a git repository", async () => {
    const extension = captureExtension({
      "rev-parse --show-toplevel": fail("fatal: not a git repository"),
      "worktree list": fail("must not matter"),
    });
    const context = worktreeSessionContext();
    await extension.runCommand("worktree-back", "", context.ctx);

    assert.equal(context.handlerNotifications.length, 1);
    assert.equal(context.handlerNotifications[0]?.level, "error");
  });

  it("notifies an error when git worktree list fails", async () => {
    const extension = captureExtension({
      "rev-parse --show-toplevel": { ...ok, stdout: `${WORKTREE}\n` },
      "worktree list": fail("fatal: this operation must be run in a work tree"),
      "status --porcelain": fail("must not be called"),
    });
    const context = worktreeSessionContext();
    await extension.runCommand("worktree-back", "", context.ctx);

    assert.equal(context.handlerNotifications.length, 1);
    assert.equal(context.handlerNotifications[0]?.level, "error");
    assert.equal(context.switches.length, 0);
    assert.equal(extension.calls.length, 2);
  });

  it("notifies an error when the porcelain output has no main worktree entry", async () => {
    const extension = captureExtension({
      "rev-parse --show-toplevel": { ...ok, stdout: `${WORKTREE}\n` },
      "worktree list": { ...ok, stdout: "" },
      "status --porcelain": fail("must not be called"),
    });
    const context = worktreeSessionContext();
    await extension.runCommand("worktree-back", "", context.ctx);

    assert.equal(context.handlerNotifications.length, 1);
    assert.equal(context.handlerNotifications[0]?.level, "error");
    assert.equal(context.switches.length, 0);
    assert.equal(extension.calls.length, 2);
  });

  it("notifies an error when the session has no session file yet", async () => {
    const extension = captureExtension({
      ...worktreeTable,
      "status --porcelain": fail("must not be called"),
    });
    const context = createCommandContext({ cwd: WORKTREE });
    await extension.runCommand("worktree-back", "", context.ctx);

    assert.equal(context.handlerNotifications.length, 1);
    assert.equal(context.handlerNotifications[0]?.level, "error");
  });
});

describe("worktree ツール", () => {
  function captureTool(extension: ReturnType<typeof captureExtension>) {
    const tool = extension.tools.get("worktree");
    if (!tool) throw new Error("worktree tool not registered");
    return tool;
  }

  it("queues /worktree as a follow-up message when called without a branch", async () => {
    const extension = captureExtension({});
    const result = await captureTool(extension).execute("call-1", {});

    assert.deepEqual(extension.sentUserMessages, [
      {
        content: "/worktree",
        options: { deliverAs: "followUp", expandPromptTemplates: true },
      },
    ]);
    const text = (result as { content: Array<{ type: string; text: string }> }).content[0]?.text;
    assert.match(text ?? "", /Queued \/worktree/);
  });

  it("queues /worktree <branch> when called with a branch", async () => {
    const extension = captureExtension({});
    await captureTool(extension).execute("call-2", { branch: "gwt" });

    assert.equal(extension.sentUserMessages[0]?.content, "/worktree gwt");
  });

  it("exposes a one-line prompt snippet and migration-first guidelines", () => {
    const extension = captureExtension({});
    const tool = extension.tools.get("worktree");
    if (!tool) throw new Error("worktree tool not registered");

    assert.ok(!tool.promptSnippet?.includes("\n"));
    assert.equal(tool.promptGuidelines?.length, 1);
    assert.match(tool.promptGuidelines?.[0] ?? "", /worktree/);
    assert.match(tool.promptGuidelines?.[0] ?? "", /before/);
  });
});

describe("終了時の掃除", () => {
  const shutdownTable: Record<string, ExecResult> = {
    "rev-parse --show-toplevel": { ...ok, stdout: `${WORKTREE}\n` },
    "worktree list": { ...ok, stdout: porcelainOf(MAIN, WORKTREE) },
  };

  function shutdownContext(): { ctx: Record<string, unknown>; notifications: Notification[] } {
    const notifications: Notification[] = [];
    const ctx: Record<string, unknown> = {
      cwd: WORKTREE,
      hasUI: true,
      ui: {
        notify: (message: string, level: string) => {
          notifications.push({ message, level });
        },
      },
    };
    return { ctx, notifications };
  }

  async function runShutdown(
    extension: ReturnType<typeof captureExtension>,
    reason: string,
    context: { ctx: unknown },
  ): Promise<void> {
    const handler = extension.shutdownHandlers.get("session_shutdown");
    if (!handler) throw new Error("session_shutdown handler not registered");
    await handler({ reason }, context.ctx);
  }

  it("auto-commits with the branch name and removes the worktree when dirty", async () => {
    const extension = captureExtension({
      ...shutdownTable,
      "status --porcelain": { ...ok, stdout: " M src/a.ts\n" },
      "branch --show-current": { ...ok, stdout: "gwt\n" },
      "add -A": ok,
      "commit -m": ok,
      "worktree remove": ok,
    });
    const context = shutdownContext();
    await runShutdown(extension, "quit", context);

    assert.deepEqual(
      extension.calls.map((call) => call.args.join(" ")),
      [
        "rev-parse --show-toplevel",
        "worktree list --porcelain",
        "status --porcelain",
        "branch --show-current",
        "add -A",
        "commit -m [pi] auto-commit on exit (gwt)",
        `worktree remove ${WORKTREE}`,
      ],
    );
    // removal runs from the main worktree
    assert.equal(extension.calls[6]?.cwd, MAIN);
    assert.deepEqual(context.notifications, []);
  });

  it("commits with (detached) when the branch name is unavailable", async () => {
    const extension = captureExtension({
      ...shutdownTable,
      "status --porcelain": { ...ok, stdout: " M src/a.ts\n" },
      "branch --show-current": ok,
      "add -A": ok,
      "commit -m": ok,
      "worktree remove": ok,
    });
    const context = shutdownContext();
    await runShutdown(extension, "quit", context);

    const commit = extension.calls.find((call) => call.args[0] === "commit");
    assert.equal(commit?.args.join(" "), "commit -m [pi] auto-commit on exit (detached)");
  });

  it("removes the worktree without committing when clean", async () => {
    const extension = captureExtension({
      ...shutdownTable,
      "status --porcelain": ok,
      "commit -m": fail("must not be called"),
      "worktree remove": ok,
    });
    const context = shutdownContext();
    await runShutdown(extension, "quit", context);

    assert.deepEqual(
      extension.calls.map((call) => call.args.join(" ")),
      [
        "rev-parse --show-toplevel",
        "worktree list --porcelain",
        "status --porcelain",
        `worktree remove ${WORKTREE}`,
      ],
    );
  });

  it("keeps the worktree and notifies when the auto-commit fails", async () => {
    const extension = captureExtension({
      ...shutdownTable,
      "status --porcelain": { ...ok, stdout: " M src/a.ts\n" },
      "branch --show-current": { ...ok, stdout: "gwt\n" },
      "add -A": ok,
      "commit -m": fail("fatal: unable to auto-create config"),
      "worktree remove": fail("must not be called"),
    });
    const context = shutdownContext();
    await runShutdown(extension, "quit", context);

    assert.equal(context.notifications.length, 1);
    assert.equal(context.notifications[0]?.level, "warning");
    const removals = extension.calls.filter(
      (call) => call.args[0] === "worktree" && call.args[1] === "remove",
    );
    assert.equal(removals.length, 0);
  });

  it("keeps the worktree and notifies when the removal fails", async () => {
    const extension = captureExtension({
      ...shutdownTable,
      "status --porcelain": ok,
      "worktree remove": fail("fatal: working trees containing submodules cannot be removed"),
    });
    const context = shutdownContext();
    await runShutdown(extension, "quit", context);

    assert.equal(context.notifications.length, 1);
    assert.equal(context.notifications[0]?.level, "warning");
  });

  it("finishes silently and keeps the worktree when git status fails", async () => {
    const extension = captureExtension({
      ...shutdownTable,
      "status --porcelain": fail("fatal: bad object HEAD"),
      "worktree remove": fail("must not be called"),
    });
    const context = shutdownContext();
    await runShutdown(extension, "quit", context);

    assert.deepEqual(context.notifications, []);
    assert.deepEqual(
      extension.calls.map((call) => call.args[0]),
      ["rev-parse", "worktree", "status"],
    );
  });

  it("finishes silently without throwing when a git call itself throws", async () => {
    const extension = captureExtension({
      // no "worktree list" entry: the stub git runner throws on unexpected calls
      "rev-parse --show-toplevel": { ...ok, stdout: `${WORKTREE}\n` },
    });
    const context = shutdownContext();
    await runShutdown(extension, "quit", context);

    assert.deepEqual(context.notifications, []);
    assert.equal(extension.calls.length, 2);
  });

  it("does nothing for a session on the main worktree", async () => {
    const extension = captureExtension({
      "rev-parse --show-toplevel": { ...ok, stdout: `${MAIN}\n` },
      "worktree list": { ...ok, stdout: porcelainOf(MAIN) },
      "worktree remove": fail("must not be called"),
    });
    const context = shutdownContext();
    context.ctx = { ...context.ctx, cwd: MAIN };
    await runShutdown(extension, "quit", context);

    assert.deepEqual(
      extension.calls.map((call) => call.args[0]),
      ["rev-parse", "worktree"],
    );
  });

  it("does nothing when the reason is not quit", async () => {
    const extension = captureExtension({});
    await runShutdown(extension, "reload", shutdownContext());

    assert.equal(extension.calls.length, 0);
  });
});
