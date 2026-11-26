import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { TmuxConfig } from "./configuration";
import { type LastRun, readSessionLastRun } from "./history-summary";
import { LockBusyError, withLock } from "./locks";
import {
  isTemporarySession,
  launchRecordToken,
  matchesLaunch,
  promoteSession,
} from "./pane-inventory";
import { clearStateOptions, type StateNotification, type StateSource } from "./pane-state";
import { platform } from "./platform";
import { snapshotSessions } from "./restoration";
import { errorMessage, isRecord } from "./session-model";
import {
  guardedTmuxLine,
  paneEntityGuard,
  serverLifetime,
  serverOption,
  tmux,
  windowsManagement,
} from "./mux";
import { mutateWindowsPeerPane } from "./windows/windows-lifecycle";
import type { WindowsManagement } from "./windows/windows-management";
import { inspectWindowsProcess } from "./windows/windows-process";

type StartupTarget = {
  panePid: number;
  metadata: Record<string, unknown>;
  encoded: string;
  launch: string;
};

export async function notifyStartupInputDrained(
  config: TmuxConfig,
  id: string,
  source: StateSource,
): Promise<void> {
  if (source.socket !== config.socket)
    throw new Error("Source socket does not match the dedicated socket");

  if (platform.windows) {
    const management = windowsManagement(config);
    const target = await verifyWindowsStateSource(management, id, source);
    const drained = drainedStartupMetadata(target, id, source);
    const outcome = await mutateWindowsPeerPane(
      management.scope,
      target.audit,
      target.peer,
      source.pane,
      {
        expected: windowsSourceExpectations(target),
        mutations:
          drained === target.encoded ? [] : [{ option: "@pi-tmux-session", value: drained }],
        processes: target.processes,
      },
    );
    if (outcome !== "applied") throw new Error("Cannot confirm guarded startup input notification");
    return;
  }

  const server = await serverLifetime(config);
  if (!server || server.pid !== source.serverPid)
    throw new Error("Source server lifetime no longer matches");
  const target = await verifyStateTarget(config, id, source);
  const drained = drainedStartupMetadata(target, id, source);
  if (
    !platform.processIsAlive(target.panePid) ||
    !platform.processIsAlive(source.pid) ||
    !platform.processDescendsFrom(source.pid, target.panePid)
  )
    throw new Error("Source Pi process is not live in the pane");

  const { pane } = source;
  const guard = [
    paneEntityGuard(server.pid, pane, target.panePid),
    "#{==:#{pane_dead},0}",
    formatEquals("@pi-mux-generation", server.generation),
    formatEquals("@pi-mux-launch", target.launch),
    formatEquals("@pi-tmux-session", target.encoded),
  ].reduce((left, right) => `#{&&:${left},${right}}`);
  const readback = ["show-options", "-pqv", "-t", pane, "@pi-tmux-session"];
  const commands =
    drained === target.encoded
      ? [readback]
      : [["set-option", "-p", "-t", pane, "@pi-tmux-session", drained], readback];
  const update = guardedTmuxLine(pane, guard, commands);
  const result = await tmux(config, ["source-file", "-"], false, `${update}\n`);
  if (result.stdout.replace(/\n$/, "") !== drained)
    throw new Error("Cannot confirm guarded startup input notification");
}

function drainedStartupMetadata(target: StartupTarget, id: string, source: StateSource): string {
  const { panePid, metadata, encoded, launch } = target;
  const pid = metadata.processPid === undefined ? panePid : metadata.processPid;
  if (
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ||
    !Number.isSafeInteger(panePid) ||
    panePid <= 0 ||
    metadata.id !== id ||
    metadata.pid !== panePid ||
    pid !== source.pid ||
    metadata.token !== source.token ||
    (launch && !matchesLaunch(launch, id, panePid, source.token))
  )
    throw new Error("Source Pi process does not match the startup metadata and launch");

  if (metadata.reloadReadiness === "drained") return encoded;
  if (metadata.reloadReadiness !== "pending")
    throw new Error("Source Pi process has not published pending reload readiness");
  return encodeDrainedStartupMetadata(metadata);
}

