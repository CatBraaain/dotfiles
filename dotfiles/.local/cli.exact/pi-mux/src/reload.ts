import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { type Config, prepareDirectory, type TmuxConfig } from "./configuration";
import { lockAddress, tryAcquireLock, withLock } from "./locks";
import { livePanes, managedSessions } from "./pane-inventory";
import { parseSessionState } from "./pane-state";
import { platform } from "./platform";
import {
  announceReloaded,
  matchesReloadPublication,
  type ReloadProgress,
  type ReloadPublication,
  publishWaitingTargets,
  reportReloadFailure,
  wasReplacedByPeer,
} from "./reload-publication";
import { ReloadWaiting } from "./reload-waiting";
import { bootstrapServer, snapshotSessions, startAndRestore } from "./restoration";
import { readSnapshot } from "./restore-state";
import { findSaved } from "./saved-sessions";
import {
  isRecord,
  type ManagedSession,
  type Pane,
  POLL_INTERVAL_MS,
  STARTUP_TIMEOUT_MS,
} from "./session-model";
import {
  excludedGlobalEnvironment,
  serverLifetime,
  type ServerLifetime,
  tmux,
  tmuxArguments,
  tmuxQueries,
  verifyServerLifetime,
} from "./tmux";
import { reloadWindowsPanes } from "./windows-reload";

type ReloadTarget = { session: ManagedSession; pane: Pane };

export async function reloadPanes(config: Config, onlyId?: string): Promise<number> {
  if (platform.windows) return await reloadWindowsPanes(config, onlyId);
  const original = await withLock(config, () => serverLifetime(config));
  if (!original) {
    if (onlyId !== undefined)
      throw new Error(`Cannot reload session ${onlyId}: the dedicated server is not running`);
    return await withLock(config, async () => {
      if (await serverLifetime(config)) throw new Error("Dedicated server changed during reload");
      prepareDirectory(config.directory);
      return (await startAndRestore(config, true)).failures > 0 ? 2 : 0;
    });
  }
  if (!original.generation) throw new Error("Dedicated server has not been initialized by pi-mux");
  const initialPanes = await withLock(config, async () => {
    await verifyServerLifetime(config, original, "reload");
    readSnapshot(config);
    if (onlyId) await validateReloadTarget(config, onlyId);
    await bootstrapServer(config, onlyId === undefined ? "start" : "existing");
    return await livePanes(config, "list");
  });
  const progress: ReloadProgress = {
    reloaded: new Set(),
    failed: new Set(),
    inFlight: new Map(),
    waiting: new ReloadWaiting(config, original),
  };
  let schedulingFailure: { cause: unknown } | undefined;
  try {
    while (true) {
      const step = schedulingFailure
        ? "done"
        : await withLock(config, () =>
            startNextReload(config, original, initialPanes, progress, onlyId),
          ).catch((cause: unknown) => {
            schedulingFailure = { cause };
            publishWaitingTargets(progress);
            return "done" as const;
          });
      await confirmReloadPublications(config, original, progress);
      if (step === "done" && progress.inFlight.size === 0) {
        if (schedulingFailure) throw schedulingFailure.cause;
        return progress.failed.size > 0 ? 2 : 0;
      }
      if (step !== "started") await Bun.sleep(POLL_INTERVAL_MS);
    }
  } finally {
    progress.waiting.replace([]);
    await Promise.all([...progress.inFlight.values()].map(({ release }) => release()));
  }
}

async function startNextReload(
  config: Config,
  original: ServerLifetime,
  initialPanes: readonly Pane[],
  progress: ReloadProgress,
  onlyId?: string,
): Promise<"started" | "wait" | "done"> {
  await verifyServerLifetime(config, original, "reload");
  const scan = await scanReloadTargets(config, initialPanes, progress, onlyId);
  publishWaitingTargets(progress, scan?.queued);
  if (!scan) return "done";
  for (const target of scan.ready) {
    const { id } = target.pane;
    const scope = `\0reload\0${original.pid}\0${original.generation}\0${id}`;
    const release = await tryAcquireLock(lockAddress(config, scope));
    if (!release) continue;
    try {
      const publication = await respawnReloadTarget(config, original, target, progress);
      if (!publication) continue;
      progress.inFlight.set(id, { ...publication, release });
      return "started";
    } finally {
      if (!progress.inFlight.has(id)) await release();
    }
  }
  return "wait";
}

