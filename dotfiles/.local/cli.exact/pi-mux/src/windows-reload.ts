import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, win32 } from "node:path";
import { promisify } from "node:util";
import {
  DISPATCH_TICKET_ID_MAX_LENGTH,
  DISPATCH_TICKET_ID_PATTERN,
  type WindowsReloadRoute,
} from "./cli-arguments";
import {
  cliInvocation,
  type Config,
  GENERATED_ENV_KEYS,
  PARENT_ENV_KEYS,
  prepareDirectory,
  PSMUX_ROUTING,
  tmuxConfiguration,
  type TmuxConfig,
} from "./configuration";
import { type ReleaseLock, tryAcquireLock, windowsClaimLock, withLock } from "./locks";
import { findFirstInput, launchRecordToken, matchesLaunch } from "./pane-inventory";
import { clearStateOptions } from "./pane-state";
import { platform } from "./platform";
import {
  announceReloaded,
  matchesReloadPublication,
  type ReloadProgress,
  type ReloadPublication,
  publishWaitingTargets,
  reportReloadFailure,
} from "./reload-publication";
import { ReloadWaiting } from "./reload-waiting";
import { startAndRestore } from "./restoration";
import { readSnapshot, uniqueCandidates, writeSnapshot } from "./restore-state";
import { findSaved } from "./saved-sessions";
import {
  auditWindowsLifecycle,
  type WindowsLifecycleAudit,
  type WindowsLifecycleEntry,
  type WindowsLifecyclePeer,
  windowsPaneHasWaitingUserState,
} from "./server-lifecycle";
import {
  errorMessage,
  isRecord,
  type Pane,
  POLL_INTERVAL_MS,
  SESSION_ID_PATTERN,
  STARTUP_TIMEOUT_MS,
  UUID,
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
  ticketLaunchKey,
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
import {
  inspectWindowsProcess,
  observeWindowsIdentity,
  type WindowsProcessIdentity,
} from "./windows-process";

const PROCESS_QUERY_TIMEOUT_MS = 5000;
const execFileAsync = promisify(execFile);
const DISPATCH_FIELDS = [
  "TICKET_DISPATCH_ROLE",
  "TICKET_DISPATCH_PROJECT",
  "TICKET_DISPATCH_ID",
] as const;
type DispatchEnvironment = Partial<Record<(typeof DISPATCH_FIELDS)[number], string>>;
type VerifiedWindowsReloadProcesses = { processes: WindowsProcessIdentity[]; keys: string[] };

class WindowsReloadSnapshotError extends Error {}

type PublishedEntry = WindowsLifecycleEntry & { pi: Pane };
type InitialPane = Pick<Pane, "id" | "cwd" | "session" | "pane" | "panePid"> & {
  peerIdentity: string;
};

type WindowsReloadTarget = {
  entry: WindowsLifecycleEntry;
  pane: Pane;
  temporary: boolean;
};

type WindowsReloadPlan = {
  running: WindowsLifecycleEntry[];
  candidates: WindowsLifecycleEntry[];
  rejected: { id: string; reason: string }[];
  starting: WindowsLifecycleEntry[];
  replaced: string[];
  vanished: string[];
  confirmed: string[];
};

type WindowsReloadPublication = Omit<ReloadPublication, "deadlineMs"> & {
  route: WindowsReloadRoute;
  right: string;
  deadlineMs: number;
  release: ReleaseLock;
};

type WindowsReloadProgress = Pick<ReloadProgress, "reloaded" | "failed" | "waiting"> & {
  inFlight: Map<string, WindowsReloadPublication>;
  confirmed: Set<string>;
  waitingForInputDrain: Set<string>;
  snapshotConflicts: Set<string>;
};

type WindowsReloadContext = {
  config: Config;
  management: WindowsManagement;
  rights: WindowsLaunchRights;
  original: WindowsManagementBasis;
  initialPanes: readonly InitialPane[];
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

export function startingConversationId(entry: WindowsLifecycleEntry): string | undefined {
  if (entry.pi || !entry.launch) return;
  let record: unknown;
  try {
    record = JSON.parse(entry.launch);
  } catch {
    return;
  }
  if (!isRecord(record) || typeof record.id !== "string" || !SESSION_ID_PATTERN.test(record.id))
    return;
  const token = launchRecordToken(entry.launch);
  return token && matchesLaunch(entry.launch, record.id, entry.panePid, token)
    ? record.id
    : undefined;
}

export function planWindowsReload(
  audit: WindowsLifecycleAudit,
  progress: {
    reloaded: ReadonlySet<string>;
    failed: ReadonlySet<string>;
    inFlight: ReadonlyMap<string, unknown>;
    confirmed: ReadonlySet<string>;
    initialPanes: readonly InitialPane[];
  },
  onlyId?: string,
): WindowsReloadPlan {
  const inScope = (id: string) => onlyId === undefined || id === onlyId;
  const handled = new Set(
    [...progress.reloaded, ...progress.failed, ...progress.inFlight.keys()].map((id) =>
      id.toLowerCase(),
    ),
  );
  const isPending = (id: string) => !handled.has(id.toLowerCase());
  const published = audit.entries.filter(
    (entry): entry is PublishedEntry => entry.pi !== undefined,
  );
  const live = published.filter(({ pi }) => inScope(pi!.id) && isPending(pi!.id));
  const starting = audit.entries.filter((entry) => {
    const id = startingConversationId(entry);
    return id !== undefined && inScope(id) && isPending(id);
  });
  const replaced: string[] = [];
  const confirmed = new Set([
    ...live.map(({ pi }) => pi!.id),
    ...starting.map((entry) => startingConversationId(entry)!),
  ]);
  const vanished = [...progress.confirmed].filter(
    (id) => inScope(id) && isPending(id) && !confirmed.has(id),
  );
  const rejected = new Map<string, string>();
  const candidates: WindowsLifecycleEntry[] = [];
  for (const entry of live) {
    const { id } = entry.pi!;
    if (rejected.has(id)) continue;
    const key = id.toLowerCase();
    const sameId = published.filter(({ pi }) => pi.id.toLowerCase() === key);
    const owners = audit.ownership.filter(({ session }) => session.id.toLowerCase() === key);
    const hasOtherOwner = owners.some(({ peer }) => peer.identity !== entry.peer.identity);
    const hasOtherStartup = starting.some(
      (candidate) => startingConversationId(candidate)?.toLowerCase() === key,
    );
    const directories = new Set([
      ...sameId.map(({ pi }) => pi.cwd),
      ...owners.map(({ session }) => session.cwd),
    ]);
    if (directories.size > 1 || sameId.length > 1 || hasOtherOwner || hasOtherStartup) {
      rejected.set(
        id,
        directories.size > 1
          ? `Conflicting working directories for conversation ${id}`
          : "Multiple pi processes or owners match the conversation ID",
      );
      continue;
    }
    const conflict = windowsReloadOwnershipConflict(entry);
    if (conflict) {
      rejected.set(id, conflict);
      continue;
    }
    const paneCount =
      audit.panes.find(({ peer }) => peer.identity === entry.peer.identity)?.rows.length ?? 0;
    if (paneCount !== 1) {
      rejected.set(id, "Cannot replace only the target pane in a session with several panes");
      continue;
    }
    const initial = progress.initialPanes.find(
      (pane) =>
        pane.id === id &&
        pane.peerIdentity === entry.peer.identity &&
        pane.session === entry.pi.session &&
        pane.pane === entry.pi.pane,
    );
    if (initial && initial.cwd !== entry.pi.cwd) {
      rejected.set(id, `Conflicting working directories for conversation ${id}`);
      continue;
    }
    if (initial && initial.panePid !== entry.pi.panePid) {
      replaced.push(id);
      continue;
    }
    if (entry.pi.reloadReadiness === undefined) {
      rejected.set(id, "Missing or invalid proof that pi drained its startup input");
      continue;
    }
    candidates.push(entry);
  }
  return {
    running: live,
    candidates,
    rejected: [...rejected].map(([id, reason]) => ({ id, reason })),
    starting,
    replaced,
    vanished,
    confirmed: [...confirmed],
  };
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
    const plan = planWindowsReload(audit, {
      reloaded: new Set(),
      failed: new Set(),
      inFlight: new Map(),
      confirmed: new Set(),
      initialPanes: [],
    });
    const startingIds = new Set(plan.starting.map((entry) => startingConversationId(entry)));
    if (
      onlyId !== undefined &&
      !plan.running.some(({ pi }) => pi?.id === onlyId) &&
      !startingIds.has(onlyId)
    ) {
      if (audit.managed.some(({ id }) => id === onlyId))
        throw new Error(
          `Cannot verify a live or starting Windows pi for the assigned session: ${onlyId}`,
        );
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
      initialPanes: audit.entries.flatMap(({ pi, peer }) =>
        pi ? [{ ...pi, peerIdentity: peer.identity }] : [],
      ),
      confirmed: new Set(plan.confirmed),
    };
  });
  if (typeof initial === "number") return initial;

  const progress: WindowsReloadProgress = {
    reloaded: new Set(),
    failed: new Set(),
    inFlight: new Map(),
    waiting: new ReloadWaiting(config, initial.original),
    confirmed: initial.confirmed,
    waitingForInputDrain: new Set(),
    snapshotConflicts: new Set(),
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
              publishWaitingTargets(progress);
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
    progress.waiting.replace([]);
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

  const plan = planWindowsReload(audit, { ...progress, initialPanes }, onlyId);
  for (const id of plan.confirmed) progress.confirmed.add(id);
  for (const { id, reason } of plan.rejected) reportReloadFailure(progress, id, reason);
  for (const id of plan.vanished)
    reportReloadFailure(progress, id, "The managed pi is no longer running");
  for (const entry of plan.starting) {
    const id = startingConversationId(entry)!;
    if (progress.failed.has(id)) continue;
    try {
      await confirmStillStarting(context, entry);
    } catch (error) {
      reportReloadFailure(progress, id, errorMessage(error));
    }
  }
  const replaced = new Set(plan.replaced);
  const entries = [...plan.candidates, ...plan.running.filter(({ pi }) => replaced.has(pi!.id))];
  const startingTargets = audit.ownership.flatMap(({ peer, session }) =>
    !progress.failed.has(session.id) &&
    plan.starting.some(
      (entry) =>
        entry.peer.identity === peer.identity && startingConversationId(entry) === session.id,
    )
      ? [{ id: session.id, session: session.session, name: peer.name }]
      : [],
  );
  publishWaitingTargets(progress, [...entries.map(({ pi }) => pi!), ...startingTargets]);
  for (const entry of entries) {
    const pane = entry.pi!;
    const { id } = pane;
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
      if (replaced.has(id)) {
        if (pane.startup === "accepted") continue;
        if (pane.startup === undefined || !entry.right || !entry.launch)
          throw new Error("Cannot verify the replacement published by another Windows reload");
        const status = await context.rights.status(entry.right);
        if (
          status.state !== "live" ||
          !("receipt" in status) ||
          status.receipt.child.pid !== pane.pid
        )
          throw new Error("Cannot verify the Windows replacement launch receipt");
        if (!status.completed) continue;
        announceReloaded(progress, id);
        continue;
      }
      const target = selectWindowsReloadTarget(context, entry);
      if (!target) continue;
      const publication = await respawnWindowsReloadTarget(context, audit, target);
      if (!publication) continue;
      progress.inFlight.set(id, { ...publication, release });
      return "started";
    } catch (error) {
      if (error instanceof WindowsReloadSnapshotError) throw error;
      await management.assertLive(original);
      reportReloadFailure(progress, id, errorMessage(error));
    } finally {
      if (!progress.inFlight.has(id)) await release();
    }
  }
  return entries.some(({ pi }) => !progress.failed.has(pi!.id) && !progress.reloaded.has(pi!.id)) ||
    plan.starting.some((entry) => !progress.failed.has(startingConversationId(entry)!))
    ? "wait"
    : "done";
}

