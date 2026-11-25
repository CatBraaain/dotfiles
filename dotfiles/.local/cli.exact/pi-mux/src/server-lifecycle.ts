import { isAbsolute } from "node:path";
import type { Operation } from "./cli-arguments";
import { type Config, prepareDirectory, type TmuxConfig } from "./configuration";
import { windowsClaimLock, withLock } from "./locks";
import {
  initializingPanes,
  livePanes,
  managedSessions,
  matchesLaunch,
  PANE_FORMAT,
  parseLivePaneRows,
} from "./pane-inventory";
import { parseSessionState, parseSource } from "./pane-state";
import { platform } from "./platform";
import { setRestoringSessions, snapshotSessions, startAndRestore } from "./restoration";
import { readSnapshot, uniqueCandidates, writeSnapshot } from "./restore-state";
import {
  isRecord,
  type ManagedSession,
  POLL_INTERVAL_MS,
  SESSION_ID_PATTERN,
  STARTUP_TIMEOUT_MS,
} from "./session-model";
import {
  serverLifetime,
  tmux,
  tmuxArguments,
  tmuxQueries,
  verifyServerLifetime,
  windowsManagement,
} from "./tmux";
import {
  conversationLaunchKey,
  launchBasisStillLive,
  type WindowsManagementBasis,
} from "./windows-launch-rights";
import { captureWindowsProcesses, stopWindowsPeers, waitForWindowsExit } from "./windows-lifecycle";
import type { WindowsManagement } from "./windows-management";
import type { PsmuxPeer } from "./windows-psmux";

function waitingUserStopChain(panes: string[], action: string, waitMarker: string): string {
  const wait = tmuxArguments(["display-message", "-p", waitMarker]);
  let branch = action;
  for (const pane of panes) {
    branch = tmuxArguments([
      "if-shell",
      "-t",
      pane,
      "-F",
      `#{&&:#{==:#{pane_id},${pane}},#{m:*"state":"waiting-user"*,#{@pi_session_state}}}`,
      branch,
      wait,
    ]);
  }
  return branch;
}

async function restartIsWaiting(config: TmuxConfig): Promise<boolean> {
  const panes = await livePanes(config, "list");
  const managed = await managedSessions(config);
  for (const session of managed)
    if (!panes.some((pane) => pane.session === session.session && pane.id === session.id))
      return false;
  const states = await tmuxQueries(
    config,
    panes.flatMap((pane) => [
      ["show-options", "-pqv", "-t", pane.pane, "@pi_session_state"],
      ["show-options", "-pqv", "-t", pane.pane, "@pi-mux-pending-restart-blocker"],
    ]),
  );
  return panes.every((pane, index) => {
    const result = states[index * 2]!;
    const pending = states[index * 2 + 1]!;
    if (pending.exitCode !== 0) throw new Error(`Cannot inspect pending restart state: ${pane.id}`);
    if (pending.stdout.trim()) return false;
    if (result.exitCode !== 0) throw new Error(`Cannot inspect restart state: ${pane.id}`);
    const state = parseSessionState(result.stdout.trimEnd(), pane.id);
    return pane.startup !== "accepted" && state === "waiting-user";
  });
}

const WINDOWS_LIFECYCLE_FORMAT = `${PANE_FORMAT}\t#{PI_TMUX_SESSION_ID}\t#{PI_TMUX_TEMPORARY}\t#{session_path}\t#{@pi-mux-launch}\t#{TICKET_DISPATCH_ROLE}\t#{@pi-mux-windows-start-right}\t#{@pi_session_state}\t#{@pi-mux-state-source}\t#{@pi-mux-pending-restart-blocker}`;

