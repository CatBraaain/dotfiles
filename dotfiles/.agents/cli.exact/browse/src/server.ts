import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CAMOUFOX_DEFAULT_BASE_URL,
  camoufoxBaseUrl,
  currentSlotNumber,
  FLOCK_CONFLICT_EXIT_CODE,
  LOCKED_SUBCOMMAND,
  openserpBaseUrl,
  RESTART_COOLDOWN_MS,
  RESTART_LOCK_FILE,
  SERVER_HEALTH_POLL_INTERVAL_MS,
  SERVER_STOP_TIMEOUT_MS,
  SERVER_SUBCOMMAND,
  SERVER_WAIT_TIMEOUT_MS,
  slotLockFile,
  SLOT_COUNT,
  stateDir,
  WEBSOCKET_HEALTH_TIMEOUT_MS,
} from "./config";
import { ensureDisplay, ensureX11vnc, DISPLAY_NUMBER, resolveHeadless } from "./display";
import { openLinuxProcess } from "./linux-process";
import { resolveWindowsPlaywrightCli } from "./playwright-cli";
import { delay, selfRunArgv, selfRunPath } from "./util";
import { findWindowsServerProcesses, stopWindowsProcess } from "./windows-process";

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
  const port = camoufoxServerPort(baseUrl);
  const signal = AbortSignal.timeout(SERVER_WAIT_TIMEOUT_MS);
  if (await camoufoxServerHealthy(baseUrl, signal)) return;
  const supportsDiscovery = process.platform === "linux" || process.platform === "win32";
  if (!supportsDiscovery || !findServerProcess(port)) {
    spawnBrowseDetached([SERVER_SUBCOMMAND, port]);
  }
  await waitForServerHealthy(baseUrl, signal);
}

export function camoufoxServerPort(baseUrl: string | URL = camoufoxBaseUrl()): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("CAMOUFOX_BASE_URL must use ws: or wss:");
  }
  const port = url.port || (url.protocol === "ws:" ? "80" : "443");
  if (port === "0") throw new Error("CAMOUFOX_BASE_URL must use a nonzero port");
  return port;
}

type ServerProcess = { pid: number; identity: string; startedAtMs?: number };

export async function restartCamoufoxServer(): Promise<void> {
  const endpoint = camoufoxBaseUrl();
  const port = camoufoxServerPort(endpoint);
  const target = findServerProcess(port);
  if (target) await stopServerProcess(target, port);

  const signal = AbortSignal.timeout(SERVER_WAIT_TIMEOUT_MS);
  if (await camoufoxServerHealthy(endpoint, signal)) {
    throw new Error(`Cannot restart Camoufox: ${endpoint} is already responding`);
  }
  const child = spawnBrowseDetached([SERVER_SUBCOMMAND, port], "notify");
  let ready = false;
  child.on("message", (message) => {
    if (message === "camoufox-ready") ready = true;
  });
  try {
    await waitForServerHealthy(endpoint, signal, () => ready && child.exitCode == null);
  } finally {
    if (child.connected) child.disconnect();
  }
}

export async function stopCamoufoxServer(): Promise<void> {
  const port = camoufoxServerPort();
  const target = findServerProcess(port);
  if (target) await stopServerProcess(target, port);
}

// --- render-recovery restart arbitration ---

// Spec: render 復旧に伴う server 再起動は restart ロックで仲裁する。restart ロック
// を獲得した側は、自分の render スロット以外を獲得してから再起動する（自身の
// スロットは呼び出し元が保持中のため、4 スロットすべてが再起動中に排除される）。
// 獲得できなかった側は再起動を申請せず、healthy を待つ。restart ロックは
// 非ブロッキングでしか取らないため、複数の復旧や drain restart と循環待ちに
// ならない。
type RecoveryRestartOutcome = "won" | "lost" | "no-flock";

