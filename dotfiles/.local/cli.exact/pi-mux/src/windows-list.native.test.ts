import { test } from "bun:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const tmux = process.platform === "win32" ? Bun.which("tmux.exe") : null;
const cli = join(import.meta.dir, "main.ts");

async function withPsmux(
  action: (fixture: ReturnType<typeof createPsmuxFixture>) => void | Promise<void>,
) {
  const fixture = createPsmuxFixture();
  try {
    await action(fixture);
  } finally {
    await fixture.cleanup();
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

  function startSession(name: string) {
    query("new-session", "-d", "-s", name, "-c", root, ...paneCommand);
    return publishConversation(`=${name}:0`, name).id;
  }

  function clientSessions() {
    return query("list-clients", "-F", "#{client_pid}|#{client_session}")
      .split("\n")
      .filter(Boolean)
      .sort();
  }

  const attached: { stop: () => Promise<unknown> }[] = [];
  function attach(name: string) {
    const client = Bun.spawn(tmuxArgs(["attach", "-t", `=${name}`]), {
      cwd: root,
      env: { ...env, PSMUX_PIPE_VT: "1", TERM: "xterm-256color" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    const streams = Promise.all([
      client.stdout.pipeTo(new WritableStream()),
      new Response(client.stderr).text(),
    ]);
    attached.push({
      stop: () => {
        if (client.exitCode === null) client.kill();
        return Promise.all([client.exited, streams]);
      },
    });
    return client.pid;
  }

  async function waitForClients(...expected: string[]) {
    const deadline = performance.now() + 5000;
    expected.sort();
    while (performance.now() < deadline) {
      if (clientSessions().join("\n") === expected.join("\n")) return;
      await Bun.sleep(30);
    }
    assert.deepEqual(clientSessions(), expected);
  }

  return {
    root,
    query,
    paneCommand,
    publishConversation,
    startSession,
    clientSessions,
    attach,
    waitForClients,
    list: (...args: string[]) => run([process.execPath, cli, "list", ...args]),
    switchTo: (...args: string[]) => run([process.execPath, cli, "switch", ...args]),
    async cleanup() {
      await Promise.allSettled(attached.map((client) => client.stop()));
      run(tmuxArgs(["kill-server"]));
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

test.skipIf(!tmux)("list succeeds with no active or saved conversations", () =>
  withPsmux(({ list }) => {
    const table = list();
    assert.equal(table.exitCode, 0, table.stderr);
    assert.equal(table.stderr, "");
    assert.match(table.stdout, /^WORKSPACE +SESSION ID +STATE +UPDATED \(UTC\) +TITLE\n$/);
    assert.deepEqual(list("--json"), { exitCode: 0, stdout: "[]\n", stderr: "" });
  }),
);

test.skipIf(!tmux)(
  "list reads pane options from the owning psmux session",
  () =>
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
    }),
  30_000,
);

const switchTestTimeoutMs = 30_000;

test.skipIf(!tmux)(
  "switch moves only the specified client when clients display different sessions",
  () =>
    withPsmux(async ({ startSession, attach, waitForClients, switchTo }) => {
      startSession("one");
      startSession("two");
      const destination = startSession("three");
      const selected = attach("one");
      await waitForClients(`${selected}|one`);
      const other = attach("two");
      await waitForClients(`${selected}|one`, `${other}|two`);

      assert.deepEqual(switchTo(destination, "--client-pid", String(selected)), {
        exitCode: 0,
        stdout: "",
        stderr: "",
      });
      await waitForClients(`${selected}|three`, `${other}|two`);
    }),
  switchTestTimeoutMs,
);

test.skipIf(!tmux)(
  "switch rejects a shared source session even if the requested PID is unique",
  () =>
    withPsmux(async ({ startSession, attach, waitForClients, clientSessions, switchTo }) => {
      startSession("one");
      const destination = startSession("two");
      const selected = attach("one");
      await waitForClients(`${selected}|one`);
      const other = attach("one");
      await waitForClients(`${selected}|one`, `${other}|one`);
      const before = clientSessions();

      const result = switchTo(destination, "--client-pid", String(selected));
      assert.deepEqual(clientSessions(), before);
      assert.equal(result.exitCode, 1, result.stderr);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /Cannot verify a single client in the source psmux session/);
    }),
  switchTestTimeoutMs,
);

test.skipIf(!tmux)(
  "switch rejects a destination whose name is a prefix of another psmux session",
  () =>
    withPsmux(async (fixture) => {
      const { root, query, paneCommand, startSession, attach, waitForClients, switchTo } = fixture;
      startSession("one");
      const destination = startSession("three");
      query("new-session", "-d", "-s", "three-shadow", "-c", root, ...paneCommand);
      const selected = attach("one");
      await waitForClients(`${selected}|one`);

      const result = switchTo(destination, "--client-pid", String(selected));
      assert.deepEqual(fixture.clientSessions(), [`${selected}|one`]);
      assert.equal(result.exitCode, 1, result.stderr);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /Cannot safely switch to psmux session three: three-shadow/);
    }),
  switchTestTimeoutMs,
);

test.skipIf(!tmux)(
  "switch rejects a missing destination and missing or ambiguous clients without moving them",
  () =>
    withPsmux(async ({ startSession, attach, waitForClients, clientSessions, switchTo }) => {
      startSession("one");
      startSession("two");
      const destination = startSession("three");
      const first = attach("one");
      await waitForClients(`${first}|one`);
      const second = attach("two");
      await waitForClients(`${first}|one`, `${second}|two`);
      const before = clientSessions();

      const missingTarget = switchTo(randomUUID(), "--client-pid", String(first));
      assert.equal(missingTarget.exitCode, 2, missingTarget.stderr);
      assert.match(missingTarget.stderr, /Session not found/);
      const missing = switchTo(destination, "--client-pid", String(0xffff_fffc));
      assert.equal(missing.exitCode, 3, missing.stderr);
      assert.match(missing.stderr, /Cannot identify the tmux client/);
      const ambiguous = switchTo(destination, "--client-pid", String(process.pid));
      assert.equal(ambiguous.exitCode, 1, ambiguous.stderr);
      assert.match(ambiguous.stderr, /Cannot identify the tmux client/);
      const noPid = switchTo(destination);
      assert.equal(noPid.exitCode, 1, noPid.stderr);
      assert.match(noPid.stderr, /Expected one attached tmux client, found 2/);
      assert.deepEqual(clientSessions(), before);
    }),
  switchTestTimeoutMs,
);
