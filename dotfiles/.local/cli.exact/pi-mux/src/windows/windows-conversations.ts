import { existsSync } from "node:fs";
import type { TmuxConfig } from "../configuration";
import { windowsClaimLock } from "../locks";
import { launchRecordToken, matchesLaunch } from "../pane-inventory";
import { readSnapshot } from "../restore-state";
import {
  auditWindowsLifecycle,
  type WindowsLifecycleAudit,
  type WindowsLifecycleEntry,
} from "../server-lifecycle";
import { type Pane, POLL_INTERVAL_MS, STARTUP_TIMEOUT_MS, UUID } from "../session-model";
import { windowsManagement } from "../mux";
import { WINDOWS_RIGHT_ENV, WINDOWS_RIGHT_OPTION } from "./windows-launch";
import {
  conversationLaunchKey,
  launchBasisStillLive,
  type WindowsManagementBasis,
} from "./windows-launch-rights";
import {
  captureWindowsProcesses,
  mutateWindowsPeerPane,
  readWindowsPeerPaneFields,
  runWindowsPeerPaneCommands,
  stopWindowsPeerPane,
  waitForWindowsExit,
} from "./windows-lifecycle";
import type { WindowsManagement } from "./windows-management";
import { assertWindowsPaneAncestor, terminateWindowsProcess } from "./windows-process";

export async function findWindowsWarmPane(
  config: TmuxConfig,
  cwd: string,
  basis: WindowsManagementBasis,
): Promise<Pane | undefined> {
  const management = windowsManagement(config);
  const audit = await auditWindowsLifecycle(management, "conversation");
  if (!launchBasisStillLive(basis, audit.basis))
    throw new Error("The dedicated psmux management generation changed before warm reuse");
  for (const entry of audit.entries) {
    const { pi, observedId, observedCwd, launch } = entry;
    if (!pi?.warm || pi.cwd !== cwd || pi.startup !== "ready" || existsSync(pi.file)) continue;
    if (observedId !== pi.id || observedCwd !== cwd || !launch || !paneMatchesLaunch(entry, pi.id))
      continue;
    await windowsLaunchProcess(management, audit, entry, pi.id);
    if ((await windowsPaneStillMatches(management, audit, entry)) && !existsSync(pi.file))
      return pi;
  }
}

export async function closeWindowsPane(
  config: TmuxConfig,
  id: string,
  ifTemporary: boolean,
): Promise<boolean> {
  const management = windowsManagement(config);
  const basis = await management.currentBasis();
  const audit = basis && (await auditWindowsLifecycle(management, "conversation"));
  if (basis && audit && !launchBasisStillLive(basis, audit.basis))
    throw new Error("The dedicated psmux management generation changed before close");
  const target = audit && selectCloseTarget(audit, id);
  if (!audit || !target) {
    if (ifTemporary) return false;
    const snapshot = readSnapshot(config);
    if (audit && snapshot?.sessions.some((session) => session.id === id))
      await clearWindowsRestoreMark(management, audit, id, snapshot.sessions);
    return true;
  }
  const pi = await windowsLaunchProcess(management, audit, target, id);
  if (ifTemporary && !target.temporary) return false;
  const snapshot = readSnapshot(config);
  const [pane] = captureWindowsProcesses([target.panePid]);
  if (!pane) throw new Error(`Cannot verify Windows pane process ${target.panePid}`);
  const keepShell = Boolean(target.pi && !target.right && pane.pid !== pi.pid);
  if (keepShell) await assertWindowsPaneAncestor(pi, pane);
  if (!(await windowsPaneStillMatches(management, audit, target)))
    throw new Error(`Windows pane changed before close: ${target.peer.name} ${target.paneId}`);
  const processes = keepShell || pane.pid === pi.pid ? [pi] : [pane, pi];
  if (keepShell) terminateWindowsProcess(pi);
  else
    await stopWindowsPeerPane(
      management.scope,
      audit,
      target.peer,
      target.paneId,
      expectedPaneFields(target),
      processes,
    );
  await waitForWindowsExit(processes, { timeoutMs: STARTUP_TIMEOUT_MS, pollMs: POLL_INTERVAL_MS });
  if (keepShell && (await windowsPaneStillMatches(management, audit, target))) {
    await mutateWindowsPeerPane(management.scope, audit, target.peer, target.paneId, {
      expected: expectedPaneFields(target),
      mutations: [{ option: "@pi-tmux-session" }, { option: "@pi-mux-launch" }],
      processes: [pane],
    });
  }
  const current = await confirmClosedWindowsPane(management, audit, target, id);
  if (current) await clearWindowsRestoreMark(management, current, id, snapshot?.sessions ?? []);
  return true;
}