async function validateReloadTarget(config: Config, id: string): Promise<void> {
  if ((await managedSessions(config)).some((session) => session.id === id)) return;
  const known =
    readSnapshot(config)?.sessions.some((session) => session.id === id) ||
    (await findSaved(config, id)) !== undefined;
  if (known) throw new Error(`The conversation is not running: ${id}`);
  throw new Error(`Session not found (use the complete ID): ${id}`);
}

async function scanReloadTargets(
  config: TmuxConfig,
  initialPanes: readonly Pane[],
  progress: ReloadProgress,
  onlyId?: string,
): Promise<{ ready: ReloadTarget[]; queued: ManagedSession[] } | undefined> {
  const { reloaded, failed, inFlight } = progress;
  const managed = (await managedSessions(config)).filter(
    ({ id }) =>
      (!onlyId || id === onlyId) && !reloaded.has(id) && !failed.has(id) && !inFlight.has(id),
  );
  if (managed.length === 0) return;
  const panes = await livePanes(config, "list");
  for (const { id, session } of managed)
    if (wasReplacedByPeer(initialPanes, panes, session, id)) announceReloaded(progress, id);
  const remaining = managed.filter(({ id }) => !reloaded.has(id));
  if (remaining.length === 0) return;
  const owned = panes.filter((pane) =>
    remaining.some((session) => session.session === pane.session && session.id === pane.id),
  );
  for (const pane of owned) {
    if (failed.has(pane.id)) continue;
    const conflicts = owned.filter((entry) => entry.id === pane.id);
    if (conflicts.length > 1) {
      const reason =
        new Set(conflicts.map((entry) => entry.cwd)).size > 1
          ? `Conflicting working directories for conversation ${pane.id}`
          : "Multiple pi processes match the conversation ID";
      reportReloadFailure(progress, pane.id, reason);
    }
  }
  const pending = remaining.filter(({ id }) => !failed.has(id));
  if (pending.length === 0) return;
  const rowsOfSession = await tmuxQueries(
    config,
    pending.map((session) => [
      "list-panes",
      "-s",
      "-t",
      session.session,
      "-F",
      "#{pane_id}\t#{pane_pid}\t#{pane_dead}",
    ]),
  );
  const rows = pending.map((session, index) =>
    rowsOfSession[index]!.stdout.trimEnd()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [pane, pid, dead] = line.split("\t");
        return { pane: pane ?? "", pid: pid ?? "", dead: dead ?? "" };
      })
      .filter((row) => row.pane && /^[1-9]\d*$/.test(row.pid) && row.dead === "0")
      .map((row) => ({
        ...row,
        published: owned.some(
          (entry) =>
            entry.pane === row.pane && entry.session === session.session && entry.id === session.id,
        ),
      })),
  );
  const unpublished = rows.flatMap((sessionRows, index) =>
    sessionRows.filter((row) => !row.published).map((row) => ({ session: pending[index]!, row })),
  );
  const launches = await tmuxQueries(
    config,
    unpublished.map(({ row }) => ["show-options", "-pqv", "-t", row.pane, "@pi-mux-launch"]),
  );
  const bootingBySession = new Map<string, number>();
  for (const [index, { session, row }] of unpublished.entries()) {
    let record: unknown;
    try {
      record = JSON.parse(launches[index]!.stdout);
    } catch {
      record = undefined;
    }
    if (
      isRecord(record) &&
      record.id === session.id &&
      typeof record.token === "string" &&
      (record.pid === Number(row.pid) ||
        (Number.isSafeInteger(record.pid) &&
          Number(record.pid) > 0 &&
          !platform.processIsAlive(Number(record.pid))))
    )
      bootingBySession.set(session.id, (bootingBySession.get(session.id) ?? 0) + 1);
  }
  const states = await tmuxQueries(
    config,
    owned.flatMap((pane) => [
      ["show-options", "-pqv", "-t", pane.pane, "@pi_session_state"],
      ["show-options", "-pqv", "-t", pane.pane, "@pi-mux-pending-restart-blocker"],
    ]),
  );
  const inspected = new Map(
    owned.map((pane, index) => [
      pane.pane,
      {
        state: states[index * 2]!,
        blocker: states[index * 2 + 1]!,
      },
    ]),
  );
  const ready: ReloadTarget[] = [];
  const queued: ManagedSession[] = [];
  for (const [index, session] of pending.entries()) {
    const publishedRows = rows[index]!.filter((row) => row.published);
    const isBooting = (bootingBySession.get(session.id) ?? 0) > 0;
    if (publishedRows.length === 0 && !isBooting) {
      reportReloadFailure(progress, session.id, "The managed pi is not running");
      continue;
    }
    queued.push(session);
    for (const row of publishedRows) {
      const pane = owned.find((entry) => entry.pane === row.pane)!;
      const inspection = inspected.get(pane.pane)!;
      if (inspection.blocker.exitCode !== 0)
        throw new Error(`Cannot inspect pending reload state: ${pane.id}`);
      if (inspection.state.exitCode !== 0)
        throw new Error(`Cannot inspect reload state: ${pane.id}`);
      const canRespawn =
        !inspection.blocker.stdout.trim() &&
        parseSessionState(inspection.state.stdout.trimEnd(), pane.id) === "waiting-user" &&
        pane.startup !== "accepted";
      if (!canRespawn) continue;
      ready.push({ session, pane });
      break;
    }
  }
  return { ready, queued };
}

