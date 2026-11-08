import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { quote } from "shell-quote";
import {
  assertPrivatePath,
  cleanEnvironment,
  connectionSchema,
  manifestSchema,
  readPrivateJson,
  startupSchema,
} from "./protocol.mjs";

export { cleanEnvironment, connectionSchema, PARENT_PI_ENV_KEYS } from "./protocol.mjs";
export type ConnectionRecord = Static<typeof connectionSchema>;
export type Startup = Static<typeof startupSchema>;
type SessionManager = ExtensionContext["sessionManager"];
export type TmuxPaths = ReturnType<typeof getTmuxPaths>;
export type Execute = ExtensionAPI["exec"];

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const TMUX_TIMEOUT_MS = 5_000;
const STARTUP_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 50;
const SESSION_VALUE_FLAGS = new Set([
  "--session",
  "--session-id",
  "--session-dir",
  "--fork",
  "--name",
  "-n",
]);
const SESSION_SWITCH_FLAGS = new Set(["--continue", "-c", "--resume", "-r", "--no-session"]);
const VALUE_FLAGS = new Set([
  "--mode",
  "--provider",
  "--model",
  "--api-key",
  "--system-prompt",
  "--append-system-prompt",
  "--models",
  "--tools",
  "-t",
  "--exclude-tools",
  "-xt",
  "--thinking",
  "--export",
  "--extension",
  "-e",
  "--skill",
  "--prompt-template",
  "--theme",
  "--use-theme",
  "--tui-mode",
]);

