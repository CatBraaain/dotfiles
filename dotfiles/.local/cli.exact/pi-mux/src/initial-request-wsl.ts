import { tmuxConfiguration } from "./configuration";
import { InitialRequestFiles } from "./initial-request-files";
import { matchesLaunch, sessionName } from "./pane-inventory";
import { platform } from "./platform";
import { POLL_INTERVAL_MS, STARTUP_TIMEOUT_MS, UUID } from "./session-model";
import { tmux } from "./tmux";

function inheritedEnvironment(): Record<string, string> {
  const entries = platform.processEnvironment(process.pid) ?? [];
  return Object.fromEntries(
    entries.flatMap((entry) => {
      const separator = entry.indexOf("=");
      return separator > 0 ? [[entry.slice(0, separator), entry.slice(separator + 1)]] : [];
    }),
  );
}

export async function claimWslInitialRequest(token: string): Promise<never> {
  if (process.platform !== "linux" || typeof process.execve !== "function")
    throw new Error("This initial-request launcher requires Linux and Bun process.execve");
  const config = { ...tmuxConfiguration(), noStart: true } as const;
  const environment = inheritedEnvironment();
  const {
    TMUX,
    TMUX_PANE: pane,
    PI_TMUX_SESSION_ID: id,
    PI_TMUX_LAUNCH_TOKEN: launchToken,
  } = environment;
  const route = /^(.*),([1-9]\d*),(\d+)$/.exec(TMUX ?? "");
  if (
    !route ||
    route[1] !== config.socket ||
    !pane ||
    !/^%\d+$/.test(pane) ||
    !id ||
    !UUID.test(id) ||
    launchToken !== token ||
    environment.PI_TMUX_STARTUP_MODE !== "create"
  )
    throw new Error("Cannot identify the initial-request tmux pane");

  const [, socket, pid, sessionId] = route;
  const session = sessionName(id);
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  const format =
    "#{pid}\t#{session_id}\t#{session_name}\t#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{@pi-mux-generation}\t#{@pi-mux-launch}";
  while (Date.now() < deadline) {
    const result = await tmux(config, ["display-message", "-p", "-t", pane, format]);
    const [
      actualServerPid,
      actualSession,
      actualName,
      actualPane,
      panePid,
      dead,
      generation,
      launch,
    ] = result.stdout.trimEnd().split("\t");
    if (
      actualServerPid !== pid ||
      actualSession !== `$${sessionId}` ||
      actualName !== session ||
      actualPane !== pane ||
      panePid !== String(process.pid) ||
      dead !== "0" ||
      !generation ||
      !UUID.test(generation)
    )
      throw new Error("The initial-request tmux pane identity changed");
    if (!launch) {
      await Bun.sleep(POLL_INTERVAL_MS);
      continue;
    }
    if (!matchesLaunch(launch, id, process.pid, token))
      throw new Error("The initial-request tmux launch record changed");
    const { command } = InitialRequestFiles.open(config).take(token, {
      socket: socket!,
      session,
      id,
      launchToken,
      generation,
      cwd: process.cwd(),
      serverPid: Number(pid),
    });
    try {
      return process.execve(command[0]!, command, environment);
    } catch {
      throw new Error("Cannot start Pi with the initial-request arguments");
    }
  }
  throw new Error("Timed out confirming the initial-request tmux launch");
}
