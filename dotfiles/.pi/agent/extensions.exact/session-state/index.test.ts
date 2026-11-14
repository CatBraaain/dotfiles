import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { readlinkSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { parse } from "shell-quote";
import { describe, it, spyOn } from "bun:test";
import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionEvent,
} from "@earendil-works/pi-coding-agent";
import { childInvocationArgs, subagentSessionDir } from "../agents/index.ts";
import {
  registerBackgroundBash,
  type BackgroundBashOutcome as ToolExecutionOutcome,
} from "../tools/background-bash.ts";
import sessionStateExtension from "./index.ts";
import { stateOptionValue } from "./tmux.ts";

type EventHandler = (event: ExtensionEvent, ctx: ExtensionContext) => unknown;
type KeywordResponse = (command: string) => ToolExecutionOutcome | Promise<ToolExecutionOutcome>;

const WAIT_TIMEOUT_MS = 5_000;

class FakeTmuxServer {
  readonly commands: string[] = [];
  readonly responses: Partial<Record<string, KeywordResponse>> = {};
  private pendingCount = 0;
  private readonly paneOptions = new Map<string, string>();

  constructor(readonly socketPath: string) {}

  setPaneOption(paneId: string, value: string | undefined): void {
    if (value === undefined) this.paneOptions.delete(paneId);
    else this.paneOptions.set(paneId, value);
  }

  paneOptionOf(paneId: string): string | undefined {
    return this.paneOptions.get(paneId);
  }

  hasPending(): boolean {
    return this.pendingCount > 0;
  }

  async run(command: string): Promise<ToolExecutionOutcome> {
    this.pendingCount++;
    try {
      this.commands.push(command);
      const argv = parse(command) as string[];
      const keyword = argv[0] === "pi-mux" ? "state" : argv[3]!;
      const custom = this.responses[keyword]?.(command);
      if (custom) return await custom;
      if (keyword === "display-message") return completedResult(this.verifiedFieldsLine());
      if (keyword === "state") {
        const source = JSON.parse(argv[argv.indexOf("--source") + 1]!);
        if (argv.includes("--clear")) this.paneOptions.delete(source.pane);
        else
          this.paneOptions.set(
            source.pane,
            stateOptionValue(
              argv[2]!,
              argv[3] as "running",
              JSON.parse(argv[argv.indexOf("--title") + 1]!),
            ),
          );
        return completedResult("");
      }
      return completedResult(`unexpected tmux keyword: ${keyword}`, true);
    } finally {
      this.pendingCount--;
    }
  }

  private verifiedFieldsLine(): string {
    const fields = [
      this.socketPath,
      String(process.pid),
      "%0",
      readlinkSync("/proc/self/fd/0"),
      String(process.pid),
    ];
    return fields.join("\t");
  }
}

function completedResult(text: string, isError = false): ToolExecutionOutcome {
  return {
    status: "completed",
    result: {
      content: [{ type: "text", text }],
      details: {},
      ...(isError ? { isError: true } : {}),
    },
  };
}

async function finishEventLoopTurn(): Promise<void> {
  await setImmediate();
}

