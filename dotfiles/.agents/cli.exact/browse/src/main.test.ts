import { afterAll, beforeAll, describe, it, spyOn, type Mock } from "bun:test";
import { strict as assert } from "node:assert";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as os from "node:os";
import { join } from "node:path";
import { RESTART_LOCK_FILE } from "./config";
import { createWithLockHome, withLockMainPath } from "./fixtures/with-lock";
import { restartInFlight, waitForRestartToFinish } from "./server";

// The CLI project directory: spawned as `bun <projectDir>` so bun resolves
// package.json's main field, exactly like the deployed `~/.agents/cli/browse`.
const browseProjectDir = join(import.meta.dir, "..");
const displayUsage = "usage: browse display show\n       browse display hide\n";
const serverUsage =
  "usage: browse server start\n       browse server stop\n       browse server restart\n";

type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

function createFakeX11vnc(root: string): void {
  const executable = join(root, "x11vnc");
  writeFileSync(
    executable,
    `#!/bin/sh
request="$*"
printf '%s\\n' "$request" >> "$X11VNC_LOG"
if [ "$request" = "$X11VNC_FAIL_REQUEST" ]; then
  printf '%s\\n' "$X11VNC_ERROR" >&2
  exit "\${X11VNC_EXIT}"
fi
case "$request" in
  *"-R nodeny") printf '%s\\n' accepting > "$X11VNC_STATE" ;;
  *"-R deny") printf '%s\\n' denied > "$X11VNC_STATE" ;;
  *"-R disconnect:all") printf '%s\\n' disconnected >> "$X11VNC_STATE" ;;
esac
`,
  );
  chmodSync(executable, 0o755);
}

// A stand-in browser process that browse's own restart machinery can see. The
// machinery validates /proc/<pid>/cmdline: args[1] must name the CLI project
// directory and args[2] must be "__server", so we exec tail with exactly that
// argv (tail keeps following the project's package.json — a real file — even
// though the "__server" file is missing, and the trailing -f survives GNU
// option permutation; a directory alone would make tail give up). Both the
// pgrep sweep and the cmdline validation behind `browse server restart` match
// it, and the process dies if display show/hide ever stopped or restarted the
// server.
// Requires python3 (any POSIX install with it); skipped on Windows together
// with the rest of the display suite.
function startBrowserProcess(): ChildProcess {
  return spawn(
    "python3",
    [
      "-c",
      `import os; os.execvp("tail", ["browse-fake-server", ${JSON.stringify(browseProjectDir)}, "__server", ${JSON.stringify(join(browseProjectDir, "package.json"))}, "-f"])`,
    ],
    { stdio: "ignore" },
  );
}

function isProcessAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopProcess(child: ChildProcess): void {
  if (child.pid !== undefined && isProcessAlive(child.pid)) child.kill("SIGTERM");
}

// A killed child lingers as a zombie until reaped, so a single kill(pid, 0)
// probe right after browse exits reads alive even when browse killed it. Wait
// out the reap: an exit within the window means browse stopped the browser.
async function assertBrowserStillRunning(child: ChildProcess): Promise<void> {
  const didExit = await Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300)),
  ]);
  assert.equal(didExit, false, "browse stopped or restarted the browser process");
}