async function confirmStillStarting(
  context: WindowsReloadContext,
  entry: WindowsLifecycleEntry,
): Promise<void> {
  const { rights, progress } = context;
  const id = startingConversationId(entry)!;
  if (
    (entry.observedId && entry.observedId !== id) ||
    (entry.observedTemporary && entry.observedTemporary !== id) ||
    entry.inheritedRight !== entry.right
  )
    throw new Error("The Windows startup record contradicts pane ownership");
  if (!entry.right) return;
  const status = await rights.status(entry.right);
  if (status.state === "reserved" || status.state === "pending" || status.state === "live") return;
  if (status.state === "unknown") throw new Error(`Cannot verify Windows launch for ${id}`);
  reportReloadFailure(progress, id, "Cannot verify a live Windows launch for the starting pi");
}

function windowsReloadOwnershipConflict(entry: PublishedEntry): string | undefined {
  const { pi, observedId, observedTemporary, observedCwd, inheritedRight, right, launch } = entry;
  if ((observedId && observedId !== pi.id) || (observedTemporary && observedTemporary !== pi.id))
    return "Published pi contradicts Windows session ownership";
  if (observedId && observedCwd !== pi.cwd)
    return "Published pi contradicts the managed working directory";
  if (right !== inheritedRight) return "Conflicting Windows pane and session launch rights";
  const token = JSON.parse(Buffer.from(pi.metadata, "base64").toString("utf8")).token;
  if (typeof token !== "string" || !UUID.test(token))
    return "Cannot verify the published Windows pi launch token";
  if (launch && !matchesLaunch(launch, pi.id, pi.panePid, token))
    return "The Windows pane launch record does not identify the published pi";
}