function encodeDrainedStartupMetadata(metadata: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ ...metadata, reloadReadiness: "drained" })).toString(
    "base64",
  );
}

function formatEquals(field: string, literal: string): string {
  return `#{==:#{${field}},${literal.replace(/[#,}]/g, "#$&")}}`;
}

function windowsSourceExpectations({ panePid, encoded, launch }: StartupTarget) {
  return [
    ["pane_pid", String(panePid)],
    ["@pi-tmux-session", encoded],
    ["@pi-mux-launch", launch],
  ] as const;
}

async function verifyStateSource(
  config: TmuxConfig,
  id: string,
  source: StateSource,
): Promise<{ session: string; panePid: number; file?: string }> {
  if (source.socket !== config.socket)
    throw new Error("Source socket does not match the dedicated socket");
  const server = await tmux(config, [
    "display-message",
    "-p",
    "-t",
    source.pane,
    "#{pid}:#{pane_id}",
  ]);
  const [serverPid, paneId] = server.stdout.trimEnd().split(":");
  if (Number(serverPid) !== source.serverPid || paneId !== source.pane)
    throw new Error("Source server or pane lifetime no longer matches");
  const session = (
    await tmux(config, ["display-message", "-p", "-t", source.pane, "#{session_id}"])
  ).stdout.trimEnd();
  if (!/^\$\d+$/.test(session)) throw new Error("Source server or pane lifetime no longer matches");
  const target = await verifyStateTarget(config, id, source);
  return { session, panePid: target.panePid, file: target.file };
}

async function deferUnfinishedPublish(
  config: TmuxConfig,
  id: string,
  source: StateSource,
  panePid: number,
): Promise<void> {
  const attemptAt = Date.now();
  const pending = guardedTmuxLine(
    source.pane,
    paneEntityGuard(source.serverPid, source.pane, panePid),
    [
      ["set-option", "-p", "-t", source.pane, "@pi-mux-pending-restart-blocker", "1"],
      ["set-option", "-g", "@pi-mux-restart-veto", randomUUID()],
      [
        "set-option",
        "-p",
        "-t",
        source.pane,
        "@pi_session_state_pending",
        JSON.stringify({ version: 1, sessionId: id, attemptAt }),
      ],
    ],
  );
  await tmux(config, ["source-file", "-"], false, `${pending}\n`);
}

async function clearPendingPublication(
  config: TmuxConfig,
  source: StateSource,
  panePid: number,
): Promise<void> {
  const clear = guardedTmuxLine(
    source.pane,
    paneEntityGuard(source.serverPid, source.pane, panePid),
    [["set-option", "-pu", "-t", source.pane, "@pi_session_state_pending"]],
  );
  await tmux(config, ["source-file", "-"], false, `${clear}\n`);
}

