import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { describe, it, spyOn } from "bun:test";
import {
  createEventBus,
  InteractiveMode,
  SessionManager,
  type EntryRenderer,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { parse } from "shell-quote";
import { dedicatedSocketPath } from "./session-state-tmux.ts";
import extension, { drainAgentMessages, rejectSessionChange, stopMessageWatcher } from "./index.ts";

type Handler = (event: any, ctx: any) => unknown;
let modelRegistry = {} as ExtensionContext["modelRegistry"];

function captureHandlers(
  execute?: ExtensionAPI["exec"],
  sendMessage?: ExtensionAPI["sendMessage"],
  appendEntry?: ExtensionAPI["appendEntry"],
  sessionManager = SessionManager.inMemory(),
  piVersion = "1.5.0",
  factory = extension,
) {
  const handlers = new Map<string, Handler>();
  const entryRenderers = new Map<string, EntryRenderer>();
  const events = createEventBus();
  modelRegistry = {} as ExtensionContext["modelRegistry"];
  factory(
    {
      events,
      on(event: string, handler: Handler) {
        const previous = handlers.get(event);
        handlers.set(
          event,
          previous
            ? async (eventData: any, ctxData: any) => {
                await previous(eventData, ctxData);
                await handler(eventData, ctxData);
              }
            : handler,
        );
      },
      registerCommand(name: string, definition: { handler: Handler }) {
        assert.equal(name, process.env.PI_TMUX_STARTUP_COMMAND);
        handlers.set("startup", definition.handler);
      },
      registerEntryRenderer(customType: string, renderer: EntryRenderer) {
        entryRenderers.set(customType, renderer);
      },
      appendEntry:
        appendEntry ??
        ((customType: string, data: unknown) => sessionManager.appendCustomEntry(customType, data)),
      exec:
        execute ??
        (async () => {
          throw new Error("No process fixture");
        }),
      sendMessage:
        sendMessage ??
        (() => {
          throw new Error("No message fixture");
        }),
    } as unknown as ExtensionAPI,
    piVersion,
  );
  return Object.assign(handlers, { entryRenderers, sessionManager });
}

function context(mode = "tui") {
  const notifications: Array<{ text: string; type: string }> = [];
  const ctx = {
    modelRegistry,
    mode,
    hasUI: true,
    cwd: "/original cwd",
    sessionManager: {
      getCwd: () => "/original cwd",
      getSessionDir: () => "/top-level sessions",
      getSessionName: () => undefined,
      getEntries: () => [],
      getSessionId() {
        return "fixed-id";
      },
      getSessionFile() {
        return "/planned/session.jsonl";
      },
    },
    ui: {
      notify(text: string, type: string) {
        notifications.push({ text, type });
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, notifications };
}

async function withManagedEnvironment(test: () => Promise<void>): Promise<void> {
  const updates = {
    XDG_RUNTIME_DIR: "/tmp/work/dotfiles/pi-mux-unit",
    TMUX: "/tmp/work/dotfiles/pi-mux-unit/pi-tmux/server.sock,123,0",
    TMUX_PANE: "%3",
    PI_TMUX_SESSION_ID: "fixed-id",
    PI_TMUX_STARTUP_COMMAND: "pi-mux-startup-fixture",
    PI_TMUX_STARTUP_MODE: "",
    PI_TMUX_LAUNCH_TOKEN: UNIT_TOKEN,
    TICKET_DISPATCH_ROLE: "",
    PI_OFFLINE: "1",
    PI_CODING_AGENT_DIR: `/tmp/work/dotfiles/pi-mux-fixture-${randomUUID()}`,
  };
  const sdkRun = InteractiveMode.prototype.run;
  const previous = Object.fromEntries(Object.keys(updates).map((key) => [key, process.env[key]]));
  Object.assign(process.env, updates);
  try {
    await test();
  } finally {
    InteractiveMode.prototype.run = sdkRun;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const UNIT_TOKEN = randomUUID();
const STARTUP_INPUT_DRAINED_ACK = "PI_MUX_STARTUP_INPUT_DRAINED\n";

async function withStartupTransport(
  platform: "linux" | "win32",
  test: (socket: string) => Promise<void>,
): Promise<void> {
  await withManagedEnvironment(async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
    try {
      const socket = dedicatedSocketPath();
      process.env.TMUX = `${socket},123,0`;
      await test(socket);
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });
}

function managedPaneOutput(): string {
  return [
    "/tmp/work/dotfiles/pi-mux-unit/pi-tmux/server.sock",
    "123",
    "%3",
    JSON.stringify({ id: "fixed-id", pid: process.pid, token: UNIT_TOKEN }),
    String(process.pid),
  ].join("\t");
}

function execResult(stdout = "") {
  return { stdout, stderr: "", code: 0, killed: false };
}

function startupPaneFixture({
  socket = "/tmp/work/dotfiles/pi-mux-unit/pi-tmux/server.sock",
  panePid = process.pid,
  sendDrained,
}: {
  socket?: string;
  panePid?: number;
  sendDrained?: (
    commit: () => ReturnType<typeof execResult>,
  ) => Promise<ReturnType<typeof execResult>>;
} = {}) {
  let metadata: Record<string, unknown> = {};
  const legacyWrites: Array<Record<string, unknown>> = [];
  const proofCalls: string[][] = [];
  const execute: ExtensionAPI["exec"] = async (command, args) => {
    if (command === "pi-mux") {
      proofCalls.push(args);
      function commit(): ReturnType<typeof execResult> {
        if (metadata.reloadReadiness === "pending")
          metadata = { ...metadata, reloadReadiness: "drained" };
        return execResult(STARTUP_INPUT_DRAINED_ACK);
      }
      if (sendDrained) return await sendDrained(commit);
      return commit();
    }
    assert.equal(command, "tmux");
    if (args.includes("display-message")) {
      if (args.includes("#{@pi-tmux-session}"))
        return execResult(
          metadata.startup ? Buffer.from(JSON.stringify(metadata)).toString("base64") : "",
        );
      return execResult([socket, "123", "%3", "", String(panePid)].join("\t"));
    }
    if (args.includes("@pi-tmux-session")) {
      metadata = JSON.parse(Buffer.from(args.at(-1)!, "base64").toString("utf8"));
      legacyWrites.push(metadata);
    }
    return execResult();
  };
  return {
    execute,
    legacyWrites,
    proofCalls,
    get startup() {
      return metadata.startup;
    },
    get reloadReadiness() {
      return metadata.reloadReadiness;
    },
  };
}

function beginInteractiveStartup({
  ctx,
  initialize,
  handlePrompt,
  initialMessages,
  queued,
  canAttach = true,
}: {
  ctx: () => ExtensionContext;
  initialize: () => Promise<unknown>;
  handlePrompt: (message: string) => Promise<unknown>;
  initialMessages: string[];
  queued: string[];
  canAttach?: boolean;
}): Promise<void> {
  const waiting = Promise.withResolvers<void>();
  let inputCallback: ((text: string) => void) | undefined;
  const mode: InteractiveMode = Object.create(InteractiveMode.prototype, {
    init: { value: initialize },
    options: { value: { initialMessage: "file prompt", initialMessages } },
    pendingUserInputs: { value: queued },
    onInputCallback: {
      get: () => inputCallback,
      set(callback: (text: string) => void) {
        inputCallback = callback;
        waiting.resolve();
      },
    },
    sessionManager: { get: () => ctx().sessionManager },
    session: { value: { modelRuntime: { getError: () => undefined }, prompt: handlePrompt } },
    showRuntimeDiagnostics: { value: () => undefined },
    showError: { value: waiting.reject },
    checkForPackageUpdates: { value: async () => [] },
    checkTmuxKeyboardSetup: { value: async () => undefined },
    maybeWarnAboutAnthropicSubscriptionAuth: { value: async () => undefined },
  });
  if (!canAttach) Object.preventExtensions(mode);
  void mode.run().catch(waiting.reject);
  return waiting.promise;
}

async function settleStartupPublication(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function withReloadRetryClock(test: () => Promise<void>): Promise<void> {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await withManagedEnvironment(test);
  } finally {
    mock.timers.reset();
  }
}

async function advanceReloadRetryClock(durationMs = 1_000): Promise<void> {
  mock.timers.tick(durationMs);
  await settleStartupPublication();
}

describe("reload input proof", () => {
  for (const origin of ["open", "create", "external"] as const) {
    it(`keeps ${origin} startup publication independent of queued and initial inputs`, async () => {
      await withManagedEnvironment(async () => {
        const isOpen = origin === "open";
        const slash = isOpen ? `/${process.env.PI_TMUX_STARTUP_COMMAND}` : "/slow";
        if (!isOpen) delete process.env.PI_TMUX_STARTUP_COMMAND;
        if (origin === "create") process.env.PI_TMUX_STARTUP_MODE = "create";
        const fixture = startupPaneFixture();
        const { ctx } = context();
        const handlers = captureHandlers(fixture.execute);
        const submitted: unknown[][] = [];
        const queuedInput = "typed during startup";
        const queued: string[] = [];
        try {
          await beginInteractiveStartup({
            ctx: () => ctx,
            initialize: async () => handlers.get("resources_discover")!({ reason: "startup" }, ctx),
            async handlePrompt(message) {
              if (message === slash && isOpen) await handlers.get("startup")!("", ctx);
              if (message === "file prompt") queued.push(queuedInput);
              submitted.push([
                message,
                fixture.startup,
                fixture.reloadReadiness,
                fixture.proofCalls.length,
              ]);
            },
            initialMessages: ["positional prompt", slash, "final prompt"],
            queued,
          });
          await settleStartupPublication();
          const startup = isOpen ? "ready" : "accepted";
          assert.deepEqual(submitted, [
            ["file prompt", isOpen ? undefined : startup, isOpen ? undefined : "pending", 0],
            ["positional prompt", isOpen ? undefined : startup, isOpen ? undefined : "pending", 0],
            [slash, startup, "pending", 0],
            ["final prompt", startup, "pending", 0],
            [queuedInput, startup, "pending", 0],
          ]);
          assert.equal(fixture.startup, startup);
          assert.equal(fixture.reloadReadiness, "drained");
          assert.equal(fixture.legacyWrites.length, 1);
          assert.deepEqual(fixture.proofCalls, [
            [
              "state",
              "fixed-id",
              "--startup-input-drained",
              "--source",
              JSON.stringify({
                socket: "/tmp/work/dotfiles/pi-mux-unit/pi-tmux/server.sock",
                serverPid: 123,
                pane: "%3",
                pid: process.pid,
                token: UNIT_TOKEN,
              }),
            ],
          ]);
        } finally {
          await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
        }
      });
    });
  }

  for (const origin of ["create", "external"] as const) {
    for (const timing of ["before", "after", "new server", "other session", "occupied"] as const) {
      it(`keeps accepted scoped to the ${origin} launch across /reload (${timing})`, async () => {
        await withManagedEnvironment(async () => {
          delete process.env.PI_TMUX_STARTUP_COMMAND;
          if (origin === "create") process.env.PI_TMUX_STARTUP_MODE = "create";
          else {
            delete process.env.PI_TMUX_SESSION_ID;
            delete process.env.PI_TMUX_LAUNCH_TOKEN;
          }
          const fixture = startupPaneFixture();
          const original = captureHandlers(fixture.execute);
          const { ctx } = context();
          if (timing === "after")
            await original.get("resources_discover")!({ reason: "startup" }, ctx);
          await original.get("session_shutdown")!({ reason: "reload" }, ctx);
          const stale = new Proxy(ctx, { get: () => assert.fail("The old context is invalid") });
          await original.get("resources_discover")!({ reason: "startup" }, stale);

          const reloaded = captureHandlers(async (command, args, options) => {
            const result = await fixture.execute(command, args, options);
            if (timing === "new server" && args.at(-1)?.includes("#{pid}"))
              return { ...result, stdout: result.stdout.replace("\t123\t", "\t456\t") };
            if (timing === "occupied" && args.at(-1) === "#{@pi-tmux-session}")
              return { ...result, stdout: "foreign-metadata" };
            return result;
          });
          const next = context().ctx;
          if (timing === "other session")
            Object.assign(next.sessionManager, { getSessionId: () => "other-id" });
          try {
            await reloaded.get("resources_discover")!({ reason: "reload" }, next);
            await reloaded.get("resources_discover")!({ reason: "reload" }, next);
            const sameLaunch = timing === "before" || timing === "after";
            assert.equal(fixture.legacyWrites.length, sameLaunch ? 1 : 0);
            assert.equal(fixture.startup, sameLaunch ? "accepted" : undefined);
            assert.equal(fixture.reloadReadiness, undefined);
            assert.equal(fixture.proofCalls.length, 0);
          } finally {
            await reloaded.get("session_shutdown")!({ reason: "quit" }, next);
          }
        });
      });
    }
  }

  it("resumes a proof with a generated launch token after /reload", async () => {
    await withManagedEnvironment(async () => {
      delete process.env.PI_TMUX_STARTUP_COMMAND;
      delete process.env.PI_TMUX_LAUNCH_TOKEN;
      const fixture = startupPaneFixture();
      const finalPromptStarted = Promise.withResolvers<void>();
      const finalPromptFinished = Promise.withResolvers<void>();
      let callsAfterDetach = 0;
      let detached = false;
      let { ctx } = context();
      let handlers = captureHandlers(async (command, args, options) => {
        if (detached) callsAfterDetach++;
        return fixture.execute(command, args, options);
      });
      try {
        const waiting = beginInteractiveStartup({
          ctx: () => ctx,
          initialize: async () => handlers.get("resources_discover")!({ reason: "startup" }, ctx),
          async handlePrompt(message) {
            if (message !== "/slow") return;
            finalPromptStarted.resolve();
            await finalPromptFinished.promise;
          },
          initialMessages: ["/slow"],
          queued: [],
        });
        await finalPromptStarted.promise;
        const token = process.env.PI_TMUX_LAUNCH_TOKEN;
        assert.ok(token);
        assert.equal(fixture.legacyWrites[0]?.token, token);
        await handlers.get("session_shutdown")!({ reason: "reload" }, ctx);
        detached = true;
        finalPromptFinished.resolve();
        await waiting;
        assert.equal(fixture.reloadReadiness, "pending");
        assert.equal(fixture.proofCalls.length, 0);
        const reloaded: typeof import("./index.ts") = await import(
          `./index.ts?reload=${randomUUID()}`
        );
        handlers = captureHandlers(
          fixture.execute,
          undefined,
          undefined,
          undefined,
          undefined,
          reloaded.default,
        );
        ctx = context().ctx;
        await handlers.get("resources_discover")!({ reason: "reload" }, ctx);
        await settleStartupPublication();
        assert.equal(callsAfterDetach, 0);
        assert.equal(fixture.reloadReadiness, "drained");
        assert.equal(fixture.legacyWrites.length, 1);
        assert.equal(fixture.proofCalls.length, 1);
        assert.equal(JSON.parse(fixture.proofCalls[0]!.at(-1)!).token, token);
      } finally {
        finalPromptFinished.resolve();
        await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
      }
    });
  });

  for (const observer of ["missing", "not writable"] as const) {
    it(`publishes legacy ready without a proof when the observer is ${observer}`, async () => {
      await withManagedEnvironment(async () => {
        const getUserInput = InteractiveMode.prototype.getUserInput;
        if (observer === "missing")
          Reflect.deleteProperty(InteractiveMode.prototype, "getUserInput");
        const stderr = spyOn(process.stderr, "write").mockReturnValue(true);
        const fixture = startupPaneFixture();
        const handlers = captureHandlers(fixture.execute);
        const { ctx } = context();
        try {
          if (observer === "missing") {
            await handlers.get("resources_discover")!({ reason: "startup" }, ctx);
            await handlers.get("startup")!("", ctx);
          } else {
            await beginInteractiveStartup({
              ctx: () => ctx,
              initialize: async () =>
                handlers.get("resources_discover")!({ reason: "startup" }, ctx),
              handlePrompt: async () => handlers.get("startup")!("", ctx),
              initialMessages: [],
              queued: [],
              canAttach: false,
            });
          }
          assert.equal(fixture.startup, "ready");
          assert.equal(fixture.reloadReadiness, undefined);
          assert.deepEqual(fixture.proofCalls, []);
          assert.ok(
            stderr.mock.calls.some(([line]) =>
              String(line).includes("reload readiness not published"),
            ),
          );
        } finally {
          InteractiveMode.prototype.getUserInput = getUserInput;
          stderr.mockRestore();
          await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
        }
      });
    });
  }

  it.skipIf(process.platform === "win32")(
    "recovers the legacy draft when ready is published without reload proof",
    async () => {
      await withManagedEnvironment(async () => {
        const id = randomUUID();
        process.env.PI_TMUX_SESSION_ID = id;
        const agent = process.env.PI_CODING_AGENT_DIR!;
        const directory = join(agent, "pi-tmux", "first-input", id);
        const { ctx } = context();
        const fixture = startupPaneFixture();
        const handlers = captureHandlers(fixture.execute);
        let editorText = "";
        Object.assign(ctx.sessionManager, { getSessionId: () => id });
        Object.assign(ctx.ui, {
          getEditorText: () => editorText,
          setEditorText(text: string) {
            editorText = text;
          },
        });
        const text = "preserved first input";
        try {
          mkdirSync(directory, { recursive: true, mode: 0o700 });
          writeFileSync(join(directory, "text"), text, { mode: 0o600 });
          writeFileSync(
            join(directory, "context.json"),
            JSON.stringify({ id, cwd: ctx.cwd, request: randomUUID() }),
            { mode: 0o600 },
          );
          await handlers.get("startup")!("", ctx);
          assert.equal(fixture.startup, "ready");
          assert.equal(fixture.reloadReadiness, undefined);
          assert.equal(editorText, text);
        } finally {
          await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
          rmSync(agent, { force: true, recursive: true });
        }
      });
    },
  );

  for (const order of ["before", "during", "after"] as const) {
    it(`publishes legacy ready once when the startup command runs ${order} /reload`, async () => {
      await withManagedEnvironment(async () => {
        const fixture = startupPaneFixture();
        const original = captureHandlers(fixture.execute);
        const { ctx } = context();
        await original.get("resources_discover")!({ reason: "startup" }, ctx);
        if (order === "before") await original.get("startup")!("", ctx);
        await original.get("session_shutdown")!({ reason: "reload" }, ctx);
        if (order === "during") {
          const staleContext = new Proxy(ctx, {
            get: () => assert.fail("The detached startup handler must not use an old context"),
          });
          await original.get("startup")!("", staleContext);
          assert.deepEqual(fixture.legacyWrites, []);
        }

        const reloaded: typeof import("./index.ts") = await import(
          `./index.ts?reload=${randomUUID()}`
        );
        const handlers = captureHandlers(
          fixture.execute,
          undefined,
          undefined,
          undefined,
          undefined,
          reloaded.default,
        );
        const next = context().ctx;
        try {
          await handlers.get("resources_discover")!({ reason: "reload" }, next);
          assert.equal(fixture.startup, order === "after" ? undefined : "ready");
          await handlers.get("startup")!("", next);
          await handlers.get("startup")!("", next);
          assert.equal(fixture.legacyWrites.length, 1);
          assert.equal(fixture.startup, "ready");
          assert.equal(fixture.reloadReadiness, undefined);
          assert.deepEqual(fixture.proofCalls, []);
        } finally {
          await handlers.get("session_shutdown")!({ reason: "quit" }, next);
        }
      });
    });
  }

  it("lets a started legacy publication finish before /reload invalidates its context", async () => {
    await withManagedEnvironment(async () => {
      const fixture = startupPaneFixture();
      const paneInspectionStarted = Promise.withResolvers<void>();
      const finishPaneInspection = Promise.withResolvers<void>();
      const { ctx } = context();
      let detached = false;
      const active = new Proxy(ctx, {
        get(target, property) {
          assert.equal(detached, false, "The old runner has already been invalidated");
          return Reflect.get(target, property);
        },
      });
      const handlers = captureHandlers(async (command, args, options) => {
        if (args.includes("display-message")) {
          paneInspectionStarted.resolve();
          await finishPaneInspection.promise;
        }
        return fixture.execute(command, args, options);
      });
      const startup = handlers.get("startup")!("", active);
      await paneInspectionStarted.promise;
      const shutdown = Promise.resolve(
        handlers.get("session_shutdown")!({ reason: "reload" }, active),
      ).then(() => {
        detached = true;
      });
      try {
        await settleStartupPublication();
        assert.equal(detached, false);
      } finally {
        finishPaneInspection.resolve();
        await Promise.all([startup, shutdown]);
      }
      assert.equal(fixture.startup, "ready");
      assert.equal(fixture.legacyWrites.length, 1);
    });
  });

  for (const scenario of ["seven temporary failures", "an ambiguous commit"] as const) {
    it(`publishes the same proof after ${scenario} without affecting legacy readiness`, async () => {
      await withReloadRetryClock(async () => {
        const stderr = spyOn(process.stderr, "write").mockReturnValue(true);
        const didCommit = scenario === "an ambiguous commit";
        const retryDelaysMs = didCommit
          ? [1_000]
          : [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
        const fixture = startupPaneFixture({
          async sendDrained(commit) {
            const attempt = fixture.proofCalls.length;
            if (didCommit && attempt === 1) {
              commit();
              return { ...execResult(), killed: true };
            }
            if (!didCommit) {
              if (attempt === 1) return { ...execResult(STARTUP_INPUT_DRAINED_ACK), code: 1 };
              if (attempt === 2) return { ...execResult(STARTUP_INPUT_DRAINED_ACK), killed: true };
              if (attempt === 3)
                return { ...execResult(STARTUP_INPUT_DRAINED_ACK), truncated: true };
              if (attempt === 4) throw new Error("temporary write failure");
              if (attempt === 5) return execResult();
              if (attempt === 6) return execResult(`unexpected\n${STARTUP_INPUT_DRAINED_ACK}`);
              if (attempt === 7) return execResult(STARTUP_INPUT_DRAINED_ACK.repeat(2));
            }
            return commit();
          },
        });
        const { ctx, notifications } = context();
        const handlers = captureHandlers(fixture.execute);
        const originalExitCode = process.exitCode;
        try {
          await beginInteractiveStartup({
            ctx: () => ctx,
            initialize: async () => handlers.get("resources_discover")!({ reason: "startup" }, ctx),
            handlePrompt: async () => handlers.get("startup")!("", ctx),
            initialMessages: [],
            queued: [],
          });
          await settleStartupPublication();
          assert.equal(fixture.proofCalls.length, 1);
          assert.equal(fixture.startup, "ready");
          assert.equal(fixture.reloadReadiness, didCommit ? "drained" : "pending");
          for (const [index, delayMs] of retryDelaysMs.entries()) {
            await advanceReloadRetryClock(delayMs - 1);
            assert.equal(fixture.proofCalls.length, index + 1);
            await advanceReloadRetryClock(1);
            assert.equal(fixture.proofCalls.length, index + 2);
          }
          assert.equal(fixture.reloadReadiness, "drained");
          await advanceReloadRetryClock(30_000);
          assert.deepEqual(
            fixture.proofCalls,
            Array.from({ length: retryDelaysMs.length + 1 }, () => fixture.proofCalls[0]),
          );
          assert.equal(fixture.legacyWrites.length, 1);
          assert.deepEqual(notifications, []);
          assert.equal(process.exitCode, originalExitCode);
          assert.equal(stderr.mock.calls.length, 0);
        } finally {
          stderr.mockRestore();
          await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
        }
      });
    });
  }

  for (const reason of ["quit", "reload"] as const) {
    for (const platform of ["linux", "win32"] as const) {
      it(`does not start another attempt from a detached ${platform} publisher on ${reason}`, async () => {
        await withStartupTransport(platform, async (socket) => {
          delete process.env.PI_TMUX_STARTUP_COMMAND;
          const firstAttempt = Promise.withResolvers<Parameters<ExtensionAPI["exec"]>[2]>();
          const finishAttempt = Promise.withResolvers<ReturnType<typeof execResult>>();
          let oldAttempts = 0;
          const fixture = startupPaneFixture({
            socket,
            async sendDrained(commit) {
              if (fixture.proofCalls.length === 1) return finishAttempt.promise;
              return commit();
            },
          });
          const { ctx } = context();
          let handlers = captureHandlers(async (command, args, options) => {
            if (command === "pi-mux") {
              oldAttempts++;
              firstAttempt.resolve(options);
            }
            return fixture.execute(command, args, options);
          });
          try {
            await beginInteractiveStartup({
              ctx: () => ctx,
              initialize: async () =>
                handlers.get("resources_discover")!({ reason: "startup" }, ctx),
              handlePrompt: async () => {},
              initialMessages: [],
              queued: [],
            });
            const options = await firstAttempt.promise;
            const isWindows = platform === "win32";
            assert.equal(options?.timeout, isWindows ? undefined : 1_000);
            assert.equal(options?.signal?.aborted, isWindows ? undefined : false);
            await handlers.get("session_shutdown")!({ reason }, ctx);
            assert.equal(options?.signal?.aborted, isWindows ? undefined : reason === "quit");
            if (reason === "reload") {
              handlers = captureHandlers(fixture.execute);
              await handlers.get("resources_discover")!({ reason }, ctx);
            }
            assert.equal(fixture.proofCalls.length, 1);
            finishAttempt.resolve({ ...execResult(), code: 1 });
            await settleStartupPublication();
            assert.equal(oldAttempts, 1);
            assert.equal(fixture.proofCalls.length, reason === "reload" ? 2 : 1);
            assert.equal(fixture.reloadReadiness, reason === "reload" ? "drained" : "pending");
          } finally {
            finishAttempt.resolve(execResult());
            await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
          }
        });
      });
    }

    it(`cancels the old retry wait on ${reason}`, async () => {
      await withReloadRetryClock(async () => {
        delete process.env.PI_TMUX_STARTUP_COMMAND;
        const fixture = startupPaneFixture({
          async sendDrained(commit) {
            if (fixture.proofCalls.length <= 2) return { ...execResult(), code: 1 };
            return commit();
          },
        });
        let oldAttempts = 0;
        let { ctx } = context();
        let handlers = captureHandlers(async (command, args, options) => {
          if (command === "pi-mux") oldAttempts++;
          return fixture.execute(command, args, options);
        });
        try {
          await beginInteractiveStartup({
            ctx: () => ctx,
            initialize: async () => handlers.get("resources_discover")!({ reason: "startup" }, ctx),
            handlePrompt: async () => {},
            initialMessages: [],
            queued: [],
          });
          await settleStartupPublication();
          assert.equal(fixture.proofCalls.length, 1);
          await handlers.get("session_shutdown")!({ reason }, ctx);
          if (reason === "reload") {
            const reloaded: typeof import("./index.ts") = await import(
              `./index.ts?reload=${randomUUID()}`
            );
            handlers = captureHandlers(
              fixture.execute,
              undefined,
              undefined,
              undefined,
              undefined,
              reloaded.default,
            );
            ctx = context().ctx;
            await handlers.get("resources_discover")!({ reason }, ctx);
            await settleStartupPublication();
            assert.equal(fixture.proofCalls.length, 2);
          }
          await advanceReloadRetryClock();
          await advanceReloadRetryClock();
          assert.equal(oldAttempts, 1);
          assert.equal(fixture.proofCalls.length, reason === "reload" ? 3 : 1);
          assert.equal(fixture.reloadReadiness, reason === "reload" ? "drained" : "pending");
          assert.equal(fixture.legacyWrites.length, 1);
        } finally {
          await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
        }
      });
    });
  }

  it("uses the same literal Windows state source with the Pi PID distinct from the pane PID", async () => {
    await withManagedEnvironment(async () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
      try {
        const socket = dedicatedSocketPath();
        process.env.TMUX = `${socket},456,0`;
        const panePid = process.pid + 1;
        const fixture = startupPaneFixture({ socket, panePid });
        const handlers = captureHandlers(fixture.execute);
        const { ctx } = context();
        try {
          await beginInteractiveStartup({
            ctx: () => ctx,
            initialize: async () => handlers.get("resources_discover")!({ reason: "startup" }, ctx),
            handlePrompt: async () => handlers.get("startup")!("", ctx),
            initialMessages: [],
            queued: [],
          });
          await settleStartupPublication();
          assert.equal(fixture.reloadReadiness, "drained");
          assert.equal(fixture.legacyWrites[0]?.processPid, process.pid);
          assert.equal(fixture.legacyWrites[0]?.pid, panePid);
          assert.deepEqual(fixture.proofCalls, [
            [
              "state",
              "fixed-id",
              "--startup-input-drained",
              "--source",
              JSON.stringify({
                socket,
                serverPid: 123,
                pane: "%3",
                pid: process.pid,
                token: UNIT_TOKEN,
              }),
            ],
          ]);
        } finally {
          await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
        }
      } finally {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    });
  });
});

describe("startup notification timeouts", () => {
  it("forwards the pane verification timeout and keeps the publication default", async () => {
    await withManagedEnvironment(async () => {
      const timeouts: Array<number | undefined> = [];
      const handlers = captureHandlers(async (_command, args, options) => {
        timeouts.push(options?.timeout);
        return {
          stdout: args.includes("display-message") ? managedPaneOutput() : "",
          stderr: "",
          code: 0,
          killed: false,
        };
      });
      await handlers.get("startup")!("", context().ctx);
      assert.deepEqual(timeouts, [5_000, 1_000]);
    });
  });
});

describe("fixed conversation identity", () => {
  it("does not publish managed readiness from an initialization hook", async () => {
    await withManagedEnvironment(async () => {
      const commands: string[][] = [];
      const handlers = captureHandlers(async (_command, args) => {
        commands.push(args);
        return { stdout: "", stderr: "", code: 0, killed: false };
      });
      const { ctx } = context();
      try {
        await handlers.get("session_start")!({}, ctx);
        await handlers.get("resources_discover")!({}, ctx);
        assert.equal(
          commands.some((args) => args.includes("@pi-tmux-session")),
          false,
        );
      } finally {
        await handlers.get("session_shutdown")!({}, ctx);
      }
    });
  });

  for (const reason of ["new", "resume"]) {
    it(`rejects ${reason} before switching a TUI session`, async () => {
      const handlers = captureHandlers();
      const { ctx, notifications } = context();
      const result = await handlers.get("session_before_switch")!({ reason }, ctx);
      assert.deepEqual(result, { cancel: true });
      assert.equal(notifications[0]?.type, "error");
      assert.match(notifications[0]!.text, /pi-mux open/);
    });
  }

  for (const position of ["before", "at"]) {
    it(`rejects a fork at position ${position} before changing identity`, async () => {
      const handlers = captureHandlers();
      const { ctx } = context();
      const result = await handlers.get("session_before_fork")!({ position }, ctx);
      assert.deepEqual(result, { cancel: true });
    });
  }

  for (const mode of ["rpc", "json", "print"]) {
    it(`preserves the standard identity behavior in ${mode} mode`, async () => {
      await withManagedEnvironment(async () => {
        const { ctx, notifications } = context(mode);
        assert.equal(rejectSessionChange(ctx), undefined);
        await captureHandlers().get("startup")!("", ctx);
        assert.deepEqual(notifications, []);
      });
    });
  }

  for (const startup of ["accepted", "ready"] as const)
    it(`publishes ${startup} identity only once at its explicit boundary`, async () => {
      await withManagedEnvironment(async () => {
        if (startup === "accepted") {
          delete process.env.PI_TMUX_STARTUP_COMMAND;
          process.env.PI_TMUX_STARTUP_MODE = "create";
        }
        const commands: string[][] = [];
        const handlers = captureHandlers(async (_command, args) => {
          commands.push(args);
          return {
            stdout: args.includes("display-message") ? managedPaneOutput() : "",
            stderr: "",
            code: 0,
            killed: false,
          };
        });
        assert.equal(commands.length, 0);
        const { ctx } = context();
        const boundary = startup === "accepted" ? "resources_discover" : "startup";
        if (startup === "accepted") assert.equal(handlers.has("startup"), false);
        else await handlers.get("resources_discover")!({}, ctx);
        await handlers.get(boundary)!({}, ctx);
        await handlers.get(boundary)!({}, ctx);
        assert.equal(commands.length, 2);
        const published = commands[1]!;
        assert.ok(published.includes("@pi-tmux-session"));
        const metadata = JSON.parse(Buffer.from(published.at(-1)!, "base64").toString("utf8"));
        assert.deepEqual(metadata, {
          id: "fixed-id",
          file: "/planned/session.jsonl",
          cwd: "/original cwd",
          pid: process.pid,
          startup,
          token: UNIT_TOKEN,
        });
      });
    });

  for (const phase of [
    "confirmation",
    "publication",
    "committed-publication",
    "unverifiable-publication",
  ] as const) {
    for (const failure of ["denied", "timeout"] as const) {
      it(`keeps readiness consistent when ${phase} is ${failure}`, async () => {
        await withManagedEnvironment(async () => {
          let published = false;
          let restoring = true;
          const handlers = captureHandlers(async (_command, args) => {
            const fails =
              phase === "confirmation"
                ? args.includes("if-shell")
                : args.includes("@pi-tmux-session");
            if (fails) {
              if (phase === "committed-publication" || phase === "unverifiable-publication")
                published = true;
              return { stdout: "", stderr: failure, code: 1, killed: failure === "timeout" };
            }
            if (published && phase === "unverifiable-publication")
              return { stdout: "", stderr: "verification unavailable", code: 1, killed: false };
            if (args.includes("@pi-tmux-session")) published = true;
            if (args.includes("if-shell")) restoring = false;
            const metadata = published
              ? Buffer.from(
                  JSON.stringify({
                    id: "fixed-id",
                    pid: process.pid,
                    startup: "ready",
                    token: UNIT_TOKEN,
                  }),
                ).toString("base64")
              : "";
            return {
              stdout: args.includes("#{@pi-tmux-session}")
                ? metadata
                : args.includes("display-message")
                  ? managedPaneOutput()
                  : "",
              stderr: "",
              code: 0,
              killed: false,
            };
          });
          const { ctx, notifications } = context();
          let shutdowns = 0;
          Object.assign(ctx, {
            shutdown() {
              shutdowns++;
            },
          });
          const previousExitCode = process.exitCode;
          try {
            await handlers.get("startup")!("", ctx);
            assert.equal(published, phase !== "publication");
            assert.equal(shutdowns, phase === "publication" ? 1 : 0);
            assert.equal(
              notifications.length,
              phase === "publication" || phase === "unverifiable-publication" ? 1 : 0,
            );
            if (phase === "unverifiable-publication")
              assert.equal(notifications[0]?.type, "warning");
            assert.equal(restoring, phase !== "committed-publication");
          } finally {
            process.exitCode = previousExitCode ?? 0;
          }
        });
      });
    }
  }

  it("confirms a retained ready session only on shutdown", async () => {
    await withManagedEnvironment(async () => {
      let restoring = true;
      const commands: string[][] = [];
      const handlers = captureHandlers(async (_command, args) => {
        commands.push(args);
        if (args.includes("if-shell")) restoring = false;
        return {
          stdout: args.includes("display-message") ? managedPaneOutput() : "",
          stderr: "",
          code: 0,
          killed: false,
        };
      });
      const { ctx } = context();
      await handlers.get("startup")!("", ctx);
      assert.equal(restoring, true);
      await handlers.get("session_shutdown")!({}, ctx);
      assert.equal(restoring, false);
      const confirmed = commands.at(-1)!;
      assert.ok(confirmed.includes("if-shell"));
      assert.ok(confirmed.includes(`#{&&:#{==:#{pid},123},#{==:#{pane_pid},${process.pid}}}`));
      assert.deepEqual(parse(confirmed.at(-1)!), [
        "set-option",
        "-gu",
        "@pi-mux-restoring-fixed-id",
      ]);
    });
  });

  for (const startup of ["accepted", "ready"] as const) {
    it(`uses existing ${startup} metadata on shutdown after an extension reload`, async () => {
      await withManagedEnvironment(async () => {
        let confirmations = 0;
        const metadata = Buffer.from(
          JSON.stringify({ id: "fixed-id", pid: process.pid, startup, token: UNIT_TOKEN }),
        ).toString("base64");
        const handlers = captureHandlers(async (_command, args) => {
          if (args.includes("if-shell")) confirmations++;
          return {
            stdout: args.includes("#{@pi-tmux-session}")
              ? metadata
              : args.includes("display-message")
                ? managedPaneOutput()
                : "",
            stderr: "",
            code: 0,
            killed: false,
          };
        });
        const { ctx } = context();
        await handlers.get("session_shutdown")!({}, ctx);
        assert.equal(confirmations, startup === "ready" ? 1 : 0);
      });
    });
  }

  it("shuts down instead of publishing a mismatched identity", async () => {
    await withManagedEnvironment(async () => {
      let commandCount = 0;
      const handlers = captureHandlers(async () => {
        commandCount++;
        return { stdout: managedPaneOutput(), stderr: "", code: 0, killed: false };
      });
      const { ctx, notifications } = context();
      let shutdownCount = 0;
      Object.assign(ctx, {
        sessionManager: {
          getSessionId() {
            return "wrong-id";
          },
        },
        shutdown() {
          shutdownCount++;
        },
      });
      const previousExitCode = process.exitCode;
      try {
        await handlers.get("startup")!("", ctx);
        assert.equal(process.exitCode, 1);
        assert.equal(shutdownCount, 1);
        assert.equal(commandCount, 1);
        assert.equal(notifications[0]?.type, "error");
      } finally {
        process.exitCode = previousExitCode ?? 0;
      }
    });
  });

  for (const failure of ["unavailable", "denied"] as const) {
    it(`shuts down after a ${failure} process failure`, async () => {
      await withManagedEnvironment(async () => {
        const handlers = captureHandlers(
          failure === "unavailable"
            ? undefined
            : async () => ({ stdout: "", stderr: "denied", code: 1, killed: false }),
        );
        const { ctx, notifications } = context();
        let shutdowns = 0;
        Object.assign(ctx, {
          shutdown() {
            shutdowns++;
          },
        });
        const previousExitCode = process.exitCode;
        try {
          await handlers.get("startup")!("", ctx);
          assert.equal(shutdowns, 1);
          assert.equal(process.exitCode, 1);
          assert.match(
            notifications[0]!.text,
            failure === "unavailable" ? /No process fixture/ : /denied/,
          );
        } finally {
          process.exitCode = previousExitCode ?? 0;
        }
      });
    });
  }

  it("publishes an externally launched dedicated pi without a managed session ID", async () => {
    await withManagedEnvironment(async () => {
      delete process.env.PI_TMUX_STARTUP_COMMAND;
      delete process.env.PI_TMUX_SESSION_ID;
      const commands: string[][] = [];
      const handlers = captureHandlers(async (_command, args) => {
        commands.push(args);
        return {
          stdout: args.includes("display-message") ? managedPaneOutput() : "",
          stderr: "",
          code: 0,
          killed: false,
        };
      });
      const { ctx } = context();
      await handlers.get("resources_discover")!({}, ctx);
      const metadata = JSON.parse(Buffer.from(commands.at(-1)!.at(-1)!, "base64").toString("utf8"));
      assert.equal(metadata.id, "fixed-id");
      assert.equal(metadata.startup, "accepted");
      assert.equal(commands.length, 2);
    });
  });

  it("does not inspect or publish pi outside the dedicated tmux", async () => {
    await withManagedEnvironment(async () => {
      delete process.env.PI_TMUX_STARTUP_COMMAND;
      delete process.env.PI_TMUX_SESSION_ID;
      process.env.TMUX = "/tmp/other-server.sock,123,0";
      const handlers = captureHandlers(async () =>
        assert.fail("Unrelated tmux must not be inspected"),
      );
      const { ctx, notifications } = context();
      await handlers.get("session_start")!({}, ctx);
      await handlers.get("resources_discover")!({}, ctx);
      await handlers.get("session_shutdown")!({}, ctx);
      assert.deepEqual(notifications, []);
    });
  });

  it("registers the state lifecycle once without adding a startup command to ordinary Pi", async () => {
    await withManagedEnvironment(async () => {
      delete process.env.PI_TMUX_STARTUP_COMMAND;
      const registrations: string[] = [];
      extension({
        on(event: string) {
          registrations.push(event);
        },
        registerCommand() {
          assert.fail("Ordinary Pi must not register a pi-mux startup command");
        },
        registerEntryRenderer() {},
      } as unknown as ExtensionAPI);
      assert.deepEqual(registrations, [
        "session_before_switch",
        "session_before_fork",
        "session_start",
        "session_shutdown",
        "resources_discover",
        "session_start",
        "resources_discover",
        "session_info_changed",
        "agent_start",
        "ui_prompt_start",
        "ui_prompt_end",
        "agent_settled",
        "session_shutdown",
      ]);
    });
  });
});

describe("agent message reception", () => {
  const EARLY_ID = "00000000-0000-4000-8000-000000000001";
  const LATE_ID = "00000000-0000-4000-8000-000000000002";

  function messageOptionValue(
    id: string,
    at: string,
    text: string,
    from = "sender-session-id",
  ): string {
    return Buffer.from(JSON.stringify({ v: 1, id, from, at, text })).toString("base64");
  }

  const originalIdentity = `pi-mux-rx:123,%3,${process.pid}`;

  function paneListing(
    options: { name: string; value: string }[],
    finalIdentity = originalIdentity,
  ): string {
    return [
      originalIdentity,
      ...options.map(({ name, value }) => `${name} ${value}`),
      "@pi-tmux-session eyJpZCI6IngifQ==",
      finalIdentity,
    ].join("\n");
  }

  function isPaneOptionListing(args: string[]): boolean {
    return args.at(-1)?.includes(" ; show-options ") === true;
  }

  for (const { name, pending, restart, failure } of [
    { name: "pane inspection finishing after restart", pending: "inspect", restart: true },
    { name: "an option listing arriving after shutdown", pending: "list" },
    { name: "an option listing arriving after restart", pending: "list", restart: true },
    { name: "an option removal finishing after shutdown", pending: "unset" },
    {
      name: "a missing pane reported after restart",
      pending: "list",
      restart: true,
      failure: "no such pane: %3",
    },
    {
      name: "a polling error reported after restart",
      pending: "list",
      restart: true,
      failure: "command failed",
    },
  ]) {
    it(`ignores ${name} from the old watcher`, async () => {
      await withManagedEnvironment(async () => {
        delete process.env.PI_TMUX_STARTUP_COMMAND;
        const file = realpathSync(fileURLToPath(import.meta.url));
        const stat = lstatSync(file, { bigint: true });
        const receipt = Buffer.from(
          JSON.stringify({
            v: 1,
            sessionId: "fixed-id",
            processPid: process.pid,
            file,
            fileIdentity: [stat.dev, stat.ino, stat.birthtimeNs].join(":"),
            responseId: null,
            viewedAt: "2026-11-21T00:00:01.000Z",
          }),
        ).toString("base64");
        const listing = paneListing([
          { name: `@pi-mux-view-${LATE_ID}`, value: receipt },
          { name: "@pi-mux-msg-broken", value: "!!not-base64!!" },
          {
            name: `@pi-mux-msg-${EARLY_ID}`,
            value: messageOptionValue(EARLY_ID, "2026-11-21T00:00:01.000Z", "text"),
          },
        ]);
        const actions: string[] = [];
        const queryStarted = Promise.withResolvers<void>();
        const queryResponse = Promise.withResolvers<Awaited<ReturnType<ExtensionAPI["exec"]>>>();
        let hasDeferred = false;
        const handlers = captureHandlers(
          async (_command, args) => {
            const operation = args.includes("display-message")
              ? "inspect"
              : isPaneOptionListing(args)
                ? "list"
                : "unset";
            actions.push(operation);
            if (operation === pending && !hasDeferred) {
              hasDeferred = true;
              queryStarted.resolve();
              return queryResponse.promise;
            }
            const stdout =
              operation === "inspect" ? managedPaneOutput() : operation === "list" ? listing : "";
            return { stdout, stderr: "", code: 0, killed: false };
          },
          () => {
            actions.push("deliver");
          },
          (type) => {
            actions.push(type);
          },
        );
        const oldTimer = {} as ReturnType<typeof setInterval>;
        const newTimer = {} as ReturnType<typeof setInterval>;
        const interval = spyOn(globalThis, "setInterval")
          .mockReturnValueOnce(oldTimer)
          .mockReturnValue(newTimer);
        const clear = spyOn(globalThis, "clearInterval").mockImplementation(() => {});
        const stderr = spyOn(process.stderr, "write").mockReturnValue(true);
        const { ctx } = context();
        ctx.sessionManager.getSessionFile = () => file;
        try {
          await handlers.get("session_start")!({}, ctx);
          const [pollOld] = interval.mock.calls[0]!;
          const oldPoll = pollOld();
          await queryStarted.promise;
          await handlers.get("session_shutdown")!({}, ctx);
          if (restart) await handlers.get("session_start")!({}, ctx);

          const actionsBeforeResponse = actions.slice();
          queryResponse.resolve({
            stdout: failure ? "" : pending === "inspect" ? managedPaneOutput() : listing,
            stderr: failure ?? "",
            code: failure ? 1 : 0,
            killed: false,
          });
          await oldPoll;
          assert.deepEqual(actions, actionsBeforeResponse);
          assert.deepEqual(clear.mock.calls, [[oldTimer]]);
          assert.deepEqual(stderr.mock.calls, []);

          if (restart) {
            const [pollNew] = interval.mock.calls[1]!;
            await pollNew();
            assert.deepEqual(actions.slice(actionsBeforeResponse.length), [
              "inspect",
              "list",
              "pi-mux-viewed",
              "unset",
              "unset",
              "deliver",
              "unset",
            ]);
          }
        } finally {
          stopMessageWatcher();
          stderr.mockRestore();
          clear.mockRestore();
          interval.mockRestore();
        }
      });
    });
  }

  for (const { name, result, diagnostic, hasInitialStderr } of [
    {
      name: "nonzero exit after listing options",
      result: { code: 7, killed: false },
      diagnostic: "exec_code=7 timeout=no truncated=no",
    },
    {
      name: "nonzero exit with multiline stderr",
      result: { code: 1, killed: false },
      diagnostic: "exec_code=1 timeout=no truncated=no",
      hasInitialStderr: true,
    },
    {
      name: "timeout after listing options",
      result: { code: 143, killed: true },
      diagnostic: "exec_code=143 timeout=yes truncated=no",
    },
    {
      name: "truncated pane options",
      result: { code: 143, killed: true, truncated: true },
      diagnostic: "exec_code=143 timeout=unknown truncated=yes",
    },
    {
      name: "timeout without an exit code from the older SDK",
      result: { code: 0, killed: true },
      diagnostic: "exec_code=unknown timeout=yes truncated=no",
    },
    {
      name: "rejected command without execution data",
      result: undefined,
      diagnostic: "exec_code=unknown timeout=unknown truncated=unknown",
    },
    {
      name: "incomplete listing despite a successful command",
      result: { code: 0, killed: false },
      diagnostic: "tmux show-options: incomplete pane option listing",
    },
  ]) {
    it(`records ${name} once until a successful poll, then records recurrence`, async () => {
      await withManagedEnvironment(async () => {
        let nowMs = 0;
        let listAttempts = 0;
        const handlers = captureHandlers(async (_command, args) => {
          if (args.includes("display-message"))
            return { stdout: managedPaneOutput(), stderr: "", code: 0, killed: false };
          assert.ok(isPaneOptionListing(args));
          listAttempts++;
          nowMs += listAttempts * 1_000;
          if (listAttempts === 3)
            return { stdout: paneListing([]), stderr: "", code: 0, killed: false };
          const payload = `${paneListing([])}\n@mouse-force ${listAttempts}\n@pi-mux-msg-fixture secret`;
          if (!result) throw new Error(payload);
          return {
            ...result,
            stdout: `${payload}\n@label no such pane`,
            stderr: hasInitialStderr || listAttempts > 1 ? payload : "",
          };
        });
        const interval = spyOn(globalThis, "setInterval").mockReturnValue(
          {} as ReturnType<typeof setInterval>,
        );
        const stderr = spyOn(process.stderr, "write").mockReturnValue(true);
        const clock = spyOn(performance, "now").mockImplementation(() => nowMs);
        try {
          await handlers.get("session_start")!({}, context().ctx);
          assert.equal(interval.mock.calls.length, 1);
          const [poll] = interval.mock.calls[0]!;
          await poll();
          await poll();
          await poll();
          await poll();
          const entries = handlers.sessionManager
            .getEntries()
            .filter((entry) => entry.type === "custom");
          assert.equal(listAttempts, 4);
          const commandSucceeded = result?.code === 0 && !result.killed;
          assert.deepEqual(
            entries.map(({ customType, data }) => ({ customType, data })),
            [1_000, 4_000].map((elapsedMs) => ({
              customType: "pi-mux-poll-error",
              data: commandSucceeded
                ? diagnostic
                : `tmux show-options elapsed=${elapsedMs}ms ${diagnostic}`,
            })),
          );
          assert.deepEqual(stderr.mock.calls, []);
        } finally {
          stopMessageWatcher();
          clock.mockRestore();
          stderr.mockRestore();
          interval.mockRestore();
        }
      });
    });
  }

  it("shows a cleanup failure in Pi history without creating a file for an empty conversation", async () => {
    await withManagedEnvironment(async () => {
      const testRoot = "/tmp/work/dotfiles";
      mkdirSync(testRoot, { recursive: true });
      const directory = mkdtempSync(join(testRoot, "poll-history-"));
      const manager = SessionManager.create(directory, directory);
      const file = manager.getSessionFile();
      const option = {
        name: `@pi-mux-msg-${EARLY_ID}`,
        value: messageOptionValue(EARLY_ID, "2026-11-21T00:00:01.000Z", "fixture message"),
      };
      const handlers = captureHandlers(
        async (_command, args) => {
          if (args.includes("display-message"))
            return { stdout: managedPaneOutput(), stderr: "", code: 0, killed: false };
          if (isPaneOptionListing(args))
            return { stdout: paneListing([option]), stderr: "", code: 0, killed: false };
          return { stdout: "", stderr: "fixture option deletion failed", code: 1, killed: false };
        },
        () => {},
        undefined,
        manager,
      );
      const interval = spyOn(globalThis, "setInterval").mockReturnValue(
        {} as ReturnType<typeof setInterval>,
      );
      const stderr = spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        const { ctx } = context();
        await handlers.get("session_start")!({}, ctx);
        const [poll] = interval.mock.calls[0]!;
        await poll();
        await poll();

        const entries = manager.getEntries().filter((entry) => entry.type === "custom");
        assert.equal(entries.length, 1, "Successful listing alone must not reset suppression");
        const entry = entries[0]!;
        assert.equal(entry.customType, "pi-mux-poll-error");
        assert.match(
          String(entry.data),
          /^tmux if-shell elapsed=\d+ms exec_code=1 timeout=no truncated=no$/,
        );
        assert.ok(Number.isFinite(Date.parse(entry.timestamp)));
        const render = handlers.entryRenderers.get(entry.customType);
        assert.ok(render);
        const theme = {} as Parameters<EntryRenderer>[2];
        const displayed = render(entry, { expanded: false }, theme);
        assert.equal(
          displayed?.render(200).join("\n").trimEnd(),
          `${entry.timestamp} pi-mux: message polling failed: ${entry.data}`,
        );
        assert.equal(
          render({ ...entry, data: "text\u001b[2J" }, { expanded: false }, theme),
          undefined,
        );
        assert.deepEqual(stderr.mock.calls, []);
        assert.ok(file && !existsSync(file));

        manager.appendMessage({ role: "user", content: "fixture prompt", timestamp: Date.now() });
        const reopened = SessionManager.open(file);
        assert.deepEqual(
          reopened.getEntries().find((saved) => saved.type === "custom"),
          entry,
        );
        assert.deepEqual(
          reopened.buildSessionContext().messages.map((message) => message.role),
          ["user"],
        );
      } finally {
        stopMessageWatcher();
        stderr.mockRestore();
        interval.mockRestore();
        rmSync(directory, { recursive: true });
      }
    });
  });

  for (const [piVersion, attemptsToSave] of [
    ["1.4.0", false],
    ["1.5.0-beta.1", false],
    ["1.5.0", true],
  ] as const) {
    it(`warns again after recovery on Pi ${piVersion} when diagnostics cannot be saved`, async () => {
      await withManagedEnvironment(async () => {
        let listAttempts = 0;
        const handlers = captureHandlers(
          async (_command, args) => {
            if (args.includes("display-message"))
              return { stdout: managedPaneOutput(), stderr: "", code: 0, killed: false };
            assert.ok(isPaneOptionListing(args));
            if (++listAttempts === 3)
              return { stdout: paneListing([]), stderr: "", code: 0, killed: false };
            return { stdout: "", stderr: "raw command error", code: 1, killed: false };
          },
          undefined,
          undefined,
          undefined,
          piVersion,
        );
        const append = spyOn(handlers.sessionManager, "appendCustomEntry").mockImplementation(
          () => {
            throw new Error("raw storage error");
          },
        );
        const interval = spyOn(globalThis, "setInterval").mockReturnValue(
          {} as ReturnType<typeof setInterval>,
        );
        const stderr = spyOn(process.stderr, "write").mockReturnValue(true);
        try {
          const { ctx, notifications } = context();
          await handlers.get("session_start")!({}, ctx);
          const [poll] = interval.mock.calls[0]!;
          await poll();
          await poll();
          await poll();
          await poll();
          assert.equal(append.mock.calls.length, attemptsToSave ? 2 : 0);
          assert.equal(notifications.length, 2);
          for (const warning of notifications) {
            assert.equal(warning.type, "warning");
            assert.match(
              warning.text,
              /^\d{4}-\S+ pi-mux: message polling failed: tmux show-options elapsed=\d+ms exec_code=1 timeout=no truncated=no(?: \(not saved\))?$/,
            );
            assert.equal(warning.text.endsWith(" (not saved)"), attemptsToSave);
          }
          assert.deepEqual(stderr.mock.calls, []);
        } finally {
          stopMessageWatcher();
          stderr.mockRestore();
          interval.mockRestore();
          append.mockRestore();
        }
      });
    });
  }

  it("receives a message after the connection to the same pane recovers", async () => {
    await withManagedEnvironment(async () => {
      const optionName = `@pi-mux-msg-${EARLY_ID}`;
      const value = messageOptionValue(EARLY_ID, "2026-11-21T00:00:01.000Z", "after recovery");
      const delivered: unknown[] = [];
      let listAttempts = 0;
      const handlers = captureHandlers(
        async (_command, args) => {
          if (args.includes("display-message"))
            return { stdout: managedPaneOutput(), stderr: "", code: 0, killed: false };
          if (!isPaneOptionListing(args)) return { stdout: "", stderr: "", code: 0, killed: false };
          listAttempts++;
          if (listAttempts === 2)
            return {
              stdout: "",
              stderr: "error connecting to socket (Connection refused)",
              code: 1,
              killed: false,
            };
          const options =
            listAttempts === 3
              ? [
                  { name: "@note", value: "multiline option\nERROR: can't find pane: %3" },
                  { name: optionName, value },
                ]
              : [];
          return { stdout: paneListing(options), stderr: "", code: 0, killed: false };
        },
        (message) => delivered.push(message.content),
      );
      const timer = {} as ReturnType<typeof setInterval>;
      const interval = spyOn(globalThis, "setInterval").mockReturnValue(timer);
      const clear = spyOn(globalThis, "clearInterval").mockImplementation(() => {});
      const stderr = spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        await handlers.get("session_start")!({}, context().ctx);
        const [poll] = interval.mock.calls[0]!;
        await poll();
        await poll();
        if (clear.mock.calls.length === 0) await poll();
        assert.deepEqual(delivered, [
          "Message from pi session sender-session-id at 2026-11-21T00:00:01.000Z:\nafter recovery",
        ]);
      } finally {
        stopMessageWatcher();
        stderr.mockRestore();
        clear.mockRestore();
        interval.mockRestore();
      }
    });
  });

  for (const { operation, source } of [
    { operation: "show-options", source: "stderr" },
    { operation: "show-options", source: "stdout" },
    { operation: "show-options", source: "rejection" },
    { operation: "show-options", source: "successful command stdout" },
    { operation: "if-shell", source: "stderr" },
  ] as const) {
    it(`stops polling when ${operation} reports a missing pane in ${source}`, async () => {
      await withManagedEnvironment(async () => {
        const reason = "no such pane: %3";
        const invalidOption = "@pi-mux-msg-broken";
        const delivered: unknown[] = [];
        const attemptedRemovals: unknown[] = [];
        const handlers = captureHandlers(
          async (_command, args) => {
            if (args.includes("display-message"))
              return { stdout: managedPaneOutput(), stderr: "", code: 0, killed: false };
            const isListing = isPaneOptionListing(args);
            if (operation === "if-shell" && isListing)
              return {
                stdout: paneListing([
                  { name: invalidOption, value: "invalid" },
                  {
                    name: `@pi-mux-msg-${LATE_ID}`,
                    value: messageOptionValue(LATE_ID, "2026-11-21T00:00:02.000Z", "late text"),
                  },
                ]),
                stderr: "",
                code: 0,
                killed: false,
              };
            if (operation === "show-options") {
              assert.ok(isListing);
            } else {
              assert.ok(args.includes("if-shell"));
              attemptedRemovals.push(parse(args.at(-1)!).at(-1));
            }
            if (source === "rejection") throw new Error(reason);
            return {
              stdout:
                source === "successful command stdout"
                  ? `${originalIdentity}\nERROR: ${reason}`
                  : source === "stdout"
                    ? reason
                    : "",
              stderr: source === "stderr" ? reason : "",
              code: source === "successful command stdout" ? 0 : 1,
              killed: false,
            };
          },
          (message) => {
            delivered.push(message);
          },
        );
        const timer = {} as ReturnType<typeof setInterval>;
        const interval = spyOn(globalThis, "setInterval").mockReturnValue(timer);
        const clear = spyOn(globalThis, "clearInterval").mockImplementation(() => {});
        const stderr = spyOn(process.stderr, "write").mockReturnValue(true);
        try {
          await handlers.get("session_start")!({}, context().ctx);
          const [poll] = interval.mock.calls[0]!;
          await poll();
          const expectedRemovals = operation === "if-shell" ? [invalidOption] : [];
          assert.deepEqual(attemptedRemovals, expectedRemovals);
          assert.deepEqual(delivered, []);
          assert.deepEqual(clear.mock.calls, [[timer]]);
          assert.deepEqual(stderr.mock.calls, []);
          assert.deepEqual(handlers.sessionManager.getEntries(), []);
        } finally {
          stopMessageWatcher();
          stderr.mockRestore();
          clear.mockRestore();
          interval.mockRestore();
        }
      });
    });
  }

  it("stops watching a replacement that uses the same pane ID", async () => {
    await withManagedEnvironment(async () => {
      const replacementOptions = paneListing(
        [
          {
            name: `@pi-mux-msg-${EARLY_ID}`,
            value: messageOptionValue(EARLY_ID, "2026-11-21T00:00:01.000Z", "replacement"),
          },
          { name: `@pi-mux-view-${LATE_ID}`, value: "e30=" },
        ],
        `pi-mux-rx:123,%3,${process.pid + 1}`,
      );
      let isReplaced = false;
      const handlers = captureHandlers(
        async (_command, args) => {
          if (args.includes("display-message"))
            return { stdout: managedPaneOutput(), stderr: "", code: 0, killed: false };
          assert.ok(isPaneOptionListing(args), "A replacement pane's options must not be removed");
          return {
            stdout: isReplaced ? replacementOptions : paneListing([]),
            stderr: "",
            code: 0,
            killed: false,
          };
        },
        () => assert.fail("A replacement pane must not deliver messages"),
      );
      const timer = {} as ReturnType<typeof setInterval>;
      const interval = spyOn(globalThis, "setInterval").mockReturnValue(timer);
      const clear = spyOn(globalThis, "clearInterval").mockImplementation(() => {});
      const stderr = spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        await handlers.get("session_start")!({}, context().ctx);
        const [poll] = interval.mock.calls[0]!;
        await poll();
        isReplaced = true;
        await poll();
        assert.deepEqual(clear.mock.calls, [[timer]]);
        assert.deepEqual(stderr.mock.calls, []);
      } finally {
        stopMessageWatcher();
        stderr.mockRestore();
        clear.mockRestore();
        interval.mockRestore();
      }
    });
  });

  it("injects valid messages in send order, unsets every option, and ignores foreign options", async () => {
    await withManagedEnvironment(async () => {
      stopMessageWatcher();
      const commands: string[][] = [];
      const delivered: { message: any; options: any }[] = [];
      const pi = {
        exec: async (_command: string, args: string[]) => {
          commands.push(args);
          if (args.includes("display-message"))
            return { stdout: managedPaneOutput(), stderr: "", code: 0, killed: false };
          if (isPaneOptionListing(args))
            return {
              stdout: paneListing([
                {
                  name: `@pi-mux-msg-${LATE_ID}`,
                  value: messageOptionValue(LATE_ID, "2026-11-21T00:00:02.000Z", "late text"),
                },
                { name: "@pi-mux-msg-broken", value: "!!not-base64!!" },
                {
                  name: `@pi-mux-msg-${EARLY_ID}`,
                  value: messageOptionValue(EARLY_ID, "2026-11-21T00:00:01.000Z", "early text"),
                },
              ]),
              stderr: "",
              code: 0,
              killed: false,
            };
          return { stdout: "", stderr: "", code: 0, killed: false };
        },
        sendMessage: (message: unknown, options: unknown) => {
          delivered.push({ message, options });
        },
      };
      await drainAgentMessages(pi as unknown as ExtensionAPI, context().ctx);
      assert.deepEqual(
        delivered.map((entry) => entry.message.content),
        [
          `Message from pi session sender-session-id at 2026-11-21T00:00:01.000Z:\nearly text`,
          `Message from pi session sender-session-id at 2026-11-21T00:00:02.000Z:\nlate text`,
        ],
      );
      assert.equal(delivered[0]!.message.customType, "agent-message");
      assert.equal(delivered[0]!.message.display, true);
      assert.deepEqual(delivered[0]!.message.details, {
        from: "sender-session-id",
        at: "2026-11-21T00:00:01.000Z",
        optionName: `@pi-mux-msg-${EARLY_ID}`,
      });
      assert.deepEqual(delivered[0]!.options, { deliverAs: "steer", triggerTurn: true });
      const unsets = commands.filter(
        (args) => args.includes("if-shell") && !isPaneOptionListing(args),
      );
      assert.equal(unsets.length, 3);
      assert.deepEqual(
        unsets.map((args) => parse(args.at(-1)!)),
        [
          ["set-option", "-pu", "-t", "%3", "@pi-mux-msg-broken"],
          ["set-option", "-pu", "-t", "%3", `@pi-mux-msg-${EARLY_ID}`],
          ["set-option", "-pu", "-t", "%3", `@pi-mux-msg-${LATE_ID}`],
        ],
      );
      assert.deepEqual(
        [...new Set(unsets.map((args) => args.at(-2)))],
        [`#{&&:#{==:#{pid},123},#{==:#{pane_pid},${process.pid}}}`],
      );
      stopMessageWatcher();
    });
  });

  it("does not inspect or deliver outside the dedicated tmux", async () => {
    await withManagedEnvironment(async () => {
      stopMessageWatcher();
      process.env.TMUX = "/tmp/other-server.sock,123,0";
      const pi = {
        exec: async () => assert.fail("An unrelated server must not be inspected"),
        sendMessage: () => assert.fail("No message may be delivered"),
      };
      await drainAgentMessages(pi as unknown as ExtensionAPI, context().ctx);
    });
  });

  for (const failure of [
    "message removal",
    "message injection",
    "invalid option removal",
    "view receipt removal",
  ] as const) {
    it(`delivers later messages despite repeated ${failure} failure`, async () => {
      await withManagedEnvironment(async () => {
        stopMessageWatcher();
        const earlyMessage = `@pi-mux-msg-${EARLY_ID}`;
        const lateMessage = `@pi-mux-msg-${LATE_ID}`;
        const failedOption = {
          "message removal": earlyMessage,
          "message injection": earlyMessage,
          "invalid option removal": "@pi-mux-msg-broken",
          "view receipt removal": `@pi-mux-view-${EARLY_ID}`,
        }[failure];
        const pendingOptions = new Map([
          [
            failedOption,
            failedOption === earlyMessage
              ? messageOptionValue(EARLY_ID, "2026-11-21T00:00:01.000Z", "early text")
              : "invalid",
          ],
          [lateMessage, messageOptionValue(LATE_ID, "2026-11-21T00:00:02.000Z", "late text")],
        ]);
        const injected: string[] = [];
        const injectionFailure = new Error("message injection failed");
        const removalFailure =
          /^Error: tmux if-shell elapsed=\d+ms exec_code=1 timeout=no truncated=no$/;
        const expectedFailure = failure === "message injection" ? injectionFailure : removalFailure;
        const injectedBeforeRecovery =
          failure === "message removal" ? [earlyMessage, lateMessage] : [lateMessage];
        let isFailureActive = true;
        const pi: Parameters<typeof drainAgentMessages>[0] = {
          exec: async (_command, args) => {
            if (args.includes("display-message"))
              return { stdout: managedPaneOutput(), stderr: "", code: 0, killed: false };
            if (isPaneOptionListing(args))
              return {
                stdout: paneListing(
                  Array.from(pendingOptions, ([name, value]) => ({ name, value })),
                ),
                stderr: "",
                code: 0,
                killed: false,
              };
            assert.ok(args.includes("if-shell"));
            const name = String(parse(args.at(-1)!).at(-1));
            if (name === failedOption && isFailureActive && failure !== "message injection")
              return { stdout: "", stderr: "pane option unset denied", code: 1, killed: false };
            assert.ok(pendingOptions.delete(name));
            return { stdout: "", stderr: "", code: 0, killed: false };
          },
          sendMessage(message) {
            const { optionName } = message.details as { optionName: string };
            if (optionName === failedOption && isFailureActive && failure === "message injection")
              throw injectionFailure;
            injected.push(optionName);
          },
          appendEntry: () => assert.fail("An invalid receipt must not be recorded"),
        };
        try {
          const { ctx } = context();
          for (let attempt = 0; attempt < 2; attempt++) {
            await assert.rejects(() => drainAgentMessages(pi, ctx), expectedFailure);
            assert.deepEqual(injected, injectedBeforeRecovery);
            assert.deepEqual([...pendingOptions.keys()], [failedOption]);
          }
          isFailureActive = false;
          await drainAgentMessages(pi, ctx);
          assert.equal(pendingOptions.size, 0);
          const injectedAfterRecovery =
            failure === "message injection" ? [lateMessage, earlyMessage] : injectedBeforeRecovery;
          assert.deepEqual(injected, injectedAfterRecovery);
        } finally {
          stopMessageWatcher();
        }
      });
    });
  }
});
