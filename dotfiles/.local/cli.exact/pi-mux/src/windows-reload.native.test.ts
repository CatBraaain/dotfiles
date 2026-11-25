import { it } from "bun:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  observeWindowsIdentity,
  inspectWindowsProcess,
  type WindowsProcessIdentity,
} from "./windows-process";

const tmux = process.platform === "win32" ? Bun.which("tmux.exe") : null;
const main = join(import.meta.dir, "main.ts");
const processModule = JSON.stringify(join(import.meta.dir, "windows-process.ts"));

const fixturePi = `
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inspectWindowsProcess, observeWindowsIdentity } from ${processModule};

const id = process.env.PI_TMUX_SESSION_ID;
const token = process.env.PI_TMUX_LAUNCH_TOKEN;
const [socket] = process.env.TMUX.split(",");
const pane = process.env.TMUX_PANE;
const log = join(process.env.RELOAD_LOG_DIR, id + ".log");
function tmux(...args) {
  const result = Bun.spawnSync(["tmux", "-S", socket, ...args], { windowsHide: true });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
function identify(pid) {
  const process = inspectWindowsProcess(pid);
  if (process.state !== "live") throw new Error("Cannot identify the test process");
  return process.identity;
}
const [serverPid, pid] = tmux("display-message", "-p", "-t", pane, "#{pid} #{pane_pid}")
  .split(" ").map(Number);
const child = identify(process.pid);
const paneChild = identify(pid);
let previous = [];
try {
  previous = readFileSync(log, "utf8").trim().split("\\n").map(JSON.parse);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const oldProcesses = previous.flatMap(({child, paneChild}) => [child, paneChild]);
const record = {
  source: { socket, pane, serverPid, pid: process.pid, token },
  child, paneChild, cwd: process.cwd(), file: process.argv[3],
  replacement: process.env.RELOAD_NEW_ENV,
  stale: process.env.RELOAD_OLD_ENV,
  hardwareCursor: process.env.PI_HARDWARE_CURSOR,
  oldProcesses: oldProcesses.map((process) => observeWindowsIdentity(process, inspectWindowsProcess)),
};
appendFileSync(log, JSON.stringify(record) + "\\n");
if (previous.length > 0 && process.env.RELOAD_DEFER_PUBLICATION) {
  const permit = Bun.file(join(process.env.RELOAD_LOG_DIR, id + ".publish"));
  const deadline = Date.now() + 30000;
  while (!(await permit.exists()) && Date.now() < deadline) await Bun.sleep(40);
  if (!(await permit.exists())) process.exit(3);
}
const metadata = Buffer.from(JSON.stringify({
  id, cwd: record.cwd, file: record.file, pid, processPid: process.pid, startup: "ready", token,
})).toString("base64");
tmux("set-option", "-p", "-t", pane, "@pi-tmux-session", metadata);
await Bun.sleep(100000);
`;

type RecordFromPi = {
  source: { socket: string; pane: string; serverPid: number; pid: number; token: string };
  child: WindowsProcessIdentity;
  paneChild: WindowsProcessIdentity;
  oldProcesses: string[];
  replacement?: string;
  stale?: string;
  hardwareCursor?: string;
  cwd: string;
  file: string;
};

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the Windows reload fixture");
    await Bun.sleep(40);
  }
}

