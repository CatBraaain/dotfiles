// Camoufox server lifecycle: health checks, detached bootstrap, the `__server`
// process itself (Xvfb/x11vnc wiring and playwright-core launch), pid file
// bookkeeping and `server restart` targeting. The openserp server bootstrap
// lives here too, since it follows the same detached-spawn + health-poll shape.
import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isCamoufoxServerCommand } from "./backends";
import {
  CAMOUFOX_DEFAULT_BASE_URL,
  camoufoxBaseUrl,
  LOCKED_SUBCOMMAND,
  OPENSERP_DEFAULT_BASE_URL,
  openserpBaseUrl,
  SERVER_HEALTH_POLL_INTERVAL_MS,
  SERVER_STOP_TIMEOUT_MS,
  SERVER_SUBCOMMAND,
  SERVER_WAIT_TIMEOUT_MS,
  stateDir,
  WEBSOCKET_HEALTH_TIMEOUT_MS,
} from "./config";
import { ensureDisplay, ensureX11vnc, DISPLAY_NUMBER, resolveHeadless } from "./display";
import { delay } from "./util";

const CAMOUFOX_EXECUTABLE_PATH =
  process.env.CAMOUFOX_EXECUTABLE_PATH ?? join(homedir(), ".cache", "camoufox", "camoufox-bin");

// The CLI project directory (the parent of src/): detached server spawns go
// through `bun <projectDir>` (bun resolves package.json's main field), and the
// same string identifies server processes in the pgrep sweep and /proc check.
const projectDir = dirname(import.meta.dir);

// Spec: camoufox server のヘルスチェックは websocket 接続が成功するかで判定。
// 1 接続試行は 1 秒で打ち切り（half-open socket 対策）。
export function camoufoxServerHealthy(baseUrl: string, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = new WebSocket(baseUrl);
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), WEBSOCKET_HEALTH_TIMEOUT_MS);
    socket.addEventListener("open", () => finish(true));
    socket.addEventListener("error", () => finish(false));
    signal.addEventListener("abort", () => finish(false), { once: true });
  });
}

// Spec: `browse server start` は冪等。起動済みなら何もせず終了コード 0。
export async function startCamoufoxServer(): Promise<void> {
  const baseUrl = camoufoxBaseUrl();
  const signal = AbortSignal.timeout(SERVER_WAIT_TIMEOUT_MS);
  if (await camoufoxServerHealthy(baseUrl, signal)) return;
  spawnBrowseDetached([SERVER_SUBCOMMAND]);
  await waitForServerHealthy(baseUrl, signal);
}

// Spec: `browse server restart` は実行中の server を停止してから起動し直す。
export async function restartCamoufoxServer(): Promise<void> {
  await stopCamoufoxServers();
  await startCamoufoxServer();
}

// --- server bootstrap (health check -> spawn -> wait) ---

export async function ensureCamoufoxServer(signal: AbortSignal): Promise<void> {
  const baseUrl = camoufoxBaseUrl();
  if (await camoufoxServerHealthy(baseUrl, signal)) return;
  // The start subcommand owns the server launch recipe; wait here for the
  // server it brings up.
  spawnBrowseDetached([LOCKED_SUBCOMMAND, "server", "start"]);
  await waitForServerHealthy(baseUrl, signal);
}

async function waitForServerHealthy(baseUrl: string, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    await delay(SERVER_HEALTH_POLL_INTERVAL_MS, signal);
    if (await camoufoxServerHealthy(baseUrl, signal)) return;
  }
  throw new Error(`camoufox server not ready at ${baseUrl}`);
}

export async function ensureOpenserpServer(signal: AbortSignal): Promise<void> {
  const baseUrl = openserpBaseUrl();
  if (await serverHealthy(baseUrl, "/ready", signal)) return;
  spawnOpenserpServer();
  while (!signal.aborted) {
    await delay(SERVER_HEALTH_POLL_INTERVAL_MS, signal);
    if (await serverHealthy(baseUrl, "/ready", signal)) return;
  }
  throw new Error(`openserp server not ready at ${baseUrl}`);
}

