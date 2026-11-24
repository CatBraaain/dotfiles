import assert from "node:assert/strict";

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "bun:test";
import { quote } from "shell-quote";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getWorkspaces, WORKSPACES_ENTRY_TYPE } from "./metadata.ts";
import sessionMetadataExtension, { piMuxExecutable } from "./index.ts";

type Handler = (event: Record<string, unknown>, context: ExtensionContext) => unknown;
type SentMessage = Parameters<ExtensionAPI["sendMessage"]>;
type Renderer = Parameters<ExtensionAPI["registerMessageRenderer"]>[1];
const cleanup: (() => void)[] = [];
const piMuxCli = new URL("../../../../.local/cli.exact/pi-mux/src/main.ts", import.meta.url);
const gitEnvironment = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose()),
);

async function createHarness(persist = true) {
  mkdirSync("/tmp/work/dotfiles/session-metadata-custom-qa", { recursive: true });
  const directory = mkdtempSync("/tmp/work/dotfiles/session-metadata-custom-qa/integration-");
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "main repo");
  mkdirSync(root);
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", root], {
    env: gitEnvironment,
    stdio: "pipe",
  });
  execFileSync(
    "git",
    [
      "-C",
      root,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ],
    { env: gitEnvironment, stdio: "pipe" },
  );
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDefinition>();
  const messages: SentMessage[] = [];
  const renderers = new Map<string, Renderer>();
  const queries: string[] = [];
  let manager = newManager();
  let nestedId = 0;
  let appendError: Error | undefined;

  function newManager(): SessionManager {
    const session = SessionManager.create(root, join(directory, "sessions"));
    if (persist) {
      session.appendMessage({ role: "user", content: "fixture", timestamp: 1 });
      session.appendMessage({
        role: "assistant",
        content: [],
        api: "fixture",
        provider: "fixture",
        model: "fixture",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      });
    }
    return session;
  }

  function context(): ExtensionContext {
    return {
      cwd: root,
      sessionManager: manager,
    } as unknown as ExtensionContext;
  }

  async function emit(
    name: string,
    event: Record<string, unknown>,
    ctx = context(),
  ): Promise<void> {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  }

  function shell(command: string, env = gitEnvironment) {
    const output = spawnSync("bash", ["--noprofile", "--norc", "-c", command], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    if (output.error) throw output.error;
    return {
      result: {
        content: [{ type: "text" as const, text: output.stdout + output.stderr }],
        details: { exitCode: output.status },
      },
      isError: output.status !== 0,
    };
  }

  let execError: Error | undefined;
  const pi = {
    async exec(command: string, args: string[], options: { cwd: string }) {
      if (execError) throw execError;
      if (
        command !== "pi-mux" ||
        args[0] !== "worktree" ||
        args[1] !== "snapshot" ||
        args.length !== 3
      )
        throw new Error(`Unexpected process command: ${command} ${args.join(" ")}`);
      queries.push(args[2]!);
      const output = spawnSync(process.execPath, [fileURLToPath(piMuxCli), ...args], {
        cwd: options.cwd,
        env: gitEnvironment,
        encoding: "utf8",
      });
      if (output.error) throw output.error;
      return {
        stdout: output.stdout,
        stderr: output.stderr,
        code: output.status ?? 1,
        killed: output.signal !== null,
        truncated: false,
      };
    },
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => {};
    },
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    appendEntry(customType: string, data?: unknown) {
      if (appendError) throw appendError;
      manager.appendCustomEntry(customType, data);
    },
    sendMessage(...args: SentMessage) {
      messages.push(args);
    },
    registerMessageRenderer(type: string, renderer: Renderer) {
      renderers.set(type, renderer);
    },
  } as unknown as ExtensionAPI;
  sessionMetadataExtension(pi);
  await emit("session_start", { reason: "startup" });

  async function bash(command: string, parentToolCallId?: string) {
    const id = `bash-${++nestedId}`;
    const ctx = context();
    const input = { command };
    await emit("tool_call", { toolName: "bash", toolCallId: id, input, parentToolCallId }, ctx);
    const outcome = shell(input.command);
    const event = {
      toolName: "bash",
      toolCallId: id,
      input,
      parentToolCallId,
      ...outcome.result,
      isError: outcome.isError,
    };
    const original = structuredClone(event);
    await emit("tool_result", event, ctx);
    await emit(
      "tool_execution_end",
      {
        toolName: "bash",
        toolCallId: id,
        result: outcome.result,
        isError: outcome.isError,
        durationMs: 1,
      },
      ctx,
    );
    return { event, original, outcome };
  }

  return {
    directory,
    root,
    tools,
    messages,
    queries,
    renderers,
    get manager() {
      return manager;
    },
    emit,
    bash,
    shell,
    seedWorkspace(path: string) {
      manager.appendCustomEntry(WORKSPACES_ENTRY_TYPE, {
        sessionId: manager.getSessionId(),
        workspaces: [...getWorkspaces(manager), path],
      });
    },
    setExecError(error: Error) {
      execError = error;
    },
    setAppendError(error: Error) {
      appendError = error;
    },
    async switchSession() {
      const oldManager = manager;
      await emit("session_shutdown", { reason: "new" });
      manager = newManager();
      await emit("session_start", { reason: "new" });
      return oldManager;
    },
    async createWorktree(name: string) {
      const path = join(directory, name);
      const result = shell(
        quote(["git", "worktree", "add", "-b", name.replaceAll(" ", "-"), path]),
      );
      if (result.isError) throw new Error(result.result.content[0]!.text);
      return path;
    },
  };
}

