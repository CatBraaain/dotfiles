import { test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { INITIAL_REQUEST_DIRECTORY } from "./initial-request-files";
import { metadataFileIdentity } from "./session-metadata";
import { WindowsManagement, windowsManagementScope } from "./windows-management";
import { runWindowsPeerPaneCommands } from "./windows-lifecycle";
import { writeWindowsNpmPiFixture } from "./windows-npm-fixture";
import { isUncPath } from "./windows-pi-command";

const tmux = process.platform === "win32" && Bun.which("tmux.exe");
const id = "6ec4c4f8-3b28-4b3d-ab62-de7790d46e83";
const ticketId = "20301108-140000";
const name = `handle_${ticketId}`;
const prompt = "alpha \"double\" 'single' `backtick` $env:PATH #{pid};\nsecond line 雪";
const main = join(import.meta.dir, "main.ts");
const ticketMain = resolve(import.meta.dir, "../../../../.agents/cli.exact/ticket/src/main.ts");
const uncCwd = import.meta.dir;
const node = process.platform === "win32" && Bun.which("node.exe");
const unpublishedRequest = "leave this Pi unpublished";

const fixturePi = String.raw`
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
if (process.env.PI_MUX_TEST_DIRECT_CAPTURE) {
  writeFileSync(process.env.PI_MUX_TEST_DIRECT_CAPTURE, JSON.stringify({ argv, cwd: process.cwd() }));
  process.exit(0);
}
const [socket] = process.env.TMUX.split(",");
const pane = process.env.TMUX_PANE;
function tmux(...args) {
  return execFileSync("tmux.exe", ["-S", socket, ...args], { encoding: "utf8", windowsHide: true }).trim();
}
const id = process.env.PI_TMUX_SESSION_ID;
if (id) {
  const pid = Number(tmux("display-message", "-p", "-t", pane, "#{pane_pid}"));
  const cwd = process.cwd();
  const file = argv[0] === "--session" ? realpathSync(argv[1]) : join(process.env.PI_CODING_AGENT_SESSION_DIR, id + ".jsonl");
  if (process.env.PI_TMUX_STARTUP_MODE === "create" && !existsSync(file))
    writeFileSync(file, JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: new Date().toISOString() }) + "\n");
  if (argv.includes("--agent")) {
    const capture = join(process.env.PI_CODING_AGENT_SESSION_DIR, id + ".argv.log");
    const request = argv.at(-1);
    const inEnvironment = Object.values(process.env).some((value) => value.includes(request));
    const unpublished = request === ${JSON.stringify(unpublishedRequest)};
    appendFileSync(capture, JSON.stringify({ argv, cwd, inEnvironment, ...(unpublished ? { processPid: process.pid } : {}) }) + "\n");
  }
  const metadata = Buffer.from(JSON.stringify({
    id, cwd, file, pid,
    processPid: process.pid, startup: "ready", token: process.env.PI_TMUX_LAUNCH_TOKEN,
    warm: process.env.PI_TMUX_STARTUP_MODE === "warm",
    reloadReadiness: process.env.PI_MUX_TEST_RELOAD_READINESS === "1" ? "pending" : undefined,
  })).toString("base64");
  if (argv.at(-1) !== ${JSON.stringify(unpublishedRequest)})
    tmux("set-option", "-p", "-t", pane, "@pi-tmux-session", metadata);
} else {
  writeFileSync(process.env.RECEIVED_PATH, JSON.stringify({
    argv, role: process.env.TICKET_DISPATCH_ROLE, project: process.env.TICKET_DISPATCH_PROJECT,
    stale: process.env.PI_TMUX_SESSION_ID, cwd: realpathSync(process.cwd()),
    hardwareCursor: process.env.PI_HARDWARE_CURSOR,
  }));
}
setInterval(() => {}, 1_000);
`;

function json<T>(output: string): T {
  return JSON.parse(output) as T;
}

async function poll(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for the isolated Windows fixture");
    await Bun.sleep(30);
  }
}

