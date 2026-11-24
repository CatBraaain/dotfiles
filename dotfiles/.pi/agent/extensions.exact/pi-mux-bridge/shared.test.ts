import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { parse } from "shell-quote";
import { attachCommand, getTmuxPaths, inspectManagedPane, tmuxArgs } from "./shared.ts";

function launchRecordOf(token: string): string {
  return JSON.stringify({ id: "session", pid: 4242, token });
}

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

  it("uses the global config independently of PI_CODING_AGENT_DIR", () => {
    const defaultPaths = getTmuxPaths({});
    const customPaths = getTmuxPaths({ PI_CODING_AGENT_DIR: "/custom pi agent" });
    const configPath = join(homedir(), ".config", "tmux", "pi.conf");
    assert.equal(defaultPaths.configPath, configPath);
    assert.equal(customPaths.configPath, configPath);
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

  function reply(paths: { socketPath: string }, launch: string, pid = "4242") {
    return async () => ({
      stdout: [paths.socketPath, "123", "%1", launch, pid].join("\t"),
      stderr: "",
      code: 0,
      killed: false,
    });
  }

  it("adopts a pane whose launch record matches the environment token", async () => {
    const paths = getTmuxPaths({ XDG_RUNTIME_DIR: "/isolated" });
    const token = randomUUID();
    const identity = await inspectManagedPane(reply(paths, launchRecordOf(token)), paths, {
      TMUX: paths.socketPath + ",123,0",
      TMUX_PANE: "%1",
      PI_TMUX_LAUNCH_TOKEN: token,
    });
    assert.deepEqual(identity, { pane: "%1", pid: 4242, serverPid: 123 });
  });

  it("adopts a pane without a launch record when no environment token is set", async () => {
    const paths = getTmuxPaths({ XDG_RUNTIME_DIR: "/isolated" });
    const identity = await inspectManagedPane(reply(paths, ""), paths, {
      TMUX: paths.socketPath + ",123,0",
      TMUX_PANE: "%1",
    });
    assert.deepEqual(identity, { pane: "%1", pid: 4242, serverPid: 123 });
  });

  it("does not recognize a pane whose launch record token differs", async () => {
    const paths = getTmuxPaths({ XDG_RUNTIME_DIR: "/isolated" });
    const identity = await inspectManagedPane(reply(paths, launchRecordOf(randomUUID())), paths, {
      TMUX: paths.socketPath + ",123,0",
      TMUX_PANE: "%1",
      PI_TMUX_LAUNCH_TOKEN: randomUUID(),
    });
    assert.equal(identity, undefined);
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

  it("identifies the same Windows socket when psmux uses a forward slash before its label", async () => {
    const socketPath = "C:\\Profile\\.local\\state\\pi-tmux\\server.sock";
    const paths = { socketPath, directory: "C:\\Profile", configPath: "C:\\Profile\\pi.conf" };
    const token = randomUUID();
    const env = { TMUX: `${socketPath},55123,0`, TMUX_PANE: "%1", PI_TMUX_LAUNCH_TOKEN: token };
    const identity = await inspectManagedPane(
      reply(
        { socketPath: "c:\\profile\\.local\\state\\pi-tmux/server.sock" },
        launchRecordOf(token),
      ),
      paths,
      env,
      "win32",
    );
    assert.deepEqual(identity, { pane: "%1", pid: 4242, serverPid: 123 });
    assert.equal(
      await inspectManagedPane(
        reply({ socketPath: "C:\\Other\\server.sock" }, ""),
        paths,
        env,
        "win32",
      ),
      undefined,
    );
  });

  it("uses ~/.local/state on Windows regardless of XDG_RUNTIME_DIR", () => {
    const paths = getTmuxPaths({ XDG_RUNTIME_DIR: "/isolated" }, "win32");
    assert.equal(paths.socketPath, join(homedir(), ".local", "state", "pi-tmux", "server.sock"));
  });
});
