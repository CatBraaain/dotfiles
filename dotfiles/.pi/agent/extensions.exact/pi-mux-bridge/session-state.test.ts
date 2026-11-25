import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import * as timers from "node:timers/promises";
import { setImmediate } from "node:timers/promises";
import { describe, it, spyOn } from "bun:test";
import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionEvent,
} from "@earendil-works/pi-coding-agent";
import { childInvocationArgs, subagentSessionDir } from "../agents/index.ts";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { registerSessionState } from "./session-state.ts";
import { dedicatedSocketPath, stateOptionValue } from "./session-state-tmux.ts";

type EventHandler = (event: ExtensionEvent, ctx: ExtensionContext) => unknown;
type KeywordResponse = (file: string, args: string[]) => ExecResult | Promise<ExecResult>;

interface CommandCall {
  file: string;
  args: string[];
}

function isStateCall(call: CommandCall): boolean {
  return call.file === "pi-mux" && call.args[0] === "state";
}

const WAIT_TIMEOUT_MS = 5_000;

class FakeTmuxServer {
  readonly commands: CommandCall[] = [];
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

  async run(file: string, args: string[]): Promise<ExecResult> {
    this.pendingCount++;
    try {
      this.commands.push({ file, args });
      const keyword = file === "pi-mux" ? "state" : args[2]!;
      const custom = this.responses[keyword]?.(file, args);
      if (custom) return await custom;
      if (keyword === "display-message") return completedResult(this.verifiedFieldsLine());
      if (keyword === "state") {
        const source = JSON.parse(args[args.indexOf("--source") + 1]!);
        if (args.includes("--clear")) this.paneOptions.delete(source.pane);
        else
          this.paneOptions.set(
            source.pane,
            stateOptionValue(
              args[1]!,
              args[2] as "running",
              JSON.parse(args[args.indexOf("--title") + 1]!),
            ),
          );
        return completedResult("");
      }
      return completedResult("", 1, `unexpected tmux keyword: ${keyword}`);
    } finally {
      this.pendingCount--;
    }
  }

  private verifiedFieldsLine(): string {
    const fields = [this.socketPath, String(process.pid), "%0", "", String(process.pid)];
    return fields.join("\t");
  }
}

function completedResult(stdout: string, code = 0, stderr = ""): ExecResult {
  return { stdout, stderr, code, killed: false };
}

