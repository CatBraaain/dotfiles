import assert from "node:assert/strict";
import { readlinkSync } from "node:fs";
import { describe, it } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension, { rejectSessionChange } from "./index.ts";

type Handler = (event: any, ctx: any) => unknown;

function captureHandlers(execute?: ExtensionAPI["exec"]) {
  const handlers = new Map<string, Handler>();
  extension({
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    exec(...args: Parameters<ExtensionAPI["exec"]>) {
      if (!execute) assert.fail("The factory must not run tmux");
      return execute(...args);
    },
  } as unknown as ExtensionAPI);
  return handlers;
}

function context(mode = "tui") {
  const notifications: Array<{ text: string; type: string }> = [];
  const ctx = {
    mode,
    hasUI: true,
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
    XDG_RUNTIME_DIR: "/tmp/work/dotfiles/pimux-unit",
    TMUX: "/tmp/work/dotfiles/pimux-unit/pi-tmux/server.sock,123,0",
    TMUX_PANE: "%3",
    PI_TMUX_SESSION_ID: "fixed-id",
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
    "/tmp/work/dotfiles/pimux-unit/pi-tmux/server.sock",
    "123",
    "%3",
    readlinkSync("/proc/self/fd/0"),
    String(process.pid),
  ].join("\t");
}

describe("fixed conversation identity", () => {
  it("registers only the startup and identity-change hooks", () => {
    const handlers = captureHandlers();
    assert.deepEqual(
      [...handlers.keys()],
      ["session_before_switch", "session_before_fork", "session_start"],
    );
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
      assert.match(notifications[0]!.text, /pimux open/);
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
      const { ctx, notifications } = context(mode);
      assert.equal(rejectSessionChange(ctx), undefined);
      await captureHandlers().get("session_start")!({}, ctx);
      assert.deepEqual(notifications, []);
    });
  }

  it("publishes the verified process and planned session path without creating a file", async () => {
    await withManagedEnvironment(async () => {
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
      Object.assign(ctx, {
        cwd: "/original cwd",
        sessionManager: {
          getSessionId() {
            return "fixed-id";
          },
          getSessionFile() {
            return "/planned/session.jsonl";
          },
        },
      });
      await handlers.get("session_start")!({ reason: "startup" }, ctx);
      const published = commands[1]!;
      assert.ok(published.includes("@pi-tmux-session"));
      const metadata = JSON.parse(Buffer.from(published.at(-1)!, "base64").toString("utf8"));
      assert.deepEqual(metadata, {
        id: "fixed-id",
        file: "/planned/session.jsonl",
        cwd: "/original cwd",
        pid: process.pid,
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
        await handlers.get("session_start")!({ reason: "startup" }, ctx);
        assert.equal(process.exitCode, 1);
        assert.equal(shutdownCount, 1);
        assert.equal(commandCount, 1);
        assert.equal(notifications[0]?.type, "error");
      } finally {
        process.exitCode = previousExitCode ?? 0;
      }
    });
  });

  it("does not launch or replace an unmanaged TUI", async () => {
    const previous = process.env.TMUX;
    const expectedId = process.env.PI_TMUX_SESSION_ID;
    delete process.env.TMUX;
    delete process.env.PI_TMUX_SESSION_ID;
    try {
      const { ctx, notifications } = context();
      Object.assign(ctx, {
        sessionManager: {
          getSessionId() {
            return "unchanged";
          },
        },
      });
      await captureHandlers().get("session_start")!({}, ctx);
      assert.deepEqual(notifications, []);
    } finally {
      if (previous === undefined) delete process.env.TMUX;
      else process.env.TMUX = previous;
      if (expectedId === undefined) delete process.env.PI_TMUX_SESSION_ID;
      else process.env.PI_TMUX_SESSION_ID = expectedId;
    }
  });
});