test.skipIf(!tmux || !node)(
  "reopens the exact Windows session and gates locked dispatch on the same management generation",
  async () => {
    assert.ok(tmux);
    const root = mkdtempSync(join(tmpdir(), "pi-mux-native-launch-"));
    const profile = join(root, "home");
    const conf = join(profile, ".config", "psmux", "pi.conf");
    const agent = join(profile, ".pi", "agent");
    const extension = join(agent, "extensions", "pi-mux-bridge");
    const data = join(root, "registry");
    const sessions = join(root, "sessions");
    const socket = join(profile, ".local", "state", "pi-tmux", "server.sock");
    const received = join(root, "received.json");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: profile,
      USERPROFILE: profile,
      PI_CODING_AGENT_DIR: agent,
      PI_CODING_AGENT_SESSION_DIR: sessions,
      PSMUX_DATA_DIR: data,
      PSMUX_NO_WARM: "1",
      npm_config_prefix: root,
      PATH: `${root};${dirname(tmux)};${process.env.PATH}`,
      RECEIVED_PATH: received,
      PI_HARDWARE_CURSOR: "0",
    };
    for (const key of Object.keys(env)) {
      if (
        (key.toUpperCase() === "PATH" && key !== "PATH") ||
        /^(TMUX(?:_PANE)?|PSMUX_TARGET_SESSION|PSMUX_TARGET_FULL|PSMUX_ROUTE_WARM)$/i.test(key)
      )
        delete env[key];
    }
    async function run(command: string[]) {
      const child = Bun.spawn(command, {
        env,
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 35_000,
        windowsHide: true,
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout: stdout.trim(), stderr: stderr.trim() };
    }
    async function ok(command: string[]): Promise<string> {
      const output = await run(command);
      assert.equal(output.code, 0, JSON.stringify({ args: command.slice(0, 4), ...output }));
      return output.stdout;
    }
    const muxExe = join(root, "pi-mux.exe");
    const ticketExe = join(root, "ticket.exe");
    const mux = (...args: string[]) => ok([muxExe, ...args]);
    const ticket = (...args: string[]) => ok([ticketExe, "dispatch", ...args]);
    const compile = (source: string, output: string) =>
      ok([process.execPath, "build", "--compile", source, "--outfile", output]);
    try {
      for (const dir of [
        dirname(conf),
        extension,
        data,
        sessions,
        join(profile, ".agents", "tickets", "empty"),
        join(profile, "projects", "empty"),
      ]) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(
        conf,
        "set -g exit-empty off\nset -g remain-on-exit on\nset -g @pi-mux-test-config windows\n",
      );
      writeFileSync(join(extension, "index.ts"), "export default () => {};\n");
      const file = join(sessions, `${id}.jsonl`);
      writeFileSync(
        file,
        JSON.stringify({
          type: "session",
          version: 3,
          id,
          cwd: root,
          timestamp: "2026-10-01T00:00:00Z",
        }) + "\n",
      );
      writeWindowsNpmPiFixture(root, fixturePi);
      await compile(main, muxExe);
      await compile(ticketMain, ticketExe);

      const unavailable = await run([muxExe, "inspect", id]);
      assert.equal(unavailable.code, 1);
      assert.equal(unavailable.stdout, "");
      const start = ["start", "--status", "locked", "--project", "empty"];
      assert.equal((await run([ticketExe, "dispatch", ...start])).code, 1);
      await mux("restore");
      const loadedConfig = await ok([
        tmux,
        "-S",
        socket,
        "display-message",
        "-p",
        "#{@pi-mux-test-config}",
      ]);
      assert.equal(loadedConfig, "windows");
      const serverCursor = await run([
        tmux,
        "-S",
        socket,
        "show-environment",
        "-g",
        "PI_HARDWARE_CURSOR",
      ]);
      assert.equal(serverCursor.stdout, "");
      assert.match(serverCursor.stderr, /unknown variable: PI_HARDWARE_CURSOR/i);
      assert.deepEqual(json(await mux("inspect", id)), { state: "absent", file });
      const args = ["open", "--detached", "--expect-file", file, id];
      const saved = await mux(...args);
      assert.equal(await mux(...args), saved);
      assert.deepEqual(json(await mux("inspect", id)), { state: "present" });
      const dispatch = (owner: string) =>
        mux(
          "inspect",
          "--dispatch-ticket",
          owner,
          socket,
          "dotfiles",
          ticketId,
          name,
          root,
          prompt,
        );
      assert.deepEqual(json(await dispatch(id)), { state: "present" });
      assert.equal(existsSync(received), false);
      assert.equal(json<{ state: string }>(await dispatch("other-owner")).state, "launched");
      await poll(() => existsSync(received));
      assert.deepEqual(await Bun.file(received).json(), {
        argv: ["--", prompt],
        role: "pi",
        project: "dotfiles",
        cwd: root,
        hardwareCursor: "1",
      });
      const sleep = Buffer.from("Start-Sleep -Seconds 90", "utf16le").toString("base64");
      const powerShell = join(
        process.env.SystemRoot!,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const split = (target: string) =>
        ok([
          tmux,
          "-S",
          socket,
          "-f",
          conf,
          "split-window",
          "-d",
          "-t",
          target,
          "--",
          powerShell,
          "-NoProfile",
          "-EncodedCommand",
          sleep,
        ]);
      const managedName = await ok([
        tmux,
        "-S",
        socket,
        "-f",
        conf,
        "list-sessions",
        "-F",
        "#{session_name}",
      ]);
      await split(`=${managedName.split("\n").find((session) => session !== name)!}`);
      await split(`=${name}`);
      assert.deepEqual(json(await mux("inspect", id)), { state: "present" });
      const inventory = json<{ sessions: { name: string; project: string; ticketId: string }[] }>(
        await mux("inspect", "--dispatch-inventory", socket),
      );
      assert.deepEqual(
        inventory.sessions.map(({ name, project, ticketId }) => ({ name, project, ticketId })),
        [{ name, project: "dotfiles", ticketId }],
      );
      const scope = windowsManagementScope({ socket, directory: dirname(socket), env });
      const ledger = join(scope.storageDirectory, "launch-rights.json");
      const recorded = readFileSync(ledger);
      rmSync(ledger);
      try {
        const uncertain = await run([muxExe, "inspect", "--dispatch-inventory", socket]);
        assert.equal(uncertain.code, 1);
        assert.equal(uncertain.stdout, "");
        assert.match(uncertain.stderr, /no verifiable live launch/);
      } finally {
        writeFileSync(ledger, recorded);
      }
      assert.match(await ticket(...start), /dispatcher started/);
      await ticket("stop", "--project", "empty");
      const generation = async () =>
        json<{ generation: string }>(await mux("inspect", "--management", socket)).generation;
      const previous = await generation();
      const sourceName = managedName.split(/\r?\n/).find((session) => session !== name)!;
      const client = Bun.spawn(
        [Bun.which("psmux.exe")!, "-S", socket, "-f", conf, "attach", "-t", `=${sourceName}`],
        {
          env: { ...env, PSMUX_PIPE_VT: "1", PSMUX_CLIENT_DEBUG: "1" },
          cwd: root,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          windowsHide: true,
        },
      );
      const streams = Promise.all([
        new Response(client.stdout).arrayBuffer(),
        new Response(client.stderr).text(),
      ]);
      try {
        await poll(async () =>
          (
            await ok([
              tmux,
              "-S",
              socket,
              "-f",
              conf,
              "list-clients",
              "-t",
              `=${sourceName}`,
              "-F",
              "#{client_pid}",
            ])
          )
            .split(/\r?\n/)
            .includes(String(client.pid)),
        );
        const checking = join(root, "checking");
        const contended = join(root, "contended");
        const preload = join(root, "switch-barrier.ts");
        const key = createHash("sha256").update(scope.lockResource).digest("hex");
        writeFileSync(
          preload,
          `
          import { existsSync, writeFileSync } from "node:fs";
          import { Server } from "node:net";
          const spawn = Bun.spawn;
          Bun.spawn = (argv, options) => {
            if (argv.includes("list-clients") && argv.includes("-t")) {
              writeFileSync(${JSON.stringify(checking)}, "");
              const deadline = performance.now() + 4000;
              while (!existsSync(${JSON.stringify(contended)})) {
                if (performance.now() >= deadline) throw new Error("restart did not contend for the new lock");
                Bun.sleepSync(10);
              }
            }
            const switching = argv.includes("switch-client");
            if (!switching && !argv.includes("list-clients")) return spawn(argv, options);
            const child = spawn(argv, switching ? { ...options, env: { ...options.env, PSMUX_ROUTE_DEBUG: "1" } } : options);
            const [stdout, capturedOut] = child.stdout.tee();
            const [stderr, capturedErr] = child.stderr.tee();
            const exited = Promise.all([child.exited, new Response(capturedOut).text(), new Response(capturedErr).text()]).then(([code, out, err]) => {
              console.error(JSON.stringify({ argv: argv.slice(5), code, out, err }));
              return code;
            });
            return { stdout, stderr, exited };
          };
          const listen = Server.prototype.listen;
          Server.prototype.listen = function(address, ...args) {
            if (process.argv.includes("restart") && typeof address === "string" && address.endsWith(${JSON.stringify(key)}))
              this.once("error", error => { if (error.code === "EADDRINUSE") writeFileSync(${JSON.stringify(contended)}, ""); });
            return listen.call(this, address, ...args);
          };
        `,
        );
        const command = [process.execPath, "--preload", preload, main];
        const switching = run([...command, "new", "--client-pid", String(client.pid)]);
        await poll(() => existsSync(checking));
        const clients = await run([
          tmux,
          "-S",
          socket,
          "-f",
          conf,
          "list-clients",
          "-F",
          "#{client_pid}|#{client_session}|#{pid}|#{server_instance}",
        ]);
        const restarting = run([...command, "restart", "--force"]);
        const [switched, restarted] = await Promise.all([switching, restarting]);
        if (switched.code !== 0) {
          client.kill();
          const [output, stderr] = await streams;
          const log = join(data, "client_reconnect.log");
          assert.fail(
            JSON.stringify({
              switched,
              sourceName,
              clientPid: client.pid,
              generation: previous,
              clients,
              outputTail: Buffer.from(output).subarray(-512).toString(),
              stderr,
              reconnect: existsSync(log) ? readFileSync(log, "utf8").slice(-2000) : null,
            }),
          );
        }
        assert.match(switched.stdout, /Attach with:/);
        assert.ok(existsSync(contended));
        assert.equal(restarted.code, 0, JSON.stringify(restarted));
      } finally {
        client.kill();
        await Promise.all([client.exited, streams]);
      }
      const beforeNormal = await generation();
      assert.notEqual(beforeNormal, previous);
      assert.deepEqual(json(await mux("inspect", id)), { state: "present" });

      const paneFields = () =>
        ok([
          tmux,
          "-S",
          socket,
          "-f",
          conf,
          "list-panes",
          "-a",
          "-F",
          "#{pid}\t#{pane_id}\t#{pane_pid}\t#{@pi-tmux-session}",
        ]);
      const [serverPid, pane, panePid, metadata] = (await paneFields()).split("\t");
      assert.ok(metadata);
      const { processPid, token } = json<{ processPid: number; token: string }>(
        Buffer.from(metadata, "base64").toString("utf8"),
      );
      const source = JSON.stringify({
        socket,
        serverPid: Number(serverPid),
        pane,
        pid: processPid,
        token,
      });
      const notify = (state: string) =>
        mux("state", id, state, "--source", source, "--title", "null");

      await notify("running");
      const restarting = run([muxExe, "restart"]);
      let completed = false;
      void restarting
        .finally(() => {
          completed = true;
        })
        .catch(() => {});
      for (const state of ["running", "waiting-approval"] as const) {
        if (state === "waiting-approval") await notify(state);
        await Bun.sleep(500);
        assert.equal(completed, false, state);
        assert.equal(await generation(), beforeNormal, state);
      }
      await notify("waiting-user");
      const result = await restarting;
      assert.equal(result.code, 0, JSON.stringify(result));
      assert.notEqual(await generation(), beforeNormal);
      assert.deepEqual(json(await mux("inspect", id)), { state: "present" });
      assert.notEqual((await paneFields()).split("\t")[2], panePid);
    } finally {
      await run([tmux, "-S", socket, "-f", conf, "kill-server"]);
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  },
  100_000,
);

test
  .skipIf(!tmux || !node)
  .each([
    "restart",
    "stop --force",
    "stop --force with a snapshot write error",
    "stop --force with a startup record write error",
  ] as const)(
  "%s preserves a Windows conversation launched directly through Node",
  async (command) => {
    assert.ok(tmux);
    const root = mkdtempSync(join(tmpdir(), "pi-mux-native-node-restart-"));
    const conf = join(root, ".config", "psmux", "pi.conf");
    const agent = join(root, ".pi", "agent");
    const extension = join(agent, "extensions", "pi-mux-bridge");
    const socket = join(root, ".local", "state", "pi-tmux", "server.sock");
    const env = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      PI_CODING_AGENT_DIR: agent,
      PI_CODING_AGENT_SESSION_DIR: root,
      PSMUX_DATA_DIR: join(root, "registry"),
      PSMUX_NO_WARM: "1",
      npm_config_prefix: root,
      PATH: `${root};${dirname(tmux)};${process.env.PATH}`,
    };
    for (const key of Object.keys(env)) {
      if (
        (key.toUpperCase() === "PATH" && key !== "PATH") ||
        /^(TMUX(?:_PANE)?|PSMUX_TARGET_SESSION|PSMUX_TARGET_FULL|PSMUX_ROUTE_WARM)$/i.test(key)
      )
        delete (env as NodeJS.ProcessEnv)[key];
    }
    async function run(command: string[]) {
      const result = Bun.spawnSync(command, { env, cwd: root, timeout: 35_000, windowsHide: true });
      assert.equal(result.exitCode, 0, `${command.join(" ")}: ${result.stderr.toString()}`);
      return result.stdout.toString().trim();
    }
    const muxExe = join(root, "pi-mux.exe");
    const mux = (...args: string[]) => run([muxExe, ...args]);
    const tmuxCommand = (...args: string[]) => run([tmux, "-S", socket, "-f", conf, ...args]);
    const panes = () =>
      tmuxCommand(
        "list-panes",
        "-a",
        "-F",
        "#{pid}\t#{pane_id}\t#{pane_pid}\t#{@pi-tmux-session}\t#{@pi-mux-windows-start-right}",
      );
    try {
      for (const dir of [dirname(conf), extension, env.PSMUX_DATA_DIR])
        mkdirSync(dir, { recursive: true });
      writeFileSync(conf, "set -g exit-empty off\nset -g remain-on-exit on\n");
      writeFileSync(join(extension, "index.ts"), "export default () => {};\n");
      const file = join(root, `${id}.jsonl`);
      writeFileSync(
        file,
        JSON.stringify({
          type: "session",
          version: 3,
          id,
          cwd: root,
          timestamp: "2026-10-01T00:00:00Z",
        }) + "\n",
      );
      writeWindowsNpmPiFixture(root, fixturePi);
      await run([process.execPath, "build", "--compile", main, "--outfile", muxExe]);

      await mux("restore");
      await mux("open", "--detached", "--expect-file", file, id);
      await poll(async () => Boolean((await panes()).split("\t")[3]));
      const [serverPid, pane, panePid, metadata, startRight] = (await panes()).split("\t");
      assert.ok(metadata);
      const { processPid, token } = json<{ processPid: number; token: string }>(
        Buffer.from(metadata, "base64").toString("utf8"),
      );
      const scope = windowsManagementScope({ socket, directory: dirname(socket), env });
      const ledger = await Bun.file(join(scope.storageDirectory, "launch-rights.json")).json();
      const childPid = ledger.rights.find((right: { token: string }) => right.token === startRight)
        ?.child.pid;
      assert.ok(childPid);
      assert.equal(childPid, processPid);
      assert.notEqual(childPid, Number(panePid));
      const source = JSON.stringify({
        socket,
        serverPid: Number(serverPid),
        pane,
        pid: processPid,
        token,
      });
      const state = command === "restart" ? "waiting-user" : "running";
      await mux("state", id, state, "--source", source, "--title", "null");
      if (command.endsWith("write error")) {
        const snapshotName = "pi-mux-restore.json";
        const startupName = "startup.json";
        const snapshotPath = join(agent, "pi-tmux", snapshotName);
        const startupPath = join(scope.storageDirectory, startupName);
        const snapshot = JSON.stringify(json(readFileSync(snapshotPath, "utf8")), null, 2);
        writeFileSync(snapshotPath, snapshot);
        const lockSnapshot = command === "stop --force with a snapshot write error";
        const lockedPath = lockSnapshot ? snapshotPath : startupPath;
        const management = await mux("inspect", "--management", socket);
        const result = Bun.spawnSync(
          [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `$ErrorActionPreference = 'Stop'
$lock = [IO.File]::Open($env:PI_MUX_TEST_LOCKED_FILE, 'Open', 'Read', 'Read')
try { & $env:PI_MUX_TEST_EXE stop --force; exit $LASTEXITCODE }
finally { $lock.Dispose() }`,
          ],
          {
            env: { ...env, PI_MUX_TEST_LOCKED_FILE: lockedPath, PI_MUX_TEST_EXE: muxExe },
            cwd: root,
            timeout: 15_000,
            windowsHide: true,
          },
        );
        assert.equal(result.exitCode, 1);
        const error = result.stderr.toString();
        assert.match(error, /rename/);
        assert.ok(error.includes(lockSnapshot ? snapshotName : startupName), error);
        assert.equal(readFileSync(snapshotPath, "utf8"), snapshot);
        assert.equal(await mux("inspect", "--management", socket), management);
        return;
      }
      if (command === "stop --force") {
        await mux("stop", "--force");
        const stopped = Bun.spawnSync([muxExe, "inspect", "--management", socket], {
          env,
          cwd: root,
          timeout: 15_000,
          windowsHide: true,
        });
        assert.equal(stopped.exitCode, 1);
        assert.match(stopped.stderr.toString(), /not restored and running/);
        await mux("restore");
      } else {
        await mux("restart");
      }
      const [restoredServer, , , restoredMetadata] = (await panes()).split("\t");
      assert.notEqual(restoredServer, serverPid);
      assert.ok(restoredMetadata);
      assert.equal(
        json<{ id: string }>(Buffer.from(restoredMetadata, "base64").toString("utf8")).id,
        id,
      );
    } finally {
      Bun.spawnSync([tmux, "-S", socket, "-f", conf, "kill-server"], {
        env,
        cwd: root,
        timeout: 5000,
        windowsHide: true,
      });
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  },
  60_000,
);

test.skipIf(!tmux || !node || !isUncPath(uncCwd))(
  "starts npm pi in the requested UNC directory and keeps that directory on reopen, reload, and restore",
  async () => {
    assert.ok(tmux && node);
    const root = mkdtempSync(join(tmpdir(), "pi-mux-native-unc-"));
    const conf = join(root, ".config", "psmux", "pi.conf");
    const agent = join(root, ".pi", "agent");
    const extension = join(agent, "extensions", "pi-mux-bridge");
    const socket = join(root, ".local", "state", "pi-tmux", "server.sock");
    const registry = join(root, "registry");
    const sessions = join(root, "sessions");
    const muxExe = join(root, "pi-mux.exe");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      PI_CODING_AGENT_DIR: agent,
      PI_CODING_AGENT_SESSION_DIR: sessions,
      PSMUX_DATA_DIR: registry,
      PSMUX_NO_WARM: "1",
      LOCALAPPDATA: root,
      PI_MUX_TEST_RELOAD_READINESS: "1",
      npm_config_prefix: root,
      PATH: `${root};${dirname(tmux)};${dirname(node)};${process.env.PATH}`,
    };
    for (const key of Object.keys(env)) {
      if (
        (key.toUpperCase() === "PATH" && key !== "PATH") ||
        /^(TMUX(?:_PANE)?|PSMUX_TARGET_SESSION|PSMUX_TARGET_FULL|PSMUX_ROUTE_WARM)$/i.test(key)
      )
        delete env[key];
    }
    function run(command: string[], cwd = root) {
      return Bun.spawnSync(command, { cwd, env, timeout: 35_000, windowsHide: true });
    }
    function ok(command: string[], cwd?: string) {
      const result = run(command, cwd);
      assert.equal(result.exitCode, 0, `${command.join(" ")}: ${result.stderr.toString()}`);
      return result.stdout.toString().trim();
    }
    const mux = (...args: string[]) => ok([muxExe, ...args]);
    const tmuxArgs = [tmux, "-S", socket, "-f", conf];
    function verifyPane(expectedId: string) {
      const row = ok([
        ...tmuxArgs,
        "list-panes",
        "-a",
        "-F",
        "#{pid}\t#{pane_id}\t#{pane_dead}\t#{@pi-tmux-session}",
      ]);
      const live = row
        .split(/\r?\n/)
        .map((line) => line.split("\t"))
        .filter(([, , dead, encoded]) => dead === "0" && encoded);
      assert.equal(live.length, 1, row);
      const [serverPid, pane, , encoded] = live[0]!;
      assert.ok(encoded, row);
      const state = json<{ id: string; cwd: string; processPid: number; token: string }>(
        Buffer.from(encoded, "base64").toString("utf8"),
      );
      assert.equal(state.id, expectedId);
      assert.equal(state.cwd, uncCwd);
      const source = {
        socket,
        serverPid: Number(serverPid),
        pane,
        pid: state.processPid,
        token: state.token,
      };
      mux(
        "state",
        expectedId,
        "waiting-user",
        "--source",
        JSON.stringify(source),
        "--title",
        "null",
      );
      return source;
    }
    try {
      for (const directory of [dirname(conf), extension, sessions, registry])
        mkdirSync(directory, { recursive: true });
      writeFileSync(conf, "set -g exit-empty off\nset -g remain-on-exit on\n");
      writeFileSync(join(extension, "index.ts"), "export default () => {};\n");
      ok([process.execPath, "build", "--compile", main, "--outfile", muxExe]);
      writeFileSync(join(root, "pi.cmd"), "@exit /b 42\r\n");
      const missingPackage = run([muxExe, "new", "--detached"], uncCwd);
      assert.notEqual(missingPackage.exitCode, 0);
      assert.match(missingPackage.stderr.toString(), /Cannot resolve npm-installed Windows pi/);
      writeWindowsNpmPiFixture(root, fixturePi);

      const request = "-short \"double\" 'single'\r\nsecond line";
      const output = ok([muxExe, "new", "--detached", request], uncCwd);
      const conversation = /^Pi session (\S+)/.exec(output)?.[1];
      assert.ok(conversation, output);
      const startupSource = verifyPane(conversation);
      const capture = readFileSync(join(sessions, `${conversation}.argv.log`), "utf8")
        .trimEnd()
        .split("\n");
      assert.equal(capture.length, 1);
      const launched = json<{ argv: string[]; cwd: string; inEnvironment: boolean }>(capture[0]!);
      assert.deepEqual(launched, {
        argv: [
          "--session-id",
          conversation,
          "-e",
          join(extension, "index.ts"),
          "--agent",
          "main",
          "--",
          request,
        ],
        cwd: uncCwd,
        inEnvironment: false,
      });
      const header = json<{ cwd: string }>(
        readFileSync(join(sessions, `${conversation}.jsonl`), "utf8"),
      );
      assert.equal(header.cwd, uncCwd);
      mux(
        "state",
        conversation,
        "--startup-input-drained",
        "--source",
        JSON.stringify(startupSource),
      );
      mux("reload", conversation);
      const reloadedSource = verifyPane(conversation);
      assert.notEqual(reloadedSource.token, startupSource.token);
      mux("stop");
      mux("restore");
      const restoredSource = verifyPane(conversation);
      mux("close", "--if-temporary", conversation);
      assert.equal(verifyPane(conversation).token, restoredSource.token);
      mux("close", conversation);
      mux("open", "--temporary", "--detached", conversation);
      const temporarySource = verifyPane(conversation);
      mux("close", "--if-temporary", conversation);
      mux("open", "--detached", conversation);
      assert.notEqual(verifyPane(conversation).token, temporarySource.token);
      env.npm_config_prefix = join(root, "missing-prefix");
      mux("snapshot");
      mux("stop");
      mux("stop");
    } finally {
      run([...tmuxArgs, "kill-server"]);
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  },
  180_000,
);

test.skipIf(!tmux || !node)(
  "preserves long Windows new requests in fresh and running psmux and routes overlapping pane IDs",
  async () => {
    assert.ok(tmux && node);
    const root = mkdtempSync(join(tmpdir(), "pi-mux-native-delivery-"));
    const conf = join(root, ".config", "psmux", "pi.conf");
    const extension = join(root, ".pi", "agent", "extensions", "pi-mux-bridge");
    const socket = join(root, ".local", "state", "pi-tmux", "server.sock");
    const registry = join(root, "registry");
    const sessions = join(root, "sessions");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !/^(TMUX(?:_PANE)?|PSMUX_.*|PI_.*|HOME|USERPROFILE|LOCALAPPDATA|PATH)$/i.test(key),
      ),
    );
    Object.assign(env, {
      HOME: root,
      USERPROFILE: root,
      LOCALAPPDATA: root,
      PI_SESSION_ID: id,
      PI_CODING_AGENT_SESSION_DIR: sessions,
      PSMUX_DATA_DIR: registry,
      PSMUX_NO_WARM: "1",
      npm_config_prefix: root,
      PATH: `${dirname(tmux)};${dirname(node)};${process.env.PATH}`,
    });
    async function run(args: string[], overrides: NodeJS.ProcessEnv = {}) {
      const child = Bun.spawn(args, {
        cwd: root,
        env: { ...env, ...overrides },
        timeout: 30_000,
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    }
    const control = [tmux, "-S", socket, "-f", conf];
    const management = new WindowsManagement({
      socket,
      directory: dirname(socket),
      env,
      async query(args) {
        const result = await run([...control, ...args]);
        return {
          ...result,
          stdout: result.stdout.replaceAll("\r\n", "\n"),
          stderr: result.stderr.replaceAll("\r\n", "\n"),
        };
      },
    });
    async function mux(...args: string[]) {
      return run([process.execPath, main, ...args]);
    }
    try {
      for (const directory of [dirname(conf), extension, sessions, registry])
        mkdirSync(directory, { recursive: true });
      writeFileSync(conf, "set -g exit-empty off\nset -g remain-on-exit on\n");
      writeFileSync(join(extension, "index.ts"), "export default () => {};\n");
      writeWindowsNpmPiFixture(root, fixturePi);
      const piEntry = join(root, "node_modules", "@earendil-works/pi-coding-agent", "cli.js");
      for (const state of ["fresh", "existing"]) {
        const sentinel = `-long-body-${state}`;
        const request = `${sentinel} "double" “curly” 雪\r\n${"'x'".repeat(12_000)}`.slice(
          0,
          24_000,
        );
        const created = await mux("new", "--detached", "--cwd", root, request);
        assert.equal(created.exitCode, 0, created.stderr);
        const createdId = /^Pi session ([a-f0-9-]+)\r?$/m.exec(created.stdout)?.[1];
        assert.ok(createdId, created.stdout);
        const capture = join(sessions, `${createdId}.argv.log`);
        await poll(() => existsSync(capture));

        const directCapture = join(root, "direct-argv.json");
        const direct = await run(
          [
            node,
            piEntry,
            "--session-id",
            createdId,
            "-e",
            join(extension, "index.ts"),
            "--agent",
            "main",
            "--",
            request,
          ],
          { PI_MUX_TEST_DIRECT_CAPTURE: directCapture },
        );
        assert.equal(direct.exitCode, 0, direct.stderr);
        const lines = readFileSync(capture, "utf8").trimEnd().split("\n");
        assert.equal(lines.length, 1);
        const launched = json<{ argv: string[]; cwd: string; inEnvironment: boolean }>(lines[0]!);
        const expected = json<{ argv: string[]; cwd: string }>(readFileSync(directCapture, "utf8"));
        assert.equal(expected.argv.at(-1) === request, true);
        assert.equal(JSON.stringify(launched.argv) === JSON.stringify(expected.argv), true);
        assert.equal(launched.cwd, expected.cwd);
        assert.equal(launched.inEnvironment, false);
        assert.deepEqual(readdirSync(join(root, INITIAL_REQUEST_DIRECTORY)), []);
        const ledger = readFileSync(
          join(management.scope.storageDirectory, "launch-rights.json"),
          "utf8",
        );
        assert.equal(ledger.includes(sentinel) || ledger.includes("command"), false);
      }
      const observation = await management.audit("#{pane_id}\t#{@pi-tmux-session}");
      const peers = observation.panes.filter(({ peer }) => !peer.held);
      assert.equal(peers.length, 2);
      const [other, target] = [peers[0]!, peers[1]!];
      const [pane, metadata] = target.rows[0]!.split("\t");
      assert.ok(pane && metadata);
      assert.equal(other.rows[0]!.split("\t")[0], pane);
      const conversation = json<{ id: string; file: string; processPid: number }>(
        Buffer.from(metadata, "base64").toString(),
      );
      async function paneCommand(peer: typeof target.peer, ...args: string[]) {
        return runWindowsPeerPaneCommands(management.scope, observation, peer, pane!, [args]);
      }
      function options(peer: typeof target.peer) {
        return paneCommand(peer, "show-options", "-p", "-t", pane!);
      }
      async function pendingOption(prefix: string) {
        const pattern = new RegExp(`^(${prefix}[-a-f0-9]+) ([A-Za-z0-9+/=]+)$`, "m");
        let match: RegExpMatchArray | undefined;
        await poll(async () => {
          match = (await options(target.peer)).match(pattern) ?? undefined;
          return match !== undefined;
        });
        const option = match?.[1];
        const value = match?.[2];
        assert.ok(option && value);
        return { option, value };
      }
      async function consume(prefix: string) {
        const { option, value } = await pendingOption(prefix);
        await paneCommand(target.peer, "set-option", "-pu", "-t", pane!, option);
        return json<Record<string, unknown>>(Buffer.from(value, "base64").toString());
      }
      const text = `-literal '" \\ 日本語\n${"🌏".repeat(2780)}`;
      const sent = await mux("send", conversation.id, text);
      assert.equal(sent.exitCode, 0, sent.stderr);
      assert.equal(sent.stdout, "");
      const envelope = await consume("@pi-mux-msg-");
      assert.equal(envelope.text, text);
      assert.equal(envelope.from, id);

      const waitText = "wait for consumption";
      const [waited, waitedEnvelope] = await Promise.all([
        mux("send", "--wait", "6", conversation.id, waitText),
        consume("@pi-mux-msg-"),
      ]);
      assert.equal(waited.exitCode, 0, waited.stderr);
      assert.equal(waited.stdout.trim(), "delivered");
      assert.equal(waitedEnvelope.text, waitText);
      assert.equal(waitedEnvelope.from, id);

      const receipt = {
        file: conversation.file,
        fileIdentity: metadataFileIdentity(conversation.file),
        responseId: null,
        viewedAt: "2026-11-26T00:00:00.000Z",
      };
      const [recorded, viewed] = await Promise.all([
        mux("record-view", conversation.id, JSON.stringify(receipt)),
        consume("@pi-mux-view-"),
      ]);
      assert.equal(recorded.exitCode, 0, recorded.stderr);
      assert.deepEqual(viewed, {
        ...receipt,
        v: 1,
        sessionId: conversation.id,
        processPid: conversation.processPid,
      });
      const timedOut = await mux("record-view", conversation.id, JSON.stringify(receipt));
      assert.equal(timedOut.exitCode, 1);
      assert.match(timedOut.stderr, /View receipt not consumed .*: timeout/);
      assert.doesNotMatch(await options(target.peer), /^@pi-mux-view-/m);

      const waiting = mux("send", "--wait", "6", conversation.id, "target replacement");
      const { option } = await pendingOption("@pi-mux-msg-");
      const replacementMetadata = other.rows[0]!.split("\t")[1];
      assert.ok(replacementMetadata);
      await paneCommand(
        target.peer,
        "set-option",
        "-p",
        "-t",
        pane,
        "@pi-tmux-session",
        replacementMetadata,
      );
      await paneCommand(target.peer, "set-option", "-pu", "-t", pane, option);
      const replaced = await waiting;
      assert.equal(replaced.exitCode, 1);
      assert.equal(replaced.stdout, "");
      assert.match(replaced.stderr, /Target pane disappeared before consuming @pi-mux-msg-/);

      await paneCommand(target.peer, "set-option", "-p", "-t", pane, "@pi-tmux-session", metadata);
      const waitForRemovedPeer = mux("send", "--wait", "6", conversation.id, "target removal");
      const pendingRemoval = await pendingOption("@pi-mux-msg-");
      const stopped = await run([...control, "kill-session", "-t", `=${target.peer.name}`]);
      assert.equal(stopped.exitCode, 0, stopped.stderr);
      const removed = await waitForRemovedPeer;
      assert.equal(removed.exitCode, 1);
      assert.equal(removed.stdout, "");
      assert.ok(
        removed.stderr.includes(`Cannot inspect ${pendingRemoval.option} in the target pane`) ||
          removed.stderr.includes(
            `Target pane disappeared before consuming ${pendingRemoval.option}`,
          ),
        removed.stderr,
      );
      const sessionsAfterRemoval = await run([
        ...control,
        "list-sessions",
        "-F",
        "#{session_name}",
      ]);
      assert.equal(sessionsAfterRemoval.exitCode, 0, sessionsAfterRemoval.stderr);
      assert.deepEqual(sessionsAfterRemoval.stdout.trim().split(/\r?\n/), [other.peer.name]);
      const otherOptions = await options(other.peer);
      assert.match(otherOptions, /^@pi-tmux-session /m);
      assert.doesNotMatch(otherOptions, /^@pi-mux-(msg|view)-/m);

      const unverifiedParent = join(root, `unverified-${randomUUID()}`);
      const unverifiedStorage = join(unverifiedParent, INITIAL_REQUEST_DIRECTORY);
      mkdirSync(unverifiedStorage, { recursive: true });
      const filesBefore = readdirSync(sessions);
      const rejected = await run(
        [process.execPath, main, "new", "--detached", "must not be launched"],
        { LOCALAPPDATA: unverifiedParent },
      );
      assert.equal(rejected.exitCode, 1, rejected.stderr);
      assert.match(rejected.stderr, /Cannot verify a private Windows initial-request directory/);
      assert.deepEqual(readdirSync(unverifiedStorage), []);
      assert.deepEqual(readdirSync(sessions), filesBefore);
    } finally {
      const listed = await run([...control, "list-sessions", "-F", "#{session_name}"]);
      for (const session of listed.stdout.trim().split(/\r?\n/).filter(Boolean))
        await run([...control, "kill-session", "-t", `=${session}`]);
      await run([...control, "kill-server"]);
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  },
  80_000,
);

test.skipIf(!tmux || !node)(
  "reuses the earlier warm Pi when Windows peers share a pane ID",
  async () => {
    await withWindowsPeers(async ({ create, panes }) => {
      const warmId = await create();
      const otherId = await create("existing conversation");
      const before = await panes();
      const warm = before.find((pane) => pane.id === warmId);
      const other = before.find((pane) => pane.id === otherId);
      assert.ok(warm?.processPid && other?.processPid);
      assert.notEqual(warm.peer, other.peer);
      assert.equal(warm.pane, other.pane);

      assert.equal(await create(), warmId);
      assert.deepEqual(await panes(), before);
    });
  },
  45_000,
);

test.skipIf(!tmux || !node)(
  "closes only the timed-out Windows Pi when peers share a pane ID",
  async () => {
    await withWindowsPeers(async ({ create, mux, panes, requestProcessPid }) => {
      const otherId = await create("existing conversation");
      const timedOut = await mux("new", "--detached", unpublishedRequest);
      assert.equal(timedOut.exitCode, 1, timedOut.stderr);
      assert.match(timedOut.stderr, /startup timed out/);
      const before = await panes();
      const pending = before.find((pane) => !pane.processPid);
      const other = before.find((pane) => pane.id === otherId);
      assert.ok(pending && other?.processPid);
      assert.notEqual(pending.peer, other.peer);
      assert.equal(pending.pane, other.pane);
      const pendingPiPid = requestProcessPid(pending.id);
      assert.equal(process.kill(pendingPiPid, 0), true);

      const closed = await mux("close", pending.id);
      assert.equal(closed.exitCode, 0, closed.stderr);
      assert.deepEqual(await panes(), [other]);
      assert.throws(() => process.kill(pending.panePid, 0), { code: "ESRCH" });
      assert.throws(() => process.kill(pendingPiPid, 0), { code: "ESRCH" });
      assert.equal(process.kill(other.processPid, 0), true);
    });
  },
  110_000,
);

async function withWindowsPeers(
  check: (fixture: ReturnType<typeof windowsPeerFixture>) => Promise<void>,
) {
  const fixture = windowsPeerFixture();
  try {
    await check(fixture);
  } finally {
    await fixture.cleanup();
  }
}

function windowsPeerFixture() {
  assert.ok(tmux && node);
  const root = mkdtempSync(join(tmpdir(), "pi-mux-native-peer-scope-"));
  const conf = join(root, ".config", "psmux", "pi.conf");
  const extension = join(root, ".pi", "agent", "extensions", "pi-mux-bridge");
  const socket = join(root, ".local", "state", "pi-tmux", "server.sock");
  const registry = join(root, "registry");
  const sessions = join(root, "sessions");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(TMUX(?:_PANE)?|PSMUX_.*|PI_.*|HOME|USERPROFILE|LOCALAPPDATA|PATH)$/i.test(key),
    ),
  );
  Object.assign(env, {
    HOME: root,
    USERPROFILE: root,
    LOCALAPPDATA: root,
    PI_CODING_AGENT_SESSION_DIR: sessions,
    PSMUX_DATA_DIR: registry,
    PSMUX_NO_WARM: "1",
    npm_config_prefix: root,
    PATH: `${dirname(tmux)};${dirname(node)};${process.env.PATH}`,
  });
  async function run(args: string[]) {
    const child = Bun.spawn(args, {
      cwd: root,
      env,
      timeout: 90_000,
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return {
      exitCode,
      stdout: stdout.replaceAll("\r\n", "\n"),
      stderr: stderr.replaceAll("\r\n", "\n"),
    };
  }
  const control = [tmux, "-S", socket, "-f", conf];
  const management = new WindowsManagement({
    socket,
    directory: dirname(socket),
    env,
    query: (args) => run([...control, ...args]),
  });
  for (const directory of [dirname(conf), extension, sessions, registry])
    mkdirSync(directory, { recursive: true });
  writeFileSync(conf, "set -g exit-empty off\nset -g remain-on-exit on\n");
  writeFileSync(join(extension, "index.ts"), "export default () => {};\n");
  writeWindowsNpmPiFixture(root, fixturePi);

  function mux(...args: string[]) {
    return run([process.execPath, main, ...args]);
  }
  async function create(request?: string) {
    const result = await mux("new", "--detached", ...(request === undefined ? [] : [request]));
    assert.equal(result.exitCode, 0, result.stderr);
    const createdId = /^Pi session ([a-f0-9-]+)$/m.exec(result.stdout)?.[1];
    assert.ok(createdId, result.stdout);
    return createdId;
  }
  async function panes() {
    const observation = await management.audit(
      "#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{@pi-mux-launch}\t#{@pi-tmux-session}",
    );
    return observation.panes.flatMap(({ peer, rows }) =>
      rows.flatMap((row) => {
        const [pane, pid, dead, launch, metadata] = row.split("\t");
        if (peer.held || dead === "1") return [];
        assert.ok(pane && pid && launch);
        const { id } = json<{ id: string }>(launch);
        const processPid = metadata
          ? json<{ processPid: number }>(Buffer.from(metadata, "base64").toString()).processPid
          : undefined;
        return [{ id, peer: peer.identity, pane, panePid: Number(pid), processPid }];
      }),
    );
  }
  async function cleanup() {
    const listed = await run([...control, "list-sessions", "-F", "#{session_name}"]);
    for (const session of listed.stdout.trim().split("\n").filter(Boolean))
      await run([...control, "kill-session", "-t", `=${session}`]);
    await run([...control, "kill-server"]);
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
  function requestProcessPid(id: string) {
    const capture = readFileSync(join(sessions, `${id}.argv.log`), "utf8").trim();
    return json<{ processPid: number }>(capture).processPid;
  }
  return { create, mux, panes, cleanup, requestProcessPid };
}

for (const hasSavedMatch of [false, true]) {
  test.skipIf(!tmux || !node)(
    `Windows open rejects a case-only live ID mismatch ${hasSavedMatch ? "with" : "without"} an exact saved match`,
    async () => {
      assert.ok(tmux && node);
      const root = mkdtempSync(join(tmpdir(), "pi-mux-native-open-id-"));
      const conf = join(root, ".config", "psmux", "pi.conf");
      const extension = join(root, ".pi", "agent", "extensions", "pi-mux-bridge");
      const socket = join(root, ".local", "state", "pi-tmux", "server.sock");
      const registry = join(root, "registry");
      const sessions = join(root, "sessions");
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            !/^(TMUX(?:_PANE)?|PSMUX_.*|PI_.*|HOME|USERPROFILE|LOCALAPPDATA|PATH)$/i.test(key),
        ),
      );
      Object.assign(env, {
        HOME: root,
        USERPROFILE: root,
        LOCALAPPDATA: root,
        PI_CODING_AGENT_SESSION_DIR: sessions,
        PSMUX_DATA_DIR: registry,
        PSMUX_NO_WARM: "1",
        npm_config_prefix: root,
        PATH: `${dirname(tmux)};${dirname(node)};${process.env.PATH}`,
      });
      async function run(args: string[]) {
        const child = Bun.spawn(args, {
          cwd: root,
          env,
          stdout: "pipe",
          stderr: "pipe",
          timeout: 30_000,
          windowsHide: true,
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return { exitCode, stdout, stderr };
      }
      const control = [tmux, "-S", socket, "-f", conf];
      async function mux(...args: string[]) {
        return await run([process.execPath, main, ...args]);
      }
      try {
        for (const directory of [dirname(conf), extension, sessions, registry])
          mkdirSync(directory, { recursive: true });
        writeFileSync(conf, "set -g exit-empty off\nset -g remain-on-exit on\n");
        writeFileSync(join(extension, "index.ts"), "export default () => {};\n");
        writeWindowsNpmPiFixture(root, fixturePi);
        const created = await mux("new", "--detached", "--cwd", root, "existing conversation");
        assert.equal(created.exitCode, 0, created.stderr);
        const liveId = /^Pi session ([a-f0-9-]+)\r?$/m.exec(created.stdout)?.[1];
        assert.ok(liveId, created.stdout);
        const requestedId = liveId.toUpperCase();
        assert.notEqual(requestedId, liveId);

        if (hasSavedMatch) {
          const savedHeader = {
            type: "session",
            version: 3,
            id: requestedId,
            cwd: root,
            timestamp: new Date().toISOString(),
          };
          writeFileSync(
            join(sessions, "separate-saved-conversation.jsonl"),
            `${JSON.stringify(savedHeader)}\n`,
          );
          const saved = await mux("metadata", requestedId);
          assert.equal(saved.exitCode, 0, saved.stderr);
        }

        const opened = await mux("open", "--detached", requestedId);
        assert.equal(opened.exitCode, 1, opened.stdout);
        assert.equal(opened.stdout, "");
        assert.match(
          opened.stderr,
          hasSavedMatch ? /A competing Windows pi launch is still running/ : /Session not found/,
        );

        const reopened = await mux("open", "--detached", liveId);
        assert.equal(reopened.exitCode, 0, reopened.stderr);
        assert.equal(reopened.stdout, created.stdout);
        const listed = await run([...control, "list-sessions", "-F", "#{session_name}"]);
        assert.equal(listed.exitCode, 0, listed.stderr);
        assert.equal(listed.stdout.trim().split(/\r?\n/).filter(Boolean).length, 1);
      } finally {
        const listed = await run([...control, "list-sessions", "-F", "#{session_name}"]);
        for (const session of listed.stdout.trim().split(/\r?\n/).filter(Boolean))
          await run([...control, "kill-session", "-t", `=${session}`]);
        await run([...control, "kill-server"]);
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
    },
    80_000,
  );
}
