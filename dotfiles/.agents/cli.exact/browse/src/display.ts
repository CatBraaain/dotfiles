// Headed display helpers for the camoufox server: keep Xvfb (:99) and x11vnc
// alive on Linux and toggle VNC access for `browse display show|hide`.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { stateDir } from "./config";
import { fail } from "./util";

export const DISPLAY_NUMBER = 99;
const VNC_PORT = 5900;
const XVFB_SCREEN = "1920x1080x24";

// Spec: Linux では既定で headed（Xvfb 上）。`CAMOUFOX_HEADLESS=1` で従来の
// headless に戻せる。Xvfb のない Windows では既定で headless のまま。
export function resolveHeadless(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (env.CAMOUFOX_HEADLESS === "1") return true;
  if (env.CAMOUFOX_HEADLESS === "0") return false;
  return platform === "win32";
}

// Readiness probe for the display: Xvfb creates this unix socket on startup.
function displaySocketPath(displayNumber: number = DISPLAY_NUMBER): string {
  return `/tmp/.X11-unix/X${displayNumber}`;
}

function xvfbArgs(displayNumber: number = DISPLAY_NUMBER, screen: string = XVFB_SCREEN): string[] {
  return [`:${displayNumber}`, "-screen", "0", screen];
}

// Spec: `-deny_all` 付きで起動し、既定では誰も接続できない。表示は稼働中
// プロセスへの `x11vnc -R nodeny` / `-R deny` + `-R disconnect:all` で切り替える。
function x11vncArgs(displayNumber: number = DISPLAY_NUMBER, port: number = VNC_PORT): string[] {
  return [
    "-display",
    `:${displayNumber}`,
    "-localhost",
    "-rfbport",
    String(port),
    "-forever",
    "-nopw",
    "-deny_all",
  ];
}

export function runX11vncRequest(request: string, action: "show" | "hide"): void {
  const result = spawnSync("x11vnc", ["-display", `:${DISPLAY_NUMBER}`, "-R", request], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status === 0) return;
  const detail = (
    result.error?.message ||
    String(result.stderr ?? "").trim() ||
    `exit status ${result.status ?? "unknown"}`
  ).replace(/\s+/g, " ");
  fail(`display ${action} failed: ${detail}`);
}

// Detached helper processes (Xvfb, x11vnc) outlive the server; a restart just
// re-checks them instead of assuming they are gone.
function spawnDetachedLog(command: string, args: readonly string[], logPath: string): void {
  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, "a");
  try {
    spawn(command, args, { detached: true, stdio: ["ignore", logFd, logFd] }).unref();
  } finally {
    closeSync(logFd);
  }
}

function commandOnPath(command: string): boolean {
  return spawnSync("which", [command], { encoding: "utf8" }).status === 0;
}

function portIsOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

// Xvfb readiness: the socket may be a filesystem socket or — when
// /tmp/.X11-unix is owned by another non-root user (e.g. WSLg) and X refuses
// to create a socket there — a Linux abstract socket that never appears on
// the filesystem. Probe both so the wait does not time out on such hosts.
function displayIsUp(socketPath: string): boolean {
  if (existsSync(socketPath)) return true;
  if (process.platform === "linux") {
    try {
      return readFileSync("/proc/net/unix", "utf8").includes(`@${socketPath}`);
    } catch {
      return false;
    }
  }
  return false;
}

// Headed 起動では Xvfb がソケットを作るまで待ってから Firefox を出す。
export async function ensureDisplay(): Promise<void> {
  const socketPath = displaySocketPath();
  if (displayIsUp(socketPath)) return;
  console.log("[camoufox-server] starting Xvfb on :99");
  spawnDetachedLog("Xvfb", xvfbArgs(), join(stateDir(), "xvfb.log"));
  const deadline = Date.now() + 10_000;
  while (!displayIsUp(socketPath)) {
    if (Date.now() > deadline) {
      throw new Error(`Xvfb socket ${socketPath} did not appear within 10s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function ensureX11vnc(): Promise<void> {
  if (!commandOnPath("x11vnc")) {
    console.error(
      "[camoufox-server] x11vnc not on PATH: human handoff disabled (bootstrap: apt x11vnc)",
    );
    return;
  }
  if (await portIsOpen(VNC_PORT)) return; // already serving; another instance would just die on the port
  console.log("[camoufox-server] starting x11vnc (connection denied until -R nodeny)");
  spawnDetachedLog("x11vnc", x11vncArgs(), join(stateDir(), "x11vnc.log"));
}