async function serverHealthy(baseUrl: string, path: string, signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}${path}`, { signal });
    return response.ok;
  } catch {
    return false;
  }
}

// Spec: camoufox server のログは <XDG_CACHE_HOME|~/.cache>/pi/web-search/
// camoufox-server.log へ追記（書き込み不能なら出力破棄で続行）。
function spawnBrowseDetached(args: readonly string[]): void {
  let logFd: number | "ignore" = "ignore";
  try {
    mkdirSync(stateDir(), { recursive: true });
    logFd = openSync(join(stateDir(), "camoufox-server.log"), "a");
  } catch {
    // The append log is best effort; run the child with discarded output.
  }
  try {
    // The child keeps its own dup of the fd, so close ours right away.
    spawnDetachedServer(process.execPath, [projectDir, ...args], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      shell: process.platform === "win32",
    });
  } finally {
    if (typeof logFd === "number") closeSync(logFd);
  }
}

function spawnOpenserpServer(): void {
  const { hostname, port } = new URL(openserpBaseUrl());
  spawnDetachedServer("openserp", ["serve", "-a", hostname, "-p", port, "--quiet"], {
    detached: true,
    stdio: "ignore",
    shell: process.platform === "win32",
  });
}

// The servers are machine-scoped and outlive this CLI process, so spawn them
// detached. Swallow spawn errors (e.g. binary missing from PATH): the
// health-check loop reports them as a backend failure instead.
function spawnDetachedServer(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  const child = spawn(command, args, options);
  child.on("error", () => {});
  child.unref();
  return child;
}

// --- camoufox server process (`browse __server`) ---

const nodeRequire = createRequire(import.meta.url);

// This script (~/.agents/cli/browse) has no node_modules of its own, so
// resolve camoufox-js explicitly from the bun-installed roots that may carry
// it. Either root satisfies the server; which one is installed is a machine
// detail.
function resolveCamoufoxJsUrl(): string {
  const candidates = [
    join(homedir(), ".dsh", "plugins", "web-search"),
    join(homedir(), ".pi", "agent"),
  ];
  for (const dir of candidates) {
    try {
      const resolved = nodeRequire.resolve("camoufox-js/dist/utils.js", { paths: [dir] });
      return pathToFileURL(resolved).href;
    } catch {
      // not installed under this root; try the next
    }
  }
  throw new Error(`camoufox-js not found under ${candidates.join(", ")}`);
}

// Fingerprint generation borrows camoufox-js; the browser itself is launched
// by the same playwright-core that playwright-cli embeds, so the server
// always speaks the client's protocol version (no HTTP 428 on connect).
interface CamoufoxServerHandle {
  close(): Promise<void>;
}

interface ServerLaunchOptions {
  env?: Record<string, string | undefined>;
  executablePath?: string;
  [extra: string]: unknown;
}

interface CamoufoxJsModule {
  launchOptions(options: Record<string, unknown>): Promise<ServerLaunchOptions>;
}

interface PlaywrightCoreModule {
  firefox: { launchServer(options: Record<string, unknown>): Promise<CamoufoxServerHandle> };
}

// The playwright-cli-embedded playwright-core is the single source of truth
// for the server's protocol version: clients must send a matching major.minor
// in their User-Agent or the upgrade is rejected with HTTP 428.
function resolvePlaywrightCore(): PlaywrightCoreModule {
  const override = process.env.CAMOUFOX_PLAYWRIGHT_CORE;
  if (override) return nodeRequire(override) as PlaywrightCoreModule;
  const finder = process.platform === "win32" ? "where" : "which";
  const output = spawnSync(finder, ["playwright-cli"], { encoding: "utf8" });
  const binary = output.stdout?.trim().split(/\r?\n/)[0];
  if (!binary) throw new Error("playwright-cli not found on PATH");
  const packageDir = dirname(realpathSync(binary));
  return nodeRequire(
    nodeRequire.resolve("playwright-core", { paths: [packageDir] }),
  ) as PlaywrightCoreModule;
}

// Spec: 接続先（CAMOUFOX_BASE_URL）の host・port・path で待ち受ける。
export async function runCamoufoxServer(): Promise<void> {
  const baseUrl = new URL(process.env.CAMOUFOX_BASE_URL ?? CAMOUFOX_DEFAULT_BASE_URL);

  // The spawner appends this server's stdout/stderr to the log file across
  // starts, so leave a timestamped line to tell the runs apart when debugging
  // hangs.
  console.log(`[camoufox-server] starting on ${baseUrl} at ${new Date().toISOString()}`);

  const { launchOptions } = (await import(resolveCamoufoxJsUrl())) as CamoufoxJsModule;
  const { firefox } = resolvePlaywrightCore();

  // Linux では既定で headed（Xvfb 上）。CAMOUFOX_HEADLESS=1 で従来の headless。
  const headless = resolveHeadless();
  if (!headless) {
    await ensureDisplay();
    await ensureX11vnc();
  }

  // Fingerprint: freshly generated on every server start (os spoofed to
  // Windows). block_webgl disables WebGL instead of spoofing it: sampling the
  // WebGL fingerprint needs better-sqlite3, whose native build is unavailable
  // here.
  const launch = await launchOptions({
    headless,
    os: ["windows"],
    executable_path: CAMOUFOX_EXECUTABLE_PATH,
    i_know_what_im_doing: true,
    block_webgl: true,
    // Headed 起動では camoufox-js の virtual_display で DISPLAY を Xvfb の :99
    // へ固定する。未指定のままでは server が親シェルから継承した実画面の
    // DISPLAY（例: WSLg の :0）へブラウザのウィンドウが出てしまう。
    ...(headless ? {} : { virtual_display: `:${DISPLAY_NUMBER}` }),
  });

  // Headed on Xvfb must go through X11: with WAYLAND_DISPLAY in the
  // environment (e.g. WSLg), Firefox picks the Wayland backend and shows the
  // window on the real screen regardless of DISPLAY. Keep Firefox's process
  // sandboxes enabled; sandboxed-tools exposes the procfs needed by nested
  // user namespaces.
  launch.env = {
    ...launch.env,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`,
    ...(headless ? {} : { MOZ_ENABLE_WAYLAND: "0" }),
  };

  const server = await firefox.launchServer({
    ...launch,
    host: baseUrl.hostname,
    port: Number(baseUrl.port),
    wsPath: baseUrl.pathname === "/" ? "/camoufox" : baseUrl.pathname,
  });
  writeServerPidFile();
  console.log(`[camoufox-server] listening on ${baseUrl}`);
  console.log(`[camoufox-server] executablePath: ${launch.executablePath}`);

  process.on("SIGINT", () => void shutdownServer(server));
  process.on("SIGTERM", () => void shutdownServer(server));
}

