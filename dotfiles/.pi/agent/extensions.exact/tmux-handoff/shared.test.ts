import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  attachCommand,
  cleanEnvironment,
  consumeStartup,
  ensureTmuxDirectories,
  getTmuxPaths,
  handoff,
  inspectManagedPane,
  normalizeSessionArgs,
  pidStartTime,
  publishConnection,
  removeProvisionalSession,
  tmuxArgs,
  type ConnectionRecord,
  type Execute,
} from "./shared.ts";
import { connectionSchema, readPrivateJson } from "./protocol.mjs";

const roots: string[] = [];

function temporaryDirectory(): string {
  mkdirSync("/tmp/work/dotfiles", { recursive: true });
  const root = mkdtempSync("/tmp/work/dotfiles/handoff-unit-");
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function newSession() {
  const root = temporaryDirectory();
  return SessionManager.create(root, join(root, "sessions"), { id: "resolved-session" });
}

describe("resolved session arguments", () => {
  it("keeps a new session lazy while retaining its ID, name, and options", () => {
    const session = newSession();
    session.appendSessionInfo("New session");
    const original = [
      "--provider",
      "fake",
      "--agent",
      "main",
      "--session-id",
      "requested",
      "--name",
      "New session",
      "@input.png",
      "--",
      "-r",
    ];
    const normalized = normalizeSessionArgs(original, session);
    assert.deepEqual(normalized.argv, [
      "--session-id",
      "resolved-session",
      "--session-dir",
      session.getSessionDir(),
      "--name",
      "New session",
      "--provider",
      "fake",
      "--agent",
      "main",
      "@input.png",
      "--",
      "-r",
    ]);
    assert.equal(existsSync(session.getSessionFile()!), false);
  });

  for (const flag of ["--continue", "-c", "--resume", "-r"]) {
    it(`does not repeat selection with ${flag}`, () => {
      const session = newSession();
      const actual = normalizeSessionArgs([flag, "--", "Prompt"], session);
      assert.equal(actual.argv.includes(flag), false);
      assert.equal(actual.argv[1], session.getSessionId());
    });
  }

  it("opens the existing resolved path without forking again", () => {
    const session = newSession();
    const file = session.getSessionFile()!;
    writeFileSync(file, JSON.stringify(session.getHeader()) + "\n");
    const actual = normalizeSessionArgs(
      ["--fork", "/original.jsonl", "--session-id", "forked"],
      session,
    );
    assert.deepEqual(actual.argv, ["--session", file, "--session-dir", session.getSessionDir()]);
  });

  it("retains an explicit missing path through provisional storage", () => {
    const session = newSession();
    const actual = normalizeSessionArgs(["--session", "/requested.jsonl"], session);
    assert.equal(actual.provisionalSessionFile, session.getSessionFile());
    assert.equal(actual.argv[1], session.getSessionFile());
    assert.equal(existsSync(session.getSessionFile()!), false);
  });

  it("preserves session-like values of non-session flags", () => {
    const session = newSession();
    const args = [
      "--system-prompt",
      "--session",
      "--append-system-prompt",
      "-r",
      "--agent=main",
      "--",
      "--fork",
      "literal",
    ];
    const actual = normalizeSessionArgs(args, session);
    assert.deepEqual(actual.argv.slice(4), args);
  });

  it("preserves the ID and name of an ephemeral session", () => {
    const session = SessionManager.inMemory(temporaryDirectory(), { id: "temporary-session" });
    session.appendSessionInfo("Temporary session");
    const actual = normalizeSessionArgs(["--no-session", "--name", "old", "Prompt"], session);
    assert.deepEqual(actual.argv, [
      "--no-session",
      "--session-id",
      "temporary-session",
      "--name",
      "Temporary session",
      "Prompt",
    ]);
  });
});

describe("dedicated transport", () => {
  it("uses an absolute dedicated socket regardless of inherited tmux variables", () => {
    const root = temporaryDirectory();
    const paths = getTmuxPaths({
      XDG_RUNTIME_DIR: root,
      TMUX: "/wrong,2,0",
      TMUX_TMPDIR: "/wrong",
    });
    assert.equal(paths.socketPath, join(root, "pi-tmux/server.sock"));
    assert.deepEqual(tmuxArgs(paths, ["start-server"]), [
      "-S",
      paths.socketPath,
      "-f",
      paths.configPath,
      "start-server",
    ]);
  });

  it("rejects relative runtime directories", () => {
    assert.throws(() => getTmuxPaths({ XDG_RUNTIME_DIR: "relative" }), /must be absolute/);
  });

  it("protects directories and rejects an insecure existing directory", () => {
    const paths = getTmuxPaths({ XDG_RUNTIME_DIR: temporaryDirectory() });
    ensureTmuxDirectories(paths);
    assert.equal(statSync(paths.instancesDir).mode & 0o777, 0o700);
    const unsafe = getTmuxPaths({ XDG_RUNTIME_DIR: temporaryDirectory() });
    mkdirSync(unsafe.directory, { mode: 0o755 });
    assert.throws(() => ensureTmuxDirectories(unsafe), /Unsafe private path/);
  });

  it("removes parent session and terminal metadata but retains user environment", () => {
    const actual = cleanEnvironment({
      PATH: "/bin",
      SECRET: "retained",
      EMPTY: "",
      PI_SESSION_ID: "parent",
      PI_SESSION_FILE: "/parent",
      PI_PROVIDER: "parent",
      PI_MODEL: "parent",
      PI_REASONING_LEVEL: "high",
      TMUX: "old",
      TMUX_PANE: "%1",
      PI_TMUX_HANDOFF: "/old",
      ABSENT: undefined,
    });
    assert.deepEqual(actual, { PATH: "/bin", SECRET: "retained", EMPTY: "" });
  });

  it("requires a live pane matching socket, server, pane, terminal, and PID", async () => {
    const paths = getTmuxPaths({ XDG_RUNTIME_DIR: temporaryDirectory() });
    const oldTmux = process.env.TMUX;
    const oldPane = process.env.TMUX_PANE;
    process.env.TMUX = paths.socketPath + ",42,0";
    process.env.TMUX_PANE = "%3";
    try {
      const terminal = readlinkSync("/proc/self/fd/0");
      const output = [
        paths.socketPath,
        "42",
        "$1",
        "pi",
        "@2",
        "%3",
        terminal,
        String(process.pid),
      ].join("\t");
      function execute(): ReturnType<Execute> {
        return Promise.resolve({ code: 0, stdout: output + "\n", stderr: "", killed: false });
      }
      const pane = await inspectManagedPane(execute, paths, "/bin/tmux");
      assert.equal(pane?.pid, process.pid);
      for (const interrupted of [{ killed: true }, { truncated: true }]) {
        async function incompleteQuery() {
          return commandResult({ stdout: output, ...interrupted });
        }
        await assert.rejects(
          inspectManagedPane(incompleteQuery, paths, "/bin/tmux"),
          /Cannot confirm managed tmux pane/,
        );
      }
      async function wrongPid() {
        return {
          code: 0,
          stdout: output.replace(String(process.pid), "999999999"),
          stderr: "",
          killed: false,
        };
      }
      assert.equal(await inspectManagedPane(wrongPid, paths, "/bin/tmux"), undefined);
      process.env.TMUX = paths.socketPath + ",999,0";
      assert.equal(await inspectManagedPane(execute, paths, "/bin/tmux"), undefined);
    } finally {
      if (oldTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = oldTmux;
      if (oldPane === undefined) delete process.env.TMUX_PANE;
      else process.env.TMUX_PANE = oldPane;
    }
  });

  it("publishes separate private records for multiple instances of one conversation", () => {
    const paths = getTmuxPaths({ XDG_RUNTIME_DIR: temporaryDirectory() });
    ensureTmuxDirectories(paths);
    const record: ConnectionRecord = {
      version: 1,
      instanceId: randomUUID(),
      sessionId: "same-session",
      sessionFile: null,
      socketPath: paths.socketPath,
      serverPid: 42,
      tmuxSessionId: "$1",
      sessionName: "pi",
      windowId: "@1",
      paneId: "%1",
      tty: "/dev/pts/1",
      pid: process.pid,
      pidStartTime: pidStartTime(),
    };
    const first = publishConnection(paths, record);
    const second = publishConnection(paths, { ...record, instanceId: randomUUID(), paneId: "%2" });
    assert.notEqual(first, second);
    assert.deepEqual(readPrivateJson(first, connectionSchema), record);
    assert.equal(statSync(first).mode & 0o777, 0o600);
    assert.equal(readFileSync(first, "utf8").includes("SECRET"), false);
    assert.equal(attachCommand(record), `tmux -S ${paths.socketPath} attach-session -t \\$1`);
  });

  it("rejects symlink records", () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, "target"), "{}", { mode: 0o600 });
    symlinkSync(join(root, "target"), join(root, "link"));
    assert.throws(() => readPrivateJson(join(root, "link"), connectionSchema));
  });

  it("restores pending editor text and removes consumed startup data", () => {
    const paths = getTmuxPaths({ XDG_RUNTIME_DIR: temporaryDirectory() });
    ensureTmuxDirectories(paths);
    const instanceId = randomUUID();
    const directory = join(paths.launchesDir, instanceId);
    mkdirSync(directory, { mode: 0o700 });
    const startup = {
      version: 1,
      instanceId,
      sessionId: "resolved",
      socketPath: paths.socketPath,
      editorText: "Unsent text",
    };
    writeFileSync(join(directory, "startup.json"), JSON.stringify(startup), { mode: 0o600 });
    const previous = process.env.PI_TMUX_HANDOFF;
    process.env.PI_TMUX_HANDOFF = directory;
    try {
      assert.deepEqual(consumeStartup(paths, "resolved"), startup);
      assert.equal(existsSync(directory), false);
      assert.equal(process.env.PI_TMUX_HANDOFF, undefined);
    } finally {
      if (previous === undefined) delete process.env.PI_TMUX_HANDOFF;
      else process.env.PI_TMUX_HANDOFF = previous;
    }
  });

  it("cleans only unsubmitted provisional sessions with the matching ID", () => {
    const file = join(temporaryDirectory(), "session.jsonl");
    const header = { type: "session", id: "created" };
    writeFileSync(file, JSON.stringify(header) + "\n");
    removeProvisionalSession(file, "other");
    assert.equal(existsSync(file), true);
    removeProvisionalSession(file, "created");
    assert.equal(existsSync(file), false);
    writeFileSync(
      file,
      JSON.stringify(header) +
        "\n" +
        JSON.stringify({ type: "message", message: { role: "user" } }) +
        "\n",
    );
    removeProvisionalSession(file, "created");
    assert.equal(existsSync(file), true);
  });
});