export function windowsReloadIsWaiting(config: TmuxConfig, entry: WindowsLifecycleEntry): boolean {
  return (
    entry.pi?.reloadReadiness === "drained" &&
    windowsPaneHasWaitingUserState(config, entry) &&
    !findFirstInput(config, entry.pi.id)
  );
}

function selectWindowsReloadTarget(
  { config, progress }: WindowsReloadContext,
  entry: WindowsLifecycleEntry,
): WindowsReloadTarget | undefined {
  const pane = entry.pi!;
  if (progress.failed.has(pane.id)) return;
  if (pane.reloadReadiness === "pending") {
    if (!progress.waitingForInputDrain.has(pane.id)) {
      progress.waitingForInputDrain.add(pane.id);
      console.error(`pi-mux: reload ${pane.id}: waiting for pi to drain its startup input`);
    }
    return;
  }
  if (!windowsReloadIsWaiting(config, entry)) return;
  return { entry, pane, temporary: entry.temporary };
}

type WindowsProcessRow = {
  pid: number;
  parent: number;
  executable: string | null;
  command: string | null;
};

async function readWindowsProcessGroup(pids: readonly number[]): Promise<WindowsProcessRow[]> {
  if (!pids.length || pids.some((pid) => !Number.isInteger(pid) || pid < 1 || pid > 0xffffffff))
    throw new Error("Invalid Windows process scope");
  const filter = pids
    .flatMap((pid) => [`ProcessId = ${pid}`, `ParentProcessId = ${pid}`])
    .join(" OR ");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    `$rows = @(Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object {`,
    "  @{ pid = $_.ProcessId; parent = $_.ParentProcessId; executable = $_.ExecutablePath; command = $_.CommandLine }",
    "})",
    "[Console]::WriteLine((ConvertTo-Json -InputObject $rows -Compress))",
  ].join("\n");
  const powershell = win32.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  try {
    const { stdout } = await execFileAsync(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        timeout: PROCESS_QUERY_TIMEOUT_MS,
      },
    );
    const rows: unknown = JSON.parse(stdout);
    if (
      !Array.isArray(rows) ||
      !rows.every(
        (row) =>
          isRecord(row) &&
          Number.isSafeInteger(row.pid) &&
          Number.isSafeInteger(row.parent) &&
          (row.executable === null || typeof row.executable === "string") &&
          (row.command === null || typeof row.command === "string"),
      )
    )
      throw new Error("Invalid Windows process inventory");
    return rows;
  } catch (error) {
    throw new Error("Cannot verify the Windows pane process tree", { cause: error });
  }
}

