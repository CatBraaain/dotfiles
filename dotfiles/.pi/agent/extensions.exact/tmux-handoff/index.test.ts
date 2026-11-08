import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getPackageDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import extension, { isInteractiveCli } from "./index.ts";

describe("tmux handoff lifecycle", () => {
  it("only registers handlers from the factory", () => {
    const events: string[] = [];
    const pi = {
      on(event: string) {
        events.push(event);
      },
      exec() {
        assert.fail("Factory must not execute commands");
      },
    };
    extension(pi as unknown as ExtensionAPI);
    assert.deepEqual(events, ["session_start", "session_shutdown"]);
  });

  for (const mode of ["print", "json", "rpc"] as const) {
    it(`preserves ${mode} sessions without touching terminal or tmux`, async () => {
      const handlers = new Map<string, Function>();
      const pi = {
        on(event: string, handler: Function) {
          handlers.set(event, handler);
        },
        exec() {
          assert.fail("Non-interactive sessions must not execute tmux");
        },
      };
      extension(pi as unknown as ExtensionAPI);
      const ctx = {
        mode,
        ui: {
          custom() {
            assert.fail("Terminal must not be changed");
          },
        },
      };
      await handlers.get("session_start")!({ reason: "startup" }, ctx);
      assert.equal(isInteractiveCli(ctx), false);
    });
  }

  it("preserves unmanaged reloads even when tmux is unavailable", async () => {
    const handlers = new Map<string, Function>();
    const pi = {
      on(event: string, handler: Function) {
        handlers.set(event, handler);
      },
      exec() {
        assert.fail("Unmanaged reloads must not execute tmux");
      },
    };
    extension(pi as unknown as ExtensionAPI);
    const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const oldArgv = process.argv[1];
    const oldPath = process.env.PATH;
    const oldTmux = process.env.TMUX;
    const packageDir = getPackageDir();
    const metadata = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    process.argv[1] = join(packageDir, metadata.bin.pi);
    process.env.PATH = "";
    delete process.env.TMUX;
    try {
      await handlers.get("session_start")!(
        { reason: "reload" },
        {
          mode: "tui",
          ui: {
            custom() {
              assert.fail("Unmanaged reloads must not change the terminal");
            },
          },
        },
      );
    } finally {
      if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
      if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
      process.argv[1] = oldArgv!;
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = oldTmux;
    }
  });

  it("preserves an SDK TUI without real terminal descriptors", () => {
    const ctx = { mode: "tui" } as Pick<ExtensionContext, "mode">;
    if (!process.stdin.isTTY || !process.stdout.isTTY) assert.equal(isInteractiveCli(ctx), false);
  });
});
