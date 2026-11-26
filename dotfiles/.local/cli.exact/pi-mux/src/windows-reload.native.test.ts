import { it } from "bun:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ListedWorkspace } from "./session-list";
import { writeWindowsNpmPiFixture } from "./windows-npm-fixture";
import {
  observeWindowsIdentity,
  inspectWindowsProcess,
  type WindowsProcessIdentity,
} from "./windows-process";

const tmux = process.platform === "win32" ? Bun.which("tmux.exe") : null;
const main = join(import.meta.dir, "main.ts");
const node = process.platform === "win32" && Bun.which("node.exe");

const fixturePi = `
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";

const id = process.env.PI_TMUX_SESSION_ID;
const token = process.env.PI_TMUX_LAUNCH_TOKEN;
const [socket] = process.env.TMUX.split(",");
const pane = process.env.TMUX_PANE;
const log = join(process.env.RELOAD_LOG_DIR, id + ".log");
function tmux(...args) {
  return execFileSync("tmux.exe", ["-S", socket, ...args], { windowsHide: true, encoding: "utf8" }).trim();
}
const [serverPid, pid] = tmux("display-message", "-p", "-t", pane, "#{pid} #{pane_pid}")
  .split(" ").map(Number);
let previous = [];
try {
  previous = readFileSync(log, "utf8").trim().split("\\n").map(JSON.parse);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
function processHasExited(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    return true;
  }
}
const record = {
  source: { socket, pane, serverPid, pid: process.pid, token },
  panePid: pid, cwd: process.cwd(), file: process.argv[3],
  oldProcessesExited: previous.flatMap(({ source, panePid }) => [source.pid, panePid]).map(processHasExited),
  replacement: process.env.RELOAD_NEW_ENV,
  stale: process.env.RELOAD_OLD_ENV,
  hardwareCursor: process.env.PI_HARDWARE_CURSOR,
};
appendFileSync(log, JSON.stringify(record) + "\\n");
if (previous.length > 0 && process.env.RELOAD_DEFER_PUBLICATION) {
  const permit = join(process.env.RELOAD_LOG_DIR, id + ".publish");
  const deadline = Date.now() + 30000;
  while (!existsSync(permit) && Date.now() < deadline) await sleep(40);
  if (!existsSync(permit)) process.exit(3);
}
const metadata = Buffer.from(JSON.stringify({
  id, cwd: record.cwd, file: record.file, pid, processPid: process.pid, startup: "ready", token,
})).toString("base64");
tmux("set-option", "-p", "-t", pane, "@pi-tmux-session", metadata);
setInterval(() => {}, 1_000);
`;

type RecordFromPi = {
  source: { socket: string; pane: string; serverPid: number; pid: number; token: string };
  oldProcessesExited: boolean[];
  replacement?: string;
  stale?: string;
  hardwareCursor?: string;
  cwd: string;
  file: string;
};

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the Windows reload fixture");
    await Bun.sleep(40);
  }
}

it.skipIf(!tmux || !node)(
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
      npm_config_prefix: root,
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
    async function activeSessions(overrides?: NodeJS.ProcessEnv) {
      const workspaces: ListedWorkspace[] = JSON.parse(
        await ok([mux, "list", "--active", "--json"], overrides),
      );
      return workspaces.flatMap(({ sessions }) => sessions);
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
      writeWindowsNpmPiFixture(root, fixturePi);
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
      function identity(pid: number): WindowsProcessIdentity {
        const observation = inspectWindowsProcess(pid);
        assert.equal(observation.state, "live");
        return observation.identity;
      }
      const siblingProcess = identity(other.source.pid);
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
      const attemptAt = Date.now();
      const pending = JSON.stringify({ version: 1, sessionId: target, attemptAt });
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
      await waitFor(async () =>
        (await activeSessions()).some(({ reloadStatus }) => reloadStatus === "waiting-reload"),
      );
      const waiting = (await activeSessions()).filter(
        ({ reloadStatus }) => reloadStatus !== undefined,
      );
      assert.deepEqual(
        waiting.map(({ id }) => id),
        [target],
      );
      assert.equal(waiting[0]?.state, "running");
      assert.deepEqual(waiting[0]?.publishPending, { attemptAt });
      const alternateAgent = { PI_CODING_AGENT_DIR: join(profile, "alternate-agent") };
      const alternateSessions = await activeSessions(alternateAgent);
      assert.deepEqual(
        alternateSessions.filter(({ reloadStatus }) => reloadStatus !== undefined),
        waiting,
      );
      assert.equal(completed, false);
      assert.equal(log(target).length, 1);

      await publish(target, "waiting-user");
      await waitFor(() => log(target).length === 2 || completed);
      if (completed) assert.fail(JSON.stringify(await reload));
      const replacement = log(target)[1]!;
      assert.deepEqual(replacement.oldProcessesExited, [true, true]);
      assert.equal(replacement.source.serverPid, original.source.serverPid);
      assert.equal(replacement.source.pane, original.source.pane);
      assert.notEqual(replacement.source.token, original.source.token);
      assert.equal(replacement.file, original.file);
      assert.equal(replacement.cwd, original.cwd);
      assert.equal(replacement.stale, undefined);
      assert.equal(replacement.hardwareCursor, "1");
      assert.equal(replacement.replacement, "'quoted' \\path; $literal");
      assert.deepEqual(log(sibling), [other]);
      assert.equal(observeWindowsIdentity(siblingProcess, inspectWindowsProcess), "present");
      assert.equal(completed, false);
      writeFileSync(join(root, target + ".publish"), "");
      assert.deepEqual(await reload, { code: 0, stdout: "reloaded " + target, stderr: "" });
      assert.ok((await activeSessions()).every(({ reloadStatus }) => reloadStatus === undefined));
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
