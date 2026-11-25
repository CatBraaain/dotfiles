import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { writeWindowsNpmPiFixture } from "../../../../.local/cli.exact/pi-mux/src/windows-npm-fixture";

const ticketMain = join(import.meta.dir, "main.ts");
const muxMain = resolve(import.meta.dir, "../../../../.local/cli.exact/pi-mux/src/main.ts");
const openTemplate = join(import.meta.dir, "..", "dispatch-prompt.md");
const lockedTemplate = join(import.meta.dir, "..", "dispatch-locked-prompt.md");
const project = "quote's project";
const otherProject = "second";
const firstId = "20301108-140000";
const secondId = "20301108-140001";
const ownerId = "6ec4c4f8-3b28-4b3d-ab62-de7790d46e83";
const testTimeoutMs = 120_000;
const tickMs = 150;
const noLaunchObservationMs = 1_500;

function recordingPi(launchesDir: string): string {
  return String.raw`
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
const cwd = realpathSync(process.cwd());
const [socket] = process.env.TMUX.split(",");
const pane = process.env.TMUX_PANE;
function tmux(...args) {
  return execFileSync("tmux.exe", ["-S", socket, ...args], { encoding: "utf8", windowsHide: true }).trim();
}
const [name, panePid] = tmux("display-message", "-p", "-t", pane, "#{session_name}\t#{pane_pid}").split("\t");
const id = process.env.PI_TMUX_SESSION_ID;
if (id) {
  const file = argv[0] === "--session" ? realpathSync(argv[1]) : join(process.env.PI_CODING_AGENT_SESSION_DIR, id + ".jsonl");
  if (process.env.PI_TMUX_STARTUP_MODE === "create" && !existsSync(file))
    writeFileSync(file, JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: new Date().toISOString() }) + "\n");
  const metadata = Buffer.from(JSON.stringify({
    id, cwd, file, pid: Number(panePid), processPid: process.pid,
    startup: "ready", token: process.env.PI_TMUX_LAUNCH_TOKEN,
  })).toString("base64");
  tmux("set-option", "-p", "-t", pane, "@pi-tmux-session", metadata);
}
const output = join(${JSON.stringify(launchesDir)}, process.pid + ".json");
writeFileSync(output + ".tmp", JSON.stringify({ argv, cwd, name, panePid }));
renameSync(output + ".tmp", output);
setInterval(() => {}, 1_000);
`;
}

type Launch = { argv: string[]; cwd: string; name: string; panePid: string };

function writeLockHistory(sessions: string, cwd: string, file: string, id: string) {
  const records = [
    { type: "session", version: 3, id: ownerId, cwd, timestamp: "2030-11-08T14:00:00.000Z" },
    {
      type: "message",
      id: "call",
      parentId: null,
      timestamp: "2030-11-08T14:00:01.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "lock",
            name: "ticket_set",
            arguments: { selector: id, project, status: "locked" },
          },
        ],
      },
    },
    {
      type: "message",
      id: "result",
      parentId: "call",
      timestamp: "2030-11-08T14:00:02.000Z",
      message: {
        role: "toolResult",
        toolCallId: "lock",
        toolName: "ticket_set",
        isError: false,
        content: [
          { type: "text", text: `updated ${id}\nstatus: locked\nafter: null\npath: ${file}` },
        ],
      },
    },
  ];
  const sessionFile = join(sessions, `${ownerId}.jsonl`);
  writeFileSync(sessionFile, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  return sessionFile;
}