export function getTmuxPaths(env: NodeJS.ProcessEnv = process.env) {
  const runtime = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid!()}`;
  if (!isAbsolute(runtime)) throw new Error("XDG_RUNTIME_DIR must be absolute");
  const directory = join(runtime, "pi-tmux");
  return {
    directory,
    socketPath: join(directory, "server.sock"),
    instancesDir: join(directory, "instances"),
    launchesDir: join(directory, "launches"),
    configPath: join(MODULE_DIR, "tmux.conf"),
    launcherPath: join(MODULE_DIR, "launch.mjs"),
  };
}

export function tmuxArgs(paths: TmuxPaths, args: string[]): string[] {
  return ["-S", paths.socketPath, "-f", paths.configPath, ...args];
}

export function attachCommand(
  record: Pick<ConnectionRecord, "socketPath" | "tmuxSessionId">,
): string {
  return quote(["tmux", "-S", record.socketPath, "attach-session", "-t", record.tmuxSessionId]);
}

export function ensureTmuxDirectories(paths: TmuxPaths): void {
  for (const path of [paths.directory, paths.instancesDir, paths.launchesDir]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    assertPrivatePath(path, true);
  }
}

export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string {
  for (const directory of (env.PATH ?? "").split(":")) {
    const candidate = resolve(directory || ".", name);
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        (error as NodeJS.ErrnoException).code !== "EACCES"
      )
        throw error;
    }
  }
  throw new Error(`Executable not found: ${name}`);
}

export function normalizeSessionArgs(argv: string[], session: SessionManager) {
  const kept: string[] = [];
  let hasExplicitSession = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--") {
      kept.push(...argv.slice(index));
      break;
    }
    if (SESSION_VALUE_FLAGS.has(arg)) {
      if (arg === "--session") hasExplicitSession = true;
      index++;
      continue;
    }
    if (SESSION_SWITCH_FLAGS.has(arg)) continue;
    kept.push(arg);
    const next = argv[index + 1];
    const isUnknownValue =
      arg.startsWith("--") &&
      !arg.includes("=") &&
      !VALUE_FLAGS.has(arg) &&
      next !== undefined &&
      !next.startsWith("-") &&
      !next.startsWith("@");
    if (next !== undefined && (VALUE_FLAGS.has(arg) || isUnknownValue)) kept.push(argv[++index]!);
  }

  const file = session.getSessionFile();
  const id = session.getSessionId();
  const name = session.getSessionName();
  const nameArgs = name === undefined ? [] : ["--name", name];
  if (!file) return { argv: ["--no-session", "--session-id", id, ...nameArgs, ...kept] };
  if (existsSync(file))
    return { argv: ["--session", file, "--session-dir", session.getSessionDir(), ...kept] };
  if (hasExplicitSession || session.getHeader()?.parentSession) {
    return {
      argv: ["--session", file, "--session-dir", session.getSessionDir(), ...kept],
      provisionalSessionFile: file,
    };
  }
  return {
    argv: ["--session-id", id, "--session-dir", session.getSessionDir(), ...nameArgs, ...kept],
  };
}

export async function inspectManagedPane(
  execute: Execute,
  paths: TmuxPaths,
  tmux: string,
): Promise<
  | Omit<ConnectionRecord, "version" | "instanceId" | "sessionId" | "sessionFile" | "pidStartTime">
  | undefined
> {
  const [socket, serverPid] = (process.env.TMUX ?? "").split(",");
  if (socket !== paths.socketPath || !process.env.TMUX_PANE) return undefined;
  const result = await execute(
    tmux,
    tmuxArgs(paths, [
      "display-message",
      "-p",
      "-t",
      process.env.TMUX_PANE,
      "#{socket_path}\t#{pid}\t#{session_id}\t#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_tty}\t#{pane_pid}",
    ]),
    { timeout: TMUX_TIMEOUT_MS },
  );
  if (!isExecComplete(result)) throw new Error("Cannot confirm managed tmux pane");
  if (result.code !== 0) return undefined;
  const [actualSocket, actualServer, tmuxSessionId, sessionName, windowId, paneId, tty, pid] =
    result.stdout.trim().split("\t");
  const verified =
    actualSocket === paths.socketPath &&
    actualServer === serverPid &&
    paneId === process.env.TMUX_PANE &&
    tty === readlinkSync("/proc/self/fd/0") &&
    Number(pid) === process.pid;
  if (!verified || !tmuxSessionId || !sessionName || !windowId || !paneId || !tty) return undefined;
  return {
    socketPath: actualSocket,
    serverPid: Number(actualServer),
    tmuxSessionId,
    sessionName,
    windowId,
    paneId,
    tty,
    pid: Number(pid),
  };
}

export function publishConnection(paths: TmuxPaths, record: ConnectionRecord): string {
  const path = join(paths.instancesDir, `${record.instanceId}.json`);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(record) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(temporaryPath, path);
  return path;
}

export function pidStartTime(): string {
  const stat = readFileSync("/proc/self/stat", "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return fields[19]!;
}

export function consumeStartup(paths: TmuxPaths, sessionId: string): Startup | undefined {
  const directory = process.env.PI_TMUX_HANDOFF;
  if (!directory) return undefined;
  if (dirname(directory) !== paths.launchesDir) throw new Error("Unexpected handoff directory");
  assertPrivatePath(directory, true);
  const startup = readPrivateJson(join(directory, "startup.json"), startupSchema) as Startup;
  if (
    startup.instanceId !== basename(directory) ||
    startup.socketPath !== paths.socketPath ||
    startup.sessionId !== sessionId
  )
    throw new Error("Handoff session mismatch");
  rmSync(join(directory, "startup.json"));
  rmdirSync(directory);
  delete process.env.PI_TMUX_HANDOFF;
  return startup;
}

export async function handoff(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  paths: TmuxPaths,
  tmux: string,
): Promise<never> {
  const normalized = normalizeSessionArgs(process.argv.slice(2), ctx.sessionManager);
  const instanceId = randomUUID();
  const directory = join(paths.launchesDir, instanceId);
  mkdirSync(directory, { mode: 0o700 });
  const startup: Startup = {
    version: 1,
    instanceId,
    sessionId: ctx.sessionManager.getSessionId(),
    socketPath: paths.socketPath,
    editorText: ctx.ui.getEditorText(),
    provisionalSessionFile: normalized.provisionalSessionFile,
  };
  const manifest: Static<typeof manifestSchema> = {
    version: 1,
    execPath: process.execPath,
    execArgv: [...process.execArgv],
    argv: [realpathSync(process.argv[1]!), ...normalized.argv],
    cwd: process.cwd(),
    env: cleanEnvironment(process.env),
    startup,
  };
  let backendReady = false;
  let creationRequested = false;
  try {
    if (normalized.provisionalSessionFile) {
      writeFileSync(
        normalized.provisionalSessionFile,
        [ctx.sessionManager.getHeader(), ...ctx.sessionManager.getEntries()]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
        { mode: 0o600, flag: "wx" },
      );
    }
    writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest), {
      mode: 0o600,
      flag: "wx",
    });
    const bootstrap = `exec /usr/bin/env -i TERM="$TERM" TMUX="$TMUX" TMUX_PANE="$TMUX_PANE" ${quote([process.execPath, paths.launcherPath, directory])}`;
    creationRequested = true;
    const created = await pi.exec(
      tmux,
      tmuxArgs(paths, [
        "new-session",
        "-d",
        "-s",
        `pi-${instanceId}`,
        "-n",
        "pi",
        "-c",
        manifest.cwd,
        "-x",
        String(process.stdout.columns || 80),
        "-y",
        String(process.stdout.rows || 24),
        bootstrap,
      ]),
      { timeout: TMUX_TIMEOUT_MS },
    );
    if (!isExecComplete(created) || created.code !== 0)
      throw new Error(`Cannot create tmux session: ${created.stderr.trim()}`);
    const record = await waitForBackend(pi.exec, paths, tmux, startup, directory);
    backendReady = true;
    process.stderr.write(`tmux-handoff: reconnect with ${attachCommand(record)}\n`);
    process.execve!(
      tmux,
      [tmux, ...tmuxArgs(paths, ["attach-session", "-t", record.tmuxSessionId])],
      cleanEnvironment(process.env),
    );
    throw new Error("Client execve returned");
  } catch (error) {
    let backendStopped = !creationRequested;
    if (creationRequested && !backendReady) {
      try {
        const stopped = await pi.exec(
          tmux,
          tmuxArgs(paths, ["kill-session", "-t", `=pi-${instanceId}`]),
          { timeout: TMUX_TIMEOUT_MS },
        );
        const targetAbsent =
          stopped.code === 1 &&
          (stopped.stderr.includes("can't find session") ||
            stopped.stderr.includes("no server running"));
        backendStopped = isExecComplete(stopped) && (stopped.code === 0 || targetAbsent);
      } catch {
        backendStopped = false;
      }
      if (!backendStopped)
        process.stderr.write("tmux-handoff: backend cleanup could not confirm termination\n");
    }
    rmSync(directory, { recursive: true, force: true });
    if (!backendReady && backendStopped && normalized.provisionalSessionFile)
      removeProvisionalSession(normalized.provisionalSessionFile, startup.sessionId);
    throw error;
  }
}

function isExecComplete(result: Awaited<ReturnType<Execute>> & { truncated?: boolean }): boolean {
  return !result.killed && !result.truncated;
}

async function waitForBackend(
  execute: Execute,
  paths: TmuxPaths,
  tmux: string,
  startup: Startup,
  directory: string,
): Promise<ConnectionRecord> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  const recordPath = join(paths.instancesDir, `${startup.instanceId}.json`);
  while (Date.now() < deadline) {
    if (existsSync(recordPath)) {
      const record = readPrivateJson(recordPath, connectionSchema) as ConnectionRecord;
      if (record.sessionId !== startup.sessionId) throw new Error("Backend session mismatch");
      return record;
    }
    if (existsSync(join(directory, "error.json"))) throw new Error("Backend launch failed");
    const alive = await execute(
      tmux,
      tmuxArgs(paths, ["has-session", "-t", `=pi-${startup.instanceId}`]),
      { timeout: TMUX_TIMEOUT_MS },
    );
    if (!isExecComplete(alive)) throw new Error("Cannot confirm backend tmux session");
    if (alive.code !== 0) throw new Error("Backend exited before handoff");
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(
    `Backend startup timed out; reconnect with tmux -S ${quote([paths.socketPath])} attach-session`,
  );
}

export function removeProvisionalSession(path: string, sessionId: string): void {
  if (!existsSync(path)) return;
  const entries: Array<{ type?: string; id?: string; message?: { role?: string } }> = readFileSync(
    path,
    "utf8",
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const header = entries[0];
  const hasConversation = entries.some(
    (entry) =>
      entry.type === "message" &&
      (entry.message?.role === "user" || entry.message?.role === "assistant"),
  );
  if (header?.type === "session" && header.id === sessionId && !hasConversation) rmSync(path);
}
