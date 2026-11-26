import { createHash, randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { WindowsReloadRoute } from "./cli-arguments";
import {
  cliInvocation,
  type Config,
  GENERATED_ENV_KEYS,
  PARENT_ENV_KEYS,
  prepareDirectory,
  PSMUX_ROUTING,
  tmuxConfiguration,
} from "./configuration";
import { type ReleaseLock, tryAcquireLock, windowsClaimLock, withLock } from "./locks";
import { launchMatchesManagedSession } from "./pane-inventory";
import { clearStateOptions } from "./pane-state";
import { platform } from "./platform";
import {
  announceReloaded,
  matchesReloadPublication,
  type ReloadProgress,
  type ReloadPublication,
  reportReloadFailure,
  wasReplacedByPeer,
} from "./reload-publication";
import { startAndRestore } from "./restoration";
import { readSnapshot, uniqueCandidates, writeSnapshot } from "./restore-state";
import { findSaved } from "./saved-sessions";
import {
  auditWindowsLifecycle,
  type WindowsLifecycleAudit,
  type WindowsLifecycleEntry,
  type WindowsLifecyclePeer,
  windowsPaneIsWaiting,
} from "./server-lifecycle";
import {
  errorMessage,
  type ManagedSession,
  type Pane,
  POLL_INTERVAL_MS,
  STARTUP_TIMEOUT_MS,
} from "./session-model";
import { windowsManagement } from "./tmux";
import {
  configureWindowsPiEnvironment,
  WINDOWS_RIGHT_ENV,
  WINDOWS_RIGHT_OPTION,
} from "./windows-launch";
import {
  conversationLaunchKey,
  launchBasisStillLive,
  SpawnDidNotStartError,
  type WindowsLaunchRights,
  type WindowsManagementBasis,
} from "./windows-launch-rights";
import {
  captureWindowsProcesses,
  configureWindowsPeer,
  readWindowsPeerPaneFields,
  runWindowsPeerPaneCommands,
  waitForWindowsExit,
} from "./windows-lifecycle";
import type { WindowsManagement } from "./windows-management";
import { inspectWindowsProcess, observeWindowsIdentity } from "./windows-process";

type WindowsReloadTarget = {
  session: ManagedSession;
  entry: WindowsLifecycleEntry;
  pane: Pane;
};

type WindowsReloadPublication = Omit<ReloadPublication, "deadlineMs"> & {
  route: WindowsReloadRoute;
  right: string;
  deadlineMs: number;
  release: ReleaseLock;
};

type WindowsReloadProgress = Pick<ReloadProgress, "reloaded" | "failed"> & {
  inFlight: Map<string, WindowsReloadPublication>;
};

type WindowsReloadContext = {
  config: Config;
  management: WindowsManagement;
  rights: WindowsLaunchRights;
  original: WindowsManagementBasis;
  initialPanes: readonly Pane[];
  progress: WindowsReloadProgress;
};

function findWindowsReloadPeer(
  observation: WindowsLifecycleAudit | Awaited<ReturnType<WindowsManagement["audit"]>>,
  route: WindowsReloadRoute,
): WindowsLifecyclePeer | undefined {
  if (observation.basis.instance !== route.instance)
    throw new Error("Dedicated psmux generation changed during reload");
  return observation.panes.find(
    ({ peer }) => peer.name === route.name && peer.identity === route.identity,
  )?.peer;
}

export async function claimWindowsReload(
  token: string,
  command: string[],
  route: WindowsReloadRoute,
): Promise<number> {
  const config = tmuxConfiguration();
  const management = windowsManagement(config);
  const rights = management.createLaunchRights(windowsClaimLock(management));
  const destination = `${management.scope.namespace}__${route.name}`;
  const [, port, index] = (process.env.TMUX ?? "").split(",");
  if (
    process.env.PSMUX_TARGET_SESSION !== destination ||
    process.env.TMUX_PANE !== route.pane ||
    process.env[WINDOWS_RIGHT_ENV] !== token ||
    !/^\d+$/.test(index ?? "")
  )
    throw new Error("Windows reload wrapper did not start in its assigned pane");
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await rights.status(token);
    if (status.state === "reserved") {
      const started = await rights.claimAndStart(
        token,
        randomUUID(),
        () => {
          const env = { ...process.env };
          for (const [key, value] of route.inheritedOverrides) {
            for (const inherited of Object.keys(env))
              if (inherited.toUpperCase() === key.toUpperCase()) delete env[inherited];
            if (value !== null) env[key] = value;
          }
          configureWindowsPiEnvironment(env, `${config.socket},${port},${index}`);
          if (observeWindowsIdentity(route.launcher, inspectWindowsProcess) !== "present")
            throw new SpawnDidNotStartError("Windows reload launcher exited before the claim");
          try {
            return Bun.spawn(command, {
              cwd: route.cwd,
              env,
              stdin: "inherit",
              stdout: "inherit",
              stderr: "inherit",
            });
          } catch (error) {
            if (["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? ""))
              throw new SpawnDidNotStartError(errorMessage(error), { cause: error });
            throw error;
          }
        },
        async () => {
          const audit = await management.audit("#{pane_id}");
          const peer = findWindowsReloadPeer(audit, route);
          if (!peer || String(peer.port) !== port) throw new Error("Windows reload peer changed");
          const expected = await readWindowsPeerPaneFields(
            management.scope,
            audit,
            peer,
            route.pane,
            [
              "session_id",
              "pane_pid",
              "pane_dead",
              "PI_TMUX_SESSION_ID",
              "session_path",
              "PI_TMUX_LAUNCH_TOKEN",
              WINDOWS_RIGHT_ENV,
              "@pi-tmux-session",
            ],
          );
          if (
            JSON.stringify(expected) !==
            JSON.stringify([
              route.session,
              String(process.pid),
              "0",
              route.id,
              route.cwd,
              route.launchToken,
              token,
              "",
            ])
          )
            throw new Error("Cannot verify the new Windows reload pane");
          await runWindowsPeerPaneCommands(management.scope, audit, peer, route.pane, [
            [
              "set-option",
              "-p",
              "-t",
              route.pane,
              "@pi-mux-launch",
              JSON.stringify({ id: route.id, pid: process.pid, token: route.launchToken }),
            ],
            ["set-option", "-p", "-t", route.pane, WINDOWS_RIGHT_OPTION, token],
          ]);
        },
      );
      return started ? await started.started.exited : 1;
    }
    if (
      status.state !== "missing" ||
      observeWindowsIdentity(route.launcher, inspectWindowsProcess) !== "present"
    )
      return 1;
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  throw new Error("Windows reload launch was not permitted");
}

export async function reloadWindowsPanes(config: Config, onlyId?: string): Promise<number> {
  const management = windowsManagement(config);
  const rights = management.createLaunchRights(windowsClaimLock(management));
  const initial = await withLock(config, async () => {
    const original = await management.currentBasis();
    if (!original) {
      if (onlyId !== undefined)
        throw new Error(`Cannot reload session ${onlyId}: the dedicated server is not running`);
      await rights.fenceForRestart(false);
      if (await management.currentBasis())
        throw new Error("Dedicated psmux generation changed during reload");
      prepareDirectory(config.directory);
      return (await startAndRestore(config, true, undefined, "fresh")).failures > 0 ? 2 : 0;
    }
    const snapshot = readSnapshot(config);
    const audit = await auditWindowsLifecycle(management, "reload");
    if (!launchBasisStillLive(original, audit.basis) || !audit.startup.restored)
      throw new Error("Cannot confirm a restored psmux generation for reload");
    if (onlyId && !audit.managed.some(({ id }) => id === onlyId)) {
      if (snapshot?.sessions.some(({ id }) => id === onlyId) || (await findSaved(config, onlyId)))
        throw new Error(`The conversation is not running: ${onlyId}`);
      throw new Error(`Session not found (use the complete ID): ${onlyId}`);
    }
    const invocation = cliInvocation();
    const hookCommand = platform.hookCommand([...invocation, "snapshot", original.instance], {
      PI_CODING_AGENT_DIR: config.agentDir,
    });
    for (const { peer } of audit.panes)
      await configureWindowsPeer(management.scope, audit, {
        configFile: config.tmuxConfig,
        hookCommand,
        peerName: peer.name,
      });
    return {
      original,
      initialPanes: audit.entries.flatMap(({ pi }) => (pi ? [pi] : [])),
    };
  });
  if (typeof initial === "number") return initial;

  const progress: WindowsReloadProgress = {
    reloaded: new Set(),
    failed: new Set(),
    inFlight: new Map(),
  };
  const context = { ...initial, config, management, rights, progress };
  let schedulingFailure: { cause: unknown } | undefined;
  try {
    while (true) {
      const step = schedulingFailure
        ? "done"
        : await withLock(config, () => startNextWindowsReload(context, onlyId)).catch(
            (cause: unknown) => {
              schedulingFailure = { cause };
              return "done" as const;
            },
          );
      await confirmWindowsReloadPublications(context);
      if (step === "done" && progress.inFlight.size === 0) {
        if (schedulingFailure) throw schedulingFailure.cause;
        return progress.failed.size ? 2 : 0;
      }
      if (step !== "started") await Bun.sleep(POLL_INTERVAL_MS);
    }
  } finally {
    await Promise.all([...progress.inFlight.values()].map(({ release }) => release()));
  }
}

async function startNextWindowsReload(
  context: WindowsReloadContext,
  onlyId?: string,
): Promise<"started" | "wait" | "done"> {
  const { management, original, initialPanes, progress } = context;
  const audit = await auditWindowsLifecycle(management, "reload");
  if (!launchBasisStillLive(original, audit.basis) || !audit.startup.restored)
    throw new Error("Dedicated psmux generation changed during reload");

  const candidates = audit.ownership.filter(
    ({ session: { id } }) =>
      (!onlyId || id === onlyId) &&
      !progress.reloaded.has(id) &&
      !progress.failed.has(id) &&
      !progress.inFlight.has(id),
  );
  const livePanes = audit.entries.flatMap(({ pi }) => (pi ? [pi] : []));
  for (const { session } of candidates)
    if (wasReplacedByPeer(initialPanes, livePanes, session.session, session.id))
      announceReloaded(progress, session.id);
  const targets = candidates.filter(({ session: { id } }) => !progress.reloaded.has(id));
  if (
    onlyId &&
    !audit.managed.some(({ id }) => id === onlyId) &&
    !progress.reloaded.has(onlyId) &&
    !progress.inFlight.has(onlyId)
  )
    reportReloadFailure(progress, onlyId, "The managed pi is not running");
  for (const { peer, session } of targets) {
    const { id } = session;
    const lockKey = JSON.stringify([
      management.lockResource,
      "reload",
      original.instance,
      id.toLowerCase(),
    ]);
    const release = await tryAcquireLock(
      platform.lockAddress(createHash("sha256").update(lockKey).digest("hex")),
    );
    if (!release) continue;
    try {
      const target = await selectWindowsReloadTarget(context, audit, peer, session);
      if (!target) continue;
      const publication = await respawnWindowsReloadTarget(context, audit, target);
      if (!publication) continue;
      progress.inFlight.set(id, { ...publication, release });
      return "started";
    } finally {
      if (!progress.inFlight.has(id)) await release();
    }
  }
  return targets.some(({ session }) => !progress.failed.has(session.id)) ? "wait" : "done";
}

async function selectWindowsReloadTarget(
  context: WindowsReloadContext,
  audit: WindowsLifecycleAudit,
  peer: WindowsLifecyclePeer,
  session: ManagedSession,
): Promise<WindowsReloadTarget | undefined> {
  const { config, progress, rights } = context;
  const { id } = session;
  if (progress.failed.has(id)) return;
  const owned = audit.entries.filter((entry) => entry.peer.identity === peer.identity);
  const observed = audit.panes.find(({ peer: observed }) => observed.identity === peer.identity);
  const sameId = audit.entries.filter(({ pi }) => pi?.id.toLowerCase() === id.toLowerCase());
  const owners = audit.managed.filter(
    (candidate) => candidate.id.toLowerCase() === id.toLowerCase(),
  );
  if (owners.length !== 1 || sameId.length > 1 || (observed?.rows.length ?? 0) > 1) {
    reportReloadFailure(progress, id, "Cannot uniquely identify the managed pi and pane");
    return;
  }
  const entry = owned[0];
  const pane = entry?.pi;
  if (!entry || !pane || pane.id !== id) {
    if (
      entry &&
      !pane &&
      launchMatchesManagedSession(entry.launch ?? "", session, String(entry.panePid))
    ) {
      if (!entry.right) return;
      const status = await rights.status(entry.right);
      if (status.state === "reserved" || status.state === "pending" || status.state === "live")
        return;
      if (status.state === "unknown") throw new Error(`Cannot verify Windows launch for ${id}`);
    }
    reportReloadFailure(progress, id, "The managed pi is not running");
    return;
  }
  if (pane.cwd !== session.cwd || pane.session !== session.session) {
    reportReloadFailure(progress, id, "Conflicting working directories or session ownership");
    return;
  }
  if (!windowsPaneIsWaiting(config, entry) || !entry.launch) return;
  if (entry.right) {
    const status = await rights.status(entry.right);
    const child = inspectWindowsProcess(pane.pid);
    if (
      status.state !== "live" ||
      !("receipt" in status) ||
      child.state !== "live" ||
      status.receipt.child.pid !== pane.pid ||
      status.receipt.child.creationTime !== child.identity.creationTime
    )
      throw new Error(`Cannot verify the current Windows pi launch for ${id}`);
  }
  return { session, entry, pane };
}

async function respawnWindowsReloadTarget(
  context: WindowsReloadContext,
  audit: WindowsLifecycleAudit,
  { session, entry, pane }: WindowsReloadTarget,
): Promise<Omit<WindowsReloadPublication, "release"> | undefined> {
  const { config, management, rights, progress } = context;
  const { peer, paneId } = entry;
  const basis = { instance: audit.basis.instance, witnesses: [peer.identity] };
  const readPane = (fields: string[]) =>
    readWindowsPeerPaneFields(management.scope, audit, peer, paneId, fields);
  const run = (commands: string[][]) =>
    runWindowsPeerPaneCommands(management.scope, audit, peer, paneId, commands);
  const oldPids = new Set([pane.pid, pane.panePid]);
  const processes = captureWindowsProcesses(oldPids);
  if (processes.length !== oldPids.size) return;
  const savedFile = lstatSync(pane.file, { throwIfNoEntry: false });
  if (savedFile && !savedFile.isFile())
    throw new Error(`Invalid saved conversation file: ${pane.file}`);
  const preserveWarm = pane.warm && !savedFile;
  const launchToken = randomUUID();
  const right = randomUUID();
  const startup = `pi-mux-startup-${randomUUID()}`;
  const desired: Record<string, string> = {
    ...config.env,
    PI_CODING_AGENT_DIR: config.agentDir,
    PI_TMUX_SESSION_ID: pane.id,
    PI_TMUX_LAUNCH_TOKEN: launchToken,
    PI_TMUX_STARTUP_COMMAND: startup,
    [WINDOWS_RIGHT_ENV]: right,
    ...(session.temporary ? { PI_TMUX_TEMPORARY: pane.id } : {}),
    ...(preserveWarm ? { PI_TMUX_STARTUP_MODE: "warm" } : {}),
  };
  const { commands, inheritedOverrides } = await windowsReloadEnvironment(run, desired);
  const launcher = inspectWindowsProcess(process.pid);
  if (launcher.state !== "live") throw new Error("Cannot identify the Windows reload launcher");
  await snapshotWindowsReload(context, audit);
  const route: WindowsReloadRoute = {
    name: peer.name,
    identity: peer.identity,
    instance: basis.instance,
    pane: paneId,
    session: pane.session,
    id: pane.id,
    cwd: pane.cwd,
    launchToken,
    launcher: launcher.identity,
    inheritedOverrides,
  };
  const invocation = cliInvocation();
  const command = [
    ...config.piCommand(),
    ...(savedFile ? ["--session", pane.file] : ["--session-id", pane.id]),
    "-e",
    config.extension,
    "--",
    `/${startup}`,
  ];
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");
  const respawn = [
    "respawn-pane",
    "-k",
    "-t",
    paneId,
    "-c",
    pane.cwd,
    "--",
    ...invocation,
    "windows-claim-launch",
    right,
    encode(command),
    encode(route),
  ];
  const last = await readPane([
    "session_id",
    "pane_pid",
    "pane_dead",
    "PI_TMUX_SESSION_ID",
    "PI_TMUX_TEMPORARY",
    "session_path",
    "@pi-tmux-session",
    "@pi-mux-launch",
    WINDOWS_RIGHT_OPTION,
    "@pi_session_state",
    "@pi-mux-state-source",
    "@pi-mux-pending-restart-blocker",
  ]);
  const [
    sessionId,
    pid,
    dead,
    id,
    temporary,
    cwd,
    metadata,
    launch,
    paneRight,
    state,
    owner,
    blocker,
  ] = last;
  if (
    sessionId !== pane.session ||
    Number(pid) !== pane.panePid ||
    dead !== "0" ||
    id !== pane.id ||
    cwd !== pane.cwd ||
    temporary !== (session.temporary ? id : "") ||
    metadata !== pane.metadata ||
    launch !== entry.launch ||
    paneRight !== entry.right ||
    processes.some(
      (process) => observeWindowsIdentity(process, inspectWindowsProcess) !== "present",
    ) ||
    !windowsPaneIsWaiting(config, { ...entry, state, owner, blocker })
  )
    return;

  if (!session.temporary)
    await management.keepRestoring(basis, session.id, windowsClaimLock(management));
  try {
    await run([
      ...commands,
      ["set-option", "-pu", "-t", paneId, "@pi-tmux-session"],
      ["set-option", "-pu", "-t", paneId, "@pi-mux-launch"],
      ["set-option", "-pu", "-t", paneId, WINDOWS_RIGHT_OPTION],
      ...clearStateOptions(paneId).filter((args) => args.at(-1) !== "@pi_session_state_pending"),
      respawn,
    ]);
    await waitForWindowsExit(processes, {
      timeoutMs: STARTUP_TIMEOUT_MS,
      pollMs: POLL_INTERVAL_MS,
    });
    const [nextSession, nextPid, nextDead, nextRight] = await readPane([
      "session_id",
      "pane_pid",
      "pane_dead",
      WINDOWS_RIGHT_ENV,
    ]);
    if (
      nextSession !== pane.session ||
      !/^[1-9]\d*$/.test(nextPid ?? "") ||
      Number(nextPid) === pane.panePid ||
      nextDead !== "0" ||
      nextRight !== right
    )
      throw new Error("Cannot verify the Windows reload replacement pane");
    const reserved = await rights.reserveAfterLifecycleAudit(
      [conversationLaunchKey(pane.id)],
      basis,
      { token: right },
    );
    if (reserved.state !== "reserved") throw new Error("A Windows pi launch is still active");
    const claimDeadlineMs = Date.now() + STARTUP_TIMEOUT_MS;
    while (true) {
      const status = await rights.status(right);
      if (status.state === "live") break;
      if (status.state !== "reserved")
        throw new Error("Cannot confirm the Windows reload launch was claimed");
      if (Date.now() >= claimDeadlineMs) {
        if (await rights.cancelUnclaimed(right))
          throw new Error("Timed out waiting for the Windows reload launch claim");
        if ((await rights.status(right)).state === "live") break;
        throw new Error("Cannot confirm the Windows reload launch after the claim timeout");
      }
      await Bun.sleep(POLL_INTERVAL_MS);
    }
    return {
      pane,
      launchToken,
      preserveWarm,
      route,
      right,
      deadlineMs: Date.now() + STARTUP_TIMEOUT_MS,
    };
  } catch (error) {
    await rights.cancelUnclaimed(right);
    await management.assertLive(context.original);
    reportReloadFailure(progress, pane.id, errorMessage(error));
  }
}

async function snapshotWindowsReload(
  { config, management }: WindowsReloadContext,
  audit: WindowsLifecycleAudit,
): Promise<void> {
  const previous = readSnapshot(config);
  const { basis } = audit;
  if (previous?.generation && previous.generation !== basis.instance)
    throw new Error("Snapshot belongs to another psmux generation");
  const retained = new Set(audit.startup.restoring);
  const suppressed = new Set(
    audit.managed.filter(({ temporary }) => temporary).map(({ id }) => id.toLowerCase()),
  );
  const counts = new Map<string, number>();
  for (const { id } of audit.managed) {
    const key = id.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sessions = uniqueCandidates([
    ...(previous?.sessions ?? []).filter(({ id }) => {
      const key = id.toLowerCase();
      return !suppressed.has(key) && (retained.has(key) || (counts.get(key) ?? 0) > 1);
    }),
    ...audit.ownership
      .filter(
        ({ peer, session }) =>
          !session.temporary &&
          counts.get(session.id.toLowerCase()) === 1 &&
          audit.entries.some((entry) => entry.peer.identity === peer.identity),
      )
      .map(({ session: { id, cwd } }) => ({ id, cwd })),
  ]);
  await management.assertLive(basis);
  writeSnapshot(config, {
    version: 1,
    generation: basis.instance,
    cwds: previous?.cwds ?? [],
    sessions,
  });
}

async function windowsReloadEnvironment(
  run: (commands: string[][]) => Promise<string>,
  desired: Record<string, string>,
): Promise<{ commands: string[][]; inheritedOverrides: WindowsReloadRoute["inheritedOverrides"] }> {
  const current = await run([["show-environment", "-s"]]);
  const global = await run([["show-environment", "-gs"]]);
  const exported = (text: string) =>
    [...text.replace(/"(?:\\.|[^"\\])*"/gs, "").matchAll(/; export ([^;\n]+);/g)].map(
      (match) => match[1]!,
    );
  const desiredKeys = new Set(Object.keys(desired).map((key) => key.toUpperCase()));
  const stale = [
    ...new Set([...exported(current), ...exported(global), ...PARENT_ENV_KEYS]),
  ].filter(
    (key) =>
      !desiredKeys.has(key.toUpperCase()) &&
      !GENERATED_ENV_KEYS.has(key.toUpperCase()) &&
      !PSMUX_ROUTING.has(key.toUpperCase()),
  );
  const commands: string[][] = [];
  const inheritedOverrides: WindowsReloadRoute["inheritedOverrides"] = [];
  for (const key of stale) {
    if (platform.acceptsTmuxEnvironmentKey(key)) commands.push(["set-environment", "-r", key]);
    else if (/^[^=\0\r\n]+$/.test(key)) inheritedOverrides.push([key, null]);
  }
  for (const [key, value] of Object.entries(desired)) {
    if (GENERATED_ENV_KEYS.has(key.toUpperCase()) || PSMUX_ROUTING.has(key.toUpperCase())) continue;
    const supported = platform.acceptsTmuxEnvironmentKey(key);
    if (!supported || /[\r\n]/.test(value) || value === "-t") {
      if (supported) commands.push(["set-environment", "-r", key]);
      inheritedOverrides.push([key, value]);
    } else {
      commands.push(["set-environment", key, value]);
    }
  }
  return { commands, inheritedOverrides };
}

async function confirmWindowsReloadPublications(context: WindowsReloadContext): Promise<void> {
  const { config, management, original, progress, rights } = context;
  if (!progress.inFlight.size) return;
  const audit = await management.audit("#{pane_id}");
  if (!launchBasisStillLive(original, audit.basis))
    throw new Error("Dedicated psmux generation changed during reload publication");
  for (const [id, pending] of progress.inFlight) {
    const { route, pane, launchToken, preserveWarm, right, release, deadlineMs } = pending;
    const peer = findWindowsReloadPeer(audit, route);
    const status = await rights.status(right);
    if (
      !peer ||
      status.state === "ended" ||
      status.state === "missing" ||
      status.state === "unknown"
    ) {
      reportReloadFailure(progress, id, "Cannot confirm the Windows reload launch");
    } else {
      const [session, pid, dead, sessionId, cwd, metadata, launch, paneRight] =
        await readWindowsPeerPaneFields(management.scope, audit, peer, route.pane, [
          "session_id",
          "pane_pid",
          "pane_dead",
          "PI_TMUX_SESSION_ID",
          "session_path",
          "@pi-tmux-session",
          "@pi-mux-launch",
          WINDOWS_RIGHT_OPTION,
        ]);
      if (session !== pane.session || dead !== "0" || sessionId !== id || cwd !== pane.cwd) {
        reportReloadFailure(progress, id, "The managed pane changed before publication");
      } else if (
        status.state === "live" &&
        "receipt" in status &&
        paneRight === right &&
        matchesReloadPublication(pane, Number(pid), launchToken, preserveWarm, metadata, launch)
      ) {
        const published = JSON.parse(Buffer.from(metadata!, "base64").toString("utf8"));
        if (
          published.processPid === status.receipt.child.pid &&
          published.cwd === pane.cwd &&
          published.startup === "ready" &&
          isAbsolute(published.file ?? "")
        ) {
          await withLock(config, async () => {
            await management.assertLive({ instance: route.instance, witnesses: [peer.identity] });
            await rights.complete(right, status.receipt);
            if (management.startupState(audit.basis)?.restoring.includes(id.toLowerCase()))
              await management.clearRestoring(audit.basis, id, windowsClaimLock(management));
          });
          announceReloaded(progress, id);
        }
      }
      if (!progress.reloaded.has(id) && !progress.failed.has(id)) {
        if (Date.now() < deadlineMs) continue;
        reportReloadFailure(progress, id, "pi startup timed out during reload");
      }
    }
    if (progress.failed.has(id)) await rights.cancelUnclaimed(right);
    progress.inFlight.delete(id);
    await release();
  }
}