function tryRunRecoveryRestart(): RecoveryRestartOutcome {
  const stateDirPath = stateDir();
  // flock(1) does not create the lock file's parent directory.
  mkdirSync(stateDirPath, { recursive: true });
  const mySlot = currentSlotNumber();
  const args = [
    "-n",
    "-E",
    String(FLOCK_CONFLICT_EXIT_CODE),
    join(stateDirPath, RESTART_LOCK_FILE),
  ];
  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    if (slot === mySlot) continue;
    args.push("flock", join(stateDirPath, slotLockFile(slot)));
  }
  // The re-entered `__locked server restart` runs the restart body directly.
  args.push(...selfRunArgv, LOCKED_SUBCOMMAND, "server", "restart");
  const result = spawnSync("flock", args, { stdio: "inherit", env: process.env });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return "no-flock";
  if (result.status === FLOCK_CONFLICT_EXIT_CODE) return "lost";
  if (result.status === 0) return "won";
  const reason = result.error?.message ?? result.signal ?? result.status;
  throw new Error("Camoufox recovery restart failed: " + reason);
}

// Recovery entry for the camoufox retry hook (the caller holds a render slot).
export async function recoverCamoufoxServer(): Promise<void> {
  // Spec: server が起動してから 30 秒以内の再起動申請は、再起動せず healthy を
  // 15 秒まで待つ（起動直後の server の立て続けな再起動を避ける）。
  if (restartInCooldown(serverStartedAtMs(), Date.now())) {
    await waitForServerHealthy(camoufoxBaseUrl(), AbortSignal.timeout(SERVER_WAIT_TIMEOUT_MS));
    return;
  }
  const outcome = tryRunRecoveryRestart();
  if (outcome === "won") return;
  if (outcome === "no-flock") return restartCamoufoxServer();
  // Another restart holds the lock: wait for the restarted server instead of
  // queueing a second restart (spec: healthy を 15 秒まで待つ).
  await waitForServerHealthy(camoufoxBaseUrl(), AbortSignal.timeout(SERVER_WAIT_TIMEOUT_MS));
}

function serverStartedAtMs(): number | undefined {
  const port = camoufoxServerPort();
  const target = findServerProcess(port);
  if (!target) return undefined;
  if (process.platform === "win32") return target.startedAtMs;

  const age = spawnSync("ps", ["-p", String(target.pid), "-o", "etimes="], {
    encoding: "utf8",
    timeout: SERVER_STOP_TIMEOUT_MS,
  });
  const seconds = age.stdout?.trim() ?? "";
  if (age.status !== 0 || !/^\d+$/.test(seconds)) return undefined;
  if (linuxProcessIdentity(target.pid, port) !== target.identity) return undefined;
  return Date.now() - Number(seconds) * 1000;
}

export function restartInCooldown(startedAtMs: number | undefined, nowMs: number): boolean {
  return startedAtMs !== undefined && nowMs - startedAtMs < RESTART_COOLDOWN_MS;
}

// --- restart-lock observation (queued render slots) ---

// Spec: restart ロックの保持を探知する。Acquiring it for a no-op (and letting
// go right away) means no restart is in flight; a lost probe means `browse
// server restart` or a render-recovery restart holds the lock. Crashes cannot
// wedge this: the kernel releases the flock, unlike a flag file.
export function restartInFlight(): boolean {
  const probe = spawnSync("flock", [
    "-n",
    "-E",
    String(FLOCK_CONFLICT_EXIT_CODE),
    join(stateDir(), RESTART_LOCK_FILE),
    "true",
  ]);
  if (probe.error) return false; // no flock(1): no restart queue to yield to
  return probe.status === FLOCK_CONFLICT_EXIT_CODE;
}

