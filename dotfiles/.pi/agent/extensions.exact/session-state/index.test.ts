import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { readlinkSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { parse } from "shell-quote";
import { describe, it } from "bun:test";
import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionCommandContext,
  type ExtensionEvent,
} from "@earendil-works/pi-coding-agent";
import { childInvocationArgs, subagentSessionDir } from "../agents/index.ts";
import {
  registerBackgroundBash,
  type BackgroundBashOutcome as ToolExecutionOutcome,
} from "../tools/background-bash.ts";
import sessionStateExtension, {
  parseStore,
  unarchiveSession,
  archiveSession,
  serializeStore,
  type SessionStateStore as ActiveSessionsStore,
  type SessionStateStore,
} from "./index.ts";
import { phaseOptionValue } from "./tmux.ts";

type EventHandler = (event: ExtensionEvent, ctx: ExtensionContext) => unknown;
type KeywordResponse = (command: string) => ToolExecutionOutcome | Promise<ToolExecutionOutcome>;

const WAIT_TIMEOUT_MS = 3_000;

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
      const keyword = argv[3]!;
      const custom = this.responses[keyword]?.(command);
      if (custom) return await custom;
      if (keyword === "display-message") return completedResult(this.verifiedFieldsLine());
      if (keyword === "show-options") {
        const paneId = argv[argv.indexOf("-t") + 1]!;
        const value = this.paneOptions.get(paneId);
        return completedResult(value ?? "");
      }
      if (keyword === "set-option") {
        const paneId = argv[argv.indexOf("-t") + 1]!;
        if (argv.includes("-u")) this.paneOptions.delete(paneId);
        else this.paneOptions.set(paneId, argv.at(-1)!);
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
      "4242",
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
  storePath: string;
  commands: Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>;
  command(name: string): Promise<void>;
  server: FakeTmuxServer;
  notifications: { message: string; level: string | undefined }[];
  sessionId: string;
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
    process.env.TMUX = `/other/socket,4242`;
    process.env.TMUX_PANE = "%0";
  } else {
    process.env.TMUX = `${socketPath},4242`;
    process.env.TMUX_PANE = "%0";
  }
  const previousAgentName = process.env.PI_AGENT_NAME;
  process.env.PI_AGENT_NAME = agent;

  const workspacePath = join(agentDir, "workspace: child");
  const harnessSessionId = { value: "s1" };
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
  const context = {
    signal: runController.signal,
    hasUI: true,
    sessionManager: {
      getCwd: () => workspacePath,
      getSessionId: () => harnessSessionId.value,
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
    return registerBackgroundBash(events, async (request) => {
      const params = request.params as { command: string; timeout?: number };
      const outcome = await server.run(params.command);
      if (outcome.status === "completed") return outcome.result;
      if (outcome.status === "failed" || outcome.status === "unavailable") throw outcome.error;
      throw outcome.reason;
    });
  }
  let disposeBashReceiver = connectBashReceiver();

  const harness: ExtensionHarness = {
    agentDir,
    storePath: join(agentDir, "session-state.json"),
    commands,
    async command(name) {
      const command = commands.get(name);
      assert.ok(command);
      await command.handler("", context as ExtensionCommandContext);
    },
    server,
    notifications,
    get sessionId() {
      return harnessSessionId.value;
    },
    set sessionId(value: string) {
      harnessSessionId.value = value;
    },
    async emit(type, fields = {}) {
      const event = { type, ...fields } as ExtensionEvent;
      for (const handler of handlers.get(type) ?? []) {
        const result = await handler(event, context);
        assert.equal(result, undefined);
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
  "session_shutdown",
] as const;

describe("sessionStateExtension in child sessions", () => {
  for (const mode of ["new", "resume", "fork", "vision"] as const) {
    it(`leaves an absent store absent during the ${mode} child lifecycle`, async () => {
      const h = await createExtensionHarness({
        mode,
        agent: mode === "vision" ? "vision" : "main",
      });
      try {
        for (const event of lifecycleEvents) await h.emit(event);
        assert.equal(existsSync(h.storePath), false);
        assert.deepEqual([...h.commands.keys()], []);
        assert.deepEqual(h.server.commands, []);
      } finally {
        await h.close();
      }
    });
  }
  for (const mode of ["new", "resume", "fork", "vision"] as const) {
    const agent = mode === "vision" ? "vision" : "main";

    it(`does not update membership or publish during the ${mode} child lifecycle`, async () => {
      const harness = await createExtensionHarness({ agent, mode });
      try {
        const legacy = JSON.stringify({
          "active-workspaces": {
            [join(harness.agentDir, "workspace: child")]: {
              "active-sessions": { s1: { lock: true, state: "running", custom: "keep" } },
              pinned: true,
            },
          },
          custom: ["keep"],
        });
        writeFileSync(harness.storePath, legacy);
        const before = statSync(harness.storePath, { bigint: true });

        for (const event of lifecycleEvents) {
          await harness.emit(event);
          await finishEventLoopTurn();
          assert.equal(harness.server.commands.length, 0, `event: ${event}`);
          assert.equal(readFileSync(harness.storePath, "utf8"), legacy, `event: ${event}`);
          const after = statSync(harness.storePath, { bigint: true });
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
  for (const agent of ["main", "senior", "junior", "vision", "chat"]) {
    it(`publishes the phase sequence for a top-level ${agent} session with a parent header`, async () => {
      const harness = await createExtensionHarness({ agent, customDir: agent === "vision" });
      try {
        const phases = [
          ["session_start", "waiting-user"],
          ["agent_start", "running"],
          ["ui_prompt_start", "waiting-approval"],
          ["ui_prompt_end", "running"],
          ["agent_settled", "waiting-user"],
          ["input", "waiting-user"],
          ["agent_end", "waiting-user"],
        ] as const;
        for (const [event, expectedPhase] of phases) {
          await harness.emit(event);
          await waitFor(`phase ${expectedPhase} on ${event}`, () => {
            const value = harness.server.paneOptionOf("%0");
            return (
              value !== undefined && value === phaseOptionValue(harness.sessionId, expectedPhase)
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
        () => harness.server.paneOptionOf("%0") === phaseOptionValue("s1", "running"),
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

  it("publishes nothing outside the managed pane and still updates membership on input", async () => {
    const harness = await createExtensionHarness({ dedicated: false });
    try {
      await harness.emit("session_start");
      await harness.emit("agent_start");
      await finishEventLoopTurn();
      assert.deepEqual(harness.server.commands, []);

      await harness.emit("input");
      await waitFor("membership store", () => existsSync(harness.storePath));
      const store = JSON.parse(readFileSync(harness.storePath, "utf8")) as ActiveSessionsStore;
      assert.deepEqual(
        store["active-workspaces"][join(harness.agentDir, "workspace: child")]!["active-sessions"],
        { s1: { lock: false } },
      );
      assert.deepEqual(harness.notifications, []);
    } finally {
      await harness.close();
    }
  });

  it("notifies a detection failure once and stops publishing phases", async () => {
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
        harness.server.commands.filter((command) => command.includes("set-option")).length,
        0,
      );
      assert.deepEqual(
        harness.notifications.filter((notification) => /session phase/.test(notification.message)),
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

describe("session-state MVP phase boundaries", () => {
  it("publishes only phase changes and never reads pane options", async () => {
    const h = await createExtensionHarness();
    try {
      for (const [event, phase] of [
        ["session_start", "waiting-user"],
        ["agent_start", "running"],
        ["ui_prompt_start", "waiting-approval"],
        ["ui_prompt_end", "running"],
        ["agent_settled", "waiting-user"],
      ] as const) {
        await h.emit(event);
        await waitFor(event, () => h.server.paneOptionOf("%0") === phaseOptionValue("s1", phase));
        const count = h.server.commands.length;
        await h.emit(event === "session_start" ? "ui_prompt_end" : event);
        await finishEventLoopTurn();
        assert.equal(h.server.commands.length, count, event);
      }
      assert.equal(h.server.commands.filter((c) => c.includes("display-message")).length, 1);
      assert.equal(h.server.commands.filter((c) => c.includes("set-option")).length, 5);
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
        () => h.server.paneOptionOf("%0") === phaseOptionValue("s1", "waiting-approval"),
      );
      await h.emit("ui_prompt_end");
      await waitFor(
        "idle",
        () => h.server.paneOptionOf("%0") === phaseOptionValue("s1", "waiting-user"),
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
        () => h.server.paneOptionOf("%0") === phaseOptionValue("s1", "waiting-approval"),
      );
      const count = h.server.commands.length;
      for (const event of [...progressEvents, "agent_start", "agent_settled"]) await h.emit(event);
      await finishEventLoopTurn();
      assert.equal(h.server.commands.length, count);
      await h.emit("ui_prompt_end");
      await waitFor(
        "idle",
        () => h.server.paneOptionOf("%0") === phaseOptionValue("s1", "waiting-user"),
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
        () => h.server.paneOptionOf("%0") === phaseOptionValue("s1", "running"),
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
        () => h.server.paneOptionOf("%0") === phaseOptionValue("s1", "waiting-user"),
      );
    } finally {
      await h.close();
    }
  });

  for (const reason of ["startup", "reload", "new", "resume", "fork"]) {
    it(`publishes an equal initial phase for a new ${reason} generation`, async () => {
      const h = await createExtensionHarness();
      try {
        await h.emit("session_start");
        await waitFor("initial", () => h.server.paneOptionOf("%0") !== undefined);
        const count = h.server.commands.length;
        await h.emit("session_start", { reason });
        await waitFor("new generation set", () => h.server.commands.length === count + 2);
        assert.equal(h.server.paneOptionOf("%0"), phaseOptionValue("s1", "waiting-user"));
      } finally {
        await h.close();
      }
    });
  }

  it("preserves the latest phase after a delayed set response", async () => {
    const h = await createExtensionHarness();
    const pending = Promise.withResolvers<ToolExecutionOutcome>();
    try {
      await h.emit("session_start");
      await waitFor("initial", () => h.server.paneOptionOf("%0") !== undefined);
      h.server.responses["set-option"] = () => {
        h.server.setPaneOption("%0", phaseOptionValue("s1", "running"));
        return pending.promise;
      };
      await h.emit("agent_start");
      await waitFor("set started", () => h.server.hasPending());
      await h.emit("ui_prompt_start");
      delete h.server.responses["set-option"];
      pending.resolve(completedResult(""));
      await waitFor(
        "latest",
        () => h.server.paneOptionOf("%0") === phaseOptionValue("s1", "waiting-approval"),
      );
      await finishEventLoopTurn();
      assert.equal(h.server.paneOptionOf("%0"), phaseOptionValue("s1", "waiting-approval"));
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
        () => h.server.paneOptionOf("%0") === phaseOptionValue("replacement", "waiting-user"),
      );
      await waitFor("old drained", () => !h.server.hasPending());
      assert.deepEqual(h.notifications, []);
      assert.equal(
        h.server.commands.some((c) => c.includes(phaseOptionValue("s1", "waiting-user"))),
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
      h.server.responses["set-option"] = () => {
        h.server.setPaneOption("%0", phaseOptionValue("s1", "running"));
        return pending.promise;
      };
      await h.emit("agent_start");
      await waitFor("old set", () => h.server.hasPending());
      delete h.server.responses["set-option"];
      h.sessionId = "replacement";
      await h.emit("session_start");
      await finishEventLoopTurn();
      assert.equal(h.server.paneOptionOf("%0"), phaseOptionValue("s1", "running"));
      pending.resolve(completedResult(""));
      await waitFor(
        "replacement",
        () => h.server.paneOptionOf("%0") === phaseOptionValue("replacement", "waiting-user"),
      );
      await waitFor("late response", () => !h.server.hasPending());
      assert.equal(h.server.paneOptionOf("%0"), phaseOptionValue("replacement", "waiting-user"));
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
      h.server.responses["set-option"] = () => pending.promise;
      await h.emit("agent_start");
      await waitFor("pending", () => h.server.hasPending());
      delete h.server.responses["set-option"];
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

  it("reports a failed publication without retrying on progress", async () => {
    const h = await createExtensionHarness();
    try {
      await h.emit("session_start");
      await waitFor("initial", () => h.server.paneOptionOf("%0") !== undefined);
      h.server.responses["set-option"] = () => completedResult("failure", true);
      await h.emit("agent_start");
      await waitFor("warning", () =>
        h.notifications.some((n) => n.message.includes("cannot publish")),
      );
      const count = h.server.commands.length;
      await h.emit("message_update");
      await h.emit("agent_start");
      await finishEventLoopTurn();
      assert.equal(h.server.commands.length, count);
      delete h.server.responses["set-option"];
      await h.emit("ui_prompt_start");
      await waitFor(
        "next transition",
        () => h.server.paneOptionOf("%0") === phaseOptionValue("s1", "waiting-approval"),
      );
    } finally {
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
      h.server.responses["set-option"] = async () => {
        await finish.promise;
        h.server.setPaneOption("%0", phaseOptionValue("s1", "running"));
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
            "4242",
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
      delete h.server.responses["set-option"];
      finish.resolve();
      await waitFor(
        "replacement or failure",
        () =>
          h.notifications.length > 0 ||
          h.server.paneOptionOf("%0") === phaseOptionValue("replacement", "waiting-user"),
      );
      assert.equal(
        h.server.commands
          .slice(count)
          .some((command) => (parse(command) as string[]).includes("%9")),
        false,
      );
      assert.equal(h.server.paneOptionOf("%0"), phaseOptionValue("replacement", "waiting-user"));
      assert.notEqual(
        Reflect.get(process, Symbol.for("pi.session-state.publication-stopped")),
        true,
      );
      assert.deepEqual(h.notifications, []);
    } finally {
      process.env.TMUX_PANE = "%0";
      finish.resolve();
      delete h.server.responses["display-message"];
      delete h.server.responses["set-option"];
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
        h.server.responses["set-option"] = async () => {
          await finish.promise;
          h.server.setPaneOption(
            "%0",
            operation === "unset" ? undefined : phaseOptionValue("s1", "running"),
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
        assert.equal(h.server.paneOptionOf("%0"), phaseOptionValue("s1", "waiting-user"));
        delete h.server.responses["set-option"];
        finish.resolve();
        await shutdown;
        await waitFor(
          "replacement",
          () => h.server.paneOptionOf("%0") === phaseOptionValue("replacement", "waiting-user"),
        );
        await finishEventLoopTurn();
        assert.equal(h.server.paneOptionOf("%0"), phaseOptionValue("replacement", "waiting-user"));
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
      h.server.responses["set-option"] = async () => {
        await finish.promise;
        h.server.setPaneOption("%0", phaseOptionValue("s1", "running"));
        return completedResult("");
      };
      await h.emit("agent_start");
      await waitFor("running CLI", () => h.server.hasPending());
      const count = h.server.commands.length;
      h.abortRun();
      await h.emit("agent_settled", { aborted: true });
      await finishEventLoopTurn();
      assert.equal(h.server.commands.length, count);
      delete h.server.responses["set-option"];
      finish.resolve();
      await waitFor(
        "settled after old CLI",
        () =>
          h.server.commands.length === count + 1 &&
          h.server.paneOptionOf("%0") === phaseOptionValue("s1", "waiting-user"),
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
        h.server.responses["set-option"] = async () => {
          if (failure === "throw") throw new Error("transport failed");
          await finish.promise;
          h.server.setPaneOption("%0", phaseOptionValue("s1", "running"));
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
        delete h.server.responses["set-option"];
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
        await h.command("unarchive");
        await h.emit("session_shutdown");
        assert.equal(existsSync(h.storePath), true, "input continues while publication is stopped");
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

describe("session-state membership compatibility", () => {
  it("keeps an absent membership store absent through phase events and shutdown", async () => {
    const h = await createExtensionHarness();
    try {
      for (const event of lifecycleEvents.filter((event) => event !== "input")) await h.emit(event);
      assert.equal(existsSync(h.storePath), false);
    } finally {
      await h.close();
    }
  });
  it("preserves bytes, inode, old state, and unknown fields for phase-only events", async () => {
    const h = await createExtensionHarness();
    try {
      const bytes = JSON.stringify({
        "active-workspaces": {
          [join(h.agentDir, "workspace: child")]: {
            "active-sessions": { s1: { lock: true, state: "running", unknown: [1] } },
            pinned: true,
          },
          other: { "active-sessions": { child: { state: "waiting-user" } } },
        },
        unknown: { state: "keep" },
      });
      writeFileSync(h.storePath, bytes);
      const before = statSync(h.storePath, { bigint: true });
      for (const [event, phase] of [
        ["session_start", "waiting-user"],
        ["agent_start", "running"],
        ["ui_prompt_start", "waiting-approval"],
        ["ui_prompt_end", "running"],
        ["agent_settled", "waiting-user"],
      ] as const) {
        await h.emit(event);
        await waitFor(event, () => h.server.paneOptionOf("%0") === phaseOptionValue("s1", phase));
        assert.equal(readFileSync(h.storePath, "utf8"), bytes);
      }
      await h.emit("session_shutdown");
      const after = statSync(h.storePath, { bigint: true });
      assert.deepEqual([after.ino, after.mtimeNs], [before.ino, before.mtimeNs]);
      assert.equal(readFileSync(h.storePath, "utf8"), bytes);
      assert.equal(existsSync(join(h.agentDir, "active-sessions.json")), false);
      assert.equal(existsSync(join(h.agentDir, "active-sessions.json.lock")), false);
    } finally {
      await h.close();
    }
  });

  it("retains an existing entry byte-for-byte on input", async () => {
    const h = await createExtensionHarness();
    try {
      const bytes = JSON.stringify({
        "active-workspaces": {
          [join(h.agentDir, "workspace: child")]: {
            "active-sessions": { s1: { lock: true, state: "old", custom: true } },
          },
        },
      });
      writeFileSync(h.storePath, bytes);
      const before = statSync(h.storePath, { bigint: true });
      await h.emit("session_start");
      await h.emit("input");
      await h.emit("session_shutdown");
      assert.equal(readFileSync(h.storePath, "utf8"), bytes);
      const after = statSync(h.storePath, { bigint: true });
      assert.deepEqual([after.ino, after.mtimeNs], [before.ino, before.mtimeNs]);
    } finally {
      await h.close();
    }
  });

  it("keeps command ordering, lock protection, notifications, and automatic unarchive", async () => {
    const h = await createExtensionHarness();
    try {
      await h.emit("session_start");
      assert.deepEqual([...h.commands.keys()].sort(), ["archive", "unarchive"]);
      await h.command("unarchive");
      const store = JSON.parse(readFileSync(h.storePath, "utf8"));
      const sessions =
        store["active-workspaces"][join(h.agentDir, "workspace: child")]["active-sessions"];
      sessions.s1 = { lock: true, state: "keep", unknown: true };
      sessions.other = { lock: false, state: "running" };
      writeFileSync(h.storePath, JSON.stringify(store));
      await h.command("archive");
      assert.match(h.notifications.at(-1)!.message, /locked/);
      assert.deepEqual(JSON.parse(readFileSync(h.storePath, "utf8")), store);
      sessions.s1.lock = false;
      writeFileSync(h.storePath, JSON.stringify(store));
      await h.command("archive");
      const archivedBytes = readFileSync(h.storePath, "utf8");
      await h.command("archive");
      assert.equal(readFileSync(h.storePath, "utf8"), archivedBytes);
      assert.match(h.notifications.at(-1)!.message, /already archived/);
      await h.emit("input");
      await h.command("unarchive");
      const active = JSON.parse(readFileSync(h.storePath, "utf8"));
      assert.deepEqual(
        active["active-workspaces"][join(h.agentDir, "workspace: child")]["active-sessions"],
        { other: sessions.other, s1: { lock: false } },
      );
      assert.match(h.notifications.at(-1)!.message, /already active/);
    } finally {
      await h.close();
    }
  });

  it("does not overwrite invalid JSON and recovers on a later input", async () => {
    const h = await createExtensionHarness();
    try {
      writeFileSync(h.storePath, "{broken");
      await h.emit("session_start");
      await h.emit("input");
      await h.command("unarchive");
      assert.equal(readFileSync(h.storePath, "utf8"), "{broken");
      assert.match(h.notifications.at(-1)!.message, /not a valid session-state store/);
      writeFileSync(h.storePath, '{"active-workspaces":{}}');
      await h.emit("input");
      await h.command("unarchive");
      assert.deepEqual(
        JSON.parse(readFileSync(h.storePath, "utf8"))["active-workspaces"][
          join(h.agentDir, "workspace: child")
        ]["active-sessions"],
        { s1: { lock: false } },
      );
    } finally {
      await h.close();
    }
  });
});
describe("parseStore", () => {
  it("reads a document with active-workspaces as a valid store", () => {
    const raw = JSON.stringify({
      "active-workspaces": {
        "/tmp": {
          "active-sessions": { s1: { lock: false, state: "running" } },
          pinned: true,
        },
      },
    });
    const parsed = parseStore(raw);
    assert.ok(parsed.valid);
    assert.deepEqual(parsed.store, {
      "active-workspaces": {
        "/tmp": {
          "active-sessions": { s1: { lock: false, state: "running" } },
          pinned: true,
        },
      },
    });
  });

  it("preserves unknown root and workspace fields when parsing", () => {
    const raw = JSON.stringify({
      "active-workspaces": { "/tmp": { "active-sessions": { s1: { lock: false } }, pinned: true } },
      tags: ["a"],
    });
    const parsed = parseStore(raw);
    assert.ok(parsed.valid);
    assert.deepEqual(parsed.store, {
      "active-workspaces": { "/tmp": { "active-sessions": { s1: { lock: false } }, pinned: true } },
      tags: ["a"],
    });
  });

  it("preserves a registered workspace with no active sessions", () => {
    const store = {
      "active-workspaces": { "/w": { "active-sessions": {} } },
    };
    const parsed = parseStore(JSON.stringify(store));
    assert.ok(parsed.valid);
    assert.deepEqual(parsed.store, store);
  });

  it("rejects the legacy workspaces root without active-workspaces", () => {
    const raw = JSON.stringify({
      workspaces: { "/w": { "active-sessions": { s1: { lock: false } } } },
    });
    assert.deepEqual(parseStore(raw), { valid: false });
  });

  it("rejects an empty legacy workspaces root without active-workspaces", () => {
    assert.deepEqual(parseStore('{"workspaces":{}}'), { valid: false });
  });

  it("rejects legacy workspaces alongside active-workspaces", () => {
    const raw = JSON.stringify({
      "active-workspaces": { "/new": { "active-sessions": {} } },
      workspaces: { "/old": { "active-sessions": { s1: { lock: false } } } },
    });
    assert.deepEqual(parseStore(raw), { valid: false });
  });

  it("rejects an empty legacy workspaces root alongside active-workspaces", () => {
    const raw = JSON.stringify({
      "active-workspaces": { "/w": { "active-sessions": {} } },
      workspaces: {},
    });
    assert.deepEqual(parseStore(raw), { valid: false });
  });

  it("preserves non-object root values named workspaces as unknown attributes", () => {
    for (const workspaces of [null, false, 3, "metadata", []]) {
      const store = { "active-workspaces": {}, workspaces };
      assert.deepEqual(
        parseStore(JSON.stringify(store)),
        { valid: true, store },
        `workspaces: ${JSON.stringify(workspaces)}`,
      );
    }
  });

  it("rejects invalid JSON", () => {
    assert.equal(parseStore("{oops").valid, false);
    assert.equal(parseStore("").valid, false);
  });

  it("rejects a non-object root", () => {
    assert.equal(parseStore("[]").valid, false);
    assert.equal(parseStore("42").valid, false);
    assert.equal(parseStore("null").valid, false);
    assert.equal(parseStore('"text"').valid, false);
  });

  it("rejects a non-object active-workspaces root", () => {
    assert.equal(parseStore('{"active-workspaces":[]}').valid, false);
    assert.equal(parseStore('{"active-workspaces":"x"}').valid, false);
    assert.equal(parseStore('{"active-workspaces":3}').valid, false);
  });

  it("rejects a missing active-workspaces root", () => {
    assert.equal(parseStore("{}").valid, false);
  });

  it("rejects the legacy active-sessions array format", () => {
    assert.equal(
      parseStore('{"active-workspaces":{"/w":{"active-sessions":["s1"]}}}').valid,
      false,
    );
    assert.equal(
      parseStore('{"active-workspaces":{"/w":{"active-sessions":[]},"/x":{}}}').valid,
      false,
    );
  });
});

describe("unarchiveSession", () => {
  it("creates its workspace entry when the store is absent", () => {
    assert.deepEqual(unarchiveSession(undefined, "/w", "s1"), {
      status: "written",
      store: {
        "active-workspaces": { "/w": { "active-sessions": { s1: { lock: false } } } },
      },
    });
  });

  it("creates its absent workspace and preserves other workspaces", () => {
    const store: SessionStateStore = {
      "active-workspaces": { "/other": { "active-sessions": { s2: { lock: false } } } },
    };
    assert.deepEqual(unarchiveSession(store, "/w", "s1"), {
      status: "written",
      store: {
        "active-workspaces": {
          "/other": { "active-sessions": { s2: { lock: false } } },
          "/w": { "active-sessions": { s1: { lock: false } } },
        },
      },
    });
  });

  it("recreates its workspace on unarchive after the workspace is unregistered", () => {
    const registeredStore: SessionStateStore = {
      "active-workspaces": {
        "/w": { "active-sessions": { s1: { lock: false } } },
        "/other": { "active-sessions": {} },
      },
    };
    const unregisteredStore = structuredClone(registeredStore);
    delete unregisteredStore["active-workspaces"]["/w"];

    assert.deepEqual(unarchiveSession(unregisteredStore, "/w", "s1"), {
      status: "written",
      store: registeredStore,
    });
  });

  it("skips an already listed session", () => {
    const store: SessionStateStore = {
      "active-workspaces": {
        "/w": { "active-sessions": { s1: { lock: true, state: "running" } } },
      },
    };
    assert.deepEqual(unarchiveSession(store, "/w", "s1"), { status: "skipped" });
  });

  it("adds its entry and preserves other sessions and unknown workspace fields", () => {
    const store: SessionStateStore = {
      "active-workspaces": {
        "/w": { "active-sessions": { s2: { lock: true } }, pinned: true },
      },
    };
    assert.deepEqual(unarchiveSession(store, "/w", "s1"), {
      status: "written",
      store: {
        "active-workspaces": {
          "/w": {
            "active-sessions": { s2: { lock: true }, s1: { lock: false } },
            pinned: true,
          },
        },
      },
    });
  });

  it("creates active-sessions in a workspace without it", () => {
    const store: SessionStateStore = {
      "active-workspaces": { "/w": { pinned: true } },
    };
    assert.deepEqual(unarchiveSession(store, "/w", "s1"), {
      status: "written",
      store: {
        "active-workspaces": { "/w": { pinned: true, "active-sessions": { s1: { lock: false } } } },
      },
    });
  });

  it("replaces non-object active-sessions with a new map", () => {
    const parsed = parseStore('{"active-workspaces":{"/w":{"active-sessions":"garbage"}}}');
    assert.ok(parsed.valid);
    assert.deepEqual(unarchiveSession(parsed.store, "/w", "s1"), {
      status: "written",
      store: {
        "active-workspaces": { "/w": { "active-sessions": { s1: { lock: false } } } },
      },
    });
  });

  it("replaces its non-object workspace entry", () => {
    const parsed = parseStore('{"active-workspaces":{"/w":"garbage"}}');
    assert.ok(parsed.valid);
    assert.deepEqual(unarchiveSession(parsed.store, "/w", "s1"), {
      status: "written",
      store: {
        "active-workspaces": { "/w": { "active-sessions": { s1: { lock: false } } } },
      },
    });
  });

  it("preserves unknown root keys", () => {
    const store: SessionStateStore = {
      "active-workspaces": {},
      tags: ["a"],
    };
    assert.deepEqual(unarchiveSession(store, "/w", "s1"), {
      status: "written",
      store: {
        "active-workspaces": { "/w": { "active-sessions": { s1: { lock: false } } } },
        tags: ["a"],
      },
    });
  });

  it("does not mutate the input store", () => {
    const store: SessionStateStore = {
      "active-workspaces": {
        "/w": { "active-sessions": { s2: { lock: false }, s3: { lock: true } } },
      },
    };
    const snapshot = structuredClone(store);
    unarchiveSession(store, "/w", "s1");
    assert.deepEqual(store, snapshot);
  });
});

describe("archiveSession", () => {
  it("returns locked for a protected session", () => {
    const store: SessionStateStore = {
      "active-workspaces": { "/w": { "active-sessions": { s1: { lock: true } } } },
    };
    assert.deepEqual(archiveSession(store, "/w", "s1"), { status: "locked" });
  });

  it("skips a session that is not listed", () => {
    const store: SessionStateStore = {
      "active-workspaces": { "/w": { "active-sessions": { s2: { lock: false } } } },
    };
    assert.deepEqual(archiveSession(store, "/w", "s1"), { status: "skipped" });
  });

  it("skips an absent workspace entry", () => {
    const store: SessionStateStore = { "active-workspaces": {} };
    assert.deepEqual(archiveSession(store, "/w", "s1"), { status: "skipped" });
  });

  it("skips an absent store", () => {
    assert.deepEqual(archiveSession(undefined, "/w", "s1"), { status: "skipped" });
  });

  it("skips non-object active-sessions", () => {
    const parsed = parseStore('{"active-workspaces":{"/w":{"active-sessions":"garbage"}}}');
    assert.ok(parsed.valid);
    assert.deepEqual(archiveSession(parsed.store, "/w", "s1"), { status: "skipped" });
  });

  it("removes its entry and preserves other sessions and attributes", () => {
    const store: SessionStateStore = {
      "active-workspaces": {
        "/w": {
          "active-sessions": {
            s1: { lock: false, state: "running" },
            s2: { lock: true },
          },
          pinned: true,
        },
      },
    };
    assert.deepEqual(archiveSession(store, "/w", "s1"), {
      status: "written",
      store: {
        "active-workspaces": {
          "/w": { "active-sessions": { s2: { lock: true } }, pinned: true },
        },
      },
    });
  });

  it("preserves an empty active-sessions map after removal", () => {
    const store: SessionStateStore = {
      "active-workspaces": { "/w": { "active-sessions": { s1: { lock: false } } } },
    };
    assert.deepEqual(archiveSession(store, "/w", "s1"), {
      status: "written",
      store: {
        "active-workspaces": { "/w": { "active-sessions": {} } },
      },
    });
  });

  it("preserves other workspaces and unknown root keys", () => {
    const store: SessionStateStore = {
      "active-workspaces": {
        "/other": { "active-sessions": { s2: { lock: false } } },
        "/w": { "active-sessions": { s1: { lock: false } } },
      },
      tags: ["a"],
    };
    assert.deepEqual(archiveSession(store, "/w", "s1"), {
      status: "written",
      store: {
        "active-workspaces": {
          "/other": { "active-sessions": { s2: { lock: false } } },
          "/w": { "active-sessions": {} },
        },
        tags: ["a"],
      },
    });
  });

  it("does not mutate the input store", () => {
    const store: SessionStateStore = {
      "active-workspaces": {
        "/w": { "active-sessions": { s1: { lock: false }, s2: { lock: true } } },
      },
    };
    const snapshot = structuredClone(store);
    archiveSession(store, "/w", "s1");
    assert.deepEqual(store, snapshot);
  });
});

describe("serializeStore", () => {
  it("writes two-space pretty JSON with a final newline", () => {
    const store: SessionStateStore = {
      "active-workspaces": {
        "/w": { "active-sessions": { s1: { lock: false } } },
      },
    };
    assert.equal(
      serializeStore(store),
      '{\n  "active-workspaces": {\n    "/w": {\n      "active-sessions": {\n        "s1": {\n          "lock": false\n        }\n      }\n    }\n  }\n}\n',
    );
  });
});
