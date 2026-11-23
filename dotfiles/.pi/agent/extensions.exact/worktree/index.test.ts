import assert from "node:assert/strict";

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { quote } from "shell-quote";
import {
  createEventBus,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionToolContext,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  getDeclarations,
  getWorkspaces,
  DECLARATIONS_ENTRY_TYPE,
  WORKSPACES_ENTRY_TYPE,
} from "./metadata.ts";
import { realBwrapTest } from "../guardrails/bwrap-test-support.ts";
import toolsExtension from "../tools/index.ts";
import sessionMetadataExtension from "./index.ts";

type Handler = (event: Record<string, unknown>, context: ExtensionContext) => unknown;
type SentMessage = Parameters<ExtensionAPI["sendMessage"]>;
type Renderer = Parameters<ExtensionAPI["registerMessageRenderer"]>[1];
const cleanup: (() => void)[] = [];
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

async function createHarness(
  persist = true,
  guarded = false,
  protectedPaths: { deny?: string[]; credentials?: string[] } = {},
  objectFormat = "sha1",
) {
  mkdirSync("/tmp/work/dotfiles/session-metadata-custom-qa", { recursive: true });
  const directory = mkdtempSync("/tmp/work/dotfiles/session-metadata-custom-qa/integration-");
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "main repo");
  mkdirSync(root);
  execFileSync(
    "git",
    ["-c", "init.defaultBranch=main", "init", `--object-format=${objectFormat}`, root],
    {
      env: gitEnvironment,
      stdio: "pipe",
    },
  );
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
  const events = createEventBus();
  const modelRegistry = {};
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDefinition>();
  const messages: SentMessage[] = [];
  const renderers = new Map<string, Renderer>();
  const uiErrors: string[] = [];
  const queries: string[] = [];
  let manager = newManager();
  let nestedId = 0;
  let appendError: Error | undefined;
  let beforeAppend: (() => void) | undefined;

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
      modelRegistry,
      cwd: root,
      sessionManager: manager,
      hasUI: true,
      mode: "tui",
      ui: {
        notify(message: string) {
          uiErrors.push(message);
        },
      },
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
      if (command !== "bash" || args[0] !== "-c")
        throw new Error(`Unexpected process command: ${command} ${args.join(" ")}`);
      queries.push(args[1]!);
      const output = spawnSync(command, args, {
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
    events,
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => {};
    },
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    appendEntry(customType: string, data?: unknown) {
      beforeAppend?.();
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
  const managed = join(directory, ".agents", "worktrees", "main repo");
  if (guarded) {
    const config = join(directory, "guardrails.yaml");
    writeFileSync(
      config,
      JSON.stringify({
        read: [{ allow: "*" }],
        write: [
          { allow: root },
          {
            deny: [
              join(managed, "denied"),
              join(managed, "active", "denied"),
              ...(protectedPaths.deny ?? []).map((path) => join(directory, path)),
            ],
          },
        ],
        credentials: [
          join(managed, "credential"),
          join(managed, "active", "secret"),
          ...(protectedPaths.credentials ?? []).map((path) => join(directory, path)),
        ],
        commands: [{ ".*": [{ allow: [] }] }],
      }),
    );
    toolsExtension(pi, config);
  }
  sessionMetadataExtension(pi, directory);
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

  function invoke(tool: string, params: Record<string, unknown>, ctx = context()) {
    return tools
      .get(tool)!
      .execute(tool, params, undefined, undefined, ctx as ExtensionToolContext);
  }

  function explicit(
    action: "add" | "remove",
    name: string,
    options: { project?: string; discard?: boolean } = {},
    observe?: (command: string, id: string) => void | Promise<void>,
  ) {
    const id = `worktree-${++nestedId}`;
    const ctx = { ...context(), hasUI: false } as ExtensionToolContext;
    function nestedExecutor(parentId: string): ExtensionToolContext["executeTool"] {
      let nextId = 0;
      return async (tool, input, callOptions) => {
        assert.equal(tool, "bash");
        const nested = `${parentId}/${++nextId}`;
        const args = input as { command: string };
        const toolCall = { type: "toolCall" as const, id: nested, name: tool, arguments: args };
        if (parentId === id) await observe?.(args.command, nested);
        const event = { toolName: tool, toolCallId: nested, parentToolCallId: parentId };
        const nestedContext = { ...ctx, executeTool: nestedExecutor(nested) };
        await emit("tool_call", { ...event, input }, nestedContext);
        try {
          const result = await tools
            .get(tool)!
            .execute(nested, args, callOptions?.signal, undefined, nestedContext);
          return { toolCall, result, isError: result.isError ?? false };
        } catch (error) {
          return {
            toolCall,
            result: {
              content: [{ type: "text" as const, text: String(error) }],
              details: {},
            },
            isError: true,
          };
        } finally {
          await emit("tool_result", event, nestedContext);
        }
      };
    }

    return tools
      .get("session_worktree")!
      .execute(id, { action, name, ...options }, undefined, undefined, {
        ...ctx,
        executeTool: nestedExecutor(id),
      });
  }

  function fixtureGit(path: string, ...args: string[]): string {
    return execFileSync(
      "git",
      ["-C", path, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
      {
        env: gitEnvironment,
        stdio: "pipe",
        encoding: "utf8",
      },
    ).trim();
  }

  function createProject(name: string): string {
    const path = join(directory, "projects", name);
    mkdirSync(path, { recursive: true });
    fixtureGit(path, "init", "-b", "main");
    fixtureGit(path, "commit", "--allow-empty", "-m", "fixture");
    return path;
  }

  function request(path: string) {
    return invoke("ask_permission", { path, reason: "test" }, { ...context(), hasUI: false });
  }

  return {
    directory,
    root,
    handlers,
    tools,
    messages,
    uiErrors,
    queries,
    renderers,
    get manager() {
      return manager;
    },
    emit,
    bash,
    shell,
    explicit,
    fixtureGit,
    createProject,
    setStartCwd(cwd: string) {
      manager.getCwd = () => cwd;
    },
    setBeforeAppend(callback: () => void) {
      beforeAppend = callback;
    },
    invoke,
    managed,
    request,
    seedWorkspace(path: string) {
      manager.appendCustomEntry(WORKSPACES_ENTRY_TYPE, {
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

describe("session metadata extension", () => {
  it("starts with an empty association without appending or modifying the header", async () => {
    const h = await createHarness();
    assert.deepEqual(getWorkspaces(h.manager), []);
    assert.equal(
      h.manager.getEntries().some((entry) => entry.type === "custom"),
      false,
    );
    assert.deepEqual([...h.tools.keys()], ["session_worktree"]);
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
    assert.deepEqual(metadata.data, { workspaces: [path] });
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
        scopes: findWorktreeScopes(${JSON.stringify(command)}, ${JSON.stringify(h.root)})
      }));`;
    const parsed = JSON.parse(
      execFileSync(process.execPath, ["--eval", script], { env, encoding: "utf8" }),
    );
    const result = h.shell(command, env);
    const expected = [join(home, "feature"), join(h.root, "~/feature")];
    assert.equal(result.isError, false, result.result.content[0]!.text);
    expected.forEach((target) => assert.ok(existsSync(join(target, ".git"))));
    assert.deepEqual(parsed.scopes, [{ cwd: h.root, actions: ["add"], paths: expected }]);
  });

  it("appends multiple additions in observed Git list order after existing registrations", async () => {
    const h = await createHarness();
    const existing = await h.createWorktree("existing");
    h.seedWorkspace(existing);
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
    other.appendCustomEntry(WORKSPACES_ENTRY_TYPE, { workspaces: [path] });
    const otherEntries = structuredClone(other.getEntries());
    h.seedWorkspace(path);
    await h.bash(quote(["git", "worktree", "remove", path]));
    assert.deepEqual(getWorkspaces(h.manager), []);
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

  it("creates from main HEAD when the session starts in another linked worktree", async () => {
    const h = await createHarness(true, true);
    assert.equal(
      h.shell(
        "printf tracked > tracked && git add tracked && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -m tracked",
      ).isError,
      false,
    );
    const other = await h.createWorktree("other");
    assert.equal(
      h.shell(
        `git -C ${quote([other])} -c user.name=Fixture -c user.email=fixture@example.invalid commit --allow-empty -m branch-only`,
      ).isError,
      false,
    );

    h.setStartCwd(other);
    const result = await h.explicit("add", "agents-created");
    const path = join(h.managed, "wt-agents-created");
    assert.deepEqual(result.details, {
      name: "agents-created",
      path,
      status: "created",
      worktrees: [{ name: "agents-created", path }],
    });
    assert.equal(readFileSync(join(path, "tracked"), "utf8"), "tracked");
    assert.equal(h.shell(`git -C ${quote([path])} status --porcelain`).result.content[0]?.text, "");
    assert.equal(
      h.shell(`git -C ${quote([path])} rev-parse HEAD`).result.content[0]?.text,
      h.shell("git rev-parse HEAD").result.content[0]?.text,
    );
    assert.deepEqual(getDeclarations(h.manager), [{ name: "agents-created", path }]);
    assert.deepEqual(getWorkspaces(h.manager), []);
  });

  it("does not run repository hooks, a filesystem monitor or checkout filters when creating", async () => {
    const h = await createHarness(true, true);
    const hook = join(h.root, ".git", "hooks", "post-checkout");
    const marker = join(h.directory, "external-command-ran");
    const mark = `printf ran > ${quote([marker])}`;
    writeFileSync(join(h.root, ".gitattributes"), "payload filter=fixture\n");
    writeFileSync(join(h.root, "payload"), "tracked payload");
    assert.equal(
      h.shell(
        "git add .gitattributes payload && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -m filters",
      ).isError,
      false,
    );
    writeFileSync(hook, `#!/bin/sh\n${mark}\n`, { mode: 0o700 });
    assert.equal(h.shell(quote(["git", "config", "hook.fixture.command", mark])).isError, false);
    assert.equal(h.shell("git config hook.fixture.event reference-transaction").isError, false);
    assert.equal(
      h.shell(quote(["git", "config", "filter.fixture.smudge", `${mark}; cat`])).isError,
      false,
    );
    assert.equal(h.shell(quote(["git", "config", "core.fsmonitor", hook])).isError, false);
    await h.explicit("add", "safe-creation");
    assert.equal(
      readFileSync(join(h.managed, "safe-creation", "payload"), "utf8"),
      "tracked payload",
    );
    assert.equal(existsSync(marker), false);
  });

  it("reuses a managed linked worktree without touching existing changes or its branch", async () => {
    const h = await createHarness(true, true);
    const path = join(h.managed, "existing");
    assert.equal(
      h.shell(quote(["git", "worktree", "add", "-b", "existing-branch", path])).isError,
      false,
    );
    writeFileSync(join(path, "draft"), "keep");
    const result = await h.explicit("add", "existing");
    assert.deepEqual(result.details, {
      name: "existing",
      path,
      status: "reused",
      worktrees: [{ name: "existing", path }],
    });
    assert.equal(readFileSync(join(path, "draft"), "utf8"), "keep");
    assert.equal(
      h.shell(`git -C ${quote([path])} branch --show-current`).result.content[0]?.text.trim(),
      "existing-branch",
    );
    const file = h.manager.getSessionFile()!;
    const entry = JSON.parse(readFileSync(file, "utf8").trimEnd().split("\n").at(-1)!);
    assert.equal(entry.customType, DECLARATIONS_ENTRY_TYPE);
    assert.deepEqual(entry.data, { worktrees: [{ name: "existing", path }] });
    const before = readFileSync(file);
    await h.explicit("add", "existing");
    assert.deepEqual(readFileSync(file), before);
  });

  it("rejects unsafe names, occupied paths and existing branches without changing them", async () => {
    const h = await createHarness(true, true);
    for (const name of ["../outside", "-force", "wt-agents-conflict", "normal\n", "some/path"])
      await assert.rejects(h.explicit("add", name), /Invalid worktree name/);
    const normal = join(h.managed, "occupied");
    mkdirSync(normal, { recursive: true });
    const marker = join(normal, "draft");
    writeFileSync(marker, "keep");
    await assert.rejects(h.explicit("add", "occupied"), /Not a linked worktree/);
    assert.equal(readFileSync(marker, "utf8"), "keep");
    symlinkSync(normal, join(h.managed, "alias"));
    await assert.rejects(h.explicit("add", "alias"), /without symbolic links/);
    assert.equal(h.shell("git branch collision").isError, false);
    await assert.rejects(h.explicit("add", "collision"), /already exists/);
    assert.equal(existsSync(join(h.managed, "collision")), false);
    assert.deepEqual(getDeclarations(h.manager), []);
  });

  it("does not create worktrees at paths denied by Guardrails", async () => {
    const h = await createHarness(true, true);
    await assert.rejects(h.explicit("add", "denied"), /Access denied/);
    await assert.rejects(h.explicit("add", "credential"), /Access denied for credential path/);
    assert.equal(existsSync(h.managed), false);
    assert.deepEqual(getDeclarations(h.manager), []);
  });

  it("never elevates observed or persisted declarations without a successful tool call", async () => {
    const h = await createHarness(true, true);
    const path = join(h.managed, "observed");
    await h.bash(quote(["git", "worktree", "add", "--detach", path]));
    assert.deepEqual(getWorkspaces(h.manager), [path]);
    await assert.rejects(h.request(path), /Access requires confirmation/);
    await h.explicit("add", "observed");
    assert.match(JSON.stringify((await h.request(path)).details), /already granted/);
    await h.emit("session_start", { reason: "resume" });
    assert.deepEqual(getDeclarations(h.manager), [{ name: "observed", path }]);
    await assert.rejects(h.request(path), /Access requires confirmation/);
  });

  realBwrapTest(
    "uses one write grant for registered write, edit and Bash, but only under the declared path",
    async () => {
      const h = await createHarness(true, true);
      const path = join(h.managed, "active");
      const file = join(path, "text.txt");
      await h.explicit("add", "active");
      const noninteractive = { hasUI: false } as ExtensionContext;
      const write = await h.invoke(
        "write",
        { path: relative(process.cwd(), file), content: "start" },
        noninteractive,
      );
      assert.notEqual(write.isError, true);
      const edit = await h.invoke(
        "edit",
        { path: file, edits: [{ oldText: "start", newText: "changed" }] },
        noninteractive,
      );
      assert.notEqual(edit.isError, true);
      const bash = await h.invoke(
        "bash",
        { command: `cd ${quote([path])} && printf bash >> text.txt` },
        noninteractive,
      );
      assert.notEqual(bash.isError, true);
      assert.equal(readFileSync(file, "utf8"), "changedbash");
      const outside = await h.invoke(
        "bash",
        { command: `printf denied > ${quote([join(h.managed, "outside")])}` },
        noninteractive,
      );
      assert.equal(outside.isError, true);
      assert.equal(existsSync(join(h.managed, "outside")), false);
      for (const name of ["denied", "secret"]) {
        const protectedPath = join(path, name);
        writeFileSync(protectedPath, "unchanged");
        await assert.rejects(
          h.invoke("write", { path: protectedPath, content: "wrong" }, noninteractive),
          /Access denied/,
        );
        const blocked = await h.invoke(
          "bash",
          { command: `printf wrong > ${quote([protectedPath])}` },
          noninteractive,
        );
        assert.equal(blocked.isError, true);
        assert.equal(readFileSync(protectedPath, "utf8"), "unchanged");
      }
      await assert.rejects(h.explicit("remove", "active", { discard: true }), /Access denied/);
      await assert.rejects(h.request(h.managed), /Access requires confirmation/);
      assert.equal(readFileSync(file, "utf8"), "changedbash");
      assert.ok(existsSync(join(path, ".git")));
    },
    20_000,
  );

  it("does not grant access if the declaration cannot be saved", async () => {
    const h = await createHarness(true, true);
    const path = join(h.managed, "unsaved");
    h.setAppendError(new Error("Fixture session append failed"));
    await assert.rejects(h.explicit("add", "unsaved"), (error: Error) => {
      assert.ok(error.message.includes(path));
      assert.match(error.message, /Fixture session append failed/);
      return true;
    });
    assert.ok(existsSync(path));
    assert.deepEqual(getDeclarations(h.manager), []);
    await assert.rejects(h.request(path), /Access requires confirmation/);
  });

  it("revokes the grant even if remove cannot save the declaration update", async () => {
    const h = await createHarness(true, true);
    const path = join(h.managed, "registered");
    await h.explicit("add", "registered");
    h.setAppendError(new Error("Fixture session append failed"));
    await assert.rejects(
      h.explicit("remove", "registered"),
      /Fixture session append failed.*path=absent, registration=absent, branch refs\/heads\/registered=present; declaration=update failed; permission=revoked/,
    );
    assert.deepEqual(getDeclarations(h.manager), [{ name: "registered", path }]);
    await assert.rejects(h.request(path), /Access requires confirmation/);
  });

  it("expires a grant when a worktree is replaced and allows a fresh declaration", async () => {
    const h = await createHarness(true, true);
    const path = join(h.managed, "gone");
    await h.explicit("add", "gone");
    assert.equal(h.shell(quote(["git", "worktree", "remove", path])).isError, false);
    assert.equal(h.shell(quote(["git", "worktree", "add", path, "gone"])).isError, false);
    await assert.rejects(h.request(path), /Access requires confirmation/);
    await h.explicit("add", "gone");
    assert.match(JSON.stringify((await h.request(path)).details), /already granted/);
    assert.equal(h.shell(quote(["git", "worktree", "remove", path])).isError, false);
    await assert.rejects(h.request(path), /Access requires confirmation/);
    await h.explicit("add", "other");
    assert.deepEqual(getDeclarations(h.manager), [
      { name: "other", path: join(h.managed, "other") },
    ]);
  });

  it("keeps live declarations in different repositories and rejects a name collision", async () => {
    const h = await createHarness(true, true);
    const repo = h.createProject("other repo");
    await h.explicit("add", "first");
    const second = await h.explicit("add", "second", { project: "other repo" });
    const path = join(h.directory, ".agents", "worktrees", "other repo", "second");
    assert.deepEqual(second.details, {
      name: "second",
      path,
      status: "created",
      worktrees: [
        { name: "first", path: join(h.managed, "first") },
        { name: "second", path },
      ],
    });
    await assert.rejects(
      h.explicit("add", "first", { project: "other repo" }),
      /already declared for another repository/,
    );
    assert.throws(() => h.fixtureGit(repo, "show-ref", "--verify", "refs/heads/first"));
    await assert.rejects(h.request(join(repo, ".git")), /Access requires confirmation/);
    await h.explicit("remove", "second", { project: "other repo" });
    assert.deepEqual(getDeclarations(h.manager), [
      { name: "first", path: join(h.managed, "first") },
    ]);
    assert.match(
      JSON.stringify((await h.request(join(h.managed, "first"))).details),
      /already granted/,
    );
  });

  it("does not fall back to the start repository for a bad project or invalid discard", async () => {
    const h = await createHarness(true, true);
    mkdirSync(join(h.directory, "projects", "not-git"), { recursive: true });
    for (const project of ["", "not-git", "../main repo", "absent"])
      await assert.rejects(
        h.explicit("add", "untouched", { project }),
        /Session worktree add failed/,
      );
    await assert.rejects(
      h.explicit("add", "untouched", { discard: false }),
      /only valid for remove/,
    );
    assert.throws(() => h.fixtureGit(h.root, "show-ref", "--verify", "refs/heads/untouched"));
    assert.equal(existsSync(join(h.managed, "untouched")), false);
  });

  it("uses a separate Git registration when an unrelated worktree shares the folder basename", async () => {
    const h = await createHarness(true, true);
    const unrelated = join(h.directory, "same");
    h.fixtureGit(h.root, "worktree", "add", "-b", "unrelated", unrelated);
    writeFileSync(join(unrelated, "draft"), "preserve");
    await h.explicit("add", "same");
    const path = join(h.managed, "same");
    assert.ok(h.fixtureGit(path, "rev-parse", "--absolute-git-dir").endsWith("same1"));
    await h.explicit("remove", "same");
    assert.equal(readFileSync(join(unrelated, "draft"), "utf8"), "preserve");
    assert.equal(h.fixtureGit(unrelated, "branch", "--show-current"), "unrelated");
  });

  it("refuses an add or remove when another repository owns the destination", async () => {
    const h = await createHarness(true, true);
    const repo = h.createProject("independent");
    const path = join(h.managed, "foreign");
    h.fixtureGit(repo, "worktree", "add", "-b", "foreign", path);
    writeFileSync(join(path, "draft"), "preserve");
    await assert.rejects(h.explicit("add", "foreign"), /Not a linked worktree/);
    await assert.rejects(h.explicit("remove", "foreign", { discard: true }), /Cannot verify/);
    assert.equal(readFileSync(join(path, "draft"), "utf8"), "preserve");
    assert.equal(h.fixtureGit(path, "branch", "--show-current"), "foreign");
  });

  it("finishes a clean merged worktree and deletes only its packed branch and grant", async () => {
    const h = await createHarness(true, true);
    const path = join(h.managed, "integrated");
    await h.explicit("add", "integrated");
    const protectedSibling = join(h.managed, "unrelated");
    await h.explicit("add", "unrelated");
    h.fixtureGit(path, "commit", "--allow-empty", "-m", "integrated");
    h.fixtureGit(h.root, "merge", "--ff-only", "refs/heads/integrated");
    h.fixtureGit(h.root, "commit", "--allow-empty", "-m", "advance main");
    h.fixtureGit(h.root, "pack-refs", "--all");
    const removal = await h.explicit("remove", "integrated");
    assert.deepEqual(removal.details, {
      name: "integrated",
      path,
      branch: "integrated",
      status: "removed",
      worktrees: [{ name: "unrelated", path: protectedSibling }],
    });
    assert.equal(existsSync(path), false);
    assert.ok(!h.fixtureGit(h.root, "worktree", "list", "--porcelain").includes(path));
    assert.throws(() => h.fixtureGit(h.root, "show-ref", "--verify", "refs/heads/integrated"));
    assert.equal(h.fixtureGit(protectedSibling, "branch", "--show-current"), "unrelated");
    await assert.rejects(h.request(path), /Access requires confirmation/);
    assert.match(JSON.stringify((await h.request(protectedSibling)).details), /already granted/);
  });

  realBwrapTest("finishes a clean worktree containing a tracked symbolic link", async () => {
    const h = await createHarness(true, true);
    const target = join(h.directory, "shared-file");
    writeFileSync(target, "keep this content");
    symlinkSync(target, join(h.root, "linked-file"), "file");
    h.fixtureGit(h.root, "add", "linked-file");
    h.fixtureGit(h.root, "commit", "-m", "Track symbolic link");
    const path = join(h.managed, "with-link");
    await h.explicit("add", "with-link");
    assert.equal(readFileSync(join(path, "linked-file"), "utf8"), "keep this content");
    assert.equal(h.fixtureGit(path, "status", "--porcelain"), "");
    await h.explicit("remove", "with-link");
    assert.equal(existsSync(path), false);
    assert.equal(h.fixtureGit(h.root, "for-each-ref", "refs/heads/with-link"), "");
    assert.equal(readFileSync(target, "utf8"), "keep this content");
  });

  for (const change of [
    "staged",
    "unstaged",
    "untracked",
    "ignored",
    "empty directory",
    "unmerged",
  ] as const) {
    it("preserves the worktree and branch with " + change + " changes", async () => {
      const h = await createHarness(true, true);
      writeFileSync(join(h.root, "tracked"), "original");
      writeFileSync(join(h.root, ".gitignore"), "*.ignored\n");
      h.fixtureGit(h.root, "add", "tracked", ".gitignore");
      h.fixtureGit(h.root, "commit", "-m", "base");
      const path = join(h.managed, "keep");
      await h.explicit("add", "keep");
      if (change === "staged" || change === "unstaged")
        writeFileSync(join(path, "tracked"), "modified");
      if (change === "staged") h.fixtureGit(path, "add", "tracked");
      if (change === "untracked" || change === "ignored")
        writeFileSync(join(path, "draft." + change), "modified");
      if (change === "empty directory") mkdirSync(join(path, "empty"));
      if (change === "unmerged") h.fixtureGit(path, "commit", "--allow-empty", "-m", "unmerged");
      const oid = h.fixtureGit(path, "rev-parse", "HEAD");
      const index = h.fixtureGit(path, "ls-files", "--stage");
      await assert.rejects(h.explicit("remove", "keep"), /changes|not merged|untracked/);
      assert.equal(h.fixtureGit(h.root, "show-ref", "--hash", "--verify", "refs/heads/keep"), oid);
      assert.equal(h.fixtureGit(path, "ls-files", "--stage"), index);
      assert.match(JSON.stringify((await h.request(path)).details), /already granted/);
    });
  }

  it("discards tracked edits, untracked files and an unmerged branch only when requested", async () => {
    const h = await createHarness(true, true);
    const path = join(h.managed, "scratch");
    await h.explicit("add", "scratch");
    writeFileSync(join(path, "local"), "committed");
    h.fixtureGit(path, "add", "local");
    h.fixtureGit(path, "commit", "-m", "unmerged");
    writeFileSync(join(path, "local"), "unstaged");
    writeFileSync(join(path, "draft"), "untracked");
    await h.explicit("remove", "scratch", { discard: true });
    assert.equal(existsSync(path), false);
    assert.throws(() => h.fixtureGit(h.root, "show-ref", "--verify", "refs/heads/scratch"));
    assert.deepEqual(getDeclarations(h.manager), []);
  });

  it("does not discard a detached or mismatched worktree at a managed path", async () => {
    const h = await createHarness(true, true);
    const detached = join(h.managed, "detached");
    const different = join(h.managed, "different");
    h.fixtureGit(h.root, "worktree", "add", "--detach", detached);
    h.fixtureGit(h.root, "worktree", "add", "-b", "alternate", different);
    h.fixtureGit(h.root, "branch", "different");
    for (const name of ["detached", "different"])
      await assert.rejects(
        h.explicit("remove", name, { discard: true }),
        /Cannot verify|does not uniquely/,
      );
    assert.ok(existsSync(detached));
    assert.equal(h.fixtureGit(different, "branch", "--show-current"), "alternate");
    assert.ok(h.fixtureGit(h.root, "show-ref", "--verify", "refs/heads/different"));
  });

  it("does not discard the worktree that contains the session start directory", async () => {
    const h = await createHarness(true, true);
    const path = join(h.managed, "start");
    await h.explicit("add", "start");
    const cwd = join(path, "inside");
    mkdirSync(cwd);
    h.setStartCwd(cwd);
    await assert.rejects(
      h.explicit("remove", "start", { discard: true }),
      /overlaps the session start/,
    );
    assert.equal(h.fixtureGit(path, "branch", "--show-current"), "start");
  });

  it("does not discard a locked worktree or one containing another Git workspace", async () => {
    const h = await createHarness(true, true);
    const path = join(h.managed, "container");
    await h.explicit("add", "container");
    h.fixtureGit(h.root, "worktree", "lock", path);
    await assert.rejects(h.explicit("remove", "container", { discard: true }), /locked/);
    h.fixtureGit(h.root, "worktree", "unlock", path);
    const independent = h.createProject("independent");
    const nested = join(path, "unrelated");
    h.fixtureGit(independent, "worktree", "add", "-b", "nested", nested);
    writeFileSync(join(nested, "draft"), "must survive");
    await assert.rejects(
      h.explicit("remove", "container", { discard: true }),
      /nested Git workspace/,
    );
    assert.equal(readFileSync(join(nested, "draft"), "utf8"), "must survive");
  });

  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    it("does not treat changes hidden by " + flag + " as clean", async () => {
      const h = await createHarness(true, true);
      writeFileSync(join(h.root, "tracked"), "original");
      h.fixtureGit(h.root, "add", "tracked");
      h.fixtureGit(h.root, "commit", "-m", "base");
      const path = join(h.managed, "hidden");
      await h.explicit("add", "hidden");
      h.fixtureGit(path, "update-index", flag, "tracked");
      writeFileSync(join(path, "tracked"), "hidden edit");
      assert.equal(h.fixtureGit(path, "status", "--porcelain"), "");
      await assert.rejects(h.explicit("remove", "hidden"), /special worktree index/);
      assert.equal(readFileSync(join(path, "tracked"), "utf8"), "hidden edit");
    });
  }

  it("does not run a configured clean filter during remove preflight", async () => {
    const h = await createHarness(true, true);
    writeFileSync(join(h.root, ".gitattributes"), "payload filter=marked\n");
    writeFileSync(join(h.root, "payload"), "base");
    h.fixtureGit(h.root, "add", "payload", ".gitattributes");
    h.fixtureGit(h.root, "commit", "-m", "attrs");
    const path = join(h.managed, "filtered");
    await h.explicit("add", "filtered");
    const marker = join(h.directory, "filter-ran");
    h.fixtureGit(
      h.root,
      "config",
      "filter.marked.clean",
      "printf ran > " + quote([marker]) + "; cat",
    );
    writeFileSync(join(path, "payload"), "unstaged");
    await assert.rejects(h.explicit("remove", "filtered"), /configured Git filters/);
    assert.equal(existsSync(marker), false);
    await h.explicit("remove", "filtered", { discard: true });
    assert.equal(existsSync(marker), false);
  });

  it("refuses to inspect or change a repository layout with a Git config include", async () => {
    const h = await createHarness(true, true);
    const path = join(h.managed, "existing");
    await h.explicit("add", "existing");
    const config = join(h.directory, "external-config");
    writeFileSync(config, "[core]\n  filemode = true\n");
    h.fixtureGit(h.root, "config", "include.path", config);
    await assert.rejects(h.explicit("add", "new"), /Unsupported Git configuration/);
    await assert.rejects(
      h.explicit("remove", "existing", { discard: true }),
      /Unsupported Git configuration/,
    );
    assert.equal(existsSync(path), true);
    assert.equal(existsSync(join(h.managed, "new")), false);
  });

  it("checks prospective checkout files and Git metadata before any add mutation", async () => {
    const h = await createHarness(true, true, {
      deny: [".agents/worktrees/main repo/content/private.txt"],
      credentials: ["main repo/.git/worktrees/metadata/index.lock"],
    });
    writeFileSync(join(h.root, "private.txt"), "tracked");
    h.fixtureGit(h.root, "add", "private.txt");
    h.fixtureGit(h.root, "commit", "-m", "base");

    await assert.rejects(h.explicit("add", "content"), /Access denied.*private.txt/);
    await assert.rejects(h.explicit("add", "metadata"), /credential path.*index.lock/);
    for (const branch of ["content", "metadata"]) {
      assert.equal(existsSync(join(h.managed, branch)), false);
      assert.throws(() => h.fixtureGit(h.root, "show-ref", "--verify", "refs/heads/" + branch));
    }
    assert.deepEqual(getDeclarations(h.manager), []);
  });

  it("protects newly created ignored files and existing admin descendants in discard mode", async () => {
    const h = await createHarness(true, true, {
      deny: ["main repo/.git/worktrees/admin/custom-state"],
      credentials: [".agents/worktrees/main repo/private/**/token.*"],
    });
    for (const name of ["private", "admin"]) await h.explicit("add", name);
    writeFileSync(join(h.root, ".git", "info", "exclude"), "token.*\n");
    const nested = join(h.managed, "private", "local");
    mkdirSync(nested);
    const token = join(nested, "token.local");
    const admin = join(h.root, ".git", "worktrees", "admin", "custom-state");
    writeFileSync(token, "credential");
    writeFileSync(admin, "metadata");
    await assert.rejects(h.explicit("remove", "private", { discard: true }), /credential path/);
    await assert.rejects(h.explicit("remove", "admin", { discard: true }), /Access denied/);
    assert.equal(readFileSync(token, "utf8"), "credential");
    assert.equal(readFileSync(admin, "utf8"), "metadata");
    assert.equal(getDeclarations(h.manager).length, 2);
  });

  it("checks the protected packed branch metadata before removing a worktree", async () => {
    const h = await createHarness(true, true, { deny: ["main repo/.git/packed-refs.lock"] });
    const path = join(h.managed, "readonly-branch");
    h.fixtureGit(h.root, "worktree", "add", "-b", "readonly-branch", path);
    h.fixtureGit(h.root, "pack-refs", "--all");
    await assert.rejects(
      h.explicit("remove", "readonly-branch", { discard: true }),
      /Access denied.*packed-refs.lock/,
    );
    assert.ok(existsSync(path));
    assert.equal(h.fixtureGit(path, "branch", "--show-current"), "readonly-branch");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "revokes the grant but preserves the branch when Git removes the path and leaves its registration",
    async () => {
      const h = await createHarness(true, true);
      const path = join(h.managed, "partial");
      await h.explicit("add", "partial");
      const admin = h.fixtureGit(path, "rev-parse", "--absolute-git-dir");
      chmodSync(admin, 0o500);
      try {
        await assert.rejects(
          h.explicit("remove", "partial", { discard: true }),
          /path=absent, registration=present, branch refs\/heads\/partial=present; declaration=removed; permission=revoked/,
        );
        assert.ok(h.fixtureGit(h.root, "show-ref", "--verify", "refs/heads/partial"));
        assert.deepEqual(getDeclarations(h.manager), []);
        await assert.rejects(h.request(path), /Access requires confirmation/);
      } finally {
        if (existsSync(admin)) chmodSync(admin, 0o700);
      }
    },
  );

  it("keeps a branch checked out elsewhere after the target disappears", async () => {
    const h = await createHarness(true, true);
    const path = join(h.managed, "relocated");
    const sibling = join(h.directory, "other-worktree");
    await h.explicit("add", "relocated");
    h.setBeforeAppend(() => h.fixtureGit(h.root, "worktree", "add", sibling, "relocated"));
    await assert.rejects(
      h.explicit("remove", "relocated"),
      /unchecked-out branch.*path=absent, registration=absent, branch refs\/heads\/relocated=present/,
    );
    assert.equal(existsSync(path), false);
    assert.equal(h.fixtureGit(sibling, "branch", "--show-current"), "relocated");
  });

  it("keeps a branch used by a linked worktree that Git cannot list without gitdir", async () => {
    const h = await createHarness(true, true);
    await h.explicit("add", "hidden");
    const path = join(h.managed, "hidden");
    const sibling = join(h.directory, "hidden-registration");
    h.setBeforeAppend(() => {
      h.fixtureGit(h.root, "worktree", "add", sibling, "hidden");
      const admin = h.fixtureGit(sibling, "rev-parse", "--absolute-git-dir");
      rmSync(join(admin, "gitdir"));
      assert.ok(!h.fixtureGit(h.root, "worktree", "list", "--porcelain").includes(sibling));
    });
    await assert.rejects(
      h.explicit("remove", "hidden"),
      /Branch is still in use: refs\/heads\/hidden.*path=absent.*branch refs\/heads\/hidden=present/,
    );
    assert.ok(h.fixtureGit(h.root, "show-ref", "--verify", "refs/heads/hidden"));
    assert.equal(existsSync(path), false);
    assert.deepEqual(getDeclarations(h.manager), []);
  });

  for (const operation of ["rebase", "bisect"] as const) {
    it("keeps a branch temporarily detached by " + operation, async () => {
      const h = await createHarness(true, true);
      await h.explicit("add", "in-use");
      const sibling = join(h.directory, "detached-worktree");
      h.setBeforeAppend(() => {
        h.fixtureGit(h.root, "worktree", "add", sibling, "in-use");
        const admin = h.fixtureGit(sibling, "rev-parse", "--absolute-git-dir");
        h.fixtureGit(sibling, "switch", "--detach");
        if (operation === "rebase") {
          mkdirSync(join(admin, "rebase-merge"));
          writeFileSync(join(admin, "rebase-merge", "head-name"), "refs/heads/in-use\n");
        } else {
          writeFileSync(join(admin, "BISECT_LOG"), "# bisect fixture\n");
          writeFileSync(join(admin, "BISECT_START"), "in-use\n");
        }
        assert.equal(h.fixtureGit(sibling, "branch", "--show-current"), "");
      });
      await assert.rejects(
        h.explicit("remove", "in-use"),
        new RegExp("still in use by " + operation),
      );
      assert.ok(h.fixtureGit(h.root, "show-ref", "--verify", "refs/heads/in-use"));
    });
  }

  function planRebaseUpdate(
    h: Awaited<ReturnType<typeof createHarness>>,
    branch: string,
    malformed = false,
  ) {
    const sibling = join(h.directory, "rebasing");
    h.fixtureGit(h.root, "worktree", "add", "-b", "rebasing", sibling);
    const admin = h.fixtureGit(sibling, "rev-parse", "--absolute-git-dir");
    const oid = h.fixtureGit(sibling, "rev-parse", "HEAD");
    h.fixtureGit(sibling, "switch", "--detach");
    mkdirSync(join(admin, "rebase-merge"));
    writeFileSync(join(admin, "rebase-merge", "head-name"), "refs/heads/rebasing\n");
    const schedule = malformed
      ? "refs/heads/unknown\nnot-an-oid\n"
      : "refs/heads/" + branch + "\n" + oid + "\n" + "0".repeat(oid.length) + "\n";
    writeFileSync(join(admin, "rebase-merge", "update-refs"), schedule);
  }

  it("does not start deletion when another worktree has a rebase update scheduled for the branch", async () => {
    const h = await createHarness(true, true);
    await h.explicit("add", "scheduled");
    const path = join(h.managed, "scheduled");
    planRebaseUpdate(h, "scheduled");
    await assert.rejects(h.explicit("remove", "scheduled"), /still in use by rebase update-refs/);
    assert.equal(h.fixtureGit(path, "branch", "--show-current"), "scheduled");
    assert.deepEqual(getDeclarations(h.manager), [{ name: "scheduled", path }]);
  });

  it("rechecks the rebase update plan after path removal and preserves the branch", async () => {
    const h = await createHarness(true, true);
    const path = join(h.managed, "scheduled");
    await h.explicit("add", "scheduled");
    h.setBeforeAppend(() => {
      planRebaseUpdate(h, "scheduled");
      assert.equal(
        h.fixtureGit(h.root, "for-each-ref", "--format=%(worktreepath)", "refs/heads/scheduled"),
        "",
      );
      assert.throws(() => h.fixtureGit(h.root, "branch", "-D", "scheduled"), /used by worktree/);
    });
    await assert.rejects(
      h.explicit("remove", "scheduled"),
      /still in use by rebase update-refs.*path=absent.*branch refs\/heads\/scheduled=present/,
    );
    assert.equal(existsSync(path), false);
    assert.ok(h.fixtureGit(h.root, "show-ref", "--verify", "refs/heads/scheduled"));
    await assert.rejects(h.request(path), /Access requires confirmation/);
  });

  it("does not start deletion when a rebase update plan cannot be verified", async () => {
    const h = await createHarness(true, true);
    const path = join(h.managed, "uncertain");
    await h.explicit("add", "uncertain");
    planRebaseUpdate(h, "uncertain", true);
    await assert.rejects(h.explicit("remove", "uncertain"), /Cannot verify Git rebase update-refs/);
    assert.equal(h.fixtureGit(path, "branch", "--show-current"), "uncertain");
  });

  it("allows deletion when the rebase update plan only holds another ref", async () => {
    const h = await createHarness(true, true);
    await h.explicit("add", "not-scheduled");
    h.fixtureGit(h.root, "branch", "hold");
    planRebaseUpdate(h, "hold");
    await h.explicit("remove", "not-scheduled");
    assert.equal(existsSync(join(h.managed, "not-scheduled")), false);
    assert.ok(h.fixtureGit(h.root, "show-ref", "--verify", "refs/heads/hold"));
  });

  it("keeps the branch when an omitted registration has no readable HEAD", async () => {
    const h = await createHarness(true, true);
    await h.explicit("add", "keep-branch");
    const unknown = join(h.root, ".git", "worktrees", "unknown");
    mkdirSync(unknown);
    await assert.rejects(
      h.explicit("remove", "keep-branch"),
      /Cannot verify Git branch state: .*unknown.*HEAD.*branch refs\/heads\/keep-branch=present/,
    );
    assert.ok(h.fixtureGit(h.root, "show-ref", "--verify", "refs/heads/keep-branch"));
  });

  it("does not block branch removal for known unrelated branch use in omitted metadata", async () => {
    const h = await createHarness(true, true);
    await h.explicit("add", "remove-me");
    const sibling = join(h.directory, "keep-me");
    h.fixtureGit(h.root, "worktree", "add", "-b", "keep-me", sibling);
    const admin = h.fixtureGit(sibling, "rev-parse", "--absolute-git-dir");
    rmSync(join(admin, "gitdir"));
    await h.explicit("remove", "remove-me");
    assert.ok(h.fixtureGit(h.root, "show-ref", "--verify", "refs/heads/keep-me"));
    assert.ok(existsSync(sibling));
  });

  it("reports known admin metadata as present even when Git omits the registration", async () => {
    const h = await createHarness(true, true);
    await h.explicit("add", "leftover");
    const path = join(h.managed, "leftover");
    const admin = h.fixtureGit(path, "rev-parse", "--absolute-git-dir");
    h.setBeforeAppend(() => {
      mkdirSync(admin, { recursive: true });
      writeFileSync(join(admin, "HEAD"), "ref: refs/heads/leftover\n");
      assert.ok(!h.fixtureGit(h.root, "worktree", "list", "--porcelain").includes(path));
    });
    await assert.rejects(
      h.explicit("remove", "leftover"),
      /path=absent, registration=present, branch refs\/heads\/leftover=present; declaration=removed; permission=revoked/,
    );
    assert.ok(existsSync(admin));
    assert.ok(h.fixtureGit(h.root, "show-ref", "--verify", "refs/heads/leftover"));
    await assert.rejects(h.request(path), /Access requires confirmation/);
  });

  for (const protection of ["deny", "credentials"] as const) {
    it(
      "protects a not-yet-created checkout path through a wildcard alias in " + protection,
      async () => {
        const h = await createHarness(true, true, {
          [protection]: ["aliases/*/prospective/token"],
        });
        writeFileSync(join(h.root, "token"), "tracked");
        h.fixtureGit(h.root, "add", "token");
        h.fixtureGit(h.root, "commit", "-m", "tracked token");
        mkdirSync(h.managed, { recursive: true });
        const aliases = join(h.directory, "aliases");
        mkdirSync(aliases);
        symlinkSync(h.managed, join(aliases, "managed"), "dir");
        const path = join(h.managed, "prospective");
        const expected =
          protection === "credentials"
            ? /Access denied for credential path.*token/
            : /Access denied: .*token/;

        await assert.rejects(h.explicit("add", "prospective"), expected);
        assert.equal(existsSync(path), false);
        assert.equal(existsSync(join(h.root, ".git", "worktrees", "prospective")), false);
        assert.throws(() => h.fixtureGit(h.root, "show-ref", "--verify", "refs/heads/prospective"));
        assert.deepEqual(getDeclarations(h.manager), []);
        await h.explicit("add", "unrelated");
        assert.equal(readFileSync(join(h.managed, "unrelated", "token"), "utf8"), "tracked");
      },
    );

    it(
      "protects a discard target when a wildcard matches a symlink ancestor in " + protection,
      async () => {
        const h = await createHarness(true, true, { [protection]: ["aliases/*/token"] });
        const path = join(h.managed, "protected-alias");
        await h.explicit("add", "protected-alias");
        const token = join(path, "token");
        writeFileSync(token, "preserve");
        const aliases = join(h.directory, "aliases");
        mkdirSync(aliases);
        symlinkSync(path, join(aliases, "late-alias"), "dir");
        await assert.rejects(
          h.explicit("remove", "protected-alias", { discard: true }),
          /Access denied.*token/,
        );
        assert.equal(readFileSync(token, "utf8"), "preserve");
        assert.equal(h.fixtureGit(path, "branch", "--show-current"), "protected-alias");
      },
    );
  }

  it("reports partial removal without deleting a branch that advances after directory deletion", async () => {
    const h = await createHarness(true, true);
    const path = join(h.managed, "moving");
    await h.explicit("add", "moving");
    h.fixtureGit(h.root, "commit", "--allow-empty", "-m", "replacement oid");
    const replacement = h.fixtureGit(h.root, "rev-parse", "HEAD");
    h.setBeforeAppend(() => h.fixtureGit(h.root, "update-ref", "refs/heads/moving", replacement));
    await assert.rejects(
      h.explicit("remove", "moving"),
      /unchanged, unchecked-out branch.*path=absent, registration=absent, branch refs\/heads\/moving=present; declaration=removed; permission=revoked/,
    );
    assert.equal(
      h.fixtureGit(h.root, "show-ref", "--hash", "--verify", "refs/heads/moving"),
      replacement,
    );
    assert.deepEqual(getDeclarations(h.manager), []);
    await assert.rejects(h.request(path), /Access requires confirmation/);
  });

  it("prunes stale declarations and serializes updates across conversation branches", async () => {
    const h = await createHarness(true, true);
    await h.explicit("add", "stale");
    const stale = join(h.managed, "stale");
    assert.equal(
      h.shell(quote(["git", "worktree", "move", stale, join(h.managed, "moved")])).isError,
      false,
    );
    await assert.rejects(h.request(stale), /Access requires confirmation/);
    h.manager.branch(h.manager.getEntries()[0]!.id);
    await h.emit("session_tree", {});
    await Promise.all([h.explicit("add", "one"), h.explicit("add", "two")]);
    assert.deepEqual(getDeclarations(h.manager), [
      { name: "one", path: join(h.managed, "one") },
      { name: "two", path: join(h.managed, "two") },
    ]);
  });

  it("accepts a declaration without forcing a session file into existence", async () => {
    const h = await createHarness(false, true);
    await h.explicit("add", "unflushed");
    assert.equal(existsSync(h.manager.getSessionFile()!), false);
    assert.deepEqual(getDeclarations(h.manager), [
      { name: "unflushed", path: join(h.managed, "unflushed") },
    ]);
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

  it("automatically tracks worktrees through pi.exec without a background Bash registration", async () => {
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

  it("does not grant or append a queued declaration after a session switch", async () => {
    const h = await createHarness(true, true);
    const reachedBash = Promise.withResolvers<void>();
    const continueBash = Promise.withResolvers<void>();
    const pending = h.explicit("add", "switching", {}, async () => {
      reachedBash.resolve();
      await continueBash.promise;
    });
    const failure = assert.rejects(pending, /Session changed|operation was aborted/);
    await reachedBash.promise;
    const old = await h.switchSession();
    continueBash.resolve();
    await failure;
    assert.deepEqual(getDeclarations(old), []);
    assert.deepEqual(getDeclarations(h.manager), []);
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

  it("routes queries and mutations through registered Bash without HITL or ambient grants", async () => {
    const h = await createHarness(true, true);
    const repo = h.createProject("external repo");
    const metadata = join(repo, ".git");
    const target = join(h.directory, ".agents", "worktrees", "external repo", "nested");
    const calls: string[] = [];
    await h.explicit("add", "nested", { project: "external repo" }, async (command) => {
      calls.push(command);
      await assert.rejects(h.request(metadata), /Access requires confirmation/);
      await assert.rejects(h.request(join(target, "..")), /Access requires confirmation/);
    });
    assert.ok(calls.length > 2);
    assert.ok(calls.every((command) => command.startsWith("/bin/false scoped-execution-")));
    const replay = await h.invoke("bash", { command: calls.at(-1)! });
    assert.equal(replay.isError, true);
    await assert.rejects(h.request(metadata), /Access requires confirmation/);
    assert.equal(h.fixtureGit(target, "branch", "--show-current"), "nested");
    h.seedWorkspace(target);
    await h.explicit("remove", "nested", { project: "external repo" });
    assert.deepEqual(getWorkspaces(h.manager), []);
    await assert.rejects(h.request(target), /Access requires confirmation/);
    assert.equal(existsSync(target), false);
  }, 30_000);

  realBwrapTest(
    "blocks a protected Git management root and retains a protected sibling",
    async () => {
      const h = await createHarness(true, true, {
        deny: ["projects/blocked admin/.git"],
        credentials: [".agents/worktrees/main repo/sibling/private-*"],
      });
      const restricted = h.createProject("blocked admin");
      await assert.rejects(
        h.explicit("add", "target", { project: "blocked admin" }),
        /Access denied/,
      );
      assert.equal(h.fixtureGit(restricted, "for-each-ref", "refs/heads/target"), "");
      await h.explicit("add", "sibling");
      const credential = join(h.managed, "sibling", "private-created-late");
      writeFileSync(credential, "kept");
      await h.explicit("add", "target");
      await h.explicit("remove", "target");
      assert.equal(readFileSync(credential, "utf8"), "kept");
      await assert.rejects(
        h.explicit("remove", "sibling", { discard: true }),
        /Access denied for credential path/,
      );
      assert.equal(h.fixtureGit(join(h.managed, "sibling"), "branch", "--show-current"), "sibling");
    },
    30_000,
  );

  it("adds and removes a SHA-256 worktree with the files ref backend", async () => {
    const h = await createHarness(true, true, {}, "sha256");
    await h.explicit("add", "sha");
    await h.explicit("remove", "sha");
    assert.equal(existsSync(join(h.managed, "sha")), false);
  });
});
