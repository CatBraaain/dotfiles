import { basename, dirname, isAbsolute } from "node:path";
import { GENERATED_ENV_KEYS, PSMUX_ROUTING } from "./configuration";
import { InitialRequestFiles } from "./initial-request-files";
import { matchesLaunch } from "./pane-inventory";
import { platform } from "./platform";
import { POLL_INTERVAL_MS, SESSION_ID_PATTERN, STARTUP_TIMEOUT_MS } from "./session-model";

function isGeneratedKey(key: string, windows: boolean): boolean {
  const name = windows ? key.toUpperCase() : key;
  return GENERATED_ENV_KEYS.has(name) || (windows && PSMUX_ROUTING.has(name));
}

export function reloadProcessEnvironment(
  requested: Record<string, string>,
  inherited: NodeJS.ProcessEnv,
  windows = platform.windows,
): Record<string, string> {
  const entries = new Map<string, [string, string]>();
  for (const [key, value] of Object.entries(requested)) {
    if (!isGeneratedKey(key, windows)) entries.set(windows ? key.toUpperCase() : key, [key, value]);
  }
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined && isGeneratedKey(key, windows)) {
      const name = windows ? key.toUpperCase() : key;
      entries.set(name, [name, value]);
    }
  }
  return Object.fromEntries(entries.values());
}

export async function claimLinuxReload(token: string): Promise<never> {
  if (process.platform !== "linux" || typeof process.execve !== "function")
    throw new Error("This reload launcher requires Linux and Bun process.execve");
  const inherited = Object.fromEntries(
    (platform.processEnvironment(process.pid) ?? []).flatMap((entry) => {
      const separator = entry.indexOf("=");
      return separator > 0 ? [[entry.slice(0, separator), entry.slice(separator + 1)]] : [];
    }),
  );
  const {
    TMUX,
    TMUX_PANE: pane,
    PI_TMUX_SESSION_ID: id,
    PI_TMUX_LAUNCH_TOKEN: launchToken,
  } = inherited;
  const route = /^(.*),([1-9]\d*),(\d+)$/s.exec(TMUX ?? "");
  const socket = route?.[1];
  if (
    !route ||
    !socket ||
    !isAbsolute(socket) ||
    basename(socket) !== "server.sock" ||
    basename(dirname(socket)) !== "pi-tmux" ||
    !pane ||
    !/^%\d+$/.test(pane) ||
    !id ||
    !SESSION_ID_PATTERN.test(id) ||
    launchToken !== token
  )
    throw new Error("Cannot identify the reload tmux pane");

  const serverPid = Number(route[2]);
  if (serverPid !== process.ppid) throw new Error("The reload tmux parent changed");
  const session = `$${route[3]}`;
  const files = InitialRequestFiles.open({ directory: dirname(socket) });
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  const format =
    "#{pid}|#{session_id}|#{pane_id}|#{pane_pid}|#{pane_dead}|#{@pi-mux-generation}|#{@pi-mux-launch}";
  while (Date.now() < deadline) {
    const child: Bun.Subprocess<"ignore", "pipe", "ignore"> = Bun.spawn(
      [`/proc/${serverPid}/exe`, "-N", "-S", socket, "display-message", "-p", "-t", pane, format],
      {
        env: {},
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        timeout: Math.max(1, deadline - Date.now()),
      },
    );
    const [output, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    const [actualServer, actualSession, actualPane, panePid, dead, generation, launch] = output
      .trimEnd()
      .split("|");
    if (
      status !== 0 ||
      actualServer !== String(serverPid) ||
      actualSession !== session ||
      actualPane !== pane ||
      panePid !== String(process.pid) ||
      dead !== "0" ||
      !generation
    )
      throw new Error("The reload tmux pane identity changed");
    if (!launch || !matchesLaunch(launch, id, process.pid, launchToken)) {
      await Bun.sleep(POLL_INTERVAL_MS);
      continue;
    }

    const { command, cwd, environment } = files.takeReload({
      socket,
      session,
      pane,
      generation,
      id,
      launchToken,
      serverPid,
    });
    try {
      process.chdir(cwd);
      return process.execve(command[0]!, command, reloadProcessEnvironment(environment, inherited));
    } catch {
      throw new Error("Cannot start Pi with the reload environment");
    }
  }
  throw new Error("Timed out confirming the reload tmux launch");
}
