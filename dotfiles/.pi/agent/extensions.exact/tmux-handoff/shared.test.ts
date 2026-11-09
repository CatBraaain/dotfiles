import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { parse } from "shell-quote";
import { attachCommand, getTmuxPaths, inspectManagedPane, tmuxArgs } from "./shared.ts";

describe("dedicated tmux paths", () => {
  it("uses an absolute dedicated socket independent of TMUX and TMUX_TMPDIR", () => {
    const paths = getTmuxPaths({
      XDG_RUNTIME_DIR: "/isolated runtime",
      TMUX: "/other/socket,1,0",
      TMUX_TMPDIR: "/other",
    });
    assert.equal(paths.socketPath, "/isolated runtime/pi-tmux/server.sock");
    const args = tmuxArgs(paths, ["start-server"]);
    assert.deepEqual(args, ["-S", paths.socketPath, "-f", paths.configPath, "start-server"]);
  });

  it("rejects a relative runtime directory", () => {
    assert.throws(() => getTmuxPaths({ XDG_RUNTIME_DIR: "relative" }), /must be absolute/);
  });

  it("quotes the reconnect target without interpreting shell characters", () => {
    const target = { socketPath: "/isolated runtime/socket", tmuxSessionId: "$2" };
    assert.deepEqual(parse(attachCommand(target)), [
      "tmux",
      "-S",
      target.socketPath,
      "attach-session",
      "-t",
      "$2",
    ]);
  });

  it("does not inspect an unrelated server", async () => {
    const paths = getTmuxPaths({ XDG_RUNTIME_DIR: "/isolated" });
    const pane = await inspectManagedPane(
      async () => {
        assert.fail("An unrelated server must not be queried");
      },
      paths,
      { TMUX: "/other/socket,1,0", TMUX_PANE: "%1" },
    );
    assert.equal(pane, undefined);
  });
});
