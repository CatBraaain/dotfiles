import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { parse } from "shell-quote";
import { describe, it } from "bun:test";
import type { BackgroundBashOutcome as ToolExecutionOutcome } from "../tools/background-bash.ts";
import {
  dedicatedSocketPath,
  detectManagedPane,
  stateOptionValue,
  publishState,
  unsetStateOption,
  stateCommand,
  processStartTime,
  type BashRunner,
  type ManagedPaneBinding,
} from "./tmux.ts";

const DEDICATED_SOCKET = "/run/user/dedicated/pi-tmux/server.sock";

const verifiedBinding: ManagedPaneBinding = {
  socketPath: DEDICATED_SOCKET,
  serverPid: process.pid,
  paneId: "%0",
  serverStartTime: processStartTime(process.pid),
  pid: process.pid,
  started: processStartTime(process.pid),
};
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

function failedOutcome(error: unknown): ToolExecutionOutcome {
  return { status: "failed", error };
}

function abortedOutcome(): ToolExecutionOutcome {
  return { status: "aborted", reason: new Error("cancelled") };
}

type TmuxKeywordResponse = () => ToolExecutionOutcome | Promise<ToolExecutionOutcome>;

class FakeTmuxServer {
  readonly commands: string[] = [];
  private readonly paneOptions = new Map<string, string>();

  constructor(
    private readonly responses: Partial<Record<string, TmuxKeywordResponse>> = {},
    private readonly socketPath: string = DEDICATED_SOCKET,
  ) {}

  setPaneOption(paneId: string, value: string | undefined): void {
    if (value === undefined) this.paneOptions.delete(paneId);
    else this.paneOptions.set(paneId, value);
  }

  paneOptionOf(paneId: string): string | undefined {
    return this.paneOptions.get(paneId);
  }

  readonly run: BashRunner = async (command) => {
    this.commands.push(command);
    const argv = parse(command) as string[];
    const keyword = argv[0] === "pi-mux" ? "state" : argv[3]!;
    const custom = this.responses[keyword]?.();
    if (custom) return custom;
    if (keyword === "display-message") return completedResult(this.verifiedFieldsLine());
    if (keyword === "state") {
      const source = JSON.parse(argv[argv.indexOf("--source") + 1]!);
      if (argv.includes("--clear")) this.paneOptions.delete(source.pane);
      else
        this.paneOptions.set(
          source.pane,
          stateOptionValue(
            argv[2]!,
            argv[3] as "running",
            JSON.parse(argv[argv.indexOf("--title") + 1]!),
          ),
        );
      return completedResult("");
    }
    return completedResult(`unexpected tmux keyword: ${keyword}`, true);
  };

  private verifiedFieldsLine(): string {
    const fields = [
      this.socketPath,
      String(process.pid),
      "%0",
      readlinkSync("/proc/self/fd/0"),
      String(process.pid),
    ];
    return fields.join("\t");
  }
}

function dedicatedEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    XDG_RUNTIME_DIR: "/run/user/dedicated",
    TMUX: `${DEDICATED_SOCKET},${process.pid}`,
    TMUX_PANE: "%0",
    ...overrides,
  };
}

async function createDedicatedCandidate() {
  mkdirSync("/tmp/work/dotfiles", { recursive: true });
  const runtimeDir = mkdtempSync("/tmp/work/dotfiles/session-state-tmux-unit-");
  const socketPath = join(runtimeDir, "pi-tmux", "server.sock");
  mkdirSync(dirname(socketPath), { recursive: true });
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(socketPath, resolve);
  });
  const env = {
    XDG_RUNTIME_DIR: runtimeDir,
    TMUX: `${socketPath},${process.pid}`,
    TMUX_PANE: "%0",
  };
  return {
    env,
    socketPath,
    async cleanup() {
      await new Promise<void>((resolve) => socket.close(() => resolve()));
      rmSync(runtimeDir, { recursive: true, force: true });
    },
  };
}