function sameWindowsPath(first: string | null, second: string): boolean {
  return (
    first !== null && win32.normalize(first).toLowerCase() === win32.normalize(second).toLowerCase()
  );
}

export function verifyWindowsReloadGroup(
  rows: readonly WindowsProcessRow[],
  target: { peerPid: number; panePid: number; piPid: number; verifiedRight?: string },
  paths: { node: string; cli: string; wrapper: string },
): number[] {
  const { peerPid, panePid, piPid, verifiedRight } = target;
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const pi = byPid.get(piPid);
  const [, scriptPath] = windowsCommandPrefix(pi?.command, 2);
  if (
    !pi ||
    !sameWindowsPath(pi.executable, paths.node) ||
    !sameWindowsPath(scriptPath ?? null, paths.cli)
  )
    throw new Error("Cannot attribute the Windows pane process to the current pi CLI");
  if (!byPid.has(peerPid) || byPid.get(panePid)?.parent !== peerPid || panePid === peerPid)
    throw new Error("Cannot verify the Windows pane belongs to the audited peer");
  const children = (pid: number) => rows.filter((row) => row.parent === pid);
  const chain = [panePid];
  if (panePid !== piPid) {
    if (!verifiedRight || !UUID.test(verifiedRight))
      throw new Error("Cannot replace pi without also replacing an unverified Windows pane parent");
    const pane = byPid.get(panePid)!;
    const child = children(panePid);
    if (child.length !== 1)
      throw new Error("Cannot replace pi without affecting other Windows processes");
    if (child[0]!.pid !== piPid) {
      const wrapper = child[0]!;
      const isPowerShell = /^(?:powershell|pwsh)\.exe$/i.test(
        win32.basename(pane.executable ?? ""),
      );
      const encodedScript = pane.command?.match(
        /\s-NoProfile\s+-NonInteractive\s+-EncodedCommand\s+"?([A-Za-z0-9+/]+={0,2})"?\s*$/i,
      )?.[1];
      const script = encodedScript && Buffer.from(encodedScript, "base64").toString("utf16le");
      const operation = windowsClaimOperation(wrapper, paths.wrapper, verifiedRight);
      if (
        !isPowerShell ||
        !operation ||
        !script?.includes(`'${operation}' '${verifiedRight}'`) ||
        children(wrapper.pid).length !== 1 ||
        pi.parent !== wrapper.pid
      )
        throw new Error("Cannot verify the Windows pi wrapper and its only child");
      chain.push(wrapper.pid);
    } else if (
      windowsClaimOperation(pane, paths.wrapper, verifiedRight) !== "windows-claim-launch"
    ) {
      throw new Error("Cannot verify the Windows pi wrapper executable and assigned launch right");
    }
    chain.push(piPid);
  }
  if (children(piPid).length)
    throw new Error("Cannot replace pi without affecting its Windows child processes");
  return chain;
}

function windowsClaimOperation(
  row: WindowsProcessRow,
  wrapper: string,
  token: string,
): "windows-claim-launch" | "claim-initial-request" | undefined {
  if (!sameWindowsPath(row.executable, wrapper)) return;
  const [, first, second, third] = windowsCommandPrefix(row.command, 4);
  const [operation, claimToken] = /[\\/]main\.ts$/i.test(first ?? "")
    ? [second, third]
    : [first, second];
  if (claimToken !== token) return;
  if (operation === "windows-claim-launch" || operation === "claim-initial-request")
    return operation;
}