type CommandResult = Awaited<ReturnType<Execute>> & { truncated?: boolean };

function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return { code: 0, killed: false, truncated: false, stdout: "", stderr: "", ...overrides };
}

function handoffFixture() {
  const root = temporaryDirectory();
  const paths = getTmuxPaths({ XDG_RUNTIME_DIR: root });
  ensureTmuxDirectories(paths);
  const requested = join(root, "requested.jsonl");
  const session = SessionManager.open(requested, join(root, "sessions"));
  const context = {
    sessionManager: session,
    cwd: root,
    ui: {
      getEditorText() {
        return "Unsent text";
      },
    },
  } as unknown as ExtensionContext;
  return { paths, requested, context };
}

async function runHandoff(
  fixture: ReturnType<typeof handoffFixture>,
  execute: Execute,
): Promise<never> {
  const originalArgv = process.argv;
  process.argv = [process.execPath, fileURLToPath(import.meta.url), "--session", fixture.requested];
  try {
    return await handoff(
      { exec: execute } as ExtensionAPI,
      fixture.context,
      fixture.paths,
      "/bin/tmux",
    );
  } finally {
    process.argv = originalArgv;
  }
}

function reportBackendFailure(paths: ReturnType<typeof getTmuxPaths>): void {
  const [instanceId] = readdirSync(paths.launchesDir);
  writeFileSync(join(paths.launchesDir, instanceId!, "error.json"), "{}", { mode: 0o600 });
}