describe("dedicatedSocketPath", () => {
  it("builds the absolute path to the dedicated socket from XDG_RUNTIME_DIR", () => {
    assert.equal(
      dedicatedSocketPath({ XDG_RUNTIME_DIR: "/run/user/1000" }),
      "/run/user/1000/pi-tmux/server.sock",
    );
  });

  it("uses /run/user/<uid> when XDG_RUNTIME_DIR is unset", () => {
    assert.equal(dedicatedSocketPath({}), `/run/user/${process.getuid!()}/pi-tmux/server.sock`);
  });
});

describe("state option value", () => {
  it("builds one JSON object with a null title when no name is set", () => {
    assert.equal(
      stateOptionValue("s1", "running"),
      '{"version":1,"sessionId":"s1","state":"running","title":null}',
    );
  });

  it("preserves title text through JSON and shell escaping", async () => {
    const title = "Quoted 'title' \"\n; $(touch /unsafe) #{pane_id}";
    const server = new FakeTmuxServer();
    assert.deepEqual(await publishState(server.run, verifiedBinding, "s1", "running", title), {
      status: "published",
    });
    assert.deepEqual(JSON.parse(server.paneOptionOf("%0")!), {
      version: 1,
      sessionId: "s1",
      state: "running",
      title,
    });
    assert.equal((parse(server.commands[0]!) as string[]).includes("-F"), false);
  });
});

describe("state command builder", () => {
  it("passes source and title as single JSON arguments without tmux expansion", () => {
    const title = "Quoted 'title' \"\n; $(touch /unsafe) #{pane_id}";
    const argv = parse(
      stateCommand(verifiedBinding, "s1", ["running", "--title", JSON.stringify(title)]),
    ) as string[];
    assert.deepEqual(argv.slice(0, 4), ["pi-mux", "state", "s1", "running"]);
    assert.equal(JSON.parse(argv[argv.indexOf("--title") + 1]!), title);
    assert.deepEqual(JSON.parse(argv[argv.indexOf("--source") + 1]!), {
      socket: DEDICATED_SOCKET,
      serverPid: process.pid,
      serverStartTime: verifiedBinding.serverStartTime,
      pane: "%0",
      pid: process.pid,
      started: verifiedBinding.started,
    });
    assert.equal(argv.includes("-F"), false);
  });
});

