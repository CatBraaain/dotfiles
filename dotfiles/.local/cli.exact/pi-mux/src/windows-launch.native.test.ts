import { test } from "bun:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { windowsManagementScope } from "./windows-management";

const tmux = process.platform === "win32" && Bun.which("tmux.exe");
const id = "6ec4c4f8-3b28-4b3d-ab62-de7790d46e83";
const ticketId = "20301108-140000";
const name = `handle_${ticketId}`;
const prompt = "alpha \"double\" 'single' `backtick` $env:PATH #{pid};\nsecond line 雪";
const main = join(import.meta.dir, "main.ts");
const ticketMain = resolve(import.meta.dir, "../../../../.agents/cli.exact/ticket/src/main.ts");

const fixturePi = `
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
const [socket] = process.env.TMUX.split(",");
const pane = process.env.TMUX_PANE;
function tmux(...args) {
  const result = Bun.spawnSync(["tmux", "-S", socket, ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
const id = process.env.PI_TMUX_SESSION_ID;
if (id) {
  const pid = Number(tmux("display-message", "-p", "-t", pane, "#{pane_pid}"));
  const metadata = Buffer.from(JSON.stringify({
    id, cwd: realpathSync(process.cwd()), file: argv[0] === "--session" ? realpathSync(argv[1]) : join(process.env.PI_CODING_AGENT_SESSION_DIR, id + ".jsonl"), pid,
    processPid: process.pid, startup: "ready", token: process.env.PI_TMUX_LAUNCH_TOKEN,
  })).toString("base64");
  tmux("set-option", "-p", "-t", pane, "@pi-tmux-session", metadata);
} else {
  writeFileSync(process.env.RECEIVED_PATH, JSON.stringify({
    argv, role: process.env.TICKET_DISPATCH_ROLE, project: process.env.TICKET_DISPATCH_PROJECT,
    stale: process.env.PI_TMUX_SESSION_ID, cwd: realpathSync(process.cwd()),
  }));
}
await Bun.sleep(90_000);
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

test.skipIf(!tmux)(
  "reopens the exact Windows session and gates locked dispatch on the same management generation",
  async () => {
    assert.ok(tmux);
    const root = mkdtempSync(join(tmpdir(), "pi-mux-native-launch-"));
    const profile = join(root, "home");
    const conf = join(profile, ".config", "tmux", "pi.conf");
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
      PATH: `${root};${dirname(tmux)};${process.env.PATH}`,
      RECEIVED_PATH: received,
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
      writeFileSync(conf, "set -g exit-empty off\nset -g remain-on-exit on\n");
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
      const fixtureFile = join(root, "fixture-pi.ts");
      writeFileSync(fixtureFile, fixturePi);
      await compile(fixtureFile, join(root, "pi.exe"));
      await compile(main, muxExe);
      await compile(ticketMain, ticketExe);

      const unavailable = await run([muxExe, "inspect", id]);
      assert.equal(unavailable.code, 1);
      assert.equal(unavailable.stdout, "");
      const start = ["start", "--status", "locked", "--project", "empty"];
      assert.equal((await run([ticketExe, "dispatch", ...start])).code, 1);
      await mux("restore");
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