function runBrowse(
  args: string[],
  binDir: string,
  logPath: string,
  extraEnv: Record<string, string> = {},
): CommandResult {
  const result = spawnSync(process.execPath, [browseProjectDir, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...extraEnv,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      X11VNC_LOG: logPath,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

// Async variant for tests whose child needs the test process's event loop to
// keep running (spawnSync blocks it, starving servers served from this process).
function runBrowseAsync(
  args: string[],
  binDir: string,
  logPath: string,
  extraEnv: Record<string, string> = {},
  projectDir = browseProjectDir,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [projectDir, ...args], {
      env: {
        ...process.env,
        ...extraEnv,
        PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
        X11VNC_LOG: logPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("browse server", () => {
  it("rejects missing, unknown, and extra server actions", () => {
    const root = mkdtempSync(join(os.tmpdir(), "browse-server-"));
    try {
      for (const args of [["server"], ["server", "toggle"], ["server", "stop", "extra"]]) {
        const result = runBrowse(args, root, join(root, "requests"));
        assert.equal(result.status, 1);
        assert.equal(result.stderr, serverUsage);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exits 0 idempotently when the websocket endpoint answers", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request)) return;
        return new Response(null, { status: 426 });
      },
      websocket: {
        message() {},
      },
    });
    const root = mkdtempSync(join(os.tmpdir(), "browse-server-start-"));
    try {
      const result = await runBrowseAsync(["server", "start"], root, join(root, "requests"), {
        CAMOUFOX_BASE_URL: `ws://127.0.0.1:${server.port}/camoufox`,
        XDG_CACHE_HOME: root,
      });
      assert.equal(result.status, 0);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    } finally {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("browse server stop", () => {
  it.skipIf(process.platform !== "linux")(
    "stops the configured port without a PID file, regardless of host and path",
    async () => {
      const root = mkdtempSync(join(os.tmpdir(), "browse-server-stop-"));
      const projectDir = join(root, "browse[1]");
      const camoufoxModule = join(root, ".pi", "agent", "node_modules", "camoufox-js", "dist");
      const playwrightModule = join(root, "playwright.cjs");
      const cacheHome = join(root, "cache");
      const readyFile = join(root, "browser-ready");
      const legacyPidFile = join(cacheHome, "pi", "web-search", "camoufox-server.pid");
      const endpoint = "ws://127.0.0.1:39778/camoufox";
      const port = "39778";
      const env = {
        HOME: root,
        XDG_CACHE_HOME: cacheHome,
        CAMOUFOX_HEADLESS: "1",
        CAMOUFOX_BASE_URL: endpoint,
        CAMOUFOX_PLAYWRIGHT_CORE: playwrightModule,
      };
      mkdirSync(projectDir);
      for (const entry of ["src", "scripts", "package.json"]) {
        cpSync(join(browseProjectDir, entry), join(projectDir, entry), { recursive: true });
      }
      mkdirSync(camoufoxModule, { recursive: true });
      writeFileSync(join(camoufoxModule, "utils.js"), "export const launchOptions = () => ({});");
      writeFileSync(
        playwrightModule,
        `module.exports.firefox = {
        async launchServer() {
          setImmediate(() => require("node:fs").writeFileSync(${JSON.stringify(readyFile)}, ""));
          const timer = setInterval(() => {}, 1000);
          return { close() { clearInterval(timer); } };
        },
      };`,
      );
      const server = Bun.spawn([process.execPath, projectDir, "__server", port], {
        env: { ...process.env, ...env, XDG_RUNTIME_DIR: "" },
        stdout: "ignore",
        stderr: "pipe",
      });
      try {
        const deadline = Date.now() + 2_000;
        while (!existsSync(readyFile) && server.exitCode === null && Date.now() < deadline) {
          await Bun.sleep(10);
        }
        if (server.exitCode !== null) assert.fail(await new Response(server.stderr).text());
        assert.ok(existsSync(readyFile));
        assert.ok(!existsSync(legacyPidFile));

        const stop = (url: string) =>
          runBrowseAsync(
            ["server", "stop"],
            root,
            join(root, "unused"),
            {
              ...env,
              CAMOUFOX_BASE_URL: url,
              XDG_RUNTIME_DIR: join(root, "runtime"),
            },
            projectDir,
          );
        const ok = { status: 0, stdout: "", stderr: "" };
        assert.deepEqual(await stop("ws://127.0.0.1:39779/camoufox"), ok);
        assert.equal(server.exitCode, null);

        const samePort = "ws://127.0.0.2:39778/different-path";
        assert.deepEqual(await stop(samePort), ok);
        assert.ok(!existsSync(legacyPidFile));
        assert.equal(await server.exited, 0);
        assert.deepEqual(await stop(samePort), ok);
      } finally {
        if (server.exitCode === null) server.kill();
        await server.exited;
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "linux")("fails with a diagnostic if pgrep cannot search", () => {
    const root = mkdtempSync(join(os.tmpdir(), "browse-server-stop-error-"));
    try {
      const pgrep = join(root, "pgrep");
      writeFileSync(pgrep, "#!/bin/sh\necho 'search failed' >&2\nexit 2\n", { mode: 0o755 });
      const result = runBrowse(["server", "stop"], root, join(root, "unused"), {
        XDG_RUNTIME_DIR: root,
        XDG_CACHE_HOME: join(root, "cache"),
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /pgrep: search failed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("browse display", () => {
  if (process.platform === "win32") {
    it.skip("requires a POSIX x11vnc test double", () => {});
    return;
  }

  it("rejects missing, unknown, and extra display actions", () => {
    const root = mkdtempSync(join(os.tmpdir(), "browse-display-"));
    try {
      createFakeX11vnc(root);
      for (const args of [["display"], ["display", "toggle"], ["display", "show", "extra"]]) {
        const result = runBrowse(args, root, join(root, "requests"));
        assert.equal(result.status, 1);
        assert.equal(result.stderr, displayUsage);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("opens VNC access without restarting the browser", async () => {
    const root = mkdtempSync(join(os.tmpdir(), "browse-display-"));
    const logPath = join(root, "requests");
    const statePath = join(root, "vnc-state");
    const browser = startBrowserProcess();
    writeFileSync(statePath, "cookie=session\n");
    try {
      createFakeX11vnc(root);
      const result = runBrowse(["display", "show"], root, logPath, {
        X11VNC_STATE: statePath,
        XDG_CACHE_HOME: root,
        XDG_RUNTIME_DIR: root,
      });
      assert.equal(result.status, 0);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
      assert.equal(readFileSync(statePath, "utf8"), "accepting\n");
      await assertBrowserStillRunning(browser);
    } finally {
      stopProcess(browser);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("denies and disconnects VNC access without restarting the browser", async () => {
    const root = mkdtempSync(join(os.tmpdir(), "browse-display-"));
    const logPath = join(root, "requests");
    const statePath = join(root, "vnc-state");
    const browser = startBrowserProcess();
    writeFileSync(statePath, "cookie=session\n");
    try {
      createFakeX11vnc(root);
      const result = runBrowse(["display", "hide"], root, logPath, {
        X11VNC_STATE: statePath,
        XDG_CACHE_HOME: root,
        XDG_RUNTIME_DIR: root,
      });
      assert.equal(result.status, 0);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
      assert.equal(readFileSync(statePath, "utf8"), "denied\ndisconnected\n");
      await assertBrowserStillRunning(browser);
    } finally {
      stopProcess(browser);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports show and hide failures as one stderr line", () => {
    const root = mkdtempSync(join(os.tmpdir(), "browse-display-"));
    const logPath = join(root, "requests");
    const statePath = join(root, "vnc-state");
    try {
      createFakeX11vnc(root);
      for (const [action, failedRequest] of [
        ["show", "-display :99 -R nodeny"],
        ["hide", "-display :99 -R disconnect:all"],
      ] as const) {
        const result = runBrowse(["display", action], root, logPath, {
          X11VNC_ERROR: "first error\nsecond error",
          X11VNC_EXIT: "7",
          X11VNC_FAIL_REQUEST: failedRequest,
          X11VNC_STATE: statePath,
        });
        assert.equal(result.status, 1);
        assert.notEqual(result.stderr.trim(), "");
        assert.equal(result.stderr.trim().split("\n").length, 1);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// The render queue yields to an in-flight restart (spec: 待機中と獲得の直後に
// restart ロックの保持を探知し…让位する). The probe must report exactly the
// restart lock's holder state: held → yield, free → proceed.
describe("restart yield probing", () => {
  if (process.platform !== "linux") {
    it.skip("requires Linux lock support", () => {});
    return;
  }

  const lockHome = createWithLockHome(mkdtempSync(join(os.tmpdir(), "browse-yield-home-")));
  let homedirSpy: Mock<typeof os.homedir> | undefined;
  beforeAll(() => {
    homedirSpy = spyOn(os, "homedir").mockReturnValue(lockHome);
  });
  afterAll(() => {
    homedirSpy?.mockRestore();
    rmSync(lockHome, { recursive: true, force: true });
  });

  it("reports an in-flight restart while the restart lock is held", async () => {
    const root = mkdtempSync(join(os.tmpdir(), "browse-yield-"));
    const stateDir = join(root, "pi", "web-search");
    const holder = spawn(
      process.execPath,
      [withLockMainPath, join(stateDir, RESTART_LOCK_FILE), "sleep", "5"],
      { stdio: "ignore" },
    );
    const savedCacheHome = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = root;
    try {
      const deadline = Date.now() + 5_000;
      while (!restartInFlight() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(restartInFlight(), true);
    } finally {
      holder.kill("SIGTERM");
      if (savedCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = savedCacheHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports no restart when the restart lock is free", () => {
    const root = mkdtempSync(join(os.tmpdir(), "browse-yield-"));
    const savedCacheHome = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = root;
    try {
      assert.equal(restartInFlight(), false);
    } finally {
      if (savedCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = savedCacheHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns from the lock wait after the timeout while a restart holds the lock", async () => {
    const root = mkdtempSync(join(os.tmpdir(), "browse-yield-"));
    const stateDir = join(root, "pi", "web-search");
    // Keep the lock longer than the wait timeout below: a timed-out return
    // must come before the holder releases. The old unbounded wait (no -w)
    // would block until the holder exits and break the assertion.
    const holder = spawn(
      process.execPath,
      [withLockMainPath, join(stateDir, RESTART_LOCK_FILE), "sleep", "1.5"],
      { stdio: "ignore" },
    );
    const savedCacheHome = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = root;
    try {
      const deadline = Date.now() + 5_000;
      while (!restartInFlight() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(restartInFlight(), true);
      const startedAt = Date.now();
      waitForRestartToFinish(300);
      assert.ok(Date.now() - startedAt < 1_200);
    } finally {
      holder.kill("SIGTERM");
      if (savedCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = savedCacheHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs the no-op immediately when the restart lock is free", () => {
    const root = mkdtempSync(join(os.tmpdir(), "browse-yield-"));
    const savedCacheHome = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = root;
    try {
      const startedAt = Date.now();
      waitForRestartToFinish(5_000);
      assert.ok(Date.now() - startedAt < 2_000);
    } finally {
      if (savedCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = savedCacheHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