async function clearWindowsRestoreMark(
  management: WindowsManagement,
  audit: WindowsLifecycleAudit,
  id: string,
  saved: readonly { id: string }[],
): Promise<void> {
  const key = id.toLowerCase();
  if (!audit.startup.restoring.includes(key)) return;
  const otherIds = [
    ...saved.map((entry) => entry.id),
    ...audit.managed.map((entry) => entry.id),
    ...audit.entries.flatMap((entry) => (entry.pi ? [entry.pi.id] : [])),
  ];
  if (!otherIds.some((other) => other !== id && other.toLowerCase() === key))
    await management.clearRestoring(audit.basis, id, windowsClaimLock(management));
}

async function confirmClosedWindowsPane(
  management: WindowsManagement,
  before: WindowsLifecycleAudit,
  target: WindowsLifecycleEntry,
  id: string,
) {
  if (!(await management.currentBasis())) return;
  const current = await auditWindowsLifecycle(management, "conversation");
  if (!launchBasisStillLive(before.basis, current.basis))
    throw new Error("The dedicated psmux management generation changed during close");
  if (current.entries.some((entry) => entry.pi?.id === id || paneMatchesLaunch(entry, id)))
    throw new Error("Windows pi is still running after close");
  const remaining = current.ownership.filter(({ session }) => session.id === id);
  if (remaining.some(({ peer }) => peer.identity !== target.peer.identity))
    throw new Error("Windows conversation ownership changed during close");
  const [owner] = remaining;
  if (!owner) return current;
  const ownerMatches = `#{==:#{PI_TMUX_SESSION_ID},#{l:${id}}}`;
  function unsetMarker(name: string, expectedTemporary: string) {
    return [
      "if-shell",
      "-F",
      `#{&&:${ownerMatches},#{==:#{PI_TMUX_TEMPORARY},#{l:${expectedTemporary}}}}`,
      `set-environment -u ${name}`,
      "display-message -p PI_MUX_CLOSE_REFUSED",
    ];
  }
  const response = await runWindowsPeerPaneCommands(
    management.scope,
    current,
    owner.peer,
    target.paneId,
    [
      ...(target.temporary ? [unsetMarker("PI_TMUX_TEMPORARY", id)] : []),
      unsetMarker("PI_TMUX_SESSION_ID", ""),
      ["display-message", "-p", "PI_MUX_CLOSE_OWNER=#{PI_TMUX_SESSION_ID}:#{PI_TMUX_TEMPORARY}"],
    ],
  );
  if (
    !response.split("\n").includes("PI_MUX_CLOSE_OWNER=:") ||
    response.includes("PI_MUX_CLOSE_REFUSED")
  )
    throw new Error(`Cannot clear Windows conversation ownership in ${owner.peer.name}`);
  return current;
}