function windowsCommandPrefix(command: string | null | undefined, count: number): string[] {
  const args: string[] = [];
  const argument = /\s*(?:"([^"]+)"|([^\s"]+))(?=\s|$)/y;
  while (command && args.length < count) {
    const match = argument.exec(command);
    if (!match) break;
    args.push((match[1] ?? match[2])!);
  }
  return args;
}

async function verifyWindowsReloadProcesses(
  { config, rights }: WindowsReloadContext,
  { entry, pane }: WindowsReloadTarget,
  basis: WindowsManagementBasis,
  expected?: VerifiedWindowsReloadProcesses,
): Promise<VerifiedWindowsReloadProcesses> {
  const peerPid = Number(entry.peer.identity.split(":")[0]);
  const known = captureWindowsProcesses([peerPid, pane.panePid, pane.pid]);
  const knownByPid = new Map(known.map((process) => [process.pid, process]));
  const peer = knownByPid.get(peerPid);
  const pi = knownByPid.get(pane.pid);
  if (
    !peer ||
    !pi ||
    !knownByPid.has(pane.panePid) ||
    `${peer.pid}:${peer.creationTime}` !== entry.peer.identity
  )
    throw new Error("Cannot verify live Windows pi, pane and peer identities");
  const keys = await rights.inspectReloadKeys({
    token: entry.right || undefined,
    basis,
    child: pi,
    conversationKey: conversationLaunchKey(pane.id),
  });
  const [node, cli] = config.piCommand();
  if (!node || !cli) throw new Error("Cannot identify the Windows pi executable and CLI");
  const knownPids = [...knownByPid.keys()];
  const first = await readWindowsProcessGroup(knownPids);
  const intermediates = first.filter(
    ({ parent, pid }) => parent === pane.panePid && !knownByPid.has(pid),
  );
  const observed = captureWindowsProcesses(intermediates.map(({ pid }) => pid));
  const rows = intermediates.length
    ? await readWindowsProcessGroup([...knownPids, ...intermediates.map(({ pid }) => pid)])
    : first;
  const identities = new Map([...known, ...observed].map((process) => [process.pid, process]));
  const chain = verifyWindowsReloadGroup(
    rows,
    { peerPid, panePid: pane.panePid, piPid: pane.pid, verifiedRight: entry.right },
    { node: realpathSync(node), cli, wrapper: realpathSync(process.execPath) },
  );
  const processes = chain.map((pid) => identities.get(pid));
  let parent = peer;
  for (const child of processes) {
    if (
      !child ||
      BigInt(child.creationTime) < BigInt(parent.creationTime) ||
      observeWindowsIdentity(child, inspectWindowsProcess) !== "present"
    )
      throw new Error("The Windows pane process tree changed during verification");
    parent = child;
  }
  if (
    observeWindowsIdentity(peer, inspectWindowsProcess) !== "present" ||
    (expected && JSON.stringify(processes) !== JSON.stringify(expected.processes))
  )
    throw new Error("The Windows pane process group changed before replacement");
  if (expected && JSON.stringify(keys) !== JSON.stringify(expected.keys))
    throw new Error("The Windows launch keys changed before replacement");
  return { processes: processes as WindowsProcessIdentity[], keys };
}

export function windowsReloadDispatchEnvironment(
  id: string,
  auditedRole: string | undefined,
  [role, project, ticketId]: readonly string[],
  keys: readonly string[],
): DispatchEnvironment {
  const conversation = conversationLaunchKey(id);
  if (
    role === auditedRole &&
    !role &&
    !project &&
    !ticketId &&
    keys.length === 1 &&
    keys[0] === conversation
  )
    return {};
  if (
    role !== "pi" ||
    role !== auditedRole ||
    !project ||
    [".", ".."].includes(project) ||
    /[\\/\0\r\n\t]/.test(project) ||
    !ticketId ||
    ticketId.length > DISPATCH_TICKET_ID_MAX_LENGTH ||
    !DISPATCH_TICKET_ID_PATTERN.test(ticketId)
  )
    throw new Error("Cannot verify the Windows ticket dispatch routing");
  const ticket = ticketLaunchKey(project, ticketId);
  if (!keys.includes(ticket) || keys.some((key) => key !== ticket && key !== conversation))
    throw new Error("Windows ticket dispatch routing does not match the verified launch keys");
  return {
    TICKET_DISPATCH_ROLE: role,
    TICKET_DISPATCH_PROJECT: project,
    TICKET_DISPATCH_ID: ticketId,
  };
}