// Wait up to the timeout for the in-flight restart to release the restart lock
// (running a no-op under it, then letting go right away). Returning without the
// lock on timeout is fine: the caller re-probes restartInFlight() and yields
// again while a restart is still in flight.
export function waitForRestartToFinish(timeoutMs = SERVER_WAIT_TIMEOUT_MS): void {
  const result = spawnSync("flock", [
    "-w",
    String(Math.ceil(timeoutMs / 1000)),
    join(stateDir(), RESTART_LOCK_FILE),
    "true",
  ]);
  if (result.error) return; // no flock(1): nothing to wait for
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

async function waitForServerHealthy(
  baseUrl: string,
  signal: AbortSignal,
  isLocalServerReady?: () => boolean,
): Promise<void> {
  while (!signal.aborted) {
    await delay(SERVER_HEALTH_POLL_INTERVAL_MS, signal);
    if (isLocalServerReady && !isLocalServerReady()) continue;
    if (
      (await camoufoxServerHealthy(baseUrl, signal)) &&
      (!isLocalServerReady || isLocalServerReady())
    ) {
      return;
    }
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
function spawnBrowseDetached(args: readonly string[], readiness?: "notify"): ChildProcess {
  let logFd: number | "ignore" = "ignore";
  try {
    mkdirSync(stateDir(), { recursive: true });
    logFd = openSync(join(stateDir(), "camoufox-server.log"), "a");
  } catch {
    // The append log is best effort; run the child with discarded output.
  }
  try {
    // The child keeps its own dup of the fd, so close ours right away.
    return spawnDetachedServer(selfRunArgv[0], [...selfRunArgv.slice(1), ...args], {
      detached: true,
      stdio: readiness ? ["ignore", logFd, logFd, "ipc"] : ["ignore", logFd, logFd],
    });
  } finally {
    if (typeof logFd === "number") closeSync(logFd);
  }
}

// --quiet keeps logs on stderr only (no logs.txt in the CWD); --log_level
// error suppresses warn-level logs.
export function openserpServeArgs(hostname: string, port: string): string[] {
  return ["serve", "-a", hostname, "-p", port, "--quiet", "--log_level", "error"];
}

function spawnOpenserpServer(): void {
  const { hostname, port } = new URL(openserpBaseUrl());
  spawnDetachedServer("openserp", openserpServeArgs(hostname, port), {
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
// resolve camoufox-js explicitly from the bun-installed pi agent root that
// may carry it.
function resolveCamoufoxJsUrl(): string {
  const candidates = [join(homedir(), ".pi", "agent")];
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

async function validateWindowsCamoufoxInstall(camoufoxJsUrl: string): Promise<string> {
  if (!process.env.CAMOUFOX_INSTALL_DIR) {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    process.env.CAMOUFOX_INSTALL_DIR = join(localAppData, "Programs", "Camoufox");
  }
  const pkgmanUrl = new URL("./pkgman.js", camoufoxJsUrl);
  const { camoufoxPath } = (await import(pkgmanUrl.href)) as {
    camoufoxPath(downloadIfMissing: boolean): string;
  };

  let installDir: string;
  try {
    installDir = camoufoxPath(false);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid Camoufox installation at ${process.env.CAMOUFOX_INSTALL_DIR}: ${reason}`,
      {
        cause: error,
      },
    );
  }
  const executablePath = process.env.CAMOUFOX_EXECUTABLE_PATH ?? join(installDir, "camoufox.exe");
  if (!statSync(executablePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Camoufox executable not found at ${executablePath}`);
  }
  return executablePath;
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
  if (process.platform === "win32") {
    const { entry } = resolveWindowsPlaywrightCli();
    return createRequire(entry)("playwright-core") as PlaywrightCoreModule;
  }
  const output = spawnSync("which", ["playwright-cli"], { encoding: "utf8" });
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

  const camoufoxJsUrl = resolveCamoufoxJsUrl();
  const windowsExecutablePath =
    process.platform === "win32" ? await validateWindowsCamoufoxInstall(camoufoxJsUrl) : undefined;
  const { launchOptions } = (await import(camoufoxJsUrl)) as CamoufoxJsModule;
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
    executable_path:
      windowsExecutablePath ??
      process.env.CAMOUFOX_EXECUTABLE_PATH ??
      join(homedir(), ".cache", "camoufox", "camoufox-bin"),
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
  // sandboxes enabled; guardrail exposes the procfs needed by nested
  // user namespaces.
  launch.env = {
    ...launch.env,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`,
    ...(headless ? {} : { MOZ_ENABLE_WAYLAND: "0" }),
  };

  const server = await firefox.launchServer({
    ...launch,
    host: baseUrl.hostname,
    port: Number(camoufoxServerPort(baseUrl)),
    wsPath: baseUrl.pathname === "/" ? "/camoufox" : baseUrl.pathname,
  });
  console.log(`[camoufox-server] listening on ${baseUrl}`);
  console.log(`[camoufox-server] executablePath: ${launch.executablePath}`);

  process.on("SIGINT", () => void shutdownServer(server));
  process.on("SIGTERM", () => void shutdownServer(server));
  process.send?.("camoufox-ready");
}

async function shutdownServer(server: CamoufoxServerHandle): Promise<void> {
  await server.close();
  process.exit(0);
}

function findServerProcess(port: string): ServerProcess | undefined {
  const candidates =
    process.platform === "win32"
      ? findWindowsServerProcesses(selfRunArgv, SERVER_SUBCOMMAND, port)
      : findLinuxServerProcesses(port);
  if (candidates.length > 1)
    throw new Error("Multiple local Camoufox servers match the configured port");
  return candidates[0];
}

async function stopServerProcess(target: ServerProcess, port: string): Promise<void> {
  if (process.platform === "win32") {
    stopWindowsProcess(target.pid, target.identity, SERVER_STOP_TIMEOUT_MS);
    return;
  }
  const handle = openLinuxProcess(target.pid);
  if (!handle) return;
  try {
    if (linuxProcessIdentity(target.pid, port) !== target.identity) {
      if (handle.hasExited()) return;
      throw new Error("Cannot confirm the Linux Camoufox process identity");
    }

    handle.send("SIGTERM");
    const deadline = Date.now() + SERVER_STOP_TIMEOUT_MS;
    while (Date.now() < deadline && !handle.hasExited()) await delay(100);
    if (handle.hasExited()) return;

    handle.send("SIGKILL");
    const killDeadline = Date.now() + 2_000;
    while (Date.now() < killDeadline && !handle.hasExited()) await delay(50);
    if (!handle.hasExited()) throw new Error("Camoufox server did not stop");
  } finally {
    handle.close();
  }
}

function findLinuxServerProcesses(port: string): ServerProcess[] {
  if (process.platform !== "linux") {
    throw new Error("Camoufox process discovery is only supported on Linux and Windows");
  }
  const pattern = SERVER_SUBCOMMAND + " " + port + "$";
  const sweep = spawnSync("pgrep", ["-u", String(process.geteuid?.()), "-f", "--", pattern], {
    encoding: "utf8",
    timeout: SERVER_STOP_TIMEOUT_MS,
  });
  if (sweep.status === 1) return [];
  if (sweep.status !== 0) {
    const reason = sweep.error?.message || sweep.stderr?.trim() || sweep.signal || sweep.status;
    throw new Error("Cannot find local Camoufox processes: pgrep: " + reason);
  }

  const pids = new Set(sweep.stdout.trim().split(/\s+/).map(Number));
  return [...pids].flatMap((pid) => {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return [];
    const identity = linuxProcessIdentity(pid, port);
    return identity === undefined ? [] : [{ pid, identity }];
  });
}

function linuxProcessStartTicks(proc: string): string | undefined {
  const stat = readFileSync(proc + "/stat", "utf8");
  const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
  const startTicks = fields[19];
  return fields[0] !== "Z" && startTicks && /^\d+$/.test(startTicks) ? startTicks : undefined;
}

function linuxProcessIdentity(pid: number, port: string): string | undefined {
  const proc = "/proc/" + pid;
  try {
    if (statSync(proc).uid !== process.geteuid?.()) return undefined;
    const identity = linuxProcessStartTicks(proc);
    if (!identity) return undefined;
    const args = readFileSync(proc + "/cmdline", "utf8").split("\0");
    if (args.at(-1) === "") args.pop();
    if (
      args.length !== selfRunArgv.length + 2 ||
      args.at(-2) !== SERVER_SUBCOMMAND ||
      args.at(-1) !== port
    ) {
      return undefined;
    }
    const expectedExecutable = realpathSync(process.execPath);
    const executable = readlinkSync(proc + "/exe");
    if (executable !== expectedExecutable && executable !== expectedExecutable + " (deleted)") {
      return undefined;
    }
    if (selfRunArgv.length === 2 && args[1] !== selfRunPath) return undefined;
    return linuxProcessStartTicks(proc) === identity ? identity : undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return undefined;
    throw error;
  }
}