function selectCloseTarget(audit: WindowsLifecycleAudit, id: string) {
  const owners = audit.entries.filter(
    (entry) => entry.pi?.id === id || entry.observedId === id || paneMatchesLaunch(entry, id),
  );
  const targets = owners.filter((entry) =>
    entry.pi ? entry.pi.id === id : paneMatchesLaunch(entry, id),
  );
  const [target] = targets;
  const hasConflictingOwner = owners.some(
    (owner) =>
      owner !== target &&
      (owner.peer.identity !== target?.peer.identity || owner.pi || owner.launch || owner.right),
  );
  const hasOtherManagedSession =
    target &&
    audit.ownership.some(
      ({ peer, session }) => session.id === id && peer.identity !== target.peer.identity,
    );
  if (targets.length > 1 || hasConflictingOwner || hasOtherManagedSession)
    throw new Error("Cannot uniquely identify the Windows pane for this conversation");
  if (
    target &&
    (((!target.pi || target.observedId) && target.observedId !== id) ||
      (target.observedTemporary && target.observedTemporary !== id) ||
      (target.launch && !paneMatchesLaunch(target, id)))
  )
    throw new Error("Windows pane launch does not match the conversation");
  return target;
}

function paneMatchesLaunch({ pi, panePid, launch }: WindowsLifecycleEntry, id: string): boolean {
  if (!launch) return false;
  const token = pi
    ? JSON.parse(Buffer.from(pi.metadata, "base64").toString("utf8")).token
    : launchRecordToken(launch);
  return matchesLaunch(launch, id, panePid, token);
}

async function windowsLaunchProcess(
  management: WindowsManagement,
  audit: WindowsLifecycleAudit,
  entry: WindowsLifecycleEntry,
  id: string,
) {
  const { pi, right, inheritedRight, peer } = entry;
  if (!right && !inheritedRight && pi) {
    const [process] = captureWindowsProcesses([pi.pid]);
    if (process) return process;
    throw new Error(`Pi is no longer running in ${peer.name}`);
  }
  if (
    !right ||
    !UUID.test(right) ||
    right !== inheritedRight ||
    audit.entries.some((other) => other !== entry && other.right === right)
  )
    throw new Error(`Cannot identify the Windows launch right in ${peer.name}`);
  const rights = management.createLaunchRights(windowsClaimLock(management));
  const status = await rights.status(right);
  if (
    !("receipt" in status) ||
    status.state !== "live" ||
    (pi && pi.pid !== status.receipt.child.pid)
  )
    throw new Error(`Cannot verify the live Windows launch in ${peer.name}`);
  const conversationKey = conversationLaunchKey(id);
  const keys = await rights.inspectReloadKeys({
    token: right,
    basis: audit.basis,
    child: status.receipt.child,
    conversationKey,
  });
  if (!keys.includes(conversationKey) && !(pi && entry.role === "pi"))
    throw new Error(`Windows launch in ${peer.name} does not own the conversation`);
  return status.receipt.child;
}

function expectedPaneFields(entry: WindowsLifecycleEntry) {
  return [
    ["pane_id", entry.paneId],
    ["pane_pid", String(entry.panePid)],
    ["pane_dead", "0"],
    ["@pi-mux-launch", entry.launch ?? ""],
    ["@pi-tmux-session", entry.pi?.metadata ?? ""],
    ["PI_TMUX_SESSION_ID", entry.observedId],
    ["PI_TMUX_TEMPORARY", entry.observedTemporary],
    [WINDOWS_RIGHT_ENV, entry.inheritedRight],
    [WINDOWS_RIGHT_OPTION, entry.right ?? ""],
  ] as const;
}

async function windowsPaneStillMatches(
  management: WindowsManagement,
  audit: WindowsLifecycleAudit,
  entry: WindowsLifecycleEntry,
): Promise<boolean> {
  const fields = expectedPaneFields(entry);
  const actual = await readWindowsPeerPaneFields(
    management.scope,
    audit,
    entry.peer,
    entry.paneId,
    fields.map(([field]) => field),
  );
  const expected = fields.map(([, value]) => value);
  return actual.every((field, index) => field === expected[index]);
}