describe("pi-mux snapshot executable", () => {
  it("checks only fully qualified Windows PATH entries in order", () => {
    const checked: string[] = [];
    const expected = "C:\\Installed tools\\pi-mux.exe";
    const selected = piMuxExecutable(
      "win32",
      '.;;bin;C:relative;\\rooted;"C:\\Missing tools";"C:\\Installed tools";D:\\Later',
      (candidate) => {
        checked.push(candidate);
        return candidate === expected;
      },
    );
    assert.equal(selected, expected);
    assert.deepEqual(checked, ["C:\\Missing tools\\pi-mux.exe", expected]);
  });

  it("does not fall back to a working-directory executable", () => {
    assert.throws(
      () => piMuxExecutable("win32", ";.;bin;C:;\\rooted", () => assert.fail("Unexpected lookup")),
      /pi-mux\.exe not found/,
    );
  });
});

describe("session metadata extension", () => {
  it("starts with an empty association without appending or modifying the header", async () => {
    const h = await createHarness();
    assert.deepEqual(getWorkspaces(h.manager), []);
    assert.equal(
      h.manager.getEntries().some((entry) => entry.type === "custom"),
      false,
    );
    assert.deepEqual([...h.tools.keys()], []);
  });

  it("automatically registers add and leaves the entire Bash result unchanged", async () => {
    const h = await createHarness();
    const path = join(h.directory, "feature with spaces");
    const result = await h.bash(
      quote(["git", "-C", h.root, "worktree", "add", "-b", "feature", path]),
    );
    assert.deepEqual(getWorkspaces(h.manager), [path]);
    assert.deepEqual(result.event, result.original);
    const metadata = h.manager.getEntries().findLast((entry) => entry.type === "custom");
    assert.ok(metadata && metadata.type === "custom");
    assert.equal(metadata.customType, WORKSPACES_ENTRY_TYPE);
    assert.deepEqual(metadata.data, { sessionId: h.manager.getSessionId(), workspaces: [path] });
    const [message, options] = h.messages[0]!;
    assert.match(String(message.content), /metadata updated/);
    assert.match(String(message.content), /"added":\[/);
    assert.match(String(message.content), /"workspaces":\[/);
    assert.equal(message.display, true);
    assert.deepEqual(options, { deliverAs: "steer" });
    assert.equal(h.messages.length, 1);
  });

  it("registers a new worktree below a symlink parent using its real path", async () => {
    const h = await createHarness();
    const actual = join(h.directory, "actual");
    const alias = join(h.directory, "alias");
    mkdirSync(actual);
    symlinkSync(actual, alias);
    const target = join(alias, "missing", "feature");
    assert.equal(existsSync(target), false);
    const result = await h.bash(quote(["git", "worktree", "add", "--detach", target, "HEAD"]));
    const canonical = join(actual, "missing", "feature");
    assert.equal(result.outcome.isError, false);
    assert.deepEqual(getWorkspaces(h.manager), [canonical]);
    assert.ok(existsSync(join(canonical, ".git")));
  });

  it("registers the physical Git add target when a symlink precedes dot-dot", async () => {
    const h = await createHarness();
    const actual = join(h.directory, "actual");
    const deep = join(actual, "deep");
    const alias = join(h.root, "alias");
    mkdirSync(deep, { recursive: true });
    symlinkSync(deep, alias);
    const target = `${alias}/../new`;
    const result = await h.bash(quote(["git", "worktree", "add", "--detach", target, "HEAD"]));
    const physical = join(actual, "new");
    assert.equal(result.outcome.isError, false);
    assert.ok(existsSync(join(physical, ".git")));
    assert.equal(existsSync(join(h.root, "new")), false);
    assert.deepEqual(getWorkspaces(h.manager), [physical]);
  });

  it("resolves git -C through a symlink before dot-dot", async () => {
    const h = await createHarness();
    const deep = join(h.root, "deep");
    const alias = join(h.directory, "repo-alias");
    mkdirSync(deep);
    symlinkSync(deep, alias);
    const target = join(h.directory, "from-git-c");
    const result = await h.bash(
      quote(["git", "-C", `${alias}/..`, "worktree", "add", "--detach", target, "HEAD"]),
    );
    assert.equal(result.outcome.isError, false);
    assert.deepEqual(getWorkspaces(h.manager), [target]);
  });

  it("keeps Bash logical cd semantics for a symlink followed by dot-dot", async () => {
    const h = await createHarness();
    const deep = join(h.directory, "actual", "deep");
    const alias = join(h.root, "alias");
    mkdirSync(deep, { recursive: true });
    symlinkSync(deep, alias);
    const target = join(h.root, "from-cd");
    const result = await h.bash(
      `cd ${quote([`${alias}/..`])} && ${quote(["git", "worktree", "add", "--detach", "./from-cd", "HEAD"])}`,
    );
    assert.equal(result.outcome.isError, false);
    assert.deepEqual(getWorkspaces(h.manager), [target]);
  });

  it("keeps registration order across physical moves and removals through symlink and dot-dot", async () => {
    const h = await createHarness();
    const first = await h.createWorktree("first");
    h.seedWorkspace(first);
    const actual = join(h.directory, "actual");
    const deep = join(actual, "deep");
    const alias = join(h.root, "alias");
    mkdirSync(deep, { recursive: true });
    symlinkSync(deep, alias);
    const source = `${alias}/../source`;
    const destination = `${alias}/../destination`;
    const added = await h.bash(quote(["git", "worktree", "add", "--detach", source, "HEAD"]));
    assert.equal(added.outcome.isError, false);
    const last = await h.createWorktree("last");
    h.seedWorkspace(last);
    const moved = await h.bash(quote(["git", "worktree", "move", source, destination]));
    assert.equal(moved.outcome.isError, false);
    assert.deepEqual(getWorkspaces(h.manager), [first, join(actual, "destination"), last]);
    const removed = await h.bash(quote(["git", "worktree", "remove", destination]));
    assert.equal(removed.outcome.isError, false);
    assert.deepEqual(getWorkspaces(h.manager), [first, last]);
  });

  for (const [argument, relative] of [
    ["@feature", "@feature"],
    ["'@feature'", "@feature"],
    ["'~/feature'", "~/feature"],
    ['"~/feature"', "~/feature"],
    ["\\~/feature", "~/feature"],
  ]) {
    it(`registers the literal Bash path for ${argument}`, async () => {
      const h = await createHarness();
      const result = await h.bash(`git worktree add --detach ${argument} HEAD`);
      const target = join(h.root, relative!);
      assert.equal(result.outcome.isError, false);
      assert.ok(existsSync(join(target, ".git")));
      assert.deepEqual(getWorkspaces(h.manager), [target]);
    });
  }

  it("matches real Bash and Git for unquoted home and quoted literal tilde paths", async () => {
    const h = await createHarness();
    const home = join(h.directory, "home");
    mkdirSync(home);
    const physicalHome = join(h.directory, "physical home");
    const homeDeep = join(physicalHome, "deep");
    mkdirSync(homeDeep, { recursive: true });
    symlinkSync(homeDeep, join(home, "alias"));
    const env = { ...gitEnvironment, HOME: home };
    const command =
      "git worktree add --detach ~/feature HEAD && git worktree add --detach '~/feature' HEAD";
    const module = new URL("./worktrees.ts", import.meta.url).href;
    const script = `import { findWorktreeScopes } from ${JSON.stringify(module)};
      console.log(JSON.stringify({
        scopes: findWorktreeScopes(${JSON.stringify(command)})
      }));`;
    const parsed = JSON.parse(
      execFileSync(process.execPath, ["--eval", script], { env, encoding: "utf8" }),
    );
    const result = h.shell(command, env);
    const expected = [join(home, "feature"), join(h.root, "~/feature")];
    assert.equal(result.isError, false, result.result.content[0]!.text);
    expected.forEach((target) => assert.ok(existsSync(join(target, ".git"))));
    assert.deepEqual(parsed.scopes, [
      {
        shellDirectories: [],
        gitDirectories: [],
        actions: ["add"],
        paths: [expected[0], "~/feature"],
        destinationIndexes: [0, 1],
      },
    ]);
    const [{ actions: _actions, destinationIndexes: _destinations, ...request }] = parsed.scopes;
    const snapshot = execFileSync(
      process.execPath,
      [fileURLToPath(piMuxCli), "worktree", "snapshot", JSON.stringify(request)],
      { cwd: h.root, env, encoding: "utf8" },
    );
    assert.deepEqual(JSON.parse(snapshot).paths, expected);
  });

  it("appends multiple additions in observed Git list order after existing registrations", async () => {
    const h = await createHarness();
    const existing = join(h.directory, "existing");
    const first = await h.bash(quote(["git", "worktree", "add", "--detach", existing, "HEAD"]));
    assert.equal(first.outcome.isError, false);
    assert.deepEqual(getWorkspaces(h.manager), [existing]);
    const zulu = join(h.directory, "zulu");
    const alpha = join(h.directory, "alpha");
    const result = await h.bash(
      `${quote(["git", "worktree", "add", "--detach", zulu, "HEAD"])} && ${quote(["git", "worktree", "add", "--detach", alpha, "HEAD"])}`,
    );
    assert.equal(result.outcome.isError, false);
    assert.deepEqual(getWorkspaces(h.manager), [existing, alpha, zulu]);
  });

  it("replaces a registered path after move through cd and git -C", async () => {
    const h = await createHarness();
    const source = await h.createWorktree("source");
    h.seedWorkspace(source);
    const destination = join(h.directory, "destination");
    await h.bash(
      `cd ${quote([source])} && git -C ${quote([h.root])} worktree move ${quote([source, destination])}`,
    );
    assert.deepEqual(getWorkspaces(h.manager), [destination]);
    assert.match(String(h.messages[0]![0].content), /"moved":\[\{"from":/);
  });

  it("unregisters remove without touching other sessions", async () => {
    const h = await createHarness();
    const path = await h.createWorktree("source");
    const other = SessionManager.create(h.root, join(h.directory, "other-sessions"));
    other.appendCustomEntry(WORKSPACES_ENTRY_TYPE, {
      sessionId: other.getSessionId(),
      workspaces: [path],
    });
    const otherEntries = structuredClone(other.getEntries());
    h.seedWorkspace(path);
    await h.bash(quote(["git", "worktree", "remove", path]));
    assert.deepEqual(getWorkspaces(h.manager), []);
    const metadata = h.manager.getEntries().at(-1);
    assert.ok(metadata?.type === "custom");
    assert.deepEqual(metadata.data, { sessionId: h.manager.getSessionId(), workspaces: [] });
    assert.deepEqual(getWorkspaces(other), [path]);
    assert.deepEqual(other.getEntries(), otherEntries);
    assert.equal(existsSync(other.getSessionFile()!), false);
  });

  it("tracks nested Bash mutations instead of ignoring every child call", async () => {
    const h = await createHarness();
    const path = join(h.directory, "nested");
    await h.bash(quote(["git", "worktree", "add", "-b", "nested", path]), "codemode-parent");
    assert.deepEqual(getWorkspaces(h.manager), [path]);
    assert.equal(h.messages.length, 1);
  });

  it("records a successful mutation even when a later compound command fails", async () => {
    const h = await createHarness();
    const path = join(h.directory, "surviving");
    const result = await h.bash(
      `${quote(["git", "worktree", "add", "-b", "surviving", path])} && false`,
    );
    assert.equal(result.outcome.isError, true);
    assert.deepEqual(getWorkspaces(h.manager), [path]);
    assert.deepEqual(result.event, result.original);
  });

  it("does not register a failed add masked by a later successful command", async () => {
    const h = await createHarness();
    const result = await h.bash(`${quote(["git", "worktree", "add", h.root])} || true`);
    assert.equal(result.outcome.isError, false);
    assert.deepEqual(getWorkspaces(h.manager), []);
    assert.equal(h.messages.length, 0);
  });

  it("does not register a mutation skipped by a shell conditional", async () => {
    const h = await createHarness();
    const path = join(h.directory, "skipped");
    await h.bash(`false && ${quote(["git", "worktree", "add", "-b", "skipped", path])}`);
    assert.deepEqual(getWorkspaces(h.manager), []);
    assert.equal(h.messages.length, 0);
  });

  it("keeps only the final existing worktree after add and move in one command", async () => {
    const h = await createHarness();
    const source = join(h.directory, "first");
    const destination = join(h.directory, "last");
    await h.bash(
      `${quote(["git", "worktree", "add", "-b", "first", source])} && ${quote(["git", "worktree", "move", source, destination])}`,
    );
    assert.deepEqual(getWorkspaces(h.manager), [destination]);
  });

  it("follows a compound operation through a worktree that did not exist at preflight", async () => {
    const h = await createHarness();
    const source = join(h.directory, "new-root");
    const destination = join(h.directory, "moved-root");
    await h.bash(
      `${quote(["git", "worktree", "add", "-b", "new-root", source])} && cd ${quote([source])} && ${quote(["git", "worktree", "move", source, destination])}`,
    );
    assert.deepEqual(getWorkspaces(h.manager), [destination]);
    assert.equal(h.messages.length, 1);
  });

  it("records both worktrees when the first is added to an existing empty directory", async () => {
    const h = await createHarness();
    const first = join(h.directory, "existing empty");
    const second = join(h.directory, "second");
    mkdirSync(first);
    const addFirst = quote(["git", "worktree", "add", "--detach", first, "HEAD"]);
    const addSecond = quote(["git", "-C", first, "worktree", "add", "--detach", second, "HEAD"]);
    const result = await h.bash(addFirst + " && " + addSecond);
    assert.equal(result.outcome.isError, false, result.outcome.result.content[0]!.text);
    assert.deepEqual(getWorkspaces(h.manager), [first, second]);
    assert.equal(h.messages.length, 1);
    assert.match(String(h.messages[0]![0].content), /metadata updated/);
  });

  it("does not treat a later addition as the cause of an earlier non-repository scope", async () => {
    const h = await createHarness();
    const later = join(h.directory, "later");
    const existing = join(h.directory, "first");
    const unobserved = join(h.directory, "unobserved");
    mkdirSync(later);
    const addFirst = quote(["git", "worktree", "add", "--detach", existing, "HEAD"]);
    const addThroughMissingRepository = quote([
      "git",
      "-C",
      later,
      "worktree",
      "add",
      "--detach",
      unobserved,
      "HEAD",
    ]);
    const addLater = quote(["git", "worktree", "add", "--detach", later, "HEAD"]);
    await h.bash(addFirst + "; " + addThroughMissingRepository + "; " + addLater);
    assert.deepEqual(getWorkspaces(h.manager), []);
    assert.equal(h.messages.length, 1);
    assert.match(String(h.messages[0]![0].content), /not-repository/);
  });

  it("does not claim a concurrent worktree created outside the calling command", async () => {
    const h = await createHarness();
    const own = join(h.directory, "own");
    const command = quote(["git", "worktree", "add", "-b", "own", own]);
    await h.emit("tool_call", { toolName: "bash", toolCallId: "own-call", input: { command } });
    await h.createWorktree("foreign");
    const outcome = h.shell(command);
    await h.emit("tool_result", {
      toolName: "bash",
      toolCallId: "own-call",
      input: { command },
      ...outcome.result,
      isError: outcome.isError,
    });
    assert.deepEqual(getWorkspaces(h.manager), [own]);
  });

  it("serializes sibling automatic updates and emits only actual association changes", async () => {
    const h = await createHarness();
    const first = join(h.directory, "first-sibling");
    const second = join(h.directory, "second-sibling");
    const firstCommand = quote(["git", "worktree", "add", "-b", "first-sibling", first]);
    const secondCommand = quote(["git", "worktree", "add", "-b", "second-sibling", second]);
    await h.emit("tool_call", {
      toolName: "bash",
      toolCallId: "first-call",
      input: { command: firstCommand },
    });
    await h.emit("tool_call", {
      toolName: "bash",
      toolCallId: "second-call",
      input: { command: secondCommand },
    });
    h.shell(firstCommand);
    h.shell(secondCommand);
    await Promise.all([
      h.emit("tool_result", {
        toolName: "bash",
        toolCallId: "first-call",
        input: { command: firstCommand },
      }),
      h.emit("tool_result", {
        toolName: "bash",
        toolCallId: "second-call",
        input: { command: secondCommand },
      }),
    ]);
    assert.deepEqual(getWorkspaces(h.manager), [first, second]);
    assert.equal(h.messages.length, 2);
  });

  it("does not retain an add removed later in the same command", async () => {
    const h = await createHarness();
    const path = join(h.directory, "temporary");
    await h.bash(
      `${quote(["git", "worktree", "add", "-b", "temporary", path])} && ${quote(["git", "worktree", "remove", path])}`,
    );
    assert.deepEqual(getWorkspaces(h.manager), []);
    assert.equal(h.messages.length, 0);
  });

  it("ignores ordinary Bash reads without issuing its own queries", async () => {
    const h = await createHarness();
    await h.bash("git worktree list");
    assert.equal(h.queries.length, 0);
    assert.equal(h.messages.length, 0);
  });

  it("does not describe a custom API update as saved to disk", async () => {
    const h = await createHarness(false);
    const path = join(h.directory, "pending");
    const result = await h.bash(quote(["git", "worktree", "add", "--detach", path, "HEAD"]));
    assert.equal(result.outcome.isError, false);
    assert.deepEqual(getWorkspaces(h.manager), [path]);
    assert.equal(existsSync(h.manager.getSessionFile()!), false);
    const content = String(h.messages[0]![0].content);
    assert.match(content, /metadata updated/);
    assert.doesNotMatch(content, /persistence|saved to disk|persisted to disk/i);
    assert.deepEqual(h.messages[0]![1], { deliverAs: "steer" });
  });

  it("reports invalid owned metadata independently of a successful Bash mutation", async () => {
    const h = await createHarness();
    h.manager.appendCustomEntry(WORKSPACES_ENTRY_TYPE, {
      sessionId: h.manager.getSessionId(),
      workspaces: ["relative"],
    });
    const before = structuredClone(h.manager.getEntries());
    const path = join(h.directory, "invalid-metadata");
    const result = await h.bash(quote(["git", "worktree", "add", "--detach", path, "HEAD"]));
    assert.equal(result.outcome.isError, false);
    assert.deepEqual(result.event, result.original);
    assert.deepEqual(h.manager.getEntries(), before);
    assert.equal(h.messages.length, 1);
    assert.match(String(h.messages[0]![0].content), /Invalid workspaces in custom entry/);
  });

  it("reports automatic persistence failure separately and keeps the Bash result intact", async () => {
    const h = await createHarness();
    const path = join(h.directory, "unsaved");
    h.setAppendError(new Error("Fixture session append failed"));
    const result = await h.bash(quote(["git", "worktree", "add", "-b", "unsaved", path]));
    assert.deepEqual(getWorkspaces(h.manager), []);
    assert.deepEqual(result.event, result.original);
    assert.equal(h.messages.length, 1);
    assert.match(String(h.messages[0]![0].content), /update failed/);
    assert.doesNotMatch(String(h.messages[0]![0].content), /metadata updated/);
  });

  it("automatically tracks worktrees through pi-mux without a background Bash process", async () => {
    const h = await createHarness();
    const path = join(h.directory, "unregistered");
    const result = await h.bash(quote(["git", "worktree", "add", "-b", "unregistered", path]));
    assert.equal(result.outcome.isError, false);
    assert.deepEqual(getWorkspaces(h.manager), [path]);
    assert.ok(h.queries.length > 0);
    assert.equal(h.messages.length, 1);
  });

  it("stays silent when the worktree observer cannot parse the command", async () => {
    const h = await createHarness();
    const command = 'git -C "$d" status';
    await h.emit("tool_call", { toolName: "bash", toolCallId: "unparsed", input: { command } });
    await h.emit("tool_result", {
      toolName: "bash",
      toolCallId: "unparsed",
      input: { command },
      content: [],
      details: {},
      isError: true,
    });
    assert.deepEqual(getWorkspaces(h.manager), []);
    assert.equal(h.messages.length, 0);
  });

  it("does not confuse a late old-session result with the replacement session", async () => {
    const h = await createHarness();
    const command = quote(["git", "worktree", "add", "-b", "late", join(h.directory, "late")]);
    await h.emit("tool_call", { toolName: "bash", toolCallId: "old", input: { command } });
    const old = await h.switchSession();
    const beforeOld = readFileSync(old.getSessionFile()!);
    h.shell(command);
    await h.emit("tool_result", {
      toolName: "bash",
      toolCallId: "old",
      input: { command },
      content: [],
      details: {},
      isError: false,
    });
    assert.deepEqual(getWorkspaces(h.manager), []);
    assert.deepEqual(readFileSync(old.getSessionFile()!), beforeOld);
    assert.equal(h.messages.length, 0);
  });

  it("discards preflight state for a blocked call without a tool_result", async () => {
    const h = await createHarness();
    const command = quote([
      "git",
      "worktree",
      "add",
      "-b",
      "blocked",
      join(h.directory, "blocked"),
    ]);
    await h.emit("tool_call", { toolName: "bash", toolCallId: "blocked", input: { command } });
    await h.emit("tool_execution_end", {
      toolName: "bash",
      toolCallId: "blocked",
      result: {},
      isError: true,
    });
    h.shell(command);
    await h.emit("tool_result", {
      toolName: "bash",
      toolCallId: "blocked",
      input: { command },
      content: [],
      details: {},
      isError: false,
    });
    assert.deepEqual(getWorkspaces(h.manager), []);
    assert.equal(h.messages.length, 0);
  });

  it("reconciles a finalized executed mutation even when tool_result was not emitted", async () => {
    const h = await createHarness();
    const path = join(h.directory, "finalized");
    const command = quote(["git", "worktree", "add", "-b", "finalized", path]);
    await h.emit("tool_call", { toolName: "bash", toolCallId: "finalized", input: { command } });
    const outcome = h.shell(command);
    await h.emit("tool_execution_end", {
      toolName: "bash",
      toolCallId: "finalized",
      result: outcome.result,
      isError: false,
      durationMs: 1,
    });
    assert.deepEqual(getWorkspaces(h.manager), [path]);
  });

  it("renders the full successful notification body when expanded", async () => {
    const h = await createHarness();
    const path = join(h.directory, "expanded");
    await h.bash(quote(["git", "worktree", "add", "--detach", path, "HEAD"]));
    const message = h.messages[0]![0];
    const renderer = h.renderers.get("session-worktrees")!;
    const options = { expanded: true, outputPad: 0 } as Parameters<Renderer>[1];
    const theme = { fg: (_color: string, text: string) => text } as Theme;
    const component = renderer({ ...message, role: "custom", timestamp: 1 }, options, theme)!;
    assert.equal(component.render(10000).join("\n").trim(), String(message.content));
  });

  it("reports automatic process failures and renders a short failure notification", async () => {
    const h = await createHarness();
    h.setExecError(new Error("Fixture process failed"));
    await h.bash(
      quote(["git", "worktree", "add", "--detach", join(h.directory, "failure"), "HEAD"]),
    );
    const message = h.messages[0]![0];
    const renderer = h.renderers.get("session-worktrees")!;
    const options = { expanded: false, outputPad: 0 } as Parameters<Renderer>[1];
    const theme = { fg: (_color: string, text: string) => text } as Theme;
    const component = renderer({ ...message, role: "custom", timestamp: 1 }, options, theme)!;
    const rendered = component.render(100).join("\n").trim();
    assert.equal(rendered, "Worktree metadata update failed");
    assert.doesNotMatch(rendered, /Fixture process failed/);
    assert.match(String(message.content), /Fixture process failed/);
  });

  it("renders a compact TUI notice while keeping the full model-facing update", async () => {
    const h = await createHarness();
    const path = join(h.directory, "visible");
    await h.bash(quote(["git", "worktree", "add", "-b", "visible", path]));
    const message = h.messages[0]![0];
    const renderer = h.renderers.get("session-worktrees")!;
    const options = { expanded: false, outputPad: 0 } as Parameters<Renderer>[1];
    const theme = {
      fg(_color: string, text: string) {
        return text;
      },
    } as Theme;

    const component = renderer({ ...message, role: "custom", timestamp: 1 }, options, theme)!;
    assert.equal(component.render(100).join("\n").trim(), "Worktree metadata updated (1 change)");
    assert.match(String(message.content), new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});