async function shutdownServer(server: CamoufoxServerHandle): Promise<void> {
  clearServerPidFile();
  await server.close();
  process.exit(0);
}

// --- server pid file / restart targeting ---

// The server records its pid after the port is established, so `browse
// restart` can stop exactly the server process. A port-race loser exits
// before writing, keeping the winner's record intact.
function serverPidFilePath(): string {
  return join(stateDir(), "camoufox-server.pid");
}

function writeServerPidFile(): void {
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(serverPidFilePath(), `${process.pid}\n`);
  } catch {
    // Best effort: restart falls back to the pgrep sweep below.
  }
}

function readServerPidFile(): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(serverPidFilePath(), "utf8").trim(), 10);
    return Number.isInteger(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

function clearServerPidFile(): void {
  try {
    if (readServerPidFile() === process.pid) rmSync(serverPidFilePath());
  } catch {
    // Best effort: a stale pid file is validated before any kill.
  }
}

async function stopCamoufoxServers(): Promise<void> {
  const pids = camoufoxServerPids();
  if (pids.length === 0) return;
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  const deadline = Date.now() + SERVER_STOP_TIMEOUT_MS;
  while (Date.now() < deadline && pids.some(processAlive)) {
    await delay(100);
  }
  // A hung server ignores SIGTERM; escalate so restart always recovers.
  for (const pid of pids) {
    if (processAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  // Give the kernel a moment to release the listening port after SIGKILL.
  const killDeadline = Date.now() + 2_000;
  while (Date.now() < killDeadline && pids.some(processAlive)) {
    await delay(50);
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Identify the server processes to stop: the pid file is the primary record,
// and a pgrep sweep of the exact "<script> __server" command line catches
// current servers whose pid file was lost. Search/fetch processes never match
// the pattern because their command line names a different subcommand.
function camoufoxServerPids(): number[] {
  const pids = new Set<number>();
  const pidFilePid = readServerPidFile();
  if (
    pidFilePid !== undefined &&
    pidFilePid !== process.pid &&
    looksLikeCamoufoxServer(pidFilePid)
  ) {
    pids.add(pidFilePid);
  }
  for (const pattern of [`${projectDir} ${SERVER_SUBCOMMAND}`]) {
    const sweep = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
    if (sweep.status !== 0) continue;
    for (const line of sweep.stdout.split("\n")) {
      const pid = Number.parseInt(line, 10);
      if (
        Number.isInteger(pid) &&
        pid !== process.pid &&
        looksLikeCamoufoxServer(pid)
      ) {
        pids.add(pid);
      }
    }
  }
  return [...pids];
}

// A recycled pid must never be killed: on Linux verify the command line still
// names this browse script and the server mode; elsewhere fall back to the
// alive check alone.
function looksLikeCamoufoxServer(pid: number): boolean {
  if (process.platform !== "linux") return processAlive(pid);
  try {
    const args = readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .split("\0")
      .filter(Boolean);
    const scriptPath = realpathSync(projectDir);
    const normalizedArgs = args.map((arg) => {
      try {
        return realpathSync(arg);
      } catch {
        return arg;
      }
    });
    return isCamoufoxServerCommand(normalizedArgs, scriptPath, SERVER_SUBCOMMAND);
  } catch {
    return false;
  }
}