async function nativeFixture(work: (fixture: ReturnType<typeof commands>) => Promise<void>) {
  const psmux = Bun.which("psmux.exe");
  const tmux = Bun.which("tmux.exe");
  const node = Bun.which("node.exe");
  const npm = Bun.which("npm.cmd");
  const systemRoot = process.env.SystemRoot;
  assert.ok(
    psmux && tmux && node && npm && systemRoot,
    "Windows psmux, tmux, node and npm are required",
  );
  const root = mkdtempSync(join(tmpdir(), "ticket-native-"));
  const systemEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${root};${dirname(psmux)};${process.env.PATH}`,
  };
  for (const key of Object.keys(systemEnv)) {
    if (
      (key.toUpperCase() === "PATH" && key !== "PATH") ||
      /^(?:TMUX(?:_PANE)?|PSMUX_TARGET_SESSION|PSMUX_TARGET_FULL|PSMUX_ROUTE_WARM|PSMUX_CONFIG_FILE)$/i.test(
        key,
      )
    )
      delete systemEnv[key];
  }
  const fixture = commands(root, psmux, systemEnv);
  try {
    await fixture.prepare();
    await work(fixture);
  } finally {
    await fixture.stopServer();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function commands(root: string, psmux: string, systemEnv: NodeJS.ProcessEnv) {
  const home = join(root, "home");
  const agent = join(home, ".pi", "agent");
  const extension = join(agent, "extensions", "pi-mux-bridge");
  const registry = join(root, "registry");
  const sessions = join(root, "sessions");
  const launchesDir = join(root, "launches");
  const config = join(home, ".config", "psmux", "pi.conf");
  const socket = join(home, ".local", "state", "pi-tmux", "server.sock");
  const muxExe = join(root, "pi-mux.exe");
  const ticketExe = join(root, "ticket.exe");
  const env = {
    ...systemEnv,
    HOME: home,
    USERPROFILE: home,
    PI_CODING_AGENT_DIR: agent,
    PI_CODING_AGENT_SESSION_DIR: sessions,
    PSMUX_DATA_DIR: registry,
    PSMUX_NO_WARM: "1",
    TICKET_TEST_TMUX_SOCKET: socket,
    TICKET_TEST_TICK_MS: String(tickMs),
    npm_config_prefix: root,
  };

  async function run(...argv: string[]) {
    const child = Bun.spawn(argv, {
      env,
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
      windowsHide: true,
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout: stdout.trim(), stderr: stderr.trim() };
  }
  async function ok(...argv: string[]) {
    const result = await run(...argv);
    assert.equal(result.code, 0, JSON.stringify({ argv, ...result }));
    return result.stdout;
  }
  function tmux(...args: string[]) {
    return run(psmux, "-S", socket, "-f", config, ...args);
  }
  async function prepare() {
    for (const directory of [dirname(config), extension, registry, sessions, launchesDir])
      mkdirSync(directory, { recursive: true });
    writeFileSync(
      config,
      "set -g exit-empty off\nset -g remain-on-exit on\nset -g @ticket-native-isolated yes\n",
    );
    writeFileSync(join(extension, "index.ts"), "export default () => {};\n");
    writeWindowsNpmPiFixture(root, recordingPi(launchesDir));
    await ok(process.execPath, "build", "--compile", muxMain, "--outfile", muxExe);
    await ok(process.execPath, "build", "--compile", ticketMain, "--outfile", ticketExe);
  }
  async function restore() {
    await ok(muxExe, "restore");
    assert.equal(
      await ok(psmux, "-S", socket, "display-message", "-p", "#{@ticket-native-isolated}"),
      "yes",
    );
  }
  async function stopServer() {
    if (existsSync(registry)) await tmux("kill-server");
  }
  function dispatch(...args: string[]) {
    return ok(ticketExe, "dispatch", ...args);
  }
  function runDispatch(...args: string[]) {
    return run(ticketExe, "dispatch", ...args);
  }
  async function rejectsDispatch(code: number, reason: RegExp, ...args: string[]) {
    const result = await runDispatch(...args);
    assert.equal(result.code, code, JSON.stringify({ args, ...result }));
    assert.match(result.stderr, reason);
  }
  function projectDir(name: string) {
    return join(home, "projects", name);
  }
  function seed(name: string, id: string, status: "open" | "locked", after?: string) {
    const store = join(home, ".agents", "tickets", name);
    mkdirSync(store, { recursive: true });
    mkdirSync(projectDir(name), { recursive: true });
    const file = join(store, `${id}.md`);
    writeFileSync(
      file,
      `---\nstatus: ${status}\n${after ? `after: ${after}\n` : ""}---\n\n# ${id}\n`,
    );
    return file;
  }
  function seedOwner(file: string, id: string) {
    return writeLockHistory(sessions, projectDir(project), file, id);
  }
  function close(name: string, id: string) {
    return ok(ticketExe, "set", "--project", name, id, '{"status":"closed"}');
  }
  function launches(): Launch[] {
    return readdirSync(launchesDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => JSON.parse(readFileSync(join(launchesDir, file), "utf8")) as Launch);
  }
  async function waitForLaunch(cwd: string, prompt: string): Promise<Launch> {
    const expectedCwd = realpathSync(cwd);
    const deadline = Date.now() + 20_000;
    do {
      const found = launches().find(
        (launch) => launch.cwd === expectedCwd && launch.argv.includes(prompt),
      );
      if (found) return found;
      await Bun.sleep(50);
    } while (Date.now() < deadline);
    const panes = await tmux("capture-pane", "-p", "-S", "-30");
    assert.fail(
      `Pi did not receive the expected prompt in ${cwd}: ${JSON.stringify({ launches: launches(), panes })}`,
    );
  }
  async function assertNoNewLaunches(count: number) {
    const deadline = Date.now() + noLaunchObservationMs;
    while (Date.now() < deadline) {
      assert.equal(launches().length, count, JSON.stringify(launches()));
      await Bun.sleep(tickMs);
    }
    assert.equal(launches().length, count, JSON.stringify(launches()));
  }
  async function waitForWorkerLog(name: string, pattern: RegExp): Promise<string> {
    const deadline = Date.now() + 15_000;
    let log = "";
    while (Date.now() < deadline) {
      log = (await tmux("capture-pane", "-p", "-t", `=${name}`, "-S", "-50")).stdout;
      if (pattern.test(log)) return log;
      await Bun.sleep(tickMs);
    }
    assert.match(log, pattern);
    return log;
  }
  async function holdDispatchLock(work: () => Promise<unknown>) {
    const locks = join(registry, "ticket-dispatch");
    const namespaces = readdirSync(locks);
    assert.equal(namespaces.length, 1);
    const lock = new Database(join(locks, namespaces[0]!, "lifecycle.sqlite"), { readonly: false });
    try {
      lock.exec("PRAGMA busy_timeout = 2000");
      lock.exec("BEGIN IMMEDIATE");
      await work();
    } finally {
      lock.close();
    }
  }
  function removePiBinary() {
    rmSync(join(root, "node_modules", "@earendil-works", "pi-coding-agent", "cli.js"));
  }
  async function assertStillRunning(launch: Launch) {
    const output = await ok(
      psmux,
      "-S",
      socket,
      "list-panes",
      "-t",
      `=${launch.name}`,
      "-F",
      "#{pane_pid}\t#{pane_dead}",
    );
    assert.ok(output.split(/\r?\n/).includes(`${launch.panePid}\t0`), output);
  }
  return {
    registry,
    prepare,
    restore,
    stopServer,
    tmux,
    dispatch,
    runDispatch,
    rejectsDispatch,
    projectDir,
    seed,
    seedOwner,
    close,
    launches,
    waitForLaunch,
    assertNoNewLaunches,
    waitForWorkerLog,
    holdDispatchLock,
    removePiBinary,
    assertStillRunning,
  };
}