async function notifyWindowsState(
  config: TmuxConfig,
  id: string,
  source: StateSource,
  notification: StateNotification,
): Promise<number> {
  if (source.socket !== config.socket)
    throw new Error("Source socket does not match the dedicated socket");
  const management = windowsManagement(config);
  const observe = () => verifyWindowsStateSource(management, id, source);
  const initial = await observe();
  const lastRun =
    !notification.clear && notification.state === "waiting-user" && initial.file
      ? readSessionLastRun(initial.file, id)
      : undefined;
  const target = lastRun ? await observe() : initial;
  if (
    target.audit.basis.instance !== initial.audit.basis.instance ||
    target.peer.identity !== initial.peer.identity ||
    target.panePid !== initial.panePid ||
    target.processes.some(
      (process, index) => process.creationTime !== initial.processes[index]?.creationTime,
    )
  )
    throw new Error("Source Pi process changed during state verification");

  const ownState = ["@pi-mux-state-source", windowsStateJson({ id, ...source })] as const;
  const mutate = (
    observed: WindowsStateTarget,
    mutations: Parameters<typeof mutateWindowsPeerPane>[4]["mutations"],
    owner?: typeof ownState,
    expected: Parameters<typeof mutateWindowsPeerPane>[4]["expected"] = [],
  ) =>
    mutateWindowsPeerPane(management.scope, observed.audit, observed.peer, source.pane, {
      expected: [...windowsSourceExpectations(observed), ...expected],
      owner,
      mutations,
      processes: observed.processes,
    });

  if (notification.clear) {
    await mutate(
      target,
      clearStateOptions(source.pane).map((args) => ({ option: args.at(-1)! })),
      ownState,
    );
    return 0;
  }

  const publication: Parameters<typeof mutate>[1] = [
    { option: ownState[0], value: ownState[1] },
    {
      option: "@pi_session_state",
      value: windowsStateJson({
        version: 1,
        sessionId: id,
        state: notification.state,
        title: notification.title,
        lastRun: target.file === initial.file ? lastRun : undefined,
      }),
    },
    { option: "@pi-mux-pending-restart-blocker" },
  ];
  if (notification.state !== "running") {
    await mutate(target, publication);
    return 0;
  }

  let currentTarget = target;
  async function refreshTarget(): Promise<WindowsStateTarget> {
    const current = await observe();
    assertWindowsStateContinuity(currentTarget, current);
    return current;
  }

  async function mutateWithAckRetry(
    mutations: Parameters<typeof mutate>[1],
    owner?: typeof ownState,
    expected?: Parameters<typeof mutate>[3],
  ) {
    try {
      return await mutate(currentTarget, mutations, owner, expected);
    } catch (error) {
      if (currentTarget.metadata.reloadReadiness !== "pending") throw error;
      const current = await refreshTarget();
      if (
        current.encoded === currentTarget.encoded ||
        current.temporary !== currentTarget.temporary
      )
        throw error;
      currentTarget = current;
      return await mutate(currentTarget, mutations, owner, expected);
    }
  }

  async function mutateOwned(
    mutations: Parameters<typeof mutate>[1],
    expected?: Parameters<typeof mutate>[3],
  ) {
    if ((await mutateWithAckRetry(mutations, ownState, expected)) !== "applied")
      throw new Error("Source no longer owns the published session state");
  }

  await mutateWithAckRetry(publication);
  if (!target.temporary && !target.audit.startup) return 0;

  try {
    return await withLock(
      config,
      async () => {
        if (target.temporary) {
          currentTarget = await refreshTarget();
          if (currentTarget.temporary) {
            await mutateOwned([{ unsetTemporary: true }], [["PI_TMUX_TEMPORARY", id]]);
            currentTarget = { ...currentTarget, temporary: false };
          }
        }
        await management.assertLive(currentTarget.audit.basis);
        await snapshotSessions(config, currentTarget.audit.basis.instance, "repair");
        await mutateOwned([{ option: "@pi_session_state_pending" }]);
        return 0;
      },
      "try",
    );
  } catch (error) {
    if (!(error instanceof LockBusyError)) throw error;
    await mutateOwned([
      { option: "@pi-mux-pending-restart-blocker", value: "1" },
      { option: "@pi-mux-restart-veto", value: randomUUID(), global: true },
      {
        option: "@pi_session_state_pending",
        value: windowsStateJson({ version: 1, sessionId: id, attemptAt: Date.now() }),
      },
    ]);
    console.error(`pi-mux: state ${id}: ${errorMessage(error)}`);
    return 75;
  }
}

type WindowsStateTarget = Awaited<ReturnType<typeof verifyWindowsStateSource>>;

function assertWindowsStateContinuity(
  previous: WindowsStateTarget,
  current: WindowsStateTarget,
): void {
  const sameMetadata =
    previous.encoded === current.encoded ||
    (previous.metadata.reloadReadiness === "pending" &&
      current.encoded === encodeDrainedStartupMetadata(previous.metadata));
  if (
    !sameMetadata ||
    current.launch !== previous.launch ||
    current.audit.basis.instance !== previous.audit.basis.instance ||
    current.peer.identity !== previous.peer.identity ||
    current.peer.name !== previous.peer.name ||
    current.peer.port !== previous.peer.port ||
    current.peer.held !== previous.peer.held ||
    current.pane !== previous.pane ||
    current.panePid !== previous.panePid ||
    current.processes.length !== previous.processes.length ||
    current.processes.some(
      (process, index) =>
        process.pid !== previous.processes[index]?.pid ||
        process.creationTime !== previous.processes[index]?.creationTime,
    )
  )
    throw new Error("Source pane changed before running state update");
}

function windowsStateJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("$", "\\u0024").replaceAll("\x7f", "\\u007f");
}

async function verifyWindowsStateSource(
  management: WindowsManagement,
  id: string,
  source: StateSource,
) {
  const audit = await management.audit(
    "#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{@pi-tmux-session}\t#{@pi-mux-launch}\t#{PI_TMUX_TEMPORARY}",
    { requireRestored: false },
  );
  const matches = audit.panes.flatMap(({ peer, rows }) =>
    rows.flatMap((row) => {
      const fields = row.split("\t");
      const [pane, rawPid, dead, encoded, launch, temporary] = fields;
      if (fields.length !== 6 || !/^%\d+$/.test(pane ?? "") || (dead !== "0" && dead !== "1"))
        throw new Error(`Invalid psmux pane inventory for state: ${peer.name}`);
      if (dead === "1" || !encoded) return [];
      if (!/^[1-9]\d*$/.test(rawPid ?? ""))
        throw new Error(`Invalid live psmux pane PID for state: ${peer.name}`);
      const metadata: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      if (!isRecord(metadata)) throw new Error(`Invalid Pi metadata in pane ${pane}`);
      if (metadata.id !== id) return [];
      return [
        { peer, pane, panePid: Number(rawPid), encoded, launch: launch!, temporary, metadata },
      ];
    }),
  );
  const match = matches[0];
  if (
    matches.length !== 1 ||
    !match ||
    match.peer.identity.split(":")[0] !== String(source.serverPid) ||
    match.pane !== source.pane ||
    match.metadata.pid !== match.panePid ||
    (match.metadata.processPid ?? match.panePid) !== source.pid ||
    match.metadata.token !== source.token ||
    (match.launch && !matchesLaunch(match.launch, id, match.panePid, source.token)) ||
    (match.metadata.startup !== undefined &&
      match.metadata.startup !== "accepted" &&
      match.metadata.startup !== "ready")
  )
    throw new Error("Source Pi process does not match the conversation and pane");
  const processes = [...new Set([match.panePid, source.pid])].map((pid) => {
    const process = inspectWindowsProcess(pid);
    if (process.state !== "live") throw new Error(`Cannot verify source Windows process ${pid}`);
    return process.identity;
  });
  const { file } = match.metadata;
  return {
    ...match,
    audit,
    processes,
    temporary: match.temporary === id,
    file: typeof file === "string" && isAbsolute(file) ? file : undefined,
  };
}

export async function notifyState(
  config: TmuxConfig,
  id: string,
  source: StateSource,
  notification: StateNotification,
): Promise<number> {
  if (platform.windows) return await notifyWindowsState(config, id, source, notification);
  const { session, panePid, file } = await verifyStateSource(config, id, source);
  const owner = JSON.stringify({ id, ...source });
  if (notification.clear) {
    const currentOwner = await tmux(config, [
      "show-options",
      "-pqv",
      "-t",
      source.pane,
      "@pi-mux-state-source",
    ]);
    if (currentOwner.stdout.trimEnd() !== owner) return 0;
  }
  const lastRun =
    !notification.clear && notification.state === "waiting-user" && file
      ? readSessionLastRun(file, id)
      : undefined;
  await runGuardedStateCommands(config, source, {
    id,
    owner,
    notification,
    panePid,
    file,
    lastRun,
  });
  if (notification.clear || notification.state !== "running") return 0;
  const needsPromotion = await isTemporarySession(config, session, id);
  const needsRepair = Boolean(await serverOption(config, "@pi-mux-generation"));
  if (!needsPromotion && !needsRepair) return 0;
  try {
    return await withLock(
      config,
      async () => {
        if (needsPromotion) await promoteSession(config, session, id);
        if (needsRepair) await snapshotSessions(config, undefined, "repair");
        await clearPendingPublication(config, source, panePid);
        return 0;
      },
      "try",
    );
  } catch (error) {
    if (!(error instanceof LockBusyError)) throw error;
    try {
      await deferUnfinishedPublish(config, id, source, panePid);
    } catch (deferredError) {
      console.error(`pi-mux: state ${id}: ${errorMessage(deferredError)}`);
    }
    console.error(`pi-mux: state ${id}: ${errorMessage(error)}`);
    return 75;
  }
}

