import assert from "node:assert/strict";
import { readlinkSync } from "node:fs";
import { describe, it } from "bun:test";
import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { parse } from "shell-quote";
import { registerBackgroundBash } from "../tools/background-bash.ts";
import extension, { rejectSessionChange } from "./index.ts";

type Handler = (event: any, ctx: any) => unknown;

function captureHandlers(execute?: ExtensionAPI["exec"]) {
  const handlers = new Map<string, Handler>();
  const events = createEventBus();
  if (execute)
    registerBackgroundBash(events, async (request) => {
      const [command, ...args] = parse(request.params.command) as string[];
      const result = await execute(command!, args);
      return {
        content: [{ type: "text", text: result.stdout || result.stderr }],
        details: {},
        isError: result.code !== 0 || result.killed,
      };
    });
  extension({
    events,
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, definition: { handler: Handler }) {
      assert.equal(name, process.env.PI_TMUX_STARTUP_COMMAND);
      handlers.set("startup", definition.handler);
    },
    exec() {
      assert.fail("Startup must not bypass background Bash");
    },
  } as unknown as ExtensionAPI);
  return handlers;
}

function context(mode = "tui") {
  const notifications: Array<{ text: string; type: string }> = [];
  const ctx = {
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

describe("fixed conversation identity", () => {
  it("does not publish readiness from an initialization hook", () => {
    const handlers = captureHandlers();
    assert.equal(handlers.has("session_start"), false);
    assert.equal(handlers.has("resources_discover"), false);
    assert.equal(handlers.has("session_before_tree"), false);
    assert.equal(handlers.has("session_before_compact"), false);
    assert.equal(handlers.has("session_shutdown"), false);
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
    it(`shuts down without bypassing ${failure} background Bash`, async () => {
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
            failure === "unavailable" ? /unavailable/ : /denied/,
          );
        } finally {
          process.exitCode = previousExitCode ?? 0;
        }
      });
    });
  }

  it("does not add a startup command to an unmanaged TUI", () => {
    const previous = process.env.PI_TMUX_STARTUP_COMMAND;
    delete process.env.PI_TMUX_STARTUP_COMMAND;
    try {
      assert.deepEqual(
        [...captureHandlers().keys()],
        ["session_before_switch", "session_before_fork"],
      );
    } finally {
      if (previous !== undefined) process.env.PI_TMUX_STARTUP_COMMAND = previous;
    }
  });
});
