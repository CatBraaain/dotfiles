import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, spyOn } from "bun:test";
import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { parse } from "shell-quote";
import extension, { drainAgentMessages, rejectSessionChange, stopMessageWatcher } from "./index.ts";

type Handler = (event: any, ctx: any) => unknown;
let modelRegistry = {} as ExtensionContext["modelRegistry"];

function captureHandlers(
  execute?: ExtensionAPI["exec"],
  sendMessage?: ExtensionAPI["sendMessage"],
  appendEntry?: ExtensionAPI["appendEntry"],
) {
  const handlers = new Map<string, Handler>();
  const events = createEventBus();
  modelRegistry = {} as ExtensionContext["modelRegistry"];
  extension({
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
    appendEntry,
  } as unknown as ExtensionAPI);
  return handlers;
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
  };
  const previous = Object.fromEntries(Object.keys(updates).map((key) => [key, process.env[key]]));
  Object.assign(process.env, updates);
  try {
    await test();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const UNIT_TOKEN = randomUUID();

function managedPaneOutput(): string {
  return [
    "/tmp/work/dotfiles/pi-mux-unit/pi-tmux/server.sock",
    "123",
    "%3",
    JSON.stringify({ id: "fixed-id", pid: process.pid, token: UNIT_TOKEN }),
    String(process.pid),
  ].join("\t");
}

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
  ]) {
    it(`reports one line for ${name} even when it happens twice`, async () => {
      await withManagedEnvironment(async () => {
        let nowMs = 0;
        let listAttempts = 0;
        const handlers = captureHandlers(async (_command, args) => {
          if (args.includes("display-message"))
            return { stdout: managedPaneOutput(), stderr: "", code: 0, killed: false };
          assert.ok(isPaneOptionListing(args));
          listAttempts++;
          nowMs += listAttempts * 1_000;
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
          assert.equal(listAttempts, 2);
          assert.deepEqual(stderr.mock.calls, [
            [`pi-mux: message polling failed: tmux show-options elapsed=1000ms ${diagnostic}\n`],
          ]);
        } finally {
          stopMessageWatcher();
          clock.mockRestore();
          stderr.mockRestore();
          interval.mockRestore();
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