async function verifyStateTarget(config: TmuxConfig, id: string, source: StateSource) {
  const result = await tmux(config, [
    "list-panes",
    "-a",
    "-F",
    "#{pane_id}|#{@pi-tmux-session}|#{pane_pid}|#{pane_dead}|#{@pi-mux-launch}",
  ]);
  const matching = result.stdout
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [pane, encoded, panePid, dead, ...launchFields] = line.split("|");
      if (dead !== "0" || !pane || !encoded) return [];
      const launch = launchFields.join("|");
      let metadata: Record<string, unknown>;
      try {
        metadata = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      } catch {
        throw new Error(`Invalid pi session metadata in pane ${pane}`);
      }
      if (
        metadata.id !== id ||
        (metadata.startup !== "accepted" &&
          metadata.startup !== "ready" &&
          metadata.startup !== undefined) ||
        !panePid ||
        !/^[1-9]\d*$/.test(panePid)
      )
        return [];
      const pid = typeof metadata.processPid === "number" ? metadata.processPid : Number(panePid);
      if (!Number.isSafeInteger(pid) || pid <= 0) return [];
      const token = launchRecordToken(launch) ?? metadata.token;
      const file =
        typeof metadata.file === "string" && isAbsolute(metadata.file) ? metadata.file : undefined;
      return [{ pane, pid, panePid: Number(panePid), token, file, metadata, encoded, launch }];
    });
  if (
    matching.length !== 1 ||
    matching[0]!.pane !== source.pane ||
    matching[0]!.pid !== source.pid ||
    matching[0]!.token !== source.token
  )
    throw new Error("Source Pi process does not match the conversation and pane");
  return matching[0]!;
}

async function runGuardedStateCommands(
  config: TmuxConfig,
  source: StateSource,
  plan: {
    id: string;
    owner: string;
    notification: StateNotification;
    panePid: number;
    file?: string;
    lastRun?: LastRun;
  },
): Promise<void> {
  const verified = await verifyStateSource(config, plan.id, source);
  const entity = paneEntityGuard(source.serverPid, source.pane, plan.panePid);
  const pane = source.pane;
  const lines: string[] = [];
  if (plan.notification.clear) {
    lines.push(
      guardedTmuxLine(
        pane,
        entity,
        [...clearStateOptions(pane), ["display-message", "-p", "PI_MUX_STATE_WRITTEN"]],
        "PI_MUX_SOURCE_UNVERIFIED",
      ),
    );
  } else {
    const stateValue = JSON.stringify({
      version: 1,
      sessionId: plan.id,
      state: plan.notification.state,
      title: plan.notification.title,
      lastRun: verified.file === plan.file ? plan.lastRun : undefined,
    });
    lines.push(
      guardedTmuxLine(
        pane,
        entity,
        [
          ["set-option", "-p", "-t", pane, "@pi-mux-state-source", plan.owner],
          ["set-option", "-p", "-t", pane, "@pi_session_state", stateValue],
          ["set-option", "-pu", "-t", pane, "@pi-mux-pending-restart-blocker"],
          ["display-message", "-p", "PI_MUX_STATE_WRITTEN"],
        ],
        "PI_MUX_SOURCE_UNVERIFIED",
      ),
    );
  }
  const result = await tmux(config, ["source-file", "-"], false, `${lines.join("\n")}\n`);
  const markers = result.stdout.trim().split("\n").filter(Boolean);
  if (markers.includes("PI_MUX_SOURCE_UNVERIFIED"))
    throw new Error("Cannot verify source for session state update");
  if (markers.includes("PI_MUX_STATE_WRITTEN")) return;
  throw new Error("Cannot confirm session state update");
}