async function waitFor(label: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timeout waiting for ${label}`);
    await setImmediate();
  }
}

interface ExtensionHarness {
  agentDir: string;
  restorePath: string;
  commands: Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>;
  server: FakeTmuxServer;
  notifications: { message: string; level: string | undefined }[];
  sessionId: string;
  sessionName: string | undefined;
  emit(type: string, fields?: Record<string, unknown>): Promise<void>;
  disposeBashReceiver(): void;
  restoreBashReceiver(): void;
  restartRuntime(): void;
  abortRun(): void;
  close(): Promise<void>;
}

async function createExtensionHarness(
  options: {
    agent?: string;
    mode?: "new" | "resume" | "fork" | "vision";
    customDir?: boolean;
    dedicated?: boolean;
    deferDiscovery?: boolean;
  } = {},
): Promise<ExtensionHarness> {
  await mkdir("/tmp/work/dotfiles", { recursive: true });
  const agentDir = await mkdtemp("/tmp/work/dotfiles/session-state-extension-");
  const stoppedKey = Symbol.for("pi.session-state.publication-stopped");
  const previousStopped = Reflect.get(process, stoppedKey);
  const runController = new AbortController();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const runtimeDir = await mkdtemp("/tmp/work/dotfiles/session-state-runtime-");
  const socketPath = join(runtimeDir, "pi-tmux", "server.sock");
  await mkdir(dirname(socketPath), { recursive: true });
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(socketPath, resolve);
  });
  const previousRuntimeEnv = {
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    TMUX: process.env.TMUX,
    TMUX_PANE: process.env.TMUX_PANE,
  };
  const agent = options.agent ?? "main";
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  if (options.dedicated === false) {
    process.env.TMUX = `/other/socket,${process.pid}`;
    process.env.TMUX_PANE = "%0";
  } else {
    process.env.TMUX = `${socketPath},${process.pid}`;
    process.env.TMUX_PANE = "%0";
  }
  const previousAgentName = process.env.PI_AGENT_NAME;
  process.env.PI_AGENT_NAME = agent;

  const workspacePath = join(agentDir, "workspace: child");
  const harnessSessionId = { value: "s1", name: undefined as string | undefined };
  const childDir = subagentSessionDir(workspacePath);
  const childSession =
    options.mode === "resume" || options.mode === "fork"
      ? { path: join(childDir, "existing-session.jsonl"), fork: options.mode === "fork" }
      : undefined;
  const args = childInvocationArgs(agent, "test task", workspacePath, childSession);
  const sessionDir =
    options.mode === undefined
      ? options.customDir
        ? join(agentDir, "custom", "subagents")
        : dirname(childDir)
      : `${args[args.indexOf("--session-dir") + 1]}/../subagents/`;

  const handlers = new Map<string, EventHandler[]>();
  const bus = createEventBus();
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  const notifications: { message: string; level: string | undefined }[] = [];
  const server = new FakeTmuxServer(socketPath);
  const modelRegistry = {};
  const context = {
    signal: runController.signal,
    modelRegistry,
    hasUI: true,
    sessionManager: {
      getCwd: () => workspacePath,
      getSessionId: () => harnessSessionId.value,
      getSessionName: () => harnessSessionId.name,
      getSessionFile: () => undefined,
      getSessionDir: () => sessionDir,
      getHeader: () => ({ parentSession: "/ordinary/top-level-parent.jsonl" }),
    },
    ui: {
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
    },
  } as unknown as ExtensionContext;
  const events: ExtensionAPI["events"] = bus;
  const pi = {
    on(type: string, handler: EventHandler) {
      const registered = handlers.get(type) ?? [];
      registered.push(handler);
      handlers.set(type, registered);
    },
    events,
    registerCommand(name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;

  sessionStateExtension(pi);
  function connectBashReceiver() {
    return registerBackgroundBash(
      context,
      async (request) => {
        const params = request.params as { command: string; timeout?: number };
        const outcome = await server.run(params.command);
        if (outcome.status === "completed") return outcome.result;
        if (outcome.status === "failed" || outcome.status === "unavailable") throw outcome.error;
        throw outcome.reason;
      },
      () => {},
    );
  }
  let disposeBashReceiver = connectBashReceiver();

  const restorePath = join(agentDir, "pi-tmux", "pi-mux-restore.json");
  await mkdir(dirname(restorePath), { recursive: true });
  const harness: ExtensionHarness = {
    agentDir,
    restorePath,
    commands,
    server,
    notifications,
    get sessionId() {
      return harnessSessionId.value;
    },
    set sessionId(value: string) {
      harnessSessionId.value = value;
    },
    get sessionName() {
      return harnessSessionId.name;
    },
    set sessionName(value: string | undefined) {
      harnessSessionId.name = value;
    },
    async emit(type, fields = {}) {
      if (type === "session_info_changed")
        harnessSessionId.name = fields.name as string | undefined;
      const event = { type, ...fields } as ExtensionEvent;
      for (const handler of handlers.get(type) ?? []) {
        const result = await handler(event, context);
        assert.equal(result, undefined);
      }
      if (type === "session_start" && !options.deferDiscovery) {
        for (const handler of handlers.get("resources_discover") ?? []) {
          await handler({ type: "resources_discover" } as ExtensionEvent, context);
        }
      }
    },
    disposeBashReceiver() {
      disposeBashReceiver();
    },
    restoreBashReceiver() {
      disposeBashReceiver();
      disposeBashReceiver = connectBashReceiver();
    },
    restartRuntime() {
      handlers.clear();
      commands.clear();
      sessionStateExtension(pi);
    },
    abortRun() {
      runController.abort(new Error("run aborted"));
    },
    async close() {
      await harness.emit("session_shutdown");
      disposeBashReceiver();
      await new Promise<void>((resolve) => socket.close(() => resolve()));
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousAgentName === undefined) delete process.env.PI_AGENT_NAME;
      else process.env.PI_AGENT_NAME = previousAgentName;
      for (const [key, value] of Object.entries(previousRuntimeEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(agentDir, { recursive: true, force: true });
      await rm(runtimeDir, { recursive: true, force: true });
      if (previousStopped === undefined) Reflect.deleteProperty(process, stoppedKey);
      else Reflect.set(process, stoppedKey, previousStopped);
    },
  };
  return harness;
}

const lifecycleEvents = [
  "session_start",
  "input",
  "agent_start",
  "ui_prompt_start",
  "ui_prompt_end",
  "message_update",
  "agent_settled",
  "session_info_changed",
  "session_shutdown",
] as const;

describe("sessionStateExtension in child sessions", () => {
  for (const mode of ["new", "resume", "fork", "vision"] as const) {
    it(`leaves an absent restore record absent during the ${mode} child lifecycle`, async () => {
      const h = await createExtensionHarness({
        mode,
        agent: mode === "vision" ? "vision" : "main",
      });
      try {
        for (const event of lifecycleEvents) await h.emit(event);
        assert.equal(existsSync(h.restorePath), false);
        assert.deepEqual([...h.commands.keys()], []);
        assert.deepEqual(h.server.commands, []);
      } finally {
        await h.close();
      }
    });
  }
  for (const mode of ["new", "resume", "fork", "vision"] as const) {
    const agent = mode === "vision" ? "vision" : "main";

    it(`does not update the restore record or publish during the ${mode} child lifecycle`, async () => {
      const harness = await createExtensionHarness({ agent, mode });
      try {
        const validRecord = JSON.stringify({
          version: 1,
          generation: "saved-generation",
          workspaces: [
            {
              cwd: join(harness.agentDir, "workspace: child"),
              sessions: ["s1"],
            },
          ],
        });
        writeFileSync(harness.restorePath, validRecord);
        const before = statSync(harness.restorePath, { bigint: true });

        for (const event of lifecycleEvents) {
          await harness.emit(event);
          await finishEventLoopTurn();
          assert.equal(harness.server.commands.length, 0, `event: ${event}`);
          assert.equal(readFileSync(harness.restorePath, "utf8"), validRecord, `event: ${event}`);
          const after = statSync(harness.restorePath, { bigint: true });
          assert.deepEqual(
            [after.ino, after.mtimeNs],
            [before.ino, before.mtimeNs],
            `event: ${event}`,
          );
          assert.deepEqual([...harness.commands.keys()], [], `event: ${event}`);
        }
      } finally {
        await harness.close();
      }
    });
  }
});

describe("sessionStateExtension in top-level sessions", () => {
  it("waits for all session_start handlers before checking and publishing through later Tools", async () => {
    const h = await createExtensionHarness({ deferDiscovery: true });
    h.disposeBashReceiver();
    try {
      await h.emit("session_start");
      await h.emit("ui_prompt_start");
      await h.emit("ui_prompt_end");
      await finishEventLoopTurn();
      assert.equal(h.server.commands.length, 0);
      assert.equal(h.notifications.length, 0);
      h.restoreBashReceiver();
      await h.emit("resources_discover");
      await waitFor(
        "initial state after Tools initialization",
        () => h.server.paneOptionOf("%0") === stateOptionValue(h.sessionId, "waiting-user"),
      );
      assert.equal(h.notifications.length, 0);
    } finally {
      await h.close();
    }
  });
  for (const agent of ["main", "senior", "junior", "vision", "chat"]) {
    it(`publishes the state sequence for a top-level ${agent} session with a parent header`, async () => {
      const harness = await createExtensionHarness({ agent, customDir: agent === "vision" });
      try {
        const states = [
          ["session_start", "waiting-user"],
          ["agent_start", "running"],
          ["ui_prompt_start", "waiting-approval"],
          ["ui_prompt_end", "running"],
          ["agent_settled", "waiting-user"],
          ["input", "waiting-user"],
          ["agent_end", "waiting-user"],
        ] as const;
        for (const [event, expectedState] of states) {
          await harness.emit(event);
          await waitFor(`state ${expectedState} on ${event}`, () => {
            const value = harness.server.paneOptionOf("%0");
            return (
              value !== undefined && value === stateOptionValue(harness.sessionId, expectedState)
            );
          });
        }

        await harness.emit("session_shutdown");
        assert.equal(harness.server.paneOptionOf("%0"), undefined);
      } finally {
        await harness.close();
      }
    });
  }

  it("detects the managed pane once per session_start and reuses the binding", async () => {
    const harness = await createExtensionHarness();
    try {
      await harness.emit("session_start");
      await waitFor("waiting-user", () => harness.server.paneOptionOf("%0") !== undefined);
      await harness.emit("agent_start");
      await waitFor(
        "running",
        () => harness.server.paneOptionOf("%0") === stateOptionValue("s1", "running"),
      );
      await harness.emit("message_update");
      await finishEventLoopTurn();

      const displayCount = harness.server.commands.filter((command) =>
        command.includes("display-message"),
      ).length;
      assert.equal(displayCount, 1);
      assert.ok(harness.server.commands[0]!.includes(`-S ${harness.server.socketPath}`));
    } finally {
      await harness.close();
    }
  });

  it("publishes nothing and leaves the restore record absent outside the managed pane", async () => {
    const harness = await createExtensionHarness({ dedicated: false });
    try {
      for (const event of lifecycleEvents)
        await harness.emit(
          event,
          event === "session_info_changed" ? { name: "Unmanaged title" } : {},
        );
      await finishEventLoopTurn();
      assert.deepEqual(harness.server.commands, []);
      assert.equal(existsSync(harness.restorePath), false);
      assert.deepEqual([...harness.commands.keys()], []);
      assert.deepEqual(harness.notifications, []);
    } finally {
      await harness.close();
    }
  });

  it("notifies a detection failure once and stops publishing states", async () => {
    const harness = await createExtensionHarness();
    try {
      harness.server.responses["display-message"] = () => completedResult("no such server", true);
      await harness.emit("session_start");
      await waitFor("detection failure notification", () =>
        harness.notifications.some((notification) =>
          /cannot confirm managed tmux pane/.test(notification.message),
        ),
      );

      await harness.emit("agent_start");
      await finishEventLoopTurn();
      assert.equal(
        harness.server.commands.filter((command) => command.startsWith("pi-mux state ")).length,
        0,
      );
      assert.deepEqual(
        harness.notifications.filter((notification) => /session state/.test(notification.message)),
        [],
      );
    } finally {
      await harness.close();
    }
  });
});

const progressEvents = [
  "session_before_compact",
  "session_compact",
  "session_compact_failed",
  "context",
  "context_with_system",
  "before_provider_request",
  "before_provider_headers",
  "after_provider_response",
  "provider_stream_event",
  "before_agent_start",
  "agent_end",
  "agent_before_settle",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "tool_call",
  "tool_result",
] as const satisfies readonly ExtensionEvent["type"][];

const unchangedEvents = [
  "project_trust",
  "resources_discover",
  "session_info_changed",
  "mcp_servers_change",
  "model_select",
  "thinking_level_select",
  "session_before_switch",
  "session_before_fork",
  "session_before_tree",
  "session_tree",
  "cache_warming_decision",
  "user_bash",
  "input",
] as const satisfies readonly ExtensionEvent["type"][];

describe("session-state title publication", () => {
  for (const reason of ["startup", "resume", "reload"]) {
    it(`publishes the saved name on ${reason}`, async () => {
      const h = await createExtensionHarness();
      try {
        h.sessionName = "Saved title";
        await h.emit("session_start", { reason });
        await waitFor(
          "saved title",
          () =>
            h.server.paneOptionOf("%0") === stateOptionValue("s1", "waiting-user", "Saved title"),
        );
        assert.equal(existsSync(h.restorePath), false);
      } finally {
        await h.close();
      }
    });
  }

  it("retains name changes before discovery without starting CLI", async () => {
    const h = await createExtensionHarness({ deferDiscovery: true });
    try {
      h.sessionName = "Initial title";
      await h.emit("session_start");
      await h.emit("session_info_changed", { name: "Before discovery" });
      await finishEventLoopTurn();
      assert.deepEqual(h.server.commands, []);
      await h.emit("resources_discover");
      await waitFor(
        "latest initial title",
        () =>
          h.server.paneOptionOf("%0") ===
          stateOptionValue("s1", "waiting-user", "Before discovery"),
      );
    } finally {
      await h.close();
    }
  });

  it("publishes title-only changes, deduplicates equal titles, and clears missing names", async () => {
    const h = await createExtensionHarness();
    try {
      await h.emit("session_start");
      await waitFor("initial", () => h.server.paneOptionOf("%0") !== undefined);
      await h.emit("agent_start");
      await h.emit("agent_settled");
      await h.emit("session_info_changed", { name: "Late title" });
      await waitFor(
        "late title",
        () => h.server.paneOptionOf("%0") === stateOptionValue("s1", "waiting-user", "Late title"),
      );
      const count = h.server.commands.length;
      await h.emit("session_info_changed", { name: "Late title" });
      await finishEventLoopTurn();
      assert.equal(h.server.commands.length, count);
      await h.emit("agent_start");
      await waitFor(
        "title retained",
        () => h.server.paneOptionOf("%0") === stateOptionValue("s1", "running", "Late title"),
      );
      await h.emit("session_info_changed", { name: undefined });
      await waitFor(
        "cleared title",
        () => h.server.paneOptionOf("%0") === stateOptionValue("s1", "running", null),
      );
      assert.equal(existsSync(h.restorePath), false);
    } finally {
      await h.close();
    }
  });

  it("retains approval state when a title changes", async () => {
    const h = await createExtensionHarness();
    try {
      await h.emit("session_start");
      await h.emit("ui_prompt_start");
      await h.emit("session_info_changed", { name: "Approval title" });
      await h.emit("agent_settled");
      await waitFor(
        "approval title",
        () =>
          h.server.paneOptionOf("%0") ===
          stateOptionValue("s1", "waiting-approval", "Approval title"),
      );
      await h.emit("ui_prompt_end");
      await waitFor(
        "idle title",
        () =>
          h.server.paneOptionOf("%0") === stateOptionValue("s1", "waiting-user", "Approval title"),
      );
    } finally {
      await h.close();
    }
  });

  it("captures each queued title and state before a replacement invalidates old work", async () => {
    const h = await createExtensionHarness();
    const pending = Promise.withResolvers<ToolExecutionOutcome>();
    const oldSet = Promise.withResolvers<ToolExecutionOutcome>();
    try {
      await h.emit("session_start");
      await waitFor("initial", () => h.server.paneOptionOf("%0") !== undefined);
      const count = h.server.commands.length;
      h.server.responses["state"] = () => pending.promise;
      await h.emit("session_info_changed", { name: "First title" });
      await waitFor("pending title", () => h.server.hasPending());
      await h.emit("agent_start");
      await h.emit("session_info_changed", { name: "Second title" });
      delete h.server.responses["state"];
      pending.resolve(completedResult(""));
      await waitFor(
        "queued snapshots",
        () => h.server.paneOptionOf("%0") === stateOptionValue("s1", "running", "Second title"),
      );
      const values = h.server.commands.slice(count).map((command) => {
        const argv = parse(command) as string[];
        return JSON.parse(
          stateOptionValue(
            argv[2]!,
            argv[3] as "running",
            JSON.parse(argv[argv.indexOf("--title") + 1]!),
          ),
        );
      });
      assert.deepEqual(values, [
        { version: 1, sessionId: "s1", state: "waiting-user", title: "First title" },
        { version: 1, sessionId: "s1", state: "running", title: "First title" },
        { version: 1, sessionId: "s1", state: "running", title: "Second title" },
      ]);

      h.server.responses["state"] = () => oldSet.promise;
      await h.emit("session_info_changed", { name: "Old title" });
      await waitFor("old title in flight", () => h.server.hasPending());
      await h.emit("session_info_changed", { name: "Discarded title" });
      h.sessionId = "replacement";
      h.sessionName = "Replacement title";
      await h.emit("session_start", { reason: "resume" });
      delete h.server.responses["state"];
      oldSet.resolve(completedResult(""));
      await waitFor(
        "replacement title",
        () =>
          h.server.paneOptionOf("%0") ===
          stateOptionValue("replacement", "waiting-user", "Replacement title"),
      );
      assert.equal(
        h.server.commands.some((command) => command.includes("Discarded title")),
        false,
      );
    } finally {
      pending.resolve(completedResult(""));
      oldSet.resolve(completedResult(""));
      await h.close();
    }
  });
});

describe("session-state MVP state boundaries", () => {
  it("publishes only state changes and never reads pane options", async () => {
    const h = await createExtensionHarness();
    try {
      for (const [event, state] of [
        ["session_start", "waiting-user"],
        ["agent_start", "running"],
        ["ui_prompt_start", "waiting-approval"],
        ["ui_prompt_end", "running"],
        ["agent_settled", "waiting-user"],
      ] as const) {
        await h.emit(event);
        await waitFor(event, () => h.server.paneOptionOf("%0") === stateOptionValue("s1", state));
        await finishEventLoopTurn();
        await finishEventLoopTurn();
        const count = h.server.commands.length;
        await h.emit(event === "session_start" ? "ui_prompt_end" : event);
        await finishEventLoopTurn();
        assert.equal(h.server.commands.length, count, event);
      }
      assert.equal(h.server.commands.filter((c) => c.includes("display-message")).length, 1);
      assert.equal(h.server.commands.filter((c) => c.startsWith("pi-mux state ")).length, 5);
      assert.equal(
        h.server.commands.some((c) => c.includes("show-options")),
        false,
      );
    } finally {
      await h.close();
    }
  });

  it("returns to waiting-user when UI ends outside a run", async () => {
    const h = await createExtensionHarness();
    try {
      await h.emit("session_start");
      await h.emit("ui_prompt_start");
      await waitFor(
        "approval",
        () => h.server.paneOptionOf("%0") === stateOptionValue("s1", "waiting-approval"),
      );
      await h.emit("ui_prompt_end");
      await waitFor(
        "idle",
        () => h.server.paneOptionOf("%0") === stateOptionValue("s1", "waiting-user"),
      );
    } finally {
      await h.close();
    }
  });

  it("holds approval across settlement until UI closes", async () => {
    const h = await createExtensionHarness();
    try {
      await h.emit("session_start");
      await h.emit("agent_start");
      await h.emit("ui_prompt_start");
      await waitFor(
        "approval",
        () => h.server.paneOptionOf("%0") === stateOptionValue("s1", "waiting-approval"),
      );
      const count = h.server.commands.length;
      for (const event of [...progressEvents, "agent_start", "agent_settled"]) await h.emit(event);
      await finishEventLoopTurn();
      assert.equal(h.server.commands.length, count);
      await h.emit("ui_prompt_end");
      await waitFor(
        "idle",
        () => h.server.paneOptionOf("%0") === stateOptionValue("s1", "waiting-user"),
      );
    } finally {
      await h.close();
    }
  });

  it("ignores all progress events and external option changes", async () => {
    const h = await createExtensionHarness();
    try {
      await h.emit("session_start");
      await h.emit("agent_start");
      await waitFor(
        "running",
        () => h.server.paneOptionOf("%0") === stateOptionValue("s1", "running"),
      );
      h.server.setPaneOption("%0", "external-value");
      const count = h.server.commands.length;
      for (const event of [...progressEvents, ...unchangedEvents]) await h.emit(event);
      await h.emit("agent_start");
      await finishEventLoopTurn();
      assert.equal(h.server.commands.length, count);
      assert.equal(h.server.paneOptionOf("%0"), "external-value");
      await h.emit("agent_settled", { aborted: true });
      await waitFor(
        "aborted settled",
        () => h.server.paneOptionOf("%0") === stateOptionValue("s1", "waiting-user"),
      );
    } finally {
      await h.close();
    }
  });

  for (const reason of ["startup", "reload", "new", "resume", "fork"]) {
    it(`publishes an equal initial state for a new ${reason} generation`, async () => {
      const h = await createExtensionHarness();
      try {
        await h.emit("session_start");
        await waitFor("initial", () => h.server.paneOptionOf("%0") !== undefined);
        const count = h.server.commands.length;
        await h.emit("session_start", { reason });
        await waitFor("new generation set", () => h.server.commands.length === count + 2);
        assert.equal(h.server.paneOptionOf("%0"), stateOptionValue("s1", "waiting-user"));
      } finally {
        await h.close();
      }
    });
  }

  it("preserves the latest state after a delayed set response", async () => {
    const h = await createExtensionHarness();
    const pending = Promise.withResolvers<ToolExecutionOutcome>();
    try {
      await h.emit("session_start");
      await waitFor("initial", () => h.server.paneOptionOf("%0") !== undefined);
      h.server.responses["state"] = () => {
        h.server.setPaneOption("%0", stateOptionValue("s1", "running"));
        return pending.promise;
      };
      await h.emit("agent_start");
      await waitFor("set started", () => h.server.hasPending());
      await h.emit("ui_prompt_start");
      delete h.server.responses["state"];
      pending.resolve(completedResult(""));
      await waitFor(
        "latest",
        () => h.server.paneOptionOf("%0") === stateOptionValue("s1", "waiting-approval"),
      );
      await finishEventLoopTurn();
      assert.equal(h.server.paneOptionOf("%0"), stateOptionValue("s1", "waiting-approval"));
      assert.deepEqual(h.notifications, []);
    } finally {
      pending.resolve(completedResult(""));
      await h.close();
    }
  });

  it("invalidates delayed old inspection on session replacement", async () => {
    const h = await createExtensionHarness();
    const pending = Promise.withResolvers<ToolExecutionOutcome>();
    try {
      h.server.responses["display-message"] = () => pending.promise;
      await h.emit("session_start");
      await waitFor("old inspect", () => h.server.hasPending());
      delete h.server.responses["display-message"];
      h.sessionId = "replacement";
      await h.emit("session_start");
      await finishEventLoopTurn();
      assert.equal(h.server.commands.length, 1);
      pending.resolve(completedResult(""));
      await waitFor(
        "replacement",
        () => h.server.paneOptionOf("%0") === stateOptionValue("replacement", "waiting-user"),
      );
      await waitFor("old drained", () => !h.server.hasPending());
      assert.deepEqual(h.notifications, []);
      assert.equal(
        h.server.commands.some((c) => c.includes(stateOptionValue("s1", "waiting-user"))),
        false,
      );
    } finally {
      pending.resolve(completedResult(""));
      await h.close();
    }
  });

  it("keeps the replacement session after an old set response arrives late", async () => {
    const h = await createExtensionHarness();
    const pending = Promise.withResolvers<ToolExecutionOutcome>();
    try {
      await h.emit("session_start");
      await waitFor("initial", () => h.server.paneOptionOf("%0") !== undefined);
      h.server.responses["state"] = () => {
        h.server.setPaneOption("%0", stateOptionValue("s1", "running"));
        return pending.promise;
      };
      await h.emit("agent_start");
      await waitFor("old set", () => h.server.hasPending());
      delete h.server.responses["state"];
      h.sessionId = "replacement";
      await h.emit("session_start");
      await finishEventLoopTurn();
      assert.equal(h.server.paneOptionOf("%0"), stateOptionValue("s1", "running"));
      pending.resolve(completedResult(""));
      await waitFor(
        "replacement",
        () => h.server.paneOptionOf("%0") === stateOptionValue("replacement", "waiting-user"),
      );
      await waitFor("late response", () => !h.server.hasPending());
      assert.equal(h.server.paneOptionOf("%0"), stateOptionValue("replacement", "waiting-user"));
      assert.deepEqual(h.notifications, []);
    } finally {
      pending.resolve(completedResult(""));
      await h.close();
    }
  });

  it("invalidates delayed results and unsets the option on shutdown", async () => {
    const h = await createExtensionHarness();
    const pending = Promise.withResolvers<ToolExecutionOutcome>();
    try {
      await h.emit("session_start");
      await waitFor("initial", () => h.server.paneOptionOf("%0") !== undefined);
      h.server.responses["state"] = () => pending.promise;
      await h.emit("agent_start");
      await waitFor("pending", () => h.server.hasPending());
      delete h.server.responses["state"];
      let ended = false;
      const shutdown = h.emit("session_shutdown").then(() => {
        ended = true;
      });
      await finishEventLoopTurn();
      assert.equal(ended, false);
      pending.resolve(completedResult(""));
      await shutdown;
      assert.equal(h.server.paneOptionOf("%0"), undefined);
      await waitFor("drained", () => !h.server.hasPending());
      const count = h.server.commands.length;
      await h.emit("agent_start");
      await h.emit("session_info_changed", { name: "After shutdown" });
      await finishEventLoopTurn();
      assert.equal(h.server.commands.length, count);
      assert.deepEqual(h.notifications, []);
    } finally {
      pending.resolve(completedResult(""));
      await h.close();
    }
  });

  it("notifies briefly and fails closed when Tools stopped first", async () => {
    const h = await createExtensionHarness();
    try {
      await h.emit("session_start");
      await waitFor("initial", () => h.server.paneOptionOf("%0") !== undefined);
      h.disposeBashReceiver();
      await h.emit("session_shutdown");
      assert.match(h.notifications.at(-1)!.message, /publication stopped/);
      assert.ok(h.notifications.at(-1)!.message.length <= 220);
    } finally {
      await h.close();
    }
  });

  it("retries an equal failed state on the next state request, but not on progress", async () => {
    const h = await createExtensionHarness();
    try {
      await h.emit("session_start");
      await waitFor("initial", () => h.server.paneOptionOf("%0") !== undefined);
      h.server.responses["state"] = () => completedResult("failure", true);
      await h.emit("agent_start");
      await waitFor("warning", () =>
        h.notifications.some((n) => n.message.includes("cannot publish")),
      );
      const count = h.server.commands.length;
      await h.emit("message_update");
      await finishEventLoopTurn();
      assert.equal(h.server.commands.length, count);
      delete h.server.responses["state"];
      await h.emit("agent_start");
      await waitFor(
        "equal state retry",
        () => h.server.paneOptionOf("%0") === stateOptionValue("s1", "running"),
      );
    } finally {
      await h.close();
    }
  });
});

describe("session-state partial publication recovery", () => {
  for (const title of [undefined, "Latest title"]) {
    it(`republishes settled state after a partial running failure with ${title ? "a saved title" : "no title"}`, async () => {
      const h = await createExtensionHarness();
      try {
        h.sessionName = title;
        const waitingValue = stateOptionValue("s1", "waiting-user", title ?? null);
        const runningValue = stateOptionValue("s1", "running", title ?? null);
        await h.emit("session_start");
        await waitFor("initial publication", () => h.server.paneOptionOf("%0") === waitingValue);
        await finishEventLoopTurn();
        h.server.responses.state = () => {
          h.server.setPaneOption("%0", runningValue);
          return completedResult("snapshot update failed after publishing running", true);
        };
        await h.emit("agent_start");
        await waitFor("publication failure", () =>
          h.notifications.some((notice) => notice.message.includes("cannot publish")),
        );
        await finishEventLoopTurn();
        assert.equal(h.server.paneOptionOf("%0"), runningValue);
        delete h.server.responses.state;

        await h.emit("agent_settled");
        await waitFor("settled publication", () => h.server.paneOptionOf("%0") === waitingValue);
        await finishEventLoopTurn();
        const requests = stateArguments(h.server.commands);
        assert.deepEqual(
          requests.map((args) => args[3]),
          ["waiting-user", "running", "waiting-user"],
        );
        assert.deepEqual(
          requests.map((args) => JSON.parse(args[args.indexOf("--title") + 1]!)),
          [title ?? null, title ?? null, title ?? null],
        );
        const count = h.server.commands.length;
        await h.emit("agent_settled");
        await h.emit("session_info_changed", { name: title });
        await finishEventLoopTurn();
        assert.equal(h.server.commands.length, count);
      } finally {
        delete h.server.responses.state;
        await h.close();
      }
    });
  }
});

describe("session-state lock retry", () => {
  it("keeps a contended running notification ahead of later waiting and title notifications", async () => {
    const h = await createExtensionHarness();
    let busy = true;
    try {
      await h.emit("session_start");
      await waitFor("initial", () => h.server.paneOptionOf("%0") !== undefined);
      h.server.responses.state = () =>
        busy
          ? {
              status: "completed",
              result: {
                content: [{ type: "text", text: "lock busy" }],
                details: {},
                isError: true,
                structuredContent: { exit_code: 75 },
              },
            }
          : completedResult("");
      await h.emit("agent_start");
      await waitFor(
        "first attempt",
        () => h.server.commands.filter((command) => command.startsWith("pi-mux state")).length >= 2,
      );
      await h.emit("agent_settled");
      await h.emit("session_info_changed", { name: "Later title" });
      await waitFor(
        "background retry",
        () => h.server.commands.filter((command) => command.startsWith("pi-mux state")).length >= 3,
      );
      const pending = h.server.commands.slice(2).map((command) => parse(command) as string[]);
      assert.ok(pending.every((argv) => argv[3] === "running"));
      assert.ok(
        pending.every(
          (argv) =>
            argv[argv.indexOf("--source") + 1] === pending[0]![pending[0]!.indexOf("--source") + 1],
        ),
      );
      busy = false;
      delete h.server.responses.state;
      await waitFor(
        "ordered retry and later states",
        () => h.server.paneOptionOf("%0") === stateOptionValue("s1", "waiting-user", "Later title"),
      );
      const states = h.server.commands
        .filter((command) => command.startsWith("pi-mux state"))
        .map((command) => (parse(command) as string[])[3]);
      assert.deepEqual(states.slice(-3), ["running", "waiting-user", "waiting-user"]);
      assert.deepEqual(h.notifications, []);
    } finally {
      delete h.server.responses.state;
      await h.close();
    }
  });

  it("stops retries at shutdown and does not retry a contended clear", async () => {
    const h = await createExtensionHarness();
    try {
      await h.emit("session_start");
      await waitFor("initial", () => h.server.paneOptionOf("%0") !== undefined);
      h.server.responses.state = () => ({
        status: "completed",
        result: {
          content: [{ type: "text", text: "busy" }],
          details: {},
          structuredContent: { exit_code: 75 },
        },
      });
      await h.emit("agent_start");
      await waitFor("contended running", () => h.server.commands.length >= 3);
      await h.emit("session_shutdown");
      const count = h.server.commands.length;
      assert.equal(h.server.commands.filter((command) => command.includes("--clear")).length, 1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(h.server.commands.length, count);
      assert.ok(h.notifications.some((notice) => notice.message.includes("lock is busy")));
    } finally {
      delete h.server.responses.state;
      await h.close();
    }
  });
});

function busyResult(): ToolExecutionOutcome {
  return {
    status: "completed",
    result: {
      content: [{ type: "text", text: "pi-mux lock is busy" }],
      details: {},
      isError: true,
      structuredContent: { exit_code: 75 },
    },
  };
}

function stateArguments(commands: string[]): string[][] {
  return commands
    .filter((command) => command.startsWith("pi-mux state "))
    .map((command) => parse(command) as string[]);
}

describe("session-state lock retries", () => {
  it("returns from discovery while busy and preserves running before later idle notifications", async () => {
    const h = await createExtensionHarness();
    try {
      h.server.responses.state = () => busyResult();
      await h.emit("session_start");
      await waitFor("initial busy request", () => stateArguments(h.server.commands).length > 0);
      await h.emit("agent_start");
      await h.emit("session_info_changed", { name: "Queued title" });
      await h.emit("agent_settled");
      await waitFor("background retry", () => stateArguments(h.server.commands).length >= 2);
      assert.equal(h.server.paneOptionOf("%0"), undefined);
      delete h.server.responses.state;
      await waitFor(
        "final idle",
        () =>
          h.server.paneOptionOf("%0") === stateOptionValue("s1", "waiting-user", "Queued title"),
      );
      const requests = stateArguments(h.server.commands);
      assert.deepEqual(
        requests.slice(-3).map((args) => [args[3], JSON.parse(args[args.indexOf("--title") + 1]!)]),
        [
          ["running", null],
          ["running", "Queued title"],
          ["waiting-user", "Queued title"],
        ],
      );
      const sources = requests.map((args) => args[args.indexOf("--source") + 1]);
      assert.equal(new Set(sources).size, 1);
      assert.deepEqual(h.notifications, []);
    } finally {
      delete h.server.responses.state;
      await h.close();
    }
  });

  it("does not retry a busy shutdown clear", async () => {
    const h = await createExtensionHarness();
    try {
      await h.emit("session_start");
      await waitFor("initial", () => h.server.paneOptionOf("%0") !== undefined);
      h.server.responses.state = () => busyResult();
      await h.emit("session_shutdown");
      assert.equal(
        stateArguments(h.server.commands).filter((args) => args.includes("--clear")).length,
        1,
      );
      assert.match(h.notifications.at(-1)!.message, /lock is busy/);
    } finally {
      delete h.server.responses.state;
      await h.close();
    }
  });

  it("cancels an old retry without publishing queued running after replacement", async () => {
    const h = await createExtensionHarness();
    try {
      h.server.responses.state = () => busyResult();
      await h.emit("session_start");
      await waitFor("busy", () => stateArguments(h.server.commands).length > 0);
      await h.emit("agent_start");
      h.sessionId = "replacement";
      delete h.server.responses.state;
      await h.emit("session_start");
      await waitFor(
        "replacement",
        () => h.server.paneOptionOf("%0") === stateOptionValue("replacement", "waiting-user"),
      );
      assert.equal(
        stateArguments(h.server.commands).some((args) => args[2] === "s1" && args[3] === "running"),
        false,
      );
      assert.deepEqual(h.notifications, []);
    } finally {
      delete h.server.responses.state;
      await h.close();
    }
  });
});

describe("session-state CLI execution ordering", () => {
  it("discards an unstarted obsolete inspection behind a pending old set", async () => {
    const h = await createExtensionHarness();
    const finish = Promise.withResolvers<void>();
    try {
      await h.emit("session_start");
      await waitFor("initial", () => h.server.paneOptionOf("%0") !== undefined);
      h.server.responses["state"] = async () => {
        await finish.promise;
        h.server.setPaneOption("%0", stateOptionValue("s1", "running"));
        return completedResult("");
      };
      await h.emit("agent_start");
      await waitFor("old set started", () => h.server.hasPending());
      h.server.responses["display-message"] = (command) => {
        const argv = parse(command) as string[];
        if (argv[argv.indexOf("-t") + 1] === "%9")
          throw new Error("obsolete inspection transport failed");
        return completedResult(
          [
            h.server.socketPath,
            String(process.pid),
            "%0",
            readlinkSync("/proc/self/fd/0"),
            String(process.pid),
          ].join("\t"),
        );
      };
      process.env.TMUX_PANE = "%9";
      h.sessionId = "obsolete";
      await h.emit("session_start");
      process.env.TMUX_PANE = "%0";
      h.sessionId = "replacement";
      await h.emit("session_start");
      const count = h.server.commands.length;
      delete h.server.responses["state"];
      finish.resolve();
      await waitFor(
        "replacement or failure",
        () =>
          h.notifications.length > 0 ||
          h.server.paneOptionOf("%0") === stateOptionValue("replacement", "waiting-user"),
      );
      assert.equal(
        h.server.commands
          .slice(count)
          .some((command) => (parse(command) as string[]).includes("%9")),
        false,
      );
      assert.equal(h.server.paneOptionOf("%0"), stateOptionValue("replacement", "waiting-user"));
      assert.notEqual(
        Reflect.get(process, Symbol.for("pi.session-state.publication-stopped")),
        true,
      );
      assert.deepEqual(h.notifications, []);
    } finally {
      process.env.TMUX_PANE = "%0";
      finish.resolve();
      delete h.server.responses["display-message"];
      delete h.server.responses["state"];
      await h.close();
    }
  });
  for (const operation of ["set", "unset"] as const) {
    it(`waits for the old ${operation} side effect before publishing a replacement`, async () => {
      const h = await createExtensionHarness();
      const finish = Promise.withResolvers<void>();
      let shutdown: Promise<void> | undefined;
      try {
        await h.emit("session_start");
        await waitFor("initial", () => h.server.paneOptionOf("%0") !== undefined);
        h.server.responses["state"] = async () => {
          await finish.promise;
          h.server.setPaneOption(
            "%0",
            operation === "unset" ? undefined : stateOptionValue("s1", "running"),
          );
          return completedResult("");
        };
        if (operation === "set") await h.emit("agent_start");
        else shutdown = h.emit("session_shutdown");
        await waitFor("old command started", () => h.server.hasPending());
        const count = h.server.commands.length;
        h.sessionId = "replacement";
        await h.emit("session_start");
        await finishEventLoopTurn();
        assert.equal(h.server.commands.length, count, "no new CLI before old execution ends");
        assert.equal(h.server.paneOptionOf("%0"), stateOptionValue("s1", "waiting-user"));
        delete h.server.responses["state"];
        finish.resolve();
        await shutdown;
        await waitFor(
          "replacement",
          () => h.server.paneOptionOf("%0") === stateOptionValue("replacement", "waiting-user"),
        );
        await finishEventLoopTurn();
        assert.equal(h.server.paneOptionOf("%0"), stateOptionValue("replacement", "waiting-user"));
        assert.deepEqual(h.notifications, []);
      } finally {
        finish.resolve();
        await shutdown;
        await h.close();
      }
    });
  }

  it("waits for a running CLI across run abort and then publishes settled", async () => {
    const h = await createExtensionHarness();
    const finish = Promise.withResolvers<void>();
    try {
      await h.emit("session_start");
      await waitFor("initial", () => h.server.paneOptionOf("%0") !== undefined);
      h.server.responses["state"] = async () => {
        await finish.promise;
        h.server.setPaneOption("%0", stateOptionValue("s1", "running"));
        return completedResult("");
      };
      await h.emit("agent_start");
      await waitFor("running CLI", () => h.server.hasPending());
      const count = h.server.commands.length;
      h.abortRun();
      await h.emit("agent_settled", { aborted: true });
      await finishEventLoopTurn();
      assert.equal(h.server.commands.length, count);
      delete h.server.responses["state"];
      finish.resolve();
      await waitFor(
        "settled after old CLI",
        () =>
          h.server.commands.length === count + 1 &&
          h.server.paneOptionOf("%0") === stateOptionValue("s1", "waiting-user"),
      );
      assert.equal(h.server.commands.length, count + 1);
      assert.deepEqual(h.notifications, []);
    } finally {
      finish.resolve();
      await h.close();
    }
  });

  for (const failure of ["timeout", "receiver-stop", "throw"] as const) {
    it(`stops all later CLI after uncertain ${failure}, including a new runtime`, async () => {
      const h = await createExtensionHarness();
      const finish = Promise.withResolvers<void>();
      try {
        await h.emit("session_start");
        await waitFor("initial", () => h.server.paneOptionOf("%0") !== undefined);
        h.server.responses["state"] = async () => {
          if (failure === "throw") throw new Error("transport failed");
          await finish.promise;
          h.server.setPaneOption("%0", stateOptionValue("s1", "running"));
          return completedResult("");
        };
        await h.emit("agent_start");
        if (failure === "receiver-stop") {
          await waitFor("pending CLI", () => h.server.hasPending());
          h.disposeBashReceiver();
        }
        await waitFor("stopped notification", () =>
          h.notifications.some((n) => /publication stopped/.test(n.message)),
        );
        const count = h.server.commands.length;
        delete h.server.responses["state"];
        h.restoreBashReceiver();
        h.sessionId = "replacement";
        await h.emit("session_start");
        await h.emit("agent_start");
        await finishEventLoopTurn();
        assert.equal(h.server.commands.length, count);
        h.restartRuntime();
        await h.emit("session_start", { reason: "reload" });
        await h.emit("ui_prompt_start");
        await h.emit("input");
        await h.emit("session_shutdown");
        assert.equal(existsSync(h.restorePath), false, "input does not create a restore record");
        assert.deepEqual([...h.commands.keys()], []);
        assert.equal(h.server.commands.length, count, "new factories and cleanup remain stopped");
        assert.equal(
          h.notifications.filter((n) => /publication stopped/.test(n.message)).length,
          1,
        );
        finish.resolve();
        await waitFor("late execution finished", () => !h.server.hasPending());
        assert.equal(h.server.commands.length, count);
      } finally {
        finish.resolve();
        await h.close();
      }
    });
  }
});

describe("session-state without restore-record access", () => {
  for (const initialRecord of ["absent", "valid", "invalid"] as const) {
    it(
      "publishes and cleans up without changing the " + initialRecord + " restore record",
      async () => {
        const restoreReads = spyOn(fsPromises, "readFile");
        try {
          const h = await createExtensionHarness();
          try {
            const bytes =
              initialRecord === "invalid"
                ? "{broken"
                : JSON.stringify({
                    version: 1,
                    generation: "saved-generation",
                    workspaces: [
                      {
                        cwd: join(h.agentDir, "workspace: child"),
                        sessions: ["other"],
                      },
                    ],
                  });
            if (initialRecord !== "absent") writeFileSync(h.restorePath, bytes);
            const before =
              initialRecord === "absent" ? undefined : statSync(h.restorePath, { bigint: true });
            assert.deepEqual([...h.commands.keys()], []);
            for (const [event, state] of [
              ["session_start", "waiting-user"],
              ["input", "waiting-user"],
              ["agent_start", "running"],
              ["input", "running"],
              ["ui_prompt_start", "waiting-approval"],
              ["input", "waiting-approval"],
              ["ui_prompt_end", "running"],
              ["message_update", "running"],
              ["agent_settled", "waiting-user"],
              ["input", "waiting-user"],
              ["session_shutdown", undefined],
            ] as const) {
              await h.emit(event);
              await waitFor(
                event,
                () =>
                  h.server.paneOptionOf("%0") ===
                  (state === undefined ? undefined : stateOptionValue("s1", state)),
              );
              if (before) {
                assert.equal(readFileSync(h.restorePath, "utf8"), bytes, event);
                const after = statSync(h.restorePath, { bigint: true });
                assert.deepEqual([after.ino, after.mtimeNs], [before.ino, before.mtimeNs], event);
              } else {
                assert.equal(existsSync(h.restorePath), false, event);
              }
              const restoreRecordReads = restoreReads.mock.calls.filter(
                ([path]) => path === h.restorePath,
              );
              assert.deepEqual(restoreRecordReads, [], event);
              assert.deepEqual([...h.commands.keys()], [], event);
              assert.deepEqual(h.notifications, [], event);
            }
            assert.equal(
              h.server.commands.filter((command) => command.includes("display-message")).length,
              1,
            );
            assert.equal(
              h.server.commands.filter((command) => command.startsWith("pi-mux state ")).length,
              6,
            );
            if (initialRecord === "absent") {
              await assert.rejects(readFile(h.restorePath, "utf8"), { code: "ENOENT" });
            } else {
              assert.equal(await readFile(h.restorePath, "utf8"), bytes);
            }
            const controlReads = restoreReads.mock.calls.filter(([path]) => path === h.restorePath);
            assert.equal(controlReads.length, 1);
          } finally {
            await h.close();
          }
        } finally {
          restoreReads.mockRestore();
        }
      },
    );
  }
});