function interruptedResult(): ExecResult {
  return { ...completedResult("", 1), killed: true };
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

const LAST_RUN_ENTRY_TYPE = "pi-mux-last-run";

interface CustomEntry {
  type: "custom";
  customType: string;
  data: unknown;
}

interface ExtensionHarness {
  agentDir: string;
  restorePath: string;
  entries: CustomEntry[];
  entryCountsAtStateCalls: number[];
  commands: Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>;
  server: FakeTmuxServer;
  sessionId: string;
  sessionName: string | undefined;
  emit(type: string, fields?: Record<string, unknown>): Promise<void>;
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
    failFirstAppend?: boolean;
    platform?: NodeJS.Platform;
  } = {},
): Promise<ExtensionHarness> {
  await mkdir("/tmp/work/dotfiles", { recursive: true });
  const agentDir = await mkdtemp("/tmp/work/dotfiles/session-state-extension-");
  const runController = new AbortController();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const runtimeDir = await mkdtemp("/tmp/work/dotfiles/session-state-runtime-");
  const socketPath = join(runtimeDir, "pi-tmux", "server.sock");
  const managedSocketPath = options.platform
    ? dedicatedSocketPath({ XDG_RUNTIME_DIR: runtimeDir }, options.platform)
    : socketPath;
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
    PI_TMUX_LAUNCH_TOKEN: process.env.PI_TMUX_LAUNCH_TOKEN,
  };
  const agent = options.agent ?? "main";
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  process.env.PI_TMUX_LAUNCH_TOKEN = randomUUID();
  if (options.dedicated === false) {
    process.env.TMUX = `/other/socket,${process.pid}`;
    process.env.TMUX_PANE = "%0";
  } else {
    process.env.TMUX = `${managedSocketPath},${process.pid}`;
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
  const server = new FakeTmuxServer(managedSocketPath);
  const modelRegistry = {};
  const entries: CustomEntry[] = [];
  const entryCountsAtStateCalls: number[] = [];
  const context = {
    signal: runController.signal,
    modelRegistry,
    sessionManager: {
      getCwd: () => workspacePath,
      getSessionId: () => harnessSessionId.value,
      getSessionName: () => harnessSessionId.name,
      getSessionDir: () => sessionDir,
      getHeader: () => ({ parentSession: "/ordinary/top-level-parent.jsonl" }),
    },
  } as unknown as ExtensionContext;
  const events: ExtensionAPI["events"] = bus;
  let failNextAppend = options.failFirstAppend;
  const pi = {
    on(type: string, handler: EventHandler) {
      const registered = handlers.get(type) ?? [];
      registered.push(handler);
      handlers.set(type, registered);
    },
    events,
    appendEntry(customType: string, data: unknown) {
      if (failNextAppend) {
        failNextAppend = false;
        throw new Error("Session append temporarily failed");
      }
      entries.push({ type: "custom", customType, data });
    },
    registerCommand(name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) {
      commands.set(name, command);
    },
    exec(command: string, args: string[], options: { timeout?: number; signal?: AbortSignal }) {
      assert.deepEqual(options, { timeout: 1_000 });
      if (isStateCall({ file: command, args })) entryCountsAtStateCalls.push(entries.length);
      return server.run(command, args);
    },
  } as unknown as ExtensionAPI;

  registerSessionState(pi);
  const restorePath = join(agentDir, "pi-tmux", "pi-mux-restore.json");
  await mkdir(dirname(restorePath), { recursive: true });
  const harness: ExtensionHarness = {
    agentDir,
    restorePath,
    entries,
    entryCountsAtStateCalls,
    commands,
    server,
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
      const event = {
        type,
        ...(type === "agent_settled" ? { aborted: false } : {}),
        ...fields,
      } as ExtensionEvent;
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
    restartRuntime() {
      handlers.clear();
      commands.clear();
      registerSessionState(pi);
    },
    abortRun() {
      runController.abort(new Error("run aborted"));
    },
    async close() {
      await harness.emit("session_shutdown");
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
        assert.deepEqual(h.entries, []);
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
  it("waits for resources_discover before checking and publishing", async () => {
    const h = await createExtensionHarness({ deferDiscovery: true });
    try {
      await h.emit("session_start");
      await h.emit("ui_prompt_start");
      await h.emit("ui_prompt_end");
      await finishEventLoopTurn();
      assert.equal(h.server.commands.length, 0);
      await h.emit("resources_discover");
      await waitFor(
        "initial state after Tools initialization",
        () => h.server.paneOptionOf("%0") === stateOptionValue(h.sessionId, "waiting-user"),
      );
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

      const displayCount = harness.server.commands.filter(
        (call) => call.file === "tmux" && call.args.includes("display-message"),
      ).length;
      assert.equal(displayCount, 1);
      assert.deepEqual(harness.server.commands[0]!.args.slice(0, 2), [
        "-S",
        harness.server.socketPath,
      ]);
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
    } finally {
      await harness.close();
    }
  });

  it("does not publish states after a detection failure", async () => {
    const harness = await createExtensionHarness();
    try {
      harness.server.responses["display-message"] = () => completedResult("", 1, "no such server");
      await harness.emit("session_start");
      await waitFor("detection attempt", () =>
        harness.server.commands.some(
          (call) => call.file === "tmux" && call.args.includes("display-message"),
        ),
      );

      await harness.emit("agent_start");
      await finishEventLoopTurn();
      assert.equal(
        harness.server.commands.filter(
          (call) => call.file === "tmux" && call.args.includes("display-message"),
        ).length,
        1,
      );
      assert.equal(harness.server.commands.filter((call) => isStateCall(call)).length, 0);
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

  it("coalesces queued title and state before a replacement invalidates old work", async () => {
    const h = await createExtensionHarness();
    const pending = Promise.withResolvers<ExecResult>();
    const oldSet = Promise.withResolvers<ExecResult>();
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
      const values = h.server.commands
        .slice(count)
        .map((call) =>
          JSON.parse(
            stateOptionValue(
              call.args[1]!,
              call.args[2] as "running",
              JSON.parse(call.args[call.args.indexOf("--title") + 1]!),
            ),
          ),
        );
      assert.deepEqual(values, [
        { version: 1, sessionId: "s1", state: "waiting-user", title: "First title" },
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
        h.server.commands.some((call) => call.args.includes("Discarded title")),
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
        if (event !== "agent_settled") {
          await h.emit(event === "session_start" ? "ui_prompt_end" : event);
        }
        await finishEventLoopTurn();
        assert.equal(h.server.commands.length, count, event);
      }
      assert.equal(
        h.server.commands.filter((c) => c.file === "tmux" && c.args.includes("display-message"))
          .length,
        1,
      );
      assert.equal(h.server.commands.filter((c) => isStateCall(c)).length, 5);
      assert.equal(
        h.server.commands.some((c) => c.args.includes("show-options")),
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
      const requestCount = stateArguments(h.server.commands).length;
      for (const event of [...progressEvents, "agent_start"]) await h.emit(event);
      await finishEventLoopTurn();
      assert.equal(h.server.commands.length, count);
      const atMs = Date.now();
      await emitSettledAt(h, atMs);
      await finishEventLoopTurn();
      assert.deepEqual(h.entries, [lastRunEntry(h.sessionId, { atMs, aborted: false })]);
      assert.equal(stateArguments(h.server.commands).length, requestCount);
      await h.emit("ui_prompt_end");
      await waitFor(
        "idle",
        () => h.server.paneOptionOf("%0") === stateOptionValue("s1", "waiting-user"),
      );
      assert.equal(stateArguments(h.server.commands).length, requestCount + 1);
      assert.equal(h.entryCountsAtStateCalls.at(-1), 1);
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
    const pending = Promise.withResolvers<ExecResult>();
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
    } finally {
      pending.resolve(completedResult(""));
      await h.close();
    }
  });

  it("invalidates delayed old inspection on session replacement", async () => {
    const h = await createExtensionHarness();
    const pending = Promise.withResolvers<ExecResult>();
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
      assert.equal(
        h.server.commands.some((call) => isStateCall(call) && call.args[1] === "s1"),
        false,
      );
    } finally {
      pending.resolve(completedResult(""));
      await h.close();
    }
  });

  it("keeps the replacement session after an old set response arrives late", async () => {
    const h = await createExtensionHarness();
    const pending = Promise.withResolvers<ExecResult>();
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
    } finally {
      pending.resolve(completedResult(""));
      await h.close();
    }
  });

  it("invalidates delayed results and unsets the option on shutdown", async () => {
    const h = await createExtensionHarness();
    const pending = Promise.withResolvers<ExecResult>();
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
    } finally {
      pending.resolve(completedResult(""));
      await h.close();
    }
  });

  it("retries an equal failed state automatically and ignores progress events", async () => {
    const h = await createExtensionHarness();
    try {
      await h.emit("session_start");
      await waitFor("initial", () => h.server.paneOptionOf("%0") !== undefined);
      h.server.responses["state"] = () => completedResult("", 1, "failure");
      await h.emit("agent_start");
      await waitFor("equal state retry", () => stateArguments(h.server.commands).length >= 2);
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

describe("session-state latest publication recovery", () => {
  it("coalesces running timeouts and failures into the latest state and title", async () => {
    const h = await createExtensionHarness();
    const finish = Promise.withResolvers<ExecResult>();
    try {
      await h.emit("session_start");
      await waitFor("initial", () => h.server.paneOptionOf("%0") !== undefined);
      const results = [
        interruptedResult(),
        interruptedResult(),
        busyResult(),
        completedResult("", 1, "write failed"),
      ];
      let attempts = 0;
      h.server.responses.state = () => {
        attempts++;
        if (attempts === 1) return finish.promise;
        const result = results.shift();
        if (result) return result;
        h.server.setPaneOption("%0", stateOptionValue("s1", "waiting-user", "Latest title"));
        return completedResult("");
      };
      await h.emit("agent_start");
      await waitFor("running started", () => h.server.hasPending());
      await h.emit("agent_settled");
      await h.emit("session_info_changed", { name: "Superseded title" });
      await h.emit("session_info_changed", { name: "Latest title" });
      await finishEventLoopTurn();
      assert.equal(attempts, 1, "no new execution before the old terminal");
      finish.resolve(interruptedResult());
      await waitFor("retries started", () => attempts >= 3);
      await waitFor(
        "latest recovered",
        () =>
          h.server.paneOptionOf("%0") === stateOptionValue("s1", "waiting-user", "Latest title"),
      );
      const requests = stateArguments(h.server.commands);
      assert.deepEqual(
        requests.map((args) => args[2]),
        ["waiting-user", "running", ...Array(5).fill("waiting-user")],
      );
      assert.ok(
        requests
          .slice(2)
          .every((args) => JSON.parse(args[args.indexOf("--title") + 1]!) === "Latest title"),
      );
      assert.equal(new Set(requests.map((args) => args[args.indexOf("--source") + 1])).size, 1);
      delete h.server.responses.state;
      await h.emit("ui_prompt_end");
      await finishEventLoopTurn();
      assert.equal(stateArguments(h.server.commands).length, requests.length);
    } finally {
      finish.resolve(interruptedResult());
      delete h.server.responses.state;
      await h.close();
    }
  }, 15_000);

  it("recovers a failed latest publication without another event", async () => {
    const h = await createExtensionHarness();
    try {
      await h.emit("session_start");
      await waitFor("initial", () => h.server.paneOptionOf("%0") !== undefined);
      await h.emit("agent_start");
      await waitFor(
        "running",
        () => h.server.paneOptionOf("%0") === stateOptionValue("s1", "running"),
      );
      h.server.responses.state = () => completedResult("", 1, "write failed");
      await h.emit("agent_settled");
      await waitFor("recovery retry", () => stateArguments(h.server.commands).length >= 3);
      delete h.server.responses.state;
      await waitFor(
        "latest retry",
        () => h.server.paneOptionOf("%0") === stateOptionValue("s1", "waiting-user"),
      );
      assert.deepEqual(
        stateArguments(h.server.commands).map((args) => args[2]),
        ["waiting-user", "running", "waiting-user", "waiting-user"],
      );
    } finally {
      delete h.server.responses.state;
      await h.close();
    }
  });
});

interface RecoveryWait {
  delayMs: number | undefined;
  elapse(): void;
}

async function withRecoveryHarness(
  platform: NodeJS.Platform,
  run: (h: ExtensionHarness, waits: RecoveryWait[]) => Promise<void>,
): Promise<void> {
  const h = await createExtensionHarness({ platform });
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform });
  const waits: RecoveryWait[] = [];
  const mockedDelay = spyOn(timers, "setTimeout").mockImplementation(async function mockDelay<T>(
    delayMs?: number,
    value?: T,
    { signal }: Parameters<typeof timers.setTimeout>[2] = {},
  ): Promise<T> {
    const elapsed = Promise.withResolvers<void>();
    function onAbort(): void {
      elapsed.reject(signal?.reason);
    }
    signal?.throwIfAborted();
    signal?.addEventListener("abort", onAbort, { once: true });
    waits.push({ delayMs, elapse: elapsed.resolve });
    try {
      await elapsed.promise;
      return value as T;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  });
  try {
    await run(h, waits);
  } finally {
    try {
      await h.close();
    } finally {
      mockedDelay.mockRestore();
      Object.defineProperty(process, "platform", originalPlatform);
    }
  }
}

async function elapseRecovery(wait: RecoveryWait | undefined, expectedMs: number): Promise<void> {
  assert.ok(wait, "expected a pending recovery delay");
  assert.equal(wait.delayMs, expectedMs);
  wait.elapse();
  await finishEventLoopTurn();
}

describe("session-state recovery timing", () => {
  const windowsIntervalsMs = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
  for (const platform of ["win32", "linux"] as const) {
    it(`applies the ${platform} publication schedule until success, then restarts at one second`, async () => {
      await withRecoveryHarness(platform, async (h, waits) => {
        const terminal = Promise.withResolvers<ExecResult>();
        try {
          await h.emit("session_start");
          await finishEventLoopTurn();
          assert.equal(h.server.paneOptionOf("%0"), stateOptionValue("s1", "waiting-user"));
          let attempts = 0;
          h.server.responses.state = () => {
            attempts++;
            if (attempts === 1) return terminal.promise;
            return attempts % 2 === 0 ? busyResult() : completedResult("", 1, "write failed");
          };
          await h.emit("agent_start");
          await finishEventLoopTurn();
          assert.equal(attempts, 1);
          assert.equal(h.server.hasPending(), true);
          assert.equal(waits.length, 0, "the backoff must not start before CLI termination");
          terminal.resolve(interruptedResult());
          await finishEventLoopTurn();

          const intervalsMs =
            platform === "win32" ? windowsIntervalsMs : windowsIntervalsMs.map(() => 1_000);
          for (const [index, intervalMs] of intervalsMs.entries()) {
            assert.equal(attempts, index + 1, "only one attempt before each delay expires");
            if (index === 1) {
              await h.emit("agent_settled");
              await h.emit("session_info_changed", { name: "Latest title" });
              await finishEventLoopTurn();
              assert.equal(attempts, index + 1, "new events must not interrupt backoff");
            }
            if (index === intervalsMs.length - 1) delete h.server.responses.state;
            await elapseRecovery(waits[index], intervalMs);
          }
          assert.equal(
            h.server.paneOptionOf("%0"),
            stateOptionValue("s1", "waiting-user", "Latest title"),
          );
          const requests = stateArguments(h.server.commands);
          assert.deepEqual(
            requests.map((args) => [args[2], JSON.parse(args[args.indexOf("--title") + 1]!)]),
            [
              ["waiting-user", null],
              ["running", null],
              ["running", null],
              ...Array.from({ length: intervalsMs.length - 1 }, () => [
                "waiting-user",
                "Latest title",
              ]),
            ],
          );
          assert.equal(new Set(requests.map((args) => args[args.indexOf("--source") + 1])).size, 1);

          h.server.responses.state = () => busyResult();
          await h.emit("session_info_changed", { name: "After success" });
          await finishEventLoopTurn();
          delete h.server.responses.state;
          await elapseRecovery(waits[intervalsMs.length], 1_000);
          assert.equal(
            h.server.paneOptionOf("%0"),
            stateOptionValue("s1", "waiting-user", "After success"),
          );
        } finally {
          terminal.resolve(interruptedResult());
          delete h.server.responses.state;
        }
      });
    });
  }

  it("backs off Windows pane detection and starts publication recovery at one second once verified", async () => {
    await withRecoveryHarness("win32", async (h, waits) => {
      const token = process.env.PI_TMUX_LAUNCH_TOKEN;
      h.server.responses["display-message"] = () => interruptedResult();
      await h.emit("session_start");
      await finishEventLoopTurn();
      await elapseRecovery(waits[0], 1_000);
      await h.emit("agent_start");
      await h.emit("session_info_changed", { name: "During inspection" });
      await finishEventLoopTurn();
      assert.equal(h.server.commands.length, 2);
      assert.deepEqual(stateArguments(h.server.commands), []);
      const serverPid = process.pid + 1;
      h.server.responses["display-message"] = () =>
        completedResult(
          [h.server.socketPath, serverPid, "%0", JSON.stringify({ token }), process.pid].join("\t"),
        );
      h.server.responses.state = () => busyResult();
      await elapseRecovery(waits[1], 2_000);
      delete h.server.responses.state;
      await elapseRecovery(waits[2], 1_000);
      const requests = stateArguments(h.server.commands);
      assert.deepEqual(
        requests.map((args) => args[2]),
        ["running", "running"],
      );
      for (const args of requests) {
        assert.deepEqual(JSON.parse(args[args.indexOf("--source") + 1]!), {
          socket: h.server.socketPath,
          serverPid,
          pane: "%0",
          pid: process.pid,
          token,
        });
      }
      assert.equal(
        h.server.paneOptionOf("%0"),
        stateOptionValue("s1", "running", "During inspection"),
      );
    });
  });
});

describe("session-state persistent publication recovery", () => {
  for (const stop of ["shutdown", "replacement"] as const) {
    it(`cancels Windows publication backoff on ${stop}`, async () => {
      await withRecoveryHarness("win32", async (h, waits) => {
        await h.emit("session_start");
        await finishEventLoopTurn();
        assert.equal(h.server.paneOptionOf("%0"), stateOptionValue("s1", "waiting-user"));
        h.server.responses.state = () => completedResult("", 126, "publication failed");
        await h.emit("agent_start");
        await finishEventLoopTurn();
        await elapseRecovery(waits[0], 1_000);
        const pendingWait = waits[1];
        assert.ok(pendingWait);
        assert.equal(pendingWait.delayMs, 2_000);
        await h.emit("agent_settled");
        await h.emit("session_info_changed", { name: "Discarded title" });
        delete h.server.responses.state;
        if (stop === "shutdown") {
          await h.emit("session_shutdown");
          assert.equal(h.server.paneOptionOf("%0"), undefined);
          assert.equal(
            stateArguments(h.server.commands).filter((args) => args.includes("--clear")).length,
            1,
          );
        } else {
          h.sessionId = "replacement";
          h.sessionName = "Replacement title";
          await h.emit("session_start");
          await finishEventLoopTurn();
          assert.equal(
            h.server.paneOptionOf("%0"),
            stateOptionValue("replacement", "waiting-user", "Replacement title"),
          );
        }
        const count = h.server.commands.length;
        await elapseRecovery(pendingWait, 2_000);
        assert.equal(h.server.commands.length, count);
        assert.equal(
          h.server.commands.some((call) => call.args.includes("Discarded title")),
          false,
        );
      });
    });
  }
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
          return completedResult("", 1, "snapshot update failed after publishing running");
        };
        await h.emit("agent_start");
        await waitFor(
          "running attempt settled",
          () => stateArguments(h.server.commands).length === 2 && !h.server.hasPending(),
        );
        await finishEventLoopTurn();
        assert.equal(h.server.paneOptionOf("%0"), runningValue);
        delete h.server.responses.state;

        await h.emit("agent_settled");
        await waitFor("settled publication", () => h.server.paneOptionOf("%0") === waitingValue);
        await finishEventLoopTurn();
        const requests = stateArguments(h.server.commands);
        assert.deepEqual(
          requests.map((args) => args[2]),
          ["waiting-user", "running", "waiting-user"],
        );
        assert.deepEqual(
          requests.map((args) => JSON.parse(args[args.indexOf("--title") + 1]!)),
          [title ?? null, title ?? null, title ?? null],
        );
        const count = h.server.commands.length;
        await h.emit("ui_prompt_end");
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
  it("replaces a contended running notification with the latest waiting and title", async () => {
    const h = await createExtensionHarness();
    let busy = true;
    try {
      await h.emit("session_start");
      await waitFor("initial", () => h.server.paneOptionOf("%0") !== undefined);
      h.server.responses.state = () =>
        busy ? completedResult("", 75, "lock busy") : completedResult("");
      await h.emit("agent_start");
      await waitFor(
        "first attempt",
        () => h.server.commands.filter((call) => isStateCall(call)).length >= 2,
      );
      await h.emit("agent_settled");
      await h.emit("session_info_changed", { name: "Later title" });
      await waitFor(
        "background retry",
        () => h.server.commands.filter((call) => isStateCall(call)).length >= 3,
      );
      const pending = h.server.commands
        .filter((call) => isStateCall(call))
        .slice(1)
        .map((call) => call.args);
      assert.equal(pending[0]![2], "running");
      assert.ok(
        pending
          .slice(1)
          .every(
            (args) =>
              args[2] === "waiting-user" &&
              JSON.parse(args[args.indexOf("--title") + 1]!) === "Later title",
          ),
      );
      assert.ok(
        pending.every(
          (args) =>
            args[args.indexOf("--source") + 1] === pending[0]![pending[0]!.indexOf("--source") + 1],
        ),
      );
      busy = false;
      delete h.server.responses.state;
      await waitFor(
        "ordered retry and later states",
        () => h.server.paneOptionOf("%0") === stateOptionValue("s1", "waiting-user", "Later title"),
      );
      const states = h.server.commands
        .filter((call) => isStateCall(call))
        .map((call) => call.args[2]);
      assert.deepEqual(states.slice(-3), ["running", "waiting-user", "waiting-user"]);
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
      h.server.responses.state = () => completedResult("", 75, "busy");
      await h.emit("agent_start");
      await waitFor("contended running", () => h.server.commands.length >= 3);
      await h.emit("session_shutdown");
      const count = h.server.commands.length;
      assert.equal(h.server.commands.filter((call) => call.args.includes("--clear")).length, 1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(h.server.commands.length, count);
    } finally {
      delete h.server.responses.state;
      await h.close();
    }
  });
});

function busyResult(): ExecResult {
  return completedResult("", 75, "pi-mux lock is busy");
}

function stateArguments(commands: CommandCall[]): string[][] {
  return commands.filter((call) => isStateCall(call)).map((call) => call.args);
}

function lastRunEntry(sessionId: string, run: { atMs: number; aborted: boolean }): CustomEntry {
  return { type: "custom", customType: LAST_RUN_ENTRY_TYPE, data: { sessionId, ...run } };
}

async function emitSettledAt(h: ExtensionHarness, atMs: number, aborted = false): Promise<void> {
  const clock = spyOn(Date, "now").mockReturnValue(atMs);
  try {
    await h.emit("agent_settled", { aborted });
  } finally {
    clock.mockRestore();
  }
}

describe("session-state settlements", () => {
  it("retries a failed append before notifying waiting-user", async () => {
    const h = await createExtensionHarness({ failFirstAppend: true });
    try {
      await h.emit("session_start");
      await waitFor("initial", () => h.server.paneOptionOf("%0") !== undefined);
      await h.emit("agent_settled", { aborted: true });
      await waitFor("settled", () => stateArguments(h.server.commands).length === 2);
      assert.equal(h.entries.length, 1);
      assert.equal((h.entries[0]!.data as { aborted: boolean }).aborted, true);
      assert.deepEqual(h.entryCountsAtStateCalls, [0, 1]);
    } finally {
      await h.close();
    }
  });
  it("appends before publishing with standard argv, even for identical state, title, and timestamp", async () => {
    const h = await createExtensionHarness();
    try {
      await h.emit("session_start");
      await waitFor("initial", () => h.server.paneOptionOf("%0") !== undefined);
      const args = [
        "state",
        h.sessionId,
        "waiting-user",
        "--title",
        "null",
        "--source",
        JSON.stringify({
          socket: h.server.socketPath,
          serverPid: process.pid,
          pane: "%0",
          pid: process.pid,
          token: process.env.PI_TMUX_LAUNCH_TOKEN,
        }),
      ];
      const atMs = Date.now();
      await emitSettledAt(h, atMs);
      await waitFor("first settlement", () => stateArguments(h.server.commands).length === 2);
      await emitSettledAt(h, atMs);
      await waitFor("second settlement", () => stateArguments(h.server.commands).length === 3);
      await emitSettledAt(h, atMs + 1, true);
      await waitFor("aborted settlement", () => stateArguments(h.server.commands).length === 4);
      assert.deepEqual(stateArguments(h.server.commands), [args, args, args, args]);
      assert.deepEqual(h.entryCountsAtStateCalls, [0, 1, 2, 3]);
      assert.deepEqual(h.entries, [
        lastRunEntry(h.sessionId, { atMs, aborted: false }),
        lastRunEntry(h.sessionId, { atMs, aborted: false }),
        lastRunEntry(h.sessionId, { atMs: atMs + 1, aborted: true }),
      ]);
    } finally {
      await h.close();
    }
  });

  it("republishes the same state after an in-flight publication, coalescing to the latest run", async () => {
    const h = await createExtensionHarness();
    const inFlight = Promise.withResolvers<ExecResult>();
    try {
      h.server.responses.state = () => inFlight.promise;
      await h.emit("session_start");
      await waitFor("initial publication", () => stateArguments(h.server.commands).length === 1);
      const atMs = Date.now();
      await emitSettledAt(h, atMs);
      await emitSettledAt(h, atMs + 1, true);
      assert.deepEqual(h.entries, [
        lastRunEntry(h.sessionId, { atMs, aborted: false }),
        lastRunEntry(h.sessionId, { atMs: atMs + 1, aborted: true }),
      ]);
      assert.deepEqual(h.entryCountsAtStateCalls, [0]);
      delete h.server.responses.state;
      inFlight.resolve(completedResult(""));
      await waitFor("fresh publication", () => h.entryCountsAtStateCalls.length === 2);
      await finishEventLoopTurn();
      const requests = stateArguments(h.server.commands);
      assert.deepEqual(requests, [requests[0], requests[0]]);
      assert.deepEqual(h.entryCountsAtStateCalls, [0, 2]);
    } finally {
      delete h.server.responses.state;
      inFlight.resolve(completedResult(""));
      await h.close();
    }
  });

  it("captures settlement during pane verification and appends only after verification", async () => {
    const h = await createExtensionHarness();
    const verification = Promise.withResolvers<ExecResult>();
    try {
      h.server.responses["display-message"] = () => verification.promise;
      await h.emit("session_start");
      await waitFor("pane verification", () => h.server.hasPending());
      const atMs = Date.now();
      await emitSettledAt(h, atMs);
      assert.deepEqual(h.entries, []);
      verification.resolve(
        completedResult([h.server.socketPath, process.pid, "%0", "", process.pid].join("\t")),
      );
      await waitFor("first publication", () => stateArguments(h.server.commands).length === 1);
      assert.deepEqual(h.entryCountsAtStateCalls, [1]);
      assert.deepEqual(h.entries, [lastRunEntry(h.sessionId, { atMs, aborted: false })]);
    } finally {
      verification.resolve(completedResult(""));
      await h.close();
    }
  });

  it("does not save settlements outside the dedicated server", async () => {
    const h = await createExtensionHarness({ dedicated: false });
    try {
      await h.emit("session_start");
      await h.emit("agent_settled", { aborted: true });
      await finishEventLoopTurn();
      assert.deepEqual(h.entries, []);
      assert.deepEqual(h.server.commands, []);
    } finally {
      await h.close();
    }
  });
});

describe("session-state lock retries", () => {
  it("returns from discovery while busy and coalesces later state and title", async () => {
    const h = await createExtensionHarness();
    try {
      h.server.responses.state = () => busyResult();
      await h.emit("session_start");
      await waitFor("initial busy request", () => stateArguments(h.server.commands).length > 0);
      await h.emit("agent_start");
      await h.emit("session_info_changed", { name: "Queued title" });
      const atMs = Date.now();
      await emitSettledAt(h, atMs);
      await emitSettledAt(h, atMs + 1, true);
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
        requests.slice(-1).map((args) => [args[2], JSON.parse(args[args.indexOf("--title") + 1]!)]),
        [["waiting-user", "Queued title"]],
      );
      const sources = requests.map((args) => args[args.indexOf("--source") + 1]);
      assert.equal(new Set(sources).size, 1);
      assert.deepEqual(h.entries, [
        lastRunEntry(h.sessionId, { atMs, aborted: false }),
        lastRunEntry(h.sessionId, { atMs: atMs + 1, aborted: true }),
      ]);
      assert.deepEqual(h.entryCountsAtStateCalls, [0, 2, 2]);
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
        stateArguments(h.server.commands).some((args) => args[1] === "s1" && args[2] === "running"),
        false,
      );
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
      h.server.responses["display-message"] = (file, args) => {
        if (args[args.indexOf("-t") + 1] === "%9")
          throw new Error("obsolete inspection transport failed");
        return completedResult(
          [h.server.socketPath, String(process.pid), "%0", "", String(process.pid)].join("\t"),
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
        "replacement",
        () => h.server.paneOptionOf("%0") === stateOptionValue("replacement", "waiting-user"),
      );
      assert.equal(
        h.server.commands.slice(count).some((call) => call.args.includes("%9")),
        false,
      );
      assert.equal(h.server.paneOptionOf("%0"), stateOptionValue("replacement", "waiting-user"));
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
    } finally {
      finish.resolve();
      await h.close();
    }
  });

  it("recovers an interrupted publication automatically without new events", async () => {
    const h = await createExtensionHarness();
    try {
      await h.emit("session_start");
      await waitFor("initial", () => h.server.paneOptionOf("%0") !== undefined);
      h.server.responses.state = () => interruptedResult();
      await h.emit("agent_start");
      await waitFor(
        "interrupted attempt settled",
        () => stateArguments(h.server.commands).length === 2 && !h.server.hasPending(),
      );
      delete h.server.responses.state;
      await waitFor(
        "recovered running",
        () => h.server.paneOptionOf("%0") === stateOptionValue("s1", "running"),
      );
      await finishEventLoopTurn();
      assert.equal(stateArguments(h.server.commands).length, 3);
    } finally {
      await h.close();
    }
  }, 10_000);

  it("retries the latest waiting and title after a thrown process failure", async () => {
    const h = await createExtensionHarness();
    try {
      await h.emit("session_start");
      await waitFor("initial", () => h.server.paneOptionOf("%0") !== undefined);
      h.server.responses.state = () => {
        throw new Error("publication transport failed");
      };
      await h.emit("agent_start");
      await waitFor(
        "failed attempt settled",
        () => stateArguments(h.server.commands).length === 2 && !h.server.hasPending(),
      );
      await h.emit("agent_settled");
      await h.emit("session_info_changed", { name: "Queued recovery title" });
      assert.equal(stateArguments(h.server.commands).length, 2);
      delete h.server.responses.state;
      await waitFor(
        "queued waiting and title after retry",
        () =>
          h.server.paneOptionOf("%0") ===
          stateOptionValue("s1", "waiting-user", "Queued recovery title"),
      );
      await finishEventLoopTurn();
      const requests = stateArguments(h.server.commands);
      assert.deepEqual(
        requests.map((args) => [args[2], JSON.parse(args[args.indexOf("--title") + 1]!)]),
        [
          ["waiting-user", null],
          ["running", null],
          ["waiting-user", "Queued recovery title"],
        ],
      );
    } finally {
      delete h.server.responses.state;
      await h.close();
    }
  }, 10_000);

  it("recovers interrupted pane detection and publishes only the latest state and title", async () => {
    const h = await createExtensionHarness();
    try {
      h.server.responses["display-message"] = () => interruptedResult();
      await h.emit("session_start");
      await waitFor(
        "detection retry",
        () =>
          h.server.commands.filter(
            (call) => call.file === "tmux" && call.args.includes("display-message"),
          ).length >= 2,
      );
      await h.emit("agent_start");
      await h.emit("session_info_changed", { name: "Recovery title" });
      await h.emit("agent_settled");
      delete h.server.responses["display-message"];
      await waitFor(
        "recovered detection and pending publication",
        () =>
          h.server.paneOptionOf("%0") === stateOptionValue("s1", "waiting-user", "Recovery title"),
      );
      await finishEventLoopTurn();
      const requests = stateArguments(h.server.commands);
      assert.deepEqual(
        requests.map((args) => [args[2], JSON.parse(args[args.indexOf("--title") + 1]!)]),
        [["waiting-user", "Recovery title"]],
      );
    } finally {
      await h.close();
    }
  }, 10_000);

  it("defers a replacement generation's CLI until an uncertain old execution settles", async () => {
    const h = await createExtensionHarness();
    const release = Promise.withResolvers<ExecResult>();
    try {
      await h.emit("session_start");
      await waitFor("initial", () => h.server.paneOptionOf("%0") !== undefined);
      h.server.responses.state = () => release.promise;
      await h.emit("agent_start");
      await waitFor("old state CLI started", () => h.server.hasPending());
      h.sessionId = "replacement";
      h.restartRuntime();
      await h.emit("session_start", { reason: "reload" });
      await finishEventLoopTurn();
      const count = h.server.commands.length;
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(h.server.commands.length, count);
      delete h.server.responses.state;
      release.resolve(completedResult(""));
      await waitFor(
        "replacement after old execution settles",
        () => h.server.paneOptionOf("%0") === stateOptionValue("replacement", "waiting-user"),
      );
    } finally {
      release.resolve(completedResult(""));
      await h.close();
    }
  }, 10_000);

  it("skips shutdown cleanup until the started process reaches a terminal state", async () => {
    const h = await createExtensionHarness();
    const release = Promise.withResolvers<ExecResult>();
    try {
      await h.emit("session_start");
      await waitFor("initial", () => h.server.paneOptionOf("%0") !== undefined);
      h.server.responses.state = () => release.promise;
      await h.emit("agent_start");
      await waitFor("state CLI started", () => h.server.hasPending());
      let ended = false;
      const shutdown = h.emit("session_shutdown").then(() => {
        ended = true;
      });
      await finishEventLoopTurn();
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal(ended, false);
      assert.equal(
        stateArguments(h.server.commands).some((args) => args.includes("--clear")),
        false,
      );
      delete h.server.responses.state;
      release.resolve(completedResult(""));
      await shutdown;
      assert.equal(ended, true);
      assert.equal(h.server.paneOptionOf("%0"), undefined);
      await waitFor("process settled", () => !h.server.hasPending());
      h.restartRuntime();
      h.sessionId = "after-shutdown";
      await h.emit("session_start", { reason: "reload" });
      await waitFor(
        "new generation after shutdown boundary",
        () => h.server.paneOptionOf("%0") === stateOptionValue("after-shutdown", "waiting-user"),
      );
    } finally {
      release.resolve(completedResult(""));
      await h.close();
    }
  }, 10_000);
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
            }
            assert.equal(
              h.server.commands.filter(
                (call) => call.file === "tmux" && call.args.includes("display-message"),
              ).length,
              1,
            );
            assert.equal(h.server.commands.filter((call) => isStateCall(call)).length, 6);
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
