import assert from "node:assert/strict";
import { readlinkSync } from "node:fs";
import { describe, it } from "bun:test";
import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { parse } from "shell-quote";
import extension, { rejectSessionChange } from "./index.ts";

type Handler = (event: any, ctx: any) => unknown;
let modelRegistry = {} as ExtensionContext["modelRegistry"];

function captureHandlers(execute?: ExtensionAPI["exec"]) {
  const handlers = new Map<string, Handler>();
  const events = createEventBus();
  modelRegistry = {} as ExtensionContext["modelRegistry"];
  extension({
    events,
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
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

function managedPaneOutput(): string {
  return [
    "/tmp/work/dotfiles/pi-mux-unit/pi-tmux/server.sock",
    "123",
    "%3",
    readlinkSync("/proc/self/fd/0"),
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
      const handlers = captureHandlers();
      assert.equal(handlers.has("session_start"), false);
      assert.equal(handlers.has("resources_discover"), false);
      assert.equal(handlers.has("session_before_tree"), false);
      assert.equal(handlers.has("session_before_compact"), false);
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
        assert.equal(
          handlers.has(startup === "accepted" ? "startup" : "resources_discover"),
          false,
        );
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
                  JSON.stringify({ id: "fixed-id", pid: process.pid, startup: "ready" }),
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
          JSON.stringify({ id: "fixed-id", pid: process.pid, startup }),
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
      await handlers.get("resources_discover")!({}, ctx);
      assert.deepEqual(notifications, []);
    });
  });

  it("does not add a startup command to an unmanaged TUI", () => {
    const previous = process.env.PI_TMUX_STARTUP_COMMAND;
    delete process.env.PI_TMUX_STARTUP_COMMAND;
    try {
      assert.deepEqual(
        [...captureHandlers().keys()],
        ["session_before_switch", "session_before_fork", "resources_discover"],
      );
    } finally {
      if (previous !== undefined) process.env.PI_TMUX_STARTUP_COMMAND = previous;
    }
  });
});