describe("detectManagedPane", () => {
  it("does not run and treats the environment as unmanaged when TMUX is missing", async () => {
    const server = new FakeTmuxServer();
    const detection = await detectManagedPane(server.run, {
      XDG_RUNTIME_DIR: "/run/user/dedicated",
    });
    assert.deepEqual(detection, { status: "unmanaged" });
    assert.deepEqual(server.commands, []);
  });

  it("does not run and treats a non-dedicated TMUX or missing TMUX_PANE as unmanaged", async () => {
    for (const overrides of [
      { TMUX: "/other/socket,4242" },
      { TMUX_PANE: undefined },
      { TMUX: undefined },
    ] as const) {
      const server = new FakeTmuxServer();
      const detection = await detectManagedPane(server.run, dedicatedEnv(overrides));
      assert.deepEqual(
        detection,
        { status: "unmanaged" },
        `overrides: ${JSON.stringify(overrides)}`,
      );
      assert.deepEqual(server.commands, []);
    }
  });

  it("does not run for a candidate without a socket file", async () => {
    const runtimeDir = mkdtempSync("/tmp/work/dotfiles/session-state-tmux-unit-");
    try {
      const socketPath = join(runtimeDir, "pi-tmux/server.sock");
      const env = {
        XDG_RUNTIME_DIR: runtimeDir,
        TMUX: `${socketPath},${process.pid}`,
        TMUX_PANE: "%0",
      };
      const server = new FakeTmuxServer();
      const detection = await detectManagedPane(server.run, env);
      assert.deepEqual(detection, { status: "unmanaged" });
      assert.deepEqual(server.commands, []);
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("returns a binding as managed when all initial verification fields match", async () => {
    const candidate = await createDedicatedCandidate();
    try {
      const server = new FakeTmuxServer({}, candidate.socketPath);
      const detection = await detectManagedPane(server.run, candidate.env);
      assert.deepEqual(detection, {
        status: "managed",
        binding: { ...verifiedBinding, socketPath: candidate.socketPath },
      });
      assert.equal(server.commands.length, 1);
      const argv = parse(server.commands[0]!) as string[];
      assert.deepEqual(argv.slice(0, 4), ["tmux", "-S", candidate.socketPath, "display-message"]);
      assert.ok(argv.join(" ").includes("#{socket_path}"));
      assert.ok(argv.join(" ").includes("#{pane_pid}"));
    } finally {
      await candidate.cleanup();
    }
  });

  it("does not mark the pane as managed when the server PID, pane ID, PTY, or startup PID does not match", async () => {
    const candidate = await createDedicatedCandidate();
    try {
      const selfPid = process.pid;
      const tty = readlinkSync("/proc/self/fd/0");
      const socketPath = candidate.socketPath;
      const matching = [socketPath, String(process.pid), "%0", tty, String(selfPid)].join("\t");
      const mismatchedReplies = [
        ["serverPid", [socketPath, "9999", "%0", tty, String(selfPid)].join("\t")],
        ["paneId", [socketPath, String(process.pid), "%9", tty, String(selfPid)].join("\t")],
        [
          "paneTty",
          [socketPath, String(process.pid), "%0", "/dev/other/pty", String(selfPid)].join("\t"),
        ],
        ["panePid", [socketPath, String(process.pid), "%0", tty, String(selfPid + 1)].join("\t")],
        ["socket", ["/other/socket", String(process.pid), "%0", tty, String(selfPid)].join("\t")],
        ["shortLine", [socketPath, String(process.pid)].join("\t")],
      ] as const;
      for (const [field, reply] of mismatchedReplies) {
        const server = new FakeTmuxServer(
          { "display-message": () => completedResult(reply) },
          socketPath,
        );
        const detection = await detectManagedPane(server.run, candidate.env, selfPid);
        assert.deepEqual(detection, { status: "unmanaged" }, `field: ${field}`);
      }

      const verified = new FakeTmuxServer(
        { "display-message": () => completedResult(matching) },
        socketPath,
      );
      assert.deepEqual(await detectManagedPane(verified.run, candidate.env, selfPid), {
        status: "managed",
        binding: { ...verifiedBinding, socketPath },
      });
    } finally {
      await candidate.cleanup();
    }
  });

  it("returns distinct failures for verification command execution errors and a missing entry point", async () => {
    const candidate = await createDedicatedCandidate();
    try {
      const failed = new FakeTmuxServer(
        { "display-message": () => failedOutcome(new Error("worker rejected")) },
        candidate.socketPath,
      );
      assert.deepEqual(await detectManagedPane(failed.run, candidate.env), {
        status: "failed",
        message: "worker rejected",
      });

      const absent = new FakeTmuxServer(
        {
          "display-message": () => failedOutcome(new Error("No active background Bash API")),
        },
        candidate.socketPath,
      );
      const absentDetection = await detectManagedPane(absent.run, candidate.env);
      assert.equal(absentDetection.status, "failed");
      assert.match(
        absentDetection.status === "failed" ? absentDetection.message : "",
        /No active background Bash API/,
      );
    } finally {
      await candidate.cleanup();
    }
  });

  it("treats a non-zero exit from the verification command as a failure", async () => {
    const candidate = await createDedicatedCandidate();
    try {
      const server = new FakeTmuxServer(
        { "display-message": () => completedResult("no such server", true) },
        candidate.socketPath,
      );
      assert.deepEqual(await detectManagedPane(server.run, candidate.env), {
        status: "failed",
        message: "no such server",
      });
    } finally {
      await candidate.cleanup();
    }
  });

  it("returns an aborted result when the verification command is aborted", async () => {
    const candidate = await createDedicatedCandidate();
    try {
      const server = new FakeTmuxServer(
        { "display-message": () => abortedOutcome() },
        candidate.socketPath,
      );
      assert.deepEqual(await detectManagedPane(server.run, candidate.env), { status: "aborted" });
    } finally {
      await candidate.cleanup();
    }
  });
});

describe("publishState", () => {
  for (const state of ["running", "waiting-approval", "waiting-user"] as const) {
    it(`publishes ${state} with one set and no read`, async () => {
      const server = new FakeTmuxServer();
      assert.deepEqual(await publishState(server.run, verifiedBinding, "s1", state), {
        status: "published",
      });
      assert.equal(server.commands.length, 1);
      assert.equal(server.paneOptionOf("%0"), stateOptionValue("s1", state));
      assert.equal((parse(server.commands[0]!) as string[]).includes("-F"), false);
    });
  }
  for (const [outcome, expected] of [
    [completedResult("cannot set", true), { status: "failed", message: "cannot set" }],
    [failedOutcome(new Error("rejected")), { status: "failed", message: "rejected" }],
    [
      { status: "unavailable", error: new Error("receiver stopped") },
      { status: "failed", message: "receiver stopped" },
    ],
    [abortedOutcome(), { status: "aborted" }],
  ] as const) {
    it(`propagates ${outcome.status} without another command`, async () => {
      const server = new FakeTmuxServer({ state: () => outcome });
      assert.deepEqual(await publishState(server.run, verifiedBinding, "s1", "running"), expected);
      assert.equal(server.commands.length, 1);
    });
  }
});

describe("unsetStateOption", () => {
  it("removes the pane-local value", async () => {
    const server = new FakeTmuxServer();
    server.setPaneOption("%0", stateOptionValue("s1", "running"));

    const outcome = await unsetStateOption(server.run, verifiedBinding, "s1");

    assert.deepEqual(outcome, { status: "published" });
    assert.equal(server.paneOptionOf("%0"), undefined);
  });

  it("returns distinct results for non-zero exits, execution failures, and aborts", async () => {
    const failed = new FakeTmuxServer({
      state: () => completedResult("cannot unset option", true),
    });
    assert.deepEqual(await unsetStateOption(failed.run, verifiedBinding, "s1"), {
      status: "failed",
      message: "cannot unset option",
    });

    const thrown = new FakeTmuxServer({
      state: () => failedOutcome(new Error("no receiver")),
    });
    assert.deepEqual(await unsetStateOption(thrown.run, verifiedBinding, "s1"), {
      status: "failed",
      message: "no receiver",
    });

    const aborted = new FakeTmuxServer({
      state: () => abortedOutcome(),
    });
    assert.deepEqual(await unsetStateOption(aborted.run, verifiedBinding, "s1"), {
      status: "aborted",
    });
  });
});

describe("pane publication failure boundaries", () => {
  it("rejects a relative runtime or socket path before dispatch", () => {
    assert.throws(() => dedicatedSocketPath({ XDG_RUNTIME_DIR: "relative" }), /must be absolute/);
  });

  it("does not trust a regular file as a managed socket", async () => {
    const runtimeDir = mkdtempSync("/tmp/work/dotfiles/session-state-file-marker-");
    const socketPath = join(runtimeDir, "pi-tmux", "server.sock");
    mkdirSync(dirname(socketPath), { recursive: true });
    writeFileSync(socketPath, "not a socket");
    const server = new FakeTmuxServer({}, socketPath);
    try {
      const env = {
        XDG_RUNTIME_DIR: runtimeDir,
        TMUX: `${socketPath},${process.pid}`,
        TMUX_PANE: "%0",
      };
      assert.deepEqual(await detectManagedPane(server.run, env), { status: "unmanaged" });
      assert.deepEqual(server.commands, []);
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("treats a nonzero structured exit code as failure even without isError", async () => {
    const server = new FakeTmuxServer({
      state: () => ({
        status: "completed",
        result: {
          content: [{ type: "text", text: "nonzero" }],
          details: {},
          structuredContent: { exit_code: 1 },
        },
      }),
    });
    assert.deepEqual(await publishState(server.run, verifiedBinding, "s1", "running"), {
      status: "failed",
      message: "nonzero",
    });
  });

  it("rejects truncated inspection output", async () => {
    const candidate = await createDedicatedCandidate();
    const server = new FakeTmuxServer(
      {
        "display-message": () => ({
          status: "completed",
          result: {
            content: [{ type: "text", text: "partial output" }],
            details: {},
            structuredContent: { truncated: true },
          },
        }),
      },
      candidate.socketPath,
    );
    try {
      assert.deepEqual(await detectManagedPane(server.run, candidate.env), {
        status: "failed",
        message: "Bash output was truncated",
      });
    } finally {
      await candidate.cleanup();
    }
  });
});