export async function auditWindowsLifecycle(management: WindowsManagement, mode = "restart") {
  const audit = await management.audit(WINDOWS_LIFECYCLE_FORMAT, { requireRestored: false });
  if (!audit.startup) throw new Error("Dedicated psmux management has not been initialized");
  const managed: ManagedSession[] = [];
  const ownership: { peer: WindowsLifecyclePeer; session: ManagedSession }[] = [];
  const pids: number[] = [];
  const activeIds = new Set<string>();
  const entries = audit.panes.flatMap(({ peer, rows }) => {
    let session: ManagedSession | undefined;
    const panes = rows.flatMap((row) => {
      const fields = row.split("\t");
      const [
        paneId,
        sessionId,
        name,
        metadata,
        pid,
        dead,
        ,
        ,
        id,
        temporary,
        cwd,
        launch,
        role,
        right,
        state,
        owner,
        blocker,
      ] = fields;
      if (
        fields.length !== 17 ||
        !/^%\d+$/.test(paneId ?? "") ||
        !sessionId ||
        name !== peer.name ||
        !["0", "1"].includes(dead ?? "") ||
        (id && (!SESSION_ID_PATTERN.test(id) || !isAbsolute(cwd ?? ""))) ||
        (temporary && temporary !== id)
      )
        throw new Error(`Invalid Windows pi-mux lifecycle inventory in ${peer.name}`);
      if (id) {
        const candidate = { id, cwd: cwd!, session: sessionId, temporary: Boolean(temporary) };
        if (session && JSON.stringify(session) !== JSON.stringify(candidate))
          throw new Error(`Conflicting Windows conversation ownership in ${peer.name}`);
        session = candidate;
      }
      if (dead !== "0") return [];
      if (!/^[1-9]\d*$/.test(pid ?? ""))
        throw new Error(`Cannot identify a live pane process in ${peer.name}`);
      pids.push(Number(pid));
      const [pane] = metadata ? parseLivePaneRows(fields.slice(0, 8).join("\t"), "list") : [];
      if (metadata) {
        if (!pane || (mode !== "reload" && activeIds.has(pane.id.toLowerCase())))
          throw new Error(`Cannot uniquely identify Windows pi in ${peer.name}`);
        activeIds.add(pane.id.toLowerCase());
        pids.push(pane.pid);
      }
      return [
        {
          peer,
          paneId: paneId!,
          panePid: Number(pid),
          pi: pane,
          launch,
          role,
          right,
          state,
          owner,
          blocker,
        },
      ];
    });
    if (session) {
      managed.push(session);
      ownership.push({ peer, session });
    }
    const managedId = session?.id;
    const unresolved = managedId !== undefined && !panes.some(({ pi }) => pi?.id === managedId);
    const dispatchUnpublished =
      panes.some(({ role }) => role === "pi") && !panes.some(({ pi }) => pi);
    return panes.map((pane) => ({ ...pane, unresolved: unresolved || dispatchUnpublished }));
  });
  if (
    mode !== "reload" &&
    new Set(managed.map(({ id }) => id.toLowerCase())).size !== managed.length
  )
    throw new Error("Multiple Windows psmux sessions own the same conversation");
  return { ...audit, startup: audit.startup, managed, ownership, pids, entries };
}

export type WindowsLifecycleAudit = Awaited<ReturnType<typeof auditWindowsLifecycle>>;

export type WindowsLifecycleEntry = WindowsLifecycleAudit["entries"][number];

export type WindowsLifecyclePeer = PsmuxPeer;

export function windowsPaneIsWaiting(config: TmuxConfig, entry: WindowsLifecycleEntry): boolean {
  const { pi, peer, paneId, launch, state, owner, blocker } = entry;
  if (!pi || pi.startup === "accepted" || blocker || !owner) return false;
  if (parseSessionState(state, pi.id) !== "waiting-user") return false;
  try {
    const raw: unknown = JSON.parse(owner);
    if (!isRecord(raw) || raw.id !== pi.id) return false;
    const source = parseSource(raw);
    const metadata = JSON.parse(Buffer.from(pi.metadata, "base64").toString("utf8"));
    return (
      source.socket === config.socket &&
      String(source.serverPid) === peer.identity.split(":")[0] &&
      source.pane === paneId &&
      source.pid === pi.pid &&
      source.token === metadata.token &&
      (!launch || matchesLaunch(launch, pi.id, pi.panePid, source.token))
    );
  } catch {
    return false;
  }
}

function windowsRestartIsWaiting(config: TmuxConfig, audit: WindowsLifecycleAudit): boolean {
  return audit.entries.every((entry) =>
    entry.pi
      ? windowsPaneIsWaiting(config, entry)
      : !entry.unresolved && !entry.launch && !entry.right,
  );
}

function windowsStopInventory(audit: WindowsLifecycleAudit): string {
  const identities = audit.entries.map(({ peer, paneId, panePid, pi, launch, right }) =>
    JSON.stringify([peer.identity, paneId, panePid, pi?.id, pi?.pid, pi?.metadata, launch, right]),
  );
  return JSON.stringify([audit.basis.witnesses, identities.sort(), audit.managed]);
}