describe("handoff failure cleanup", () => {
  for (const result of [
    commandResult({ killed: true }),
    commandResult({ code: 1, killed: true, stderr: "can't find session" }),
    commandResult({ code: 1, truncated: true, stderr: "no server running" }),
  ]) {
    it(`retains provisional data when cleanup is incomplete: ${JSON.stringify(result)}`, async () => {
      const fixture = handoffFixture();
      const calls: string[] = [];
      async function execute(_command: string, args: string[]) {
        calls.push(args[4]!);
        if (args[4] === "new-session") {
          reportBackendFailure(fixture.paths);
          return commandResult();
        }
        if (args[4] === "kill-session") return result;
        return commandResult();
      }
      await assert.rejects(runHandoff(fixture, execute), /Backend launch failed/);
      assert.deepEqual(calls, ["new-session", "kill-session"]);
      assert.equal(existsSync(fixture.requested), true);
      assert.deepEqual(readdirSync(fixture.paths.launchesDir), []);
    });
  }

  it("cleans the exact target after an unsuccessful creation response", async () => {
    const fixture = handoffFixture();
    const calls: string[][] = [];
    async function execute(_command: string, args: string[]) {
      calls.push(args);
      return commandResult({ code: args[4] === "new-session" ? 87 : 0 });
    }
    await assert.rejects(runHandoff(fixture, execute), /Cannot create tmux session/);
    assert.deepEqual(
      calls.map((args) => args[4]),
      ["new-session", "kill-session"],
    );
    const createdTarget = calls[0]![calls[0]!.indexOf("-s") + 1];
    const stoppedTarget = calls[1]![calls[1]!.indexOf("-t") + 1];
    assert.equal(stoppedTarget, `=${createdTarget}`);
    assert.equal(existsSync(fixture.requested), false);
  });

  it("retains provisional data when a failed creation response is followed by uncertain cleanup", async () => {
    const fixture = handoffFixture();
    const calls: string[] = [];
    async function execute(_command: string, args: string[]) {
      calls.push(args[4]!);
      return commandResult(args[4] === "new-session" ? { code: 87 } : { killed: true });
    }
    await assert.rejects(runHandoff(fixture, execute), /Cannot create tmux session/);
    assert.deepEqual(calls, ["new-session", "kill-session"]);
    assert.equal(existsSync(fixture.requested), true);
  });

  it("attempts cleanup after the creation request throws", async () => {
    const fixture = handoffFixture();
    const calls: string[] = [];
    async function execute(_command: string, args: string[]) {
      calls.push(args[4]!);
      if (args[4] === "new-session") throw new Error("Creation response unavailable");
      return commandResult();
    }
    await assert.rejects(runHandoff(fixture, execute), /Creation response unavailable/);
    assert.deepEqual(calls, ["new-session", "kill-session"]);
    assert.equal(existsSync(fixture.requested), false);
  });

  it("rejects a killed creation command even when its reported code is zero", async () => {
    const fixture = handoffFixture();
    async function execute(_command: string, args: string[]) {
      if (args[4] === "new-session") {
        reportBackendFailure(fixture.paths);
        return commandResult({ killed: true });
      }
      return commandResult();
    }
    await assert.rejects(runHandoff(fixture, execute), /Cannot create tmux session/);
    assert.equal(existsSync(fixture.requested), false);
  });

  for (const interrupted of [{ killed: true }, { truncated: true }]) {
    it(`rejects an incomplete presence check: ${JSON.stringify(interrupted)}`, async () => {
      const fixture = handoffFixture();
      let presenceChecks = 0;
      async function execute(_command: string, args: string[]) {
        if (args[4] === "has-session") {
          presenceChecks++;
          if (presenceChecks > 1) throw new Error("Unexpected probe retry");
          return commandResult(interrupted);
        }
        return commandResult();
      }
      await assert.rejects(runHandoff(fixture, execute), /Cannot confirm backend tmux session/);
      assert.equal(presenceChecks, 1);
      assert.equal(existsSync(fixture.requested), false);
    });
  }
});