async function respawnReloadTarget(
  config: Config,
  original: ServerLifetime,
  { session, pane }: ReloadTarget,
  progress: ReloadProgress,
): Promise<ReloadPublication | undefined> {
  const state = await tmux(config, ["show-options", "-pqv", "-t", pane.pane, "@pi_session_state"]);
  if (state.exitCode !== 0) throw new Error(`Cannot inspect reload state: ${pane.id}`);
  const blocker = await tmux(config, [
    "show-options",
    "-pqv",
    "-t",
    pane.pane,
    "@pi-mux-pending-restart-blocker",
  ]);
  if (blocker.exitCode !== 0) throw new Error(`Cannot inspect pending reload state: ${pane.id}`);
  if (
    blocker.stdout.trim() ||
    parseSessionState(state.stdout.trimEnd(), pane.id) !== "waiting-user"
  )
    return;
  await tmux(config, ["set-option", "-g", "@pi-mux-restart-veto", ""]);
  await snapshotSessions(config, original.generation, "repair");
  const saved = readSnapshot(config);
  if (!saved || saved.generation !== original.generation)
    throw new Error("Cannot confirm reload snapshot");
  await verifyServerLifetime(config, original, "reload");
  const launchToken = randomUUID();
  const startupCommand = `pi-mux-startup-${randomUUID()}`;
  const hasSavedFile = existsSync(pane.file);
  const preserveWarm = pane.warm && !hasSavedFile;
  const desired: Record<string, string> = {
    ...config.env,
    PI_TMUX_SESSION_ID: pane.id,
    PI_TMUX_LAUNCH_TOKEN: launchToken,
    PI_TMUX_STARTUP_COMMAND: startupCommand,
    ...(session.temporary ? { PI_TMUX_TEMPORARY: pane.id } : {}),
    ...(preserveWarm ? { PI_TMUX_STARTUP_MODE: "warm" } : {}),
  };
  await refreshSessionEnvironment(config, session.session, desired);
  const removed = await excludedGlobalEnvironment(config, desired);
  const selection = hasSavedFile ? ["--session", pane.file] : ["--session-id", pane.id];
  const paneCommand = platform.paneCommand(
    [...config.piCommand(), ...selection, "-e", config.extension, "--", `/${startupCommand}`],
    removed,
    desired,
  );
  const canRespawn = [
    "#{==:#{@pi-mux-restart-veto},}",
    `#{==:#{pane_id},${pane.pane}}`,
    `#{==:#{pane_pid},${pane.panePid}}`,
    "#{==:#{pane_dead},0}",
    "#{==:#{@pi-mux-pending-restart-blocker},}",
    '#{m:*"state":"waiting-user"*,#{@pi_session_state}}',
  ].reduce((left, right) => `#{&&:${left},${right}}`);
  const recoveryMarker = saved.sessions.some(({ id }) => id === pane.id)
    ? [tmuxArguments(["set-option", "-g", `@pi-mux-restoring-${pane.id}`, "1"])]
    : [];
  const reloadBranch = tmuxArguments([
    "if-shell",
    "-t",
    pane.pane,
    "-F",
    canRespawn,
    [
      ...recoveryMarker,
      tmuxArguments(["set-option", "-pu", "-t", pane.pane, "@pi-tmux-session"]),
      tmuxArguments([
        "respawn-pane",
        "-k",
        "-t",
        pane.pane,
        "--",
        ...platform.tmuxPaneCommand(paneCommand),
      ]),
      tmuxArguments(["set-option", "-pu", "-t", pane.pane, "@pi_session_state"]),
      tmuxArguments(["set-option", "-pu", "-t", pane.pane, "@pi-mux-state-source"]),
      tmuxArguments([
        "set-option",
        "-pF",
        "-t",
        pane.pane,
        "@pi-mux-launch",
        `{"id":"${pane.id}","pid":#{pane_pid},"token":"${launchToken}"}`,
      ]),
    ].join(" ; "),
    "display-message -p PI_MUX_RELOAD_WAIT",
  ]);
  const respawned = await tmux(
    config,
    [
      "if-shell",
      "-F",
      `#{&&:#{==:#{pid},${original.pid}},#{==:#{@pi-mux-generation},${original.generation}}}`,
      reloadBranch,
      "display-message -p PI_MUX_RELOAD_SERVER_CHANGED",
    ],
    true,
  );
  if (respawned.stdout.includes("PI_MUX_RELOAD_SERVER_CHANGED"))
    throw new Error("Dedicated server changed during reload");
  if (respawned.exitCode !== 0) {
    await verifyServerLifetime(config, original, "reload");
    reportReloadFailure(progress, pane.id, `tmux if-shell failed: ${respawned.stderr.trim()}`);
    return;
  }
  if (respawned.stdout.includes("PI_MUX_RELOAD_WAIT")) return;
  return { pane, launchToken, preserveWarm, deadlineMs: Date.now() + STARTUP_TIMEOUT_MS };
}