export async function replaceVerifiedWindowsReloadPane(
  config: TmuxConfig,
  target: WindowsReloadTarget,
  operations: {
    dispatchRouting: readonly string[];
    verifyProcesses(): Promise<readonly WindowsProcessIdentity[]>;
    readPane(fields: string[]): Promise<string[]>;
    isPresent(process: WindowsProcessIdentity): boolean;
    replace(): Promise<unknown>;
  },
): Promise<boolean> {
  const { entry, pane } = target;
  const processes = await operations.verifyProcesses();
  const last = await operations.readPane([
    "session_id",
    "pane_pid",
    "pane_dead",
    "session_windows",
    "window_panes",
    "PI_TMUX_SESSION_ID",
    "PI_TMUX_TEMPORARY",
    "session_path",
    "@pi-tmux-session",
    "@pi-mux-launch",
    WINDOWS_RIGHT_OPTION,
    WINDOWS_RIGHT_ENV,
    "@pi_session_state",
    "@pi-mux-state-source",
    "@pi-mux-pending-restart-blocker",
    ...DISPATCH_FIELDS,
  ]);
  const [
    session,
    pid,
    dead,
    windows,
    panes,
    observedId,
    temporary,
    cwd,
    metadata,
    launch,
    right,
    inheritedRight,
    state,
    owner,
    blocker,
    ...dispatchRouting
  ] = last;
  if (JSON.stringify(dispatchRouting) !== JSON.stringify(operations.dispatchRouting))
    throw new Error("The Windows ticket dispatch routing changed before replacement");
  if (
    session !== pane.session ||
    pid !== String(pane.panePid) ||
    dead !== "0" ||
    windows !== "1" ||
    panes !== "1" ||
    observedId !== entry.observedId ||
    temporary !== entry.observedTemporary ||
    cwd !== entry.observedCwd ||
    launch !== entry.launch ||
    right !== entry.right ||
    inheritedRight !== entry.inheritedRight
  )
    throw new Error("The Windows pane scope or ownership changed before replacement");
  if (!processes.every(operations.isPresent))
    throw new Error("The Windows pane process group changed before replacement");
  if (
    metadata !== pane.metadata ||
    !windowsReloadIsWaiting(config, { ...entry, pi: pane, state, owner, blocker })
  )
    return false;
  await operations.replace();
  return true;
}

