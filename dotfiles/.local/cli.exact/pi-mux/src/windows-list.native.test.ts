import { test } from "bun:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const tmux = process.platform === "win32" ? Bun.which("tmux.exe") : null;
const cli = join(import.meta.dir, "main.ts");

function withPsmux(action: (fixture: ReturnType<typeof createPsmuxFixture>) => void) {
  const fixture = createPsmuxFixture();
  try {
    action(fixture);
  } finally {
    fixture.cleanup();
  }
}

function createPsmuxFixture() {
  assert.ok(tmux);
  const root = mkdtempSync(join(tmpdir(), "pi-mux-native-list-"));
  const profile = join(root, "home");
  const config = join(profile, ".config", "psmux", "pi.conf");
  const socket = join(profile, ".local", "state", "pi-tmux", "server.sock");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: profile,
    USERPROFILE: profile,
    PI_CODING_AGENT_DIR: join(root, "agent"),
    PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
    PSMUX_DATA_DIR: join(root, "registry"),
    PSMUX_NO_WARM: "1",
  };
  for (const key of Object.keys(env)) {
    if (/^(TMUX(?:_PANE)?|PSMUX_TARGET_SESSION|PSMUX_TARGET_FULL|PSMUX_ROUTE_WARM)$/i.test(key))
      delete env[key];
  }
  mkdirSync(dirname(config), { recursive: true });
  mkdirSync(env.PSMUX_DATA_DIR!);
  writeFileSync(config, "set -g exit-empty off\n");

  function run(argv: string[]) {
    const result = Bun.spawnSync(argv, {
      cwd: root,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
      windowsHide: true,
    });
    const stdout = result.stdout.toString().replaceAll("\r\n", "\n");
    const stderr = result.stderr.toString().replaceAll("\r\n", "\n");
    return { exitCode: result.exitCode, stdout, stderr };
  }

  function tmuxArgs(args: string[]) {
    return [tmux!, "-S", socket, "-f", config, ...args];
  }

  function query(...args: string[]) {
    const result = run(tmuxArgs(args));
    assert.equal(result.exitCode, 0, `${args[0]}: ${result.stderr}`);
    return result.stdout.trimEnd();
  }

  const paneCommand = [
    "--",
    join(env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    "-NoProfile",
    "-EncodedCommand",
    Buffer.from("Start-Sleep -Seconds 60", "utf16le").toString("base64"),
  ];

  function publishConversation(window: string, title: string) {
    const [pane, pid] = query(
      "display-message",
      "-p",
      "-t",
      window,
      "#{pane_id}\t#{pane_pid}",
    ).split("\t");
    assert.match(pane ?? "", /^%\d+$/);
    assert.match(pid ?? "", /^[1-9]\d*$/);
    const id = randomUUID();
    const file = join(root, `${title}.jsonl`);
    writeFileSync(file, "");
    const target = `${window}.${pane}`;
    const metadata = Buffer.from(JSON.stringify({ id, cwd: root, file, pid: Number(pid) }));
    query("set-option", "-p", "-t", target, "@pi-tmux-session", metadata.toString("base64"));
    const state = { version: 1, sessionId: id, state: "running", title };
    query("set-option", "-p", "-t", target, "@pi_session_state", JSON.stringify(state));
    const publishPending = { attemptAt: Date.now() };
    const pending = { version: 1, sessionId: id, ...publishPending };
    query("set-option", "-p", "-t", target, "@pi_session_state_pending", JSON.stringify(pending));
    return { id, file, state: state.state, title, publishPending };
  }

  return {
    root,
    query,
    paneCommand,
    publishConversation,
    list: (...args: string[]) => run([process.execPath, cli, "list", ...args]),
    cleanup() {
      run(tmuxArgs(["kill-server"]));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test.skipIf(!tmux)("list succeeds with no active or saved conversations", () => {
  withPsmux(({ list }) => {
    const table = list();
    assert.equal(table.exitCode, 0, table.stderr);
    assert.equal(table.stderr, "");
    assert.match(table.stdout, /^WORKSPACE +SESSION ID +STATE +UPDATED \(UTC\) +TITLE\n$/);
    assert.deepEqual(list("--json"), { exitCode: 0, stdout: "[]\n", stderr: "" });
  });
});

test.skipIf(!tmux)(
  "list reads pane options from the owning psmux session",
  () => {
    withPsmux(({ root, query, paneCommand, publishConversation, list }) => {
      query("new-session", "-d", "-s", "first", "-c", root, ...paneCommand);
      query("new-window", "-d", "-t", "=first", "-c", root, ...paneCommand);
      const first = publishConversation("=first:1", "First title");
      query("new-session", "-d", "-s", "second", "-c", root, ...paneCommand);
      const second = publishConversation("=second:0", "Second title");
      function firstActiveWindow() {
        return query("display-message", "-p", "-t", "=first", "#{window_index}");
      }
      assert.equal(firstActiveWindow(), "0");

      const result = list("--json");
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.deepEqual(JSON.parse(result.stdout), [
        {
          cwd: root,
          sessions: [first, second].map((session) => ({
            ...session,
            active: true,
            saved: true,
            btime: null,
            mtime: null,
            size: null,
          })),
        },
      ]);
      assert.equal(firstActiveWindow(), "0");
    });
  },
  30_000,
);
