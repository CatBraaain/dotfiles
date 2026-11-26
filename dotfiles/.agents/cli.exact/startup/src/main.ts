#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const UPDATE_TASK_ARG = "update";
const UPDATE_LOCK_PIPE = "\\\\.\\pipe\\pi-update";
const PI_UPDATE_ARGS = ["update", "--all"];
const SELF_RUN_ARGV: readonly [string, ...string[]] = Bun.isStandaloneExecutable
  ? [process.execPath]
  : [process.execPath, import.meta.path];

const requestedTask = process.argv[2];
const tasks =
  requestedTask === UPDATE_TASK_ARG
    ? [updatePiUnderLock()]
    : [updatePi(), startCamoufox(), startOpenserp()];

await Promise.allSettled(tasks);
process.exit(0);

async function updatePi() {
  const pi = Bun.which("pi");
  if (!pi) return;
  if (process.platform === "win32") {
    startDetached(SELF_RUN_ARGV[0], [...SELF_RUN_ARGV.slice(1), UPDATE_TASK_ARG]);
    return;
  }

  const flock = Bun.which("flock");
  if (!flock) return;
  const lock = `${process.env.TMPDIR || "/tmp"}/pi-update.lock`;
  startDetached(flock, ["-n", lock, pi, ...PI_UPDATE_ARGS]);
}

async function updatePiUnderLock() {
  if (process.platform !== "win32") return;
  const pi = Bun.which("pi");
  if (!pi) return;

  const lock = createServer((socket) => socket.destroy());
  const isAcquired = await new Promise<boolean>((resolve) => {
    lock.once("error", () => resolve(false));
    lock.listen(UPDATE_LOCK_PIPE, () => resolve(true));
  });
  if (!isAcquired) return;

  // child_process.spawn() rejects .cmd shims such as npm's pi.cmd without a shell: https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows
  const updateProcess = Bun.spawn([pi, ...PI_UPDATE_ARGS], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  await updateProcess.exited;
}

function browseCliPath(): string {
  const suffix = process.platform === "win32" ? ".exe" : "";
  return join(homedir(), ".agents", "cli", `browse${suffix}`);
}

async function startCamoufox() {
  const cli = browseCliPath();
  if (!(await Bun.file(cli).exists())) return;

  const url = new URL(process.env.CAMOUFOX_BASE_URL || "ws://127.0.0.1:9378/camoufox");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(url.port || (url.protocol === "wss:" ? "443" : "80"));
  if (await portOpen(host, port)) return;

  const cacheDir = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  const logDir = join(cacheDir, "pi", "web-search");
  await mkdir(logDir, { recursive: true });
  const log = openSync(join(logDir, "camoufox-server.log"), "a");
  try {
    startDetached(cli, ["server", "start"], log);
  } finally {
    closeSync(log);
  }
}

async function startOpenserp() {
  const openserp = Bun.which("openserp");
  if (!openserp) return;

  const baseUrl = process.env.OPENSERP_BASE_URL || "http://127.0.0.1:7000";
  if (await httpHealthy(`${baseUrl}/ready`)) return;

  const url = new URL(baseUrl);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  startDetached(openserp, ["serve", "-a", host, "-p", port, "--quiet"]);
}

function startDetached(command: string, args: string[], output: number | "ignore" = "ignore") {
  const child = spawn(command, args, {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", output, output],
  });
  child.on("error", () => {});
  child.unref();
}

function portOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, host);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function httpHealthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(1000),
    });
    await response.arrayBuffer();
    return response.status >= 200 && response.status < 300;
  } catch {
    return false;
  }
}
