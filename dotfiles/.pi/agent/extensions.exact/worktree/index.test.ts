import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
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

async function createHarness(persist = true, guarded = false) {
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
          { deny: [join(managed, "denied"), join(managed, "active", "denied")] },
        ],
        credentials: [join(managed, "credential"), join(managed, "active", "secret")],
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

  function explicit(action: "declare" | "unregister", name: string, cwd = root) {
    return invoke("session_worktree", { action, name }, { ...context(), cwd });
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

    const result = await h.explicit("declare", "agents-created", other);
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
    await h.explicit("declare", "safe-creation");
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
    const result = await h.explicit("declare", "existing");
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
    await h.explicit("declare", "existing");
    assert.deepEqual(readFileSync(file), before);
  });

  it("rejects unsafe names, occupied paths and existing branches without changing them", async () => {
    const h = await createHarness(true, true);
    for (const name of ["../outside", "-force", "wt-agents-conflict", "normal\n", "some/path"])
      await assert.rejects(h.explicit("declare", name), /Invalid worktree name/);
    const normal = join(h.managed, "occupied");
    mkdirSync(normal, { recursive: true });
    const marker = join(normal, "draft");
    writeFileSync(marker, "keep");
    await assert.rejects(h.explicit("declare", "occupied"), /Not a linked worktree/);
    assert.equal(readFileSync(marker, "utf8"), "keep");
    symlinkSync(normal, join(h.managed, "alias"));
    await assert.rejects(h.explicit("declare", "alias"), /without symbolic links/);
    assert.equal(h.shell("git branch collision").isError, false);
    await assert.rejects(h.explicit("declare", "collision"), /already exists/);
    assert.equal(existsSync(join(h.managed, "collision")), false);
    assert.deepEqual(getDeclarations(h.manager), []);
  });

  it("does not create worktrees at paths denied by Guardrails", async () => {
    const h = await createHarness(true, true);
    await assert.rejects(h.explicit("declare", "denied"), /Access denied/);
    await assert.rejects(h.explicit("declare", "credential"), /Access denied for credential path/);
    assert.equal(existsSync(h.managed), false);
    assert.deepEqual(getDeclarations(h.manager), []);
  });

  it("never elevates observed or persisted declarations without a successful tool call", async () => {
    const h = await createHarness(true, true);
    const path = join(h.managed, "observed");
    await h.bash(quote(["git", "worktree", "add", "--detach", path]));
    assert.deepEqual(getWorkspaces(h.manager), [path]);
    await assert.rejects(h.request(path), /Access requires confirmation/);
    await h.explicit("declare", "observed");
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
      await h.explicit("declare", "active");
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
      await h.explicit("unregister", "active");
      await assert.rejects(
        h.invoke("write", { path: file, content: "wrong" }, noninteractive),
        /Access requires confirmation/,
      );
      assert.equal(readFileSync(file, "utf8"), "changedbash");
      assert.ok(existsSync(join(path, ".git")));
    },
  );

  it("does not grant access if the declaration cannot be saved", async () => {
    const h = await createHarness(true, true);
    const path = join(h.managed, "unsaved");
    h.setAppendError(new Error("Fixture session append failed"));
    await assert.rejects(h.explicit("declare", "unsaved"), (error: Error) => {
      assert.ok(error.message.includes(path));
      assert.match(error.message, /Fixture session append failed/);
      return true;
    });
    assert.ok(existsSync(path));
    assert.deepEqual(getDeclarations(h.manager), []);
    await assert.rejects(h.request(path), /Access requires confirmation/);
  });

  it("revokes the grant even if unregister cannot save the update", async () => {
    const h = await createHarness(true, true);
    const path = join(h.managed, "registered");
    await h.explicit("declare", "registered");
    h.setAppendError(new Error("Fixture session append failed"));
    await assert.rejects(h.explicit("unregister", "registered"), /Fixture session append failed/);
    assert.deepEqual(getDeclarations(h.manager), [{ name: "registered", path }]);
    await assert.rejects(h.request(path), /Access requires confirmation/);
  });

  it("expires a grant when a worktree is replaced and can unregister after deletion", async () => {
    const h = await createHarness(true, true);
    const path = join(h.managed, "gone");
    await h.explicit("declare", "gone");
    assert.equal(h.shell(quote(["git", "worktree", "remove", path])).isError, false);
    assert.equal(h.shell(quote(["git", "worktree", "add", path, "gone"])).isError, false);
    await assert.rejects(h.request(path), /Access requires confirmation/);
    await h.explicit("declare", "gone");
    assert.match(JSON.stringify((await h.request(path)).details), /already granted/);
    assert.equal(h.shell(quote(["git", "worktree", "remove", path])).isError, false);
    assert.deepEqual((await h.explicit("unregister", "gone")).details, {
      name: "gone",
      changed: true,
      worktrees: [],
    });
    assert.deepEqual((await h.explicit("unregister", "gone")).details, {
      name: "gone",
      changed: false,
      worktrees: [],
    });
  });

  it("prunes stale declarations and serializes updates across conversation branches", async () => {
    const h = await createHarness(true, true);
    await h.explicit("declare", "stale");
    const stale = join(h.managed, "stale");
    assert.equal(
      h.shell(quote(["git", "worktree", "move", stale, join(h.managed, "moved")])).isError,
      false,
    );
    await assert.rejects(h.request(stale), /Access requires confirmation/);
    h.manager.branch(h.manager.getEntries()[0]!.id);
    await h.emit("session_tree", {});
    await Promise.all([h.explicit("declare", "one"), h.explicit("declare", "two")]);
    assert.deepEqual(getDeclarations(h.manager), [
      { name: "one", path: join(h.managed, "one") },
      { name: "two", path: join(h.managed, "two") },
    ]);
  });

  it("accepts a declaration without forcing a session file into existence", async () => {
    const h = await createHarness(false, true);
    await h.explicit("declare", "unflushed");
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
    const pending = h.explicit("declare", "switching");
    const failure = assert.rejects(pending, /Session changed|operation was aborted/);
    const old = await h.switchSession();
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
});