function openPrompt(id: string) {
  return readFileSync(openTemplate, "utf8").replaceAll("{{ TICKET_ID }}", id);
}

const windowsTest = test.skipIf(process.platform !== "win32");

windowsTest(
  "Windows one requires restored management, a full ID and actionable open, then launches once per project and ID",
  async () => {
    await nativeFixture(async (fixture) => {
      fixture.seed(project, firstId, "open");
      fixture.seed(project, secondId, "open", firstId);
      fixture.seed(otherProject, firstId, "open");
      const one = ["one", "--project", project, firstId];
      await fixture.rejectsDispatch(1, /management/i, ...one);
      await fixture.rejectsDispatch(1, /management/i, "start", "--project", project);
      assert.equal((await fixture.tmux("list-sessions")).code, 1);
      assert.deepEqual(
        readdirSync(fixture.registry).filter((file) => /\.(pid|port)$/.test(file)),
        [],
      );
      assert.deepEqual(fixture.launches(), []);

      await fixture.restore();
      await fixture.rejectsDispatch(
        1,
        /ticket not found/i,
        "one",
        "--project",
        project,
        firstId.slice(0, -1),
      );
      await fixture.rejectsDispatch(1, /not actionable/i, "one", "--project", project, secondId);
      const races = await Promise.all([fixture.runDispatch(...one), fixture.runDispatch(...one)]);
      assert.deepEqual(races.map(({ code }) => code).sort(), [0, 1], JSON.stringify(races));
      const first = await fixture.waitForLaunch(fixture.projectDir(project), openPrompt(firstId));
      await fixture.rejectsDispatch(1, /already running/i, ...one);
      await fixture.dispatch("one", "--project", otherProject, firstId);
      const other = await fixture.waitForLaunch(
        fixture.projectDir(otherProject),
        openPrompt(firstId),
      );
      assert.equal(await fixture.dispatch("list"), "no dispatcher running");
      assert.equal(fixture.launches().length, 2);
      await fixture.assertStillRunning(first);
      await fixture.assertStillRunning(other);
    });
  },
  testTimeoutMs,
);