it.skipIf(!tmux)(
  "waits for a selected Windows Pi, replaces only its exact peer, and waits for its publication",
  async () => {
    assert.ok(tmux);
    const root = mkdtempSync(join(tmpdir(), "pi-mux-reload-"));
    const profile = join(root, "home");
    const conf = join(profile, ".config", "psmux", "pi.conf");
    const agent = join(profile, ".pi", "agent");
    const extension = join(agent, "extensions", "pi-mux-bridge");
    const registry = join(root, "registry");
    const sessions = join(root, "sessions");
    const socket = join(profile, ".local", "state", "pi-tmux", "server.sock");
    const mux = join(root, "pi-mux.exe");
    const target = randomUUID();
    const sibling = randomUUID();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: profile,
      USERPROFILE: profile,
      PI_CODING_AGENT_DIR: agent,
      PI_CODING_AGENT_SESSION_DIR: sessions,
      PSMUX_DATA_DIR: registry,
      PSMUX_NO_WARM: "1",
      PATH: [root, dirname(tmux), process.env.PATH].join(";"),
      RELOAD_LOG_DIR: root,
      PI_HARDWARE_CURSOR: "0",
    };
    for (const key of Object.keys(env))
      if (
        (key.toUpperCase() === "PATH" && key !== "PATH") ||
        /^(TMUX(?:_PANE)?|PSMUX_TARGET_SESSION|PSMUX_TARGET_FULL|PSMUX_ROUTE_WARM)$/i.test(key)
      )
        delete env[key];

    function run(command: string[], overrides: NodeJS.ProcessEnv = {}) {
      const child = Bun.spawn(command, {
        env: { ...env, ...overrides },
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 35_000,
        windowsHide: true,
      });
      return Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]).then(([code, stdout, stderr]) => ({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
    }
    async function ok(command: string[], overrides?: NodeJS.ProcessEnv) {
      const result = await run(command, overrides);
      assert.equal(result.code, 0, JSON.stringify({ command, ...result }));
      return result.stdout;
    }
    function log(id: string): RecordFromPi[] {
      try {
        return readFileSync(join(root, id + ".log"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return [];
      }
    }
    const publish = (id: string, phase: string) =>
      ok([
        mux,
        "state",
        id,
        phase,
        "--source",
        JSON.stringify(log(id)[0]!.source),
        "--title",
        JSON.stringify(id),
      ]);

    try {
      for (const path of [dirname(conf), extension, registry, sessions])
        mkdirSync(path, { recursive: true });
      writeFileSync(conf, "set -g exit-empty off\nset -g remain-on-exit on\n");
      writeFileSync(join(extension, "index.ts"), "export default () => {};\n");
      const source = join(root, "fixture.ts");
      writeFileSync(source, fixturePi);
      await ok([process.execPath, "build", "--compile", source, "--outfile", join(root, "pi.exe")]);
      await ok([process.execPath, "build", "--compile", main, "--outfile", mux]);
      await ok([mux, "restore"]);
      for (const id of [target, sibling]) {
        const file = join(sessions, id + ".jsonl");
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
        await ok([mux, "open", "--detached", "--expect-file", file, id], {
          RELOAD_OLD_ENV: "stale",
        });
        await publish(id, "waiting-user");
      }

      const original = log(target)[0]!;
      const other = log(sibling)[0]!;
      assert.equal(original.hardwareCursor, "1");
      assert.equal(original.source.pane, other.source.pane);
      assert.notEqual(original.source.serverPid, other.source.serverPid);
      await publish(target, "running");
      const sessionsById = await ok([
        tmux,
        "-S",
        socket,
        "-f",
        conf,
        "list-sessions",
        "-F",
        "#{session_name} #{PI_TMUX_SESSION_ID}",
      ]);
      const targetSession = sessionsById.split(/\r?\n/).find((row) => row.endsWith(" " + target));
      assert.ok(targetSession);
      const tmuxTarget = "=" + targetSession.split(" ")[0];
      const pending = JSON.stringify({ version: 1, sessionId: target, attemptAt: Date.now() });
      const pendingOption = "@pi_session_state_pending";
      await ok([
        tmux,
        "-S",
        socket,
        "-f",
        conf,
        "set-option",
        "-p",
        "-t",
        tmuxTarget,
        pendingOption,
        pending,
      ]);

      let completed = false;
      const reload = run([mux, "reload", target], {
        RELOAD_NEW_ENV: "'quoted' \\path; $literal",
        RELOAD_DEFER_PUBLICATION: "1",
      }).finally(() => {
        completed = true;
      });
      await Bun.sleep(700);
      assert.equal(completed, false);
      assert.equal(log(target).length, 1);

      await publish(target, "waiting-user");
      await waitFor(() => log(target).length === 2 || completed);
      if (completed) assert.fail(JSON.stringify(await reload));
      const replacement = log(target)[1]!;
      assert.deepEqual(replacement.oldProcesses, ["ended", "ended"]);
      assert.equal(replacement.source.serverPid, original.source.serverPid);
      assert.equal(replacement.source.pane, original.source.pane);
      assert.notEqual(replacement.source.token, original.source.token);
      assert.equal(replacement.file, original.file);
      assert.equal(replacement.cwd, original.cwd);
      assert.equal(replacement.stale, undefined);
      assert.equal(replacement.hardwareCursor, "1");
      assert.equal(replacement.replacement, "'quoted' \\path; $literal");
      assert.deepEqual(log(sibling), [other]);
      assert.equal(observeWindowsIdentity(other.child, inspectWindowsProcess), "present");
      assert.equal(completed, false);
      writeFileSync(join(root, target + ".publish"), "");
      assert.deepEqual(await reload, { code: 0, stdout: "reloaded " + target, stderr: "" });
      const observedPending = await ok([
        tmux,
        "-S",
        socket,
        "-f",
        conf,
        "show-options",
        "-pqv",
        "-t",
        tmuxTarget,
        pendingOption,
      ]);
      assert.equal(observedPending, pending);
    } finally {
      await run([tmux, "-S", socket, "-f", conf, "kill-server"]);
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
  75_000,
);