async function confirmReloadPublications(
  config: Config,
  original: ServerLifetime,
  progress: ReloadProgress,
): Promise<void> {
  if (progress.inFlight.size === 0) return;
  const list = await tmux(
    config,
    [
      "list-panes",
      "-a",
      "-F",
      "#{session_id}\t#{pane_id}\t#{pid}\t#{@pi-mux-generation}\t#{pane_pid}\t#{pane_dead}\t#{@pi-tmux-session}\t#{@pi-mux-launch}",
    ],
    true,
  );
  if (list.exitCode !== 0 || !list.stdout.trim()) {
    await verifyServerLifetime(config, original, "reload");
    const noPanes =
      list.stderr.includes("no sessions") || list.stderr.includes("no current target");
    if (list.exitCode !== 0 && !noPanes)
      throw new Error(`tmux list-panes failed: ${list.stderr.trim()}`);
  }
  const rows = new Map<string, string[]>();
  for (const line of list.stdout.trimEnd().split("\n").filter(Boolean)) {
    const [session, paneId, serverPid, generation, ...publication] = line.split("\t");
    if (Number(serverPid) !== original.pid || generation !== original.generation)
      throw new Error("Dedicated server changed during reload");
    rows.set(`${session}:${paneId}`, publication);
  }
  for (const [id, { pane, launchToken, preserveWarm, deadlineMs, release }] of progress.inFlight) {
    const [pid, dead, metadata, launch] = rows.get(`${pane.session}:${pane.pane}`) ?? [];
    if (!pid || dead === "1") {
      reportReloadFailure(progress, id, "pi exited before reload was recorded");
    } else if (
      matchesReloadPublication(pane, Number(pid), launchToken, preserveWarm, metadata, launch)
    ) {
      announceReloaded(progress, id);
    } else if (Date.now() >= deadlineMs) {
      reportReloadFailure(progress, id, "pi startup timed out during reload");
    } else {
      continue;
    }
    progress.inFlight.delete(id);
    await release();
  }
}

async function refreshSessionEnvironment(
  config: TmuxConfig,
  session: string,
  desired: Record<string, string>,
): Promise<void> {
  const current = await tmux(config, ["show-environment", "-t", session]);
  const existing = new Map<string, string | undefined>();
  for (const line of current.stdout.trimEnd().split("\n").filter(Boolean)) {
    if (line.startsWith("-")) {
      existing.set(line.slice(1), undefined);
      continue;
    }
    const key = line.slice(0, line.indexOf("="));
    if (key) existing.set(key, line.slice(key.length + 1));
  }
  for (const [key, value] of Object.entries(desired))
    if (platform.acceptsTmuxEnvironmentKey(key) && existing.get(key) !== value)
      await tmux(config, ["set-environment", "-t", session, key, value]);
  for (const [key, value] of existing)
    if (
      value !== undefined &&
      !Object.hasOwn(desired, key) &&
      platform.acceptsTmuxEnvironmentKey(key)
    )
      await tmux(config, ["set-environment", "-u", "-t", session, key]);
}
