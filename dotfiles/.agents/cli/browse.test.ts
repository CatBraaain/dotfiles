import { describe, it } from "bun:test";
import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const browsePath = join(import.meta.dir, "browse.executable");
const displayUsage = "usage: browse display show\n       browse display hide\n";

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

// A stand-in browser process that browse's own restart machinery can see:
// argv[0] carries "<browse script> __server", so the pgrep sweep and the
// /proc/<pid>/cmdline validation behind `browse restart` both match it.
// If display show/hide ever stopped or restarted the server, this dies.
function startBrowserProcess(): ChildProcess {
  return spawn("bash", ["-c", `exec -a '${browsePath} __server' sleep 30`], { stdio: "ignore" });
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

// browse looks the server pid up under <cache>/pi/web-search/; point that at
// the test root so the pid file route is exercised without machine state.
function writeServerPidFile(root: string, pid: number | undefined): void {
  if (pid === undefined) return;
  const stateDir = join(root, "pi", "web-search");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "camoufox-server.pid"), `${pid}\n`);
}

function runBrowse(
  args: string[],
  binDir: string,
  logPath: string,
  extraEnv: Record<string, string> = {},
): CommandResult {
  const result = spawnSync(process.execPath, [browsePath, ...args], {
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

describe("browse display", () => {
  if (process.platform === "win32") {
    it.skip("requires a POSIX x11vnc test double");
    return;
  }

  it("rejects missing, unknown, and extra display actions", () => {
    const root = mkdtempSync(join(tmpdir(), "browse-display-"));
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
    const root = mkdtempSync(join(tmpdir(), "browse-display-"));
    const logPath = join(root, "requests");
    const statePath = join(root, "vnc-state");
    const browser = startBrowserProcess();
    writeFileSync(statePath, "cookie=session\n");
    writeServerPidFile(root, browser.pid);
    try {
      createFakeX11vnc(root);
      const result = runBrowse(["display", "show"], root, logPath, {
        X11VNC_STATE: statePath,
        XDG_CACHE_HOME: root,
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
    const root = mkdtempSync(join(tmpdir(), "browse-display-"));
    const logPath = join(root, "requests");
    const statePath = join(root, "vnc-state");
    const browser = startBrowserProcess();
    writeFileSync(statePath, "cookie=session\n");
    writeServerPidFile(root, browser.pid);
    try {
      createFakeX11vnc(root);
      const result = runBrowse(["display", "hide"], root, logPath, {
        X11VNC_STATE: statePath,
        XDG_CACHE_HOME: root,
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
    const root = mkdtempSync(join(tmpdir(), "browse-display-"));
    const logPath = join(root, "requests");
    const statePath = join(root, "vnc-state");
    try {
      createFakeX11vnc(root);
      for (const [action, failedRequest] of [
        ["show", "-display :99 -R nodeny"],
        ["hide", "-display :99 -R disconnect:all"],
      ]) {
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