windowsTest(
  "Windows start defaults to scoped open and globally counts a manual launch with different project casing",
  async () => {
    await nativeFixture(async (fixture) => {
      const olderLockedId = "20301108-135959";
      fixture.seedOwner(fixture.seed(project, olderLockedId, "locked"), olderLockedId);
      fixture.seed(project, firstId, "open");
      fixture.seed(project, secondId, "open");
      fixture.seed(otherProject, firstId, "open");
      await fixture.restore();
      assert.match(
        await fixture.dispatch("start", "--project", project, "--max", "1"),
        /dispatcher started/,
      );
      const first = await fixture.waitForLaunch(fixture.projectDir(project), openPrompt(firstId));
      await fixture.rejectsDispatch(1, /already running/i, "one", "--project", project, firstId);
      assert.deepEqual(fixture.launches(), [first]);
      assert.match(await fixture.dispatch("list"), /quote's project/);
      await fixture.rejectsDispatch(1, /overlapping dispatcher/i, "start", "--all");
      await fixture.dispatch("stop", "--project", project);
      assert.equal(await fixture.dispatch("list"), "no dispatcher running");
      await fixture.assertStillRunning(first);
      await fixture.close(project, firstId);
      await fixture.close(otherProject, firstId);
      const projectAlias = project.toUpperCase();
      await fixture.dispatch("one", "--project", projectAlias, secondId);
      const manual = await fixture.waitForLaunch(
        fixture.projectDir(projectAlias),
        openPrompt(secondId),
      );
      const pendingId = "20301108-140002";
      fixture.seed(project, pendingId, "open");
      await fixture.dispatch("start", "--all", "--max", "1");
      await fixture.assertNoNewLaunches(2);
      await fixture.holdDispatchLock(() =>
        fixture.waitForWorkerLog("ticket_dispatch_all", /timed out waiting for dispatcher lock/),
      );
      assert.match(await fixture.dispatch("list"), /\(all\)/);
      await fixture.close(project, secondId);
      const pending = await fixture.waitForLaunch(
        fixture.projectDir(project),
        openPrompt(pendingId),
      );
      await fixture.dispatch("stop", "--all");
      assert.equal(fixture.launches().length, 3);
      await fixture.assertStillRunning(first);
      await fixture.assertStillRunning(manual);
      await fixture.assertStillRunning(pending);
    });
  },
  testTimeoutMs,
);

windowsTest(
  "Windows reports a Pi launch failure without confirming manual or automatic startup",
  async () => {
    await nativeFixture(async (fixture) => {
      fixture.seed(project, firstId, "open");
      await fixture.restore();
      fixture.removePiBinary();
      await fixture.rejectsDispatch(1, /new-session failed/i, "one", "--project", project, firstId);
      await fixture.dispatch("start", "--all");
      const log = await fixture.waitForWorkerLog("ticket_dispatch_all", /dispatcher finished/);
      assert.match(log, /new-session failed/i);
      assert.doesNotMatch(log, /\blaunched\b/);
      assert.deepEqual(fixture.launches(), []);
    });
  },
  testTimeoutMs,
);

windowsTest(
  "Windows start accepts locked alone and shares max across open, locked and projects",
  async () => {
    await nativeFixture(async (fixture) => {
      const file = fixture.seed(project, firstId, "locked");
      const ownerSessionFile = fixture.seedOwner(file, firstId);
      fixture.seed(otherProject, secondId, "open");
      await fixture.restore();
      await fixture.dispatch("start", "--all", "--status", "locked");
      const assignment = { project, ticketId: firstId, ownerId, ownerSessionFile };
      const prompt = readFileSync(lockedTemplate, "utf8").replace("{{ ASSIGNMENT }}", () =>
        JSON.stringify(assignment),
      );
      const locked = await fixture.waitForLaunch(fixture.projectDir(project), prompt);
      await fixture.dispatch("stop", "--all");
      assert.deepEqual(fixture.launches(), [locked]);
      await fixture.assertStillRunning(locked);

      await fixture.dispatch(
        "start",
        "--all",
        "--max",
        "1",
        "--status",
        "open",
        "--status",
        "locked",
      );
      assert.match(await fixture.dispatch("list"), /\(all\)/);
      await fixture.assertNoNewLaunches(1);
      await fixture.close(project, firstId);
      const open = await fixture.waitForLaunch(
        fixture.projectDir(otherProject),
        openPrompt(secondId),
      );
      await fixture.dispatch("stop", "--all");
      assert.equal(await fixture.dispatch("list"), "no dispatcher running");
      assert.equal(fixture.launches().length, 2);
      await fixture.assertStillRunning(locked);
      await fixture.assertStillRunning(open);
    });
  },
  testTimeoutMs,
);