const WINDOWS_RESTART_RECHECK = Symbol("Windows restart needs a new readiness check");

type ServerOperation = Extract<Operation, { kind: "stop" | "restart" }>;

async function windowsServerLifecycle(config: Config, operation: ServerOperation): Promise<number> {
  const management = windowsManagement(config);
  const original = await withLock(config, () => management.currentBasis());
  while (true) {
    const result = await withLock(config, async () => {
      if (!original && operation.kind === "stop") {
        if (await management.currentBasis())
          throw new Error("Dedicated psmux generation changed during stop");
        return 0;
      }
      const force = operation.kind === "restart" && operation.force;
      if (!(await tryStopWindowsServer(config, management, original, force))) return undefined;
      if (operation.kind === "stop") return 0;
      prepareDirectory(config.directory);
      return (await startAndRestore(config, true, undefined, "fresh")).failures > 0 ? 2 : 0;
    });
    if (result !== undefined) return result;
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

async function tryStopWindowsServer(
  config: Config,
  management: WindowsManagement,
  original: WindowsManagementBasis | undefined,
  force: boolean,
): Promise<boolean> {
  const previous = readSnapshot(config);
  const rights = management.createLaunchRights(windowsClaimLock(management));
  if (original) {
    const audit = await auditWindowsLifecycle(management);
    if (!launchBasisStillLive(original, audit.basis))
      throw new Error("Dedicated psmux generation changed during restart");
    if (previous?.generation && previous.generation !== original.instance)
      throw new Error("Snapshot belongs to another psmux generation");
    if (!force && !windowsRestartIsWaiting(config, audit)) return false;

    const panes = captureWindowsProcesses(audit.pids);
    const activeLaunches = await rights.fenceForRestart(true);
    const hasUnmatchedLaunch = activeLaunches.some(({ child, token, basis, completed, keys }) => {
      if (
        panes.some(
          ({ pid, creationTime }) => pid === child.pid && creationTime === child.creationTime,
        )
      )
        return false;
      if (!completed || basis.instance !== audit.basis.instance) return true;
      const matchingPanes = audit.entries.filter((entry) => entry.right === token);
      const pi = matchingPanes[0]?.pi;
      return matchingPanes.length !== 1 || !pi || !keys.includes(conversationLaunchKey(pi.id));
    });
    if (!force && (panes.length !== new Set(audit.pids).size || hasUnmatchedLaunch)) return false;

    await management.assertLive(audit.basis);
    const excluded = new Set(
      audit.managed.filter(({ temporary }) => temporary).map(({ id }) => id.toLowerCase()),
    );
    const restoring = new Set(audit.startup.restoring);
    const candidates = uniqueCandidates([
      ...(previous?.sessions ?? []).filter(
        ({ id }) => restoring.has(id.toLowerCase()) && !excluded.has(id.toLowerCase()),
      ),
      ...audit.managed.filter(({ temporary }) => !temporary).map(({ id, cwd }) => ({ id, cwd })),
    ]);
    try {
      const peers = await stopWindowsPeers(management.scope, audit, undefined, async () => {
        if (force) {
          const current = await management.currentBasis();
          if (
            current?.instance !== audit.basis.instance ||
            JSON.stringify(current.witnesses) !== JSON.stringify(audit.basis.witnesses)
          )
            throw new Error("Dedicated psmux peers changed before restart stop");
          await management.prepareStartup(
            audit.basis,
            candidates.map(({ id }) => id),
            windowsClaimLock(management),
          );
        } else {
          const final = await auditWindowsLifecycle(management);
          if (!launchBasisStillLive(audit.basis, final.basis))
            throw new Error("Dedicated psmux generation changed before restart stop");
          if (
            windowsStopInventory(final) !== windowsStopInventory(audit) ||
            JSON.stringify(captureWindowsProcesses(final.pids)) !== JSON.stringify(panes) ||
            !windowsRestartIsWaiting(config, final)
          )
            throw WINDOWS_RESTART_RECHECK;
        }
        writeSnapshot(config, {
          version: 1,
          generation: original.instance,
          cwds: previous?.cwds ?? [],
          sessions: candidates,
        });
      });
      await waitForWindowsExit([...panes, ...activeLaunches.map(({ child }) => child), ...peers], {
        timeoutMs: STARTUP_TIMEOUT_MS,
        pollMs: POLL_INTERVAL_MS,
      });
    } catch (error) {
      if (error === WINDOWS_RESTART_RECHECK) return false;
      throw error;
    }
  } else {
    if (await management.currentBasis())
      throw new Error("Dedicated psmux generation changed during restart");
    await rights.fenceForRestart(false);
  }
  if (await management.currentBasis())
    throw new Error("Dedicated psmux did not remain stopped during restart");
  return true;
}

export async function serverLifecycle(config: Config, operation: ServerOperation): Promise<number> {
  if (platform.windows) return await windowsServerLifecycle(config, operation);
  const original = await withLock(config, () => serverLifetime(config));
  const force = operation.kind === "restart" && operation.force;
  while (true) {
    const result = await withLock(config, async () => {
      if (!original) {
        if (await serverLifetime(config))
          throw new Error(`Dedicated server changed during ${operation.kind}`);
        if (operation.kind === "stop") return 0;
        prepareDirectory(config.directory);
        return (await startAndRestore(config, true)).failures > 0 ? 2 : 0;
      }
      await verifyServerLifetime(config, original, operation.kind);
      readSnapshot(config);
      if (!force && !(await restartIsWaiting(config))) return undefined;
      const panes = await livePanes(config, "list");
      const initializing = await initializingPanes(config, await managedSessions(config), panes);
      uniqueCandidates(panes);
      if (new Set(panes.map((pane) => pane.id)).size !== panes.length)
        throw new Error("Multiple pi processes match a restart conversation ID");
      if (!original.generation)
        throw new Error("Dedicated server has not been initialized by pi-mux");
      await tmux(config, ["set-option", "-g", "@pi-mux-restart-veto", ""]);
      await snapshotSessions(config, original.generation, "repair");
      const saved = readSnapshot(config);
      if (!saved || saved.generation !== original.generation)
        throw new Error("Cannot confirm restart snapshot");
      await setRestoringSessions(config, saved.sessions);
      await verifyServerLifetime(config, original, operation.kind);
      if (!force && !(await restartIsWaiting(config))) return undefined;
      const stopScript = [
        tmuxArguments([
          "if-shell",
          "-F",
          `#{==:#{@pi-mux-generation},${original.generation}}`,
          force
            ? tmuxArguments(["kill-server"])
            : tmuxArguments([
                "if-shell",
                "-F",
                "#{==:#{@pi-mux-restart-veto},}",
                waitingUserStopChain(
                  panes.map((pane) => pane.pane),
                  "kill-server",
                  "PI_MUX_STOP_CHECKED",
                ),
                tmuxArguments(["display-message", "-p", "PI_MUX_STOP_CHECKED"]),
              ]),
          tmuxArguments(["display-message", "-p", "PI_MUX_RESTART_SERVER_CHANGED"]),
        ]),
      ].join("\n");
      const stopped = await tmux(config, ["source-file", "-"], false, `${stopScript}\n`);
      if (stopped.stdout.includes("PI_MUX_RESTART_SERVER_CHANGED"))
        throw new Error(
          operation.kind === "stop"
            ? "Dedicated server changed before stop"
            : "Dedicated server changed before restart stop",
        );
      if (stopped.stdout.includes("PI_MUX_STOP_CHECKED")) return undefined;
      const targets = [...panes, ...initializing].map((pane) => ({ pid: pane.pid }));
      for (const target of targets) {
        if (!platform.processIsAlive(target.pid)) continue;
        try {
          process.kill(target.pid, "SIGTERM");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      const deadline = Date.now() + STARTUP_TIMEOUT_MS;
      while (targets.some((target) => platform.processIsAlive(target.pid))) {
        if (Date.now() >= deadline)
          throw new Error(`Timed out waiting for pi to exit during ${operation.kind}`);
        await Bun.sleep(POLL_INTERVAL_MS);
      }
      if (await serverLifetime(config))
        throw new Error(`Dedicated server did not remain stopped during ${operation.kind}`);
      if (operation.kind === "stop") return 0;
      prepareDirectory(config.directory);
      return (await startAndRestore(config, true)).failures > 0 ? 2 : 0;
    });
    if (result !== undefined) return result;
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}
