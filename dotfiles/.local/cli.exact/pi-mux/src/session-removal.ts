import type { TmuxConfig } from "./configuration";
import {
  initializingPanes,
  isTemporarySession,
  livePanes,
  managedSessions,
} from "./pane-inventory";
import { platform } from "./platform";
import { readSnapshot, writeSnapshot } from "./restore-state";
import {
  errorMessage,
  type ManagedSession,
  POLL_INTERVAL_MS,
  STARTUP_TIMEOUT_MS,
  type StopTarget,
} from "./session-model";
import { serverIsAbsent, tmux, tmuxArguments } from "./mux";
import { closeWindowsPane } from "./windows/windows-conversations";

export async function closeSession(
  config: TmuxConfig,
  id: string,
  ifTemporary = false,
): Promise<void> {
  try {
    if (platform.windows) {
      if (await closeWindowsPane(config, id, ifTemporary)) removeRestoreCandidate(config, id);
      return;
    }
    const panes = await livePanes(config, "list");
    const running = panes.filter((pane) => pane.id === id);
    const managed = (await managedSessions(config)).filter((session) => session.id === id);
    if (running.length > 1 || managed.length > 1)
      throw new Error("Multiple pi processes match the conversation ID");
    const initializing = await initializingPanes(config, managed, panes);
    const targets = [...running, ...initializing];
    if (targets.length > 1) throw new Error("Multiple pi processes match the conversation ID");
    if (ifTemporary && !(await isCloseTargetTemporary(config, running[0]?.session, managed, id)))
      return;
    readSnapshot(config);
    await terminatePanes(config, targets);
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (true) {
      const current = await livePanes(config, "list");
      if (
        !current.some((pane) => pane.id === id) &&
        !targets.some((pane) => platform.processIsAlive(pane.pid))
      )
        break;
      if (Date.now() >= deadline) throw new Error("Timed out waiting for pi to exit");
      await Bun.sleep(POLL_INTERVAL_MS);
    }
    for (const session of managed) {
      const result = await tmux(
        config,
        ["set-environment", "-u", "-t", session.session, "PI_TMUX_SESSION_ID"],
        true,
      );
      if (
        result.exitCode !== 0 &&
        !serverIsAbsent(config, result.stderr) &&
        !result.stderr.includes("can't find session:") &&
        !result.stderr.includes("no such session:")
      )
        throw new Error(`Cannot clear managed session ${session.session}: ${result.stderr.trim()}`);
    }
    const cleared = await tmux(config, ["set-option", "-gu", `@pi-mux-restoring-${id}`], true);
    if (cleared.exitCode !== 0 && !serverIsAbsent(config, cleared.stderr))
      throw new Error(`Cannot clear restore target: ${cleared.stderr.trim()}`);
    removeRestoreCandidate(config, id);
  } catch (error) {
    throw new Error(`Cannot close session ${id}: ${errorMessage(error)}`);
  }
}

function removeRestoreCandidate(config: TmuxConfig, id: string): void {
  const snapshot = readSnapshot(config);
  if (snapshot?.sessions.some((session) => session.id === id))
    writeSnapshot(config, {
      ...snapshot,
      sessions: snapshot.sessions.filter((session) => session.id !== id),
    });
}

async function isCloseTargetTemporary(
  config: TmuxConfig,
  runningSession: string | undefined,
  managed: ManagedSession[],
  id: string,
): Promise<boolean> {
  if (runningSession && (await isTemporarySession(config, runningSession, id))) return true;
  for (const { session } of managed) if (await isTemporarySession(config, session, id)) return true;
  return false;
}

async function terminatePanes(config: TmuxConfig, targets: StopTarget[]): Promise<void> {
  for (const pane of targets) {
    if (pane.pid !== pane.panePid) {
      try {
        process.kill(pane.pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    } else {
      const result = await tmux(
        config,
        [
          "if-shell",
          "-F",
          "-t",
          pane.pane,
          `#{==:#{pane_pid},${pane.panePid}}`,
          tmuxArguments(["kill-pane", "-t", pane.pane]),
        ],
        true,
      );
      if (result.exitCode !== 0 && platform.processIsAlive(pane.pid))
        throw new Error(`Cannot stop pi in pane ${pane.pane}: ${result.stderr.trim()}`);
    }
  }
}

export async function unregisterWorkspace(config: TmuxConfig, cwd: string): Promise<void> {
  readSnapshot(config);
  const panes = await livePanes(config, "list");
  const targets = [
    ...panes.filter((pane) => pane.cwd === cwd),
    ...(await initializingPanes(
      config,
      (await managedSessions(config)).filter((session) => session.cwd === cwd),
      panes,
    )),
  ];
  await terminatePanes(config, targets);
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (true) {
    const current = await livePanes(config, "list");
    const remaining = current.some((pane) => pane.cwd === cwd);
    const initializing = await initializingPanes(
      config,
      (await managedSessions(config)).filter((session) => session.cwd === cwd),
      current,
    );
    if (
      !remaining &&
      initializing.length === 0 &&
      !targets.some((pane) => platform.processIsAlive(pane.pid))
    )
      break;
    if (Date.now() >= deadline) throw new Error(`Timed out stopping workspace: ${cwd}`);
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  const snapshot = readSnapshot(config);
  if (snapshot) {
    for (const candidate of snapshot.sessions.filter((session) => session.cwd === cwd)) {
      const result = await tmux(
        config,
        ["set-option", "-gu", `@pi-mux-restoring-${candidate.id}`],
        true,
      );
      if (result.exitCode !== 0 && !serverIsAbsent(config, result.stderr))
        throw new Error(`Cannot clear restore target ${candidate.id}: ${result.stderr.trim()}`);
    }
    writeSnapshot(config, {
      ...snapshot,
      cwds: snapshot.cwds.filter((registered) => registered !== cwd),
      sessions: snapshot.sessions.filter((session) => session.cwd !== cwd),
    });
  }
}