async function respawnWindowsReloadTarget(
  context: WindowsReloadContext,
  audit: WindowsLifecycleAudit,
  target: WindowsReloadTarget,
): Promise<Omit<WindowsReloadPublication, "release"> | undefined> {
  const { entry, pane, temporary } = target;
  const { config, management, rights } = context;
  const { peer, paneId } = entry;
  const basis = { instance: audit.basis.instance, witnesses: [peer.identity] };
  const readPane = (fields: string[]) =>
    readWindowsPeerPaneFields(management.scope, audit, peer, paneId, fields);
  const run = (commands: string[][]) =>
    runWindowsPeerPaneCommands(management.scope, audit, peer, paneId, commands);
  const dispatchRouting = await readPane([...DISPATCH_FIELDS]);
  const verified = await verifyWindowsReloadProcesses(context, target, basis);
  const { processes, keys } = verified;
  const dispatchEnvironment = windowsReloadDispatchEnvironment(
    pane.id,
    entry.role,
    dispatchRouting,
    keys,
  );
  const savedFile = lstatSync(pane.file, { throwIfNoEntry: false });
  if (savedFile && !savedFile.isFile())
    throw new Error(`Invalid saved conversation file: ${pane.file}`);
  const preserveWarm = pane.warm && !savedFile;
  const launchToken = randomUUID();
  const right = randomUUID();
  const startup = `pi-mux-startup-${randomUUID()}`;
  const environment = Object.fromEntries(
    Object.entries(config.env).filter(
      ([key]) => !DISPATCH_FIELDS.some((field) => field === key.toUpperCase()),
    ),
  );
  const desired: Record<string, string> = {
    ...environment,
    PI_CODING_AGENT_DIR: config.agentDir,
    PI_TMUX_SESSION_ID: pane.id,
    PI_TMUX_LAUNCH_TOKEN: launchToken,
    PI_TMUX_STARTUP_COMMAND: startup,
    [WINDOWS_RIGHT_ENV]: right,
    ...(temporary ? { PI_TMUX_TEMPORARY: pane.id } : {}),
    ...(preserveWarm ? { PI_TMUX_STARTUP_MODE: "warm" } : {}),
  };
  const { commands, inheritedOverrides } = await windowsReloadEnvironment(
    run,
    desired,
    Object.keys(dispatchEnvironment),
  );
  const launcher = inspectWindowsProcess(process.pid);
  if (launcher.state !== "live") throw new Error("Cannot identify the Windows reload launcher");
  if (!(await snapshotWindowsReload(context, audit, target)))
    throw new Error(`Conflicting working directories for conversation ${pane.id}`);
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
    inheritedOverrides: [
      ...inheritedOverrides,
      ...DISPATCH_FIELDS.map((field): [string, string | null] => [
        field,
        dispatchEnvironment[field] ?? null,
      ]),
    ],
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
  const markerAdded =
    !temporary && !management.startupState(basis)?.restoring.includes(pane.id.toLowerCase());
  if (markerAdded) await management.keepRestoring(basis, pane.id, windowsClaimLock(management));
  let replacementAttempted = false;
  try {
    const replaced = await replaceVerifiedWindowsReloadPane(config, target, {
      dispatchRouting,
      async verifyProcesses() {
        return (await verifyWindowsReloadProcesses(context, target, basis, verified)).processes;
      },
      readPane,
      isPresent: (process) => observeWindowsIdentity(process, inspectWindowsProcess) === "present",
      async replace() {
        replacementAttempted = true;
        await run([
          ...commands,
          ["set-option", "-pu", "-t", paneId, "@pi-tmux-session"],
          ["set-option", "-pu", "-t", paneId, "@pi-mux-launch"],
          ["set-option", "-pu", "-t", paneId, WINDOWS_RIGHT_OPTION],
          ...clearStateOptions(paneId).filter(
            (args) => args.at(-1) !== "@pi_session_state_pending",
          ),
          respawn,
        ]);
      },
    });
    if (!replaced) return;
    await waitForWindowsExit(processes, {
      timeoutMs: STARTUP_TIMEOUT_MS,
      pollMs: POLL_INTERVAL_MS,
    });
    const [nextSession, nextPid, nextDead, nextRight, ...nextDispatchRouting] = await readPane([
      "session_id",
      "pane_pid",
      "pane_dead",
      WINDOWS_RIGHT_ENV,
      ...DISPATCH_FIELDS,
    ]);
    if (
      nextSession !== pane.session ||
      !/^[1-9]\d*$/.test(nextPid ?? "") ||
      Number(nextPid) === pane.panePid ||
      nextDead !== "0" ||
      nextRight !== right ||
      JSON.stringify(nextDispatchRouting) !== JSON.stringify(dispatchRouting)
    )
      throw new Error("Cannot verify the Windows reload replacement pane");
    const reserved = await rights.reserveAfterLifecycleAudit(keys, basis, { token: right });
    if (reserved.state !== "reserved") throw new Error("A Windows pi launch is still active");
    const claimDeadlineMs = Date.now() + STARTUP_TIMEOUT_MS;
    while (true) {
      const status = await rights.status(right);
      if (status.state === "live") {
        if (dispatchEnvironment.TICKET_DISPATCH_ROLE && "receipt" in status)
          await rights.complete(right, status.receipt);
        break;
      }
      if (status.state !== "reserved")
        throw new Error("Cannot confirm the Windows reload launch was claimed");
      if (Date.now() >= claimDeadlineMs) {
        if (await rights.cancelUnclaimed(right))
          throw new Error("Timed out waiting for the Windows reload launch claim");
        if ((await rights.status(right)).state === "live") continue;
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
    throw error;
  } finally {
    if (
      !replacementAttempted &&
      markerAdded &&
      processes.every(
        (process) => observeWindowsIdentity(process, inspectWindowsProcess) === "present",
      )
    )
      await management.clearRestoring(basis, pane.id, windowsClaimLock(management));
  }
}

async function snapshotWindowsReload(
  { config, management, progress }: WindowsReloadContext,
  audit: WindowsLifecycleAudit,
  target: Pick<WindowsReloadTarget, "pane" | "temporary">,
): Promise<boolean> {
  try {
    const previous = readSnapshot(config);
    const { basis } = audit;
    if (previous?.generation && previous.generation !== basis.instance)
      throw new Error("Snapshot belongs to another psmux generation");
    const sessions = windowsReloadSnapshotCandidates(
      audit,
      previous?.sessions ?? [],
      target,
      progress.snapshotConflicts,
    );
    if (!sessions) {
      progress.snapshotConflicts.add(target.pane.id.toLowerCase());
      return false;
    }
    await management.assertLive(basis);
    writeSnapshot(config, {
      version: 1,
      generation: basis.instance,
      cwds: previous?.cwds ?? [],
      sessions,
    });
    return true;
  } catch (error) {
    throw new WindowsReloadSnapshotError(errorMessage(error), { cause: error });
  }
}

export function windowsReloadSnapshotCandidates(
  audit: WindowsLifecycleAudit,
  previous: readonly Pick<Pane, "id" | "cwd">[],
  { pane, temporary }: { pane: Pick<Pane, "id" | "cwd">; temporary: boolean },
  refusedConflicts: ReadonlySet<string> = new Set(),
): Pick<Pane, "id" | "cwd">[] | undefined {
  const savedDirectories = new Map<string, Set<string>>();
  for (const { id, cwd } of previous) {
    const key = id.toLowerCase();
    const directories = savedDirectories.get(key) ?? new Set<string>();
    directories.add(cwd);
    savedDirectories.set(key, directories);
  }
  const conflicts = new Set(refusedConflicts);
  for (const { id, cwd } of [
    pane,
    ...audit.managed,
    ...audit.entries.flatMap(({ pi }) => (pi ? [pi] : [])),
  ]) {
    const key = id.toLowerCase();
    const saved = savedDirectories.get(key);
    if (saved && (saved.size > 1 || !saved.has(cwd))) conflicts.add(key);
  }
  const targetKey = pane.id.toLowerCase();
  if (conflicts.has(targetKey)) return;
  const retained = new Set(audit.startup.restoring);
  const counts = new Map<string, number>();
  const suppressed = new Set<string>();
  for (const { id, temporary: isTemporary } of audit.managed) {
    const key = id.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (isTemporary) suppressed.add(key);
  }
  for (const { pi, observedId } of audit.entries) {
    if (!pi || pi.id === observedId) continue;
    const key = pi.id.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (temporary) suppressed.add(targetKey);
  return uniqueCandidates([
    ...previous.filter(({ id }) => {
      const key = id.toLowerCase();
      if (conflicts.has(key) || (counts.get(key) ?? 0) > 1) return true;
      return !suppressed.has(key) && (retained.has(key) || key === targetKey);
    }),
    ...audit.ownership
      .filter(
        ({ peer, session }) =>
          !session.temporary &&
          !conflicts.has(session.id.toLowerCase()) &&
          counts.get(session.id.toLowerCase()) === 1 &&
          audit.entries.some((entry) => entry.peer.identity === peer.identity),
      )
      .map(({ session: { id, cwd } }) => ({ id, cwd })),
    ...(temporary ? [] : [{ id: pane.id, cwd: pane.cwd }]),
  ]);
}

async function windowsReloadEnvironment(
  run: (commands: string[][]) => Promise<string>,
  desired: Record<string, string>,
  retained: readonly string[],
): Promise<{ commands: string[][]; inheritedOverrides: WindowsReloadRoute["inheritedOverrides"] }> {
  const current = await run([["show-environment", "-s"]]);
  const global = await run([["show-environment", "-gs"]]);
  const exported = (text: string) =>
    [...text.replace(/"(?:\\.|[^"\\])*"/gs, "").matchAll(/; export ([^;\n]+);/g)].map(
      (match) => match[1]!,
    );
  const desiredKeys = new Set(
    [...Object.keys(desired), ...retained].map((key) => key.toUpperCase()),
  );
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
  const { management, original, progress, rights } = context;
  if (!progress.inFlight.size) return;
  const audit = await management.audit("#{pane_id}");
  if (!launchBasisStillLive(original, audit.basis))
    throw new Error("Dedicated psmux generation changed during reload publication");
  for (const [id, pending] of progress.inFlight) {
    try {
      if (await hasWindowsReloadPublication(context, audit, pending)) {
        announceReloaded(progress, id);
      } else if (Date.now() < pending.deadlineMs) {
        continue;
      } else {
        throw new Error("pi startup timed out during reload");
      }
    } catch (error) {
      await management.assertLive(original);
      reportReloadFailure(progress, id, errorMessage(error));
    }
    if (progress.failed.has(id)) await rights.cancelUnclaimed(pending.right);
    progress.inFlight.delete(id);
    await pending.release();
  }
}

async function hasWindowsReloadPublication(
  { config, management, rights }: WindowsReloadContext,
  audit: Awaited<ReturnType<WindowsManagement["audit"]>>,
  { route, pane, launchToken, preserveWarm, right }: WindowsReloadPublication,
): Promise<boolean> {
  const peer = findWindowsReloadPeer(audit, route);
  const status = await rights.status(right);
  if (!peer || status.state === "ended" || status.state === "missing" || status.state === "unknown")
    throw new Error("Cannot confirm the Windows reload launch");
  const [session, pid, dead, sessionId, metadata, launch, paneRight] =
    await readWindowsPeerPaneFields(management.scope, audit, peer, route.pane, [
      "session_id",
      "pane_pid",
      "pane_dead",
      "PI_TMUX_SESSION_ID",
      "@pi-tmux-session",
      "@pi-mux-launch",
      WINDOWS_RIGHT_OPTION,
    ]);
  if (session !== pane.session || dead !== "0" || sessionId !== pane.id)
    throw new Error("The managed pane changed before publication");
  if (
    status.state !== "live" ||
    !("receipt" in status) ||
    paneRight !== right ||
    !matchesReloadPublication(pane, Number(pid), launchToken, preserveWarm, metadata, launch)
  )
    return false;
  const published = JSON.parse(Buffer.from(metadata!, "base64").toString("utf8"));
  if (
    published.processPid !== status.receipt.child.pid ||
    published.cwd !== pane.cwd ||
    published.startup !== "ready" ||
    typeof published.file !== "string" ||
    !isAbsolute(published.file)
  )
    return false;
  await withLock(config, async () => {
    await management.assertLive({ instance: route.instance, witnesses: [peer.identity] });
    await rights.complete(right, status.receipt);
    if (management.startupState(audit.basis)?.restoring.includes(pane.id.toLowerCase()))
      await management.clearRestoring(audit.basis, pane.id, windowsClaimLock(management));
  });
  return true;
}
