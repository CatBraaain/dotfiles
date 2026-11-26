import type { TmuxConfig } from "./configuration";
import { livePanes, PANE_FORMAT, parseLivePaneRows } from "./pane-inventory";
import { platform } from "./platform";
import type { Pane, Session } from "./session-model";
import { serverIsAbsent, tmux, windowsManagement } from "./mux";
import { launchBasisStillLive, type WindowsManagementBasis } from "./windows/windows-launch-rights";
import type { WindowsManagement } from "./windows/windows-management";
import {
  inspectWindowsProcess,
  observeWindowsIdentity,
  type WindowsProcessIdentity,
} from "./windows/windows-process";
import { waitForPsmuxClient, type PsmuxObservation, type PsmuxPeer } from "./windows/windows-psmux";

type TmuxClient = { name: string; pid: number; session: string };

type DisplayedSession = Session & { clientPid: number; target: string };

async function tmuxClients(config: TmuxConfig): Promise<TmuxClient[]> {
  const result = await tmux(
    config,
    ["list-clients", "-F", "#{client_name}\t#{client_pid}\t#{client_session}"],
    true,
  );
  if (result.exitCode !== 0) {
    if (serverIsAbsent(config, result.stderr) || result.stderr.includes("no clients")) return [];
    throw new Error(`Cannot list tmux clients: ${result.stderr.trim()}`);
  }
  return result.stdout
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [name, pid, session] = line.split("\t");
      if (!name || !pid || !/^[1-9]\d*$/.test(pid) || !session)
        throw new Error(`Invalid tmux client output: ${line}`);
      return [{ name, pid: Number(pid), session }];
    });
}

const SWITCH_TARGET_MISSING_EXIT_CODE = 2;

const SWITCH_CLIENT_MISSING_EXIT_CODE = 3;

const PSMUX_SWITCH_GUARD_TIMEOUT_MS = 5000;

export class SwitchResolutionError extends Error {
  constructor(
    message: string,
    readonly exitCode:
      | typeof SWITCH_TARGET_MISSING_EXIT_CODE
      | typeof SWITCH_CLIENT_MISSING_EXIT_CODE,
  ) {
    super(message);
  }
}

async function clientsMatchingPid(clients: TmuxClient[], clientPid: number): Promise<TmuxClient[]> {
  const matchingPids = await platform.clientPidsFor(
    clientPid,
    clients.map(({ pid }) => pid),
  );
  return clients.filter(({ pid }) => matchingPids.includes(pid));
}

async function resolveClient(
  config: TmuxConfig,
  clientPid: number | undefined,
): Promise<TmuxClient> {
  const clients = await tmuxClients(config);
  const matching = clientPid === undefined ? clients : await clientsMatchingPid(clients, clientPid);
  if (matching.length === 1) return matching[0]!;
  const message =
    clientPid === undefined
      ? `Expected one attached tmux client, found ${matching.length}`
      : `Cannot identify the tmux client for process ${clientPid}`;
  if (matching.length === 0)
    throw new SwitchResolutionError(message, SWITCH_CLIENT_MISSING_EXIT_CODE);
  throw new Error(message);
}

export async function switchSession(
  config: TmuxConfig,
  id: string,
  clientPid: number | undefined,
): Promise<void> {
  const targets = (await livePanes(config, "list")).filter((pane) => pane.id === id);
  if (targets.length === 0)
    throw new SwitchResolutionError(
      `Session not found (use the complete ID): ${id}`,
      SWITCH_TARGET_MISSING_EXIT_CODE,
    );
  if (targets.length > 1) throw new Error(`Multiple pi processes are running for session ${id}`);
  const target = targets[0]!;
  const client = await resolveClient(config, clientPid);
  if (platform.windows) return switchWindowsClient(config, target, client);
  await tmux(config, ["switch-client", "-c", client.name, "-t", `=${target.name}`]);
}

function auditedSwitchTargets(audit: PsmuxObservation, id: string) {
  return audit.panes.flatMap(({ peer, rows }) =>
    parseLivePaneRows(rows.join("\n"), "list")
      .filter((pane) => pane.id === id)
      .map((pane) => ({ pane, peer })),
  );
}

function switchPeerIdentity({ identity }: PsmuxPeer): WindowsProcessIdentity {
  const [pid, creationTime] = identity.split(":") as [string, string];
  return { pid: Number(pid), creationTime };
}

async function confirmWindowsClientSwitch(
  config: TmuxConfig,
  destination: PsmuxPeer,
  instance: string,
  client: WindowsProcessIdentity,
): Promise<void> {
  const server = switchPeerIdentity(destination);
  await waitForPsmuxClient(
    (args, timeout) => tmux({ ...config, timeout }, args, true),
    { clientPid: client.pid, name: destination.name, serverPid: server.pid, instance },
    () =>
      [server, client].every(
        (identity) => observeWindowsIdentity(identity, inspectWindowsProcess) === "present",
      ),
  );
}

async function switchWindowsClient(
  config: TmuxConfig,
  target: Pane,
  client: TmuxClient,
): Promise<void> {
  const audit = await windowsManagement(config).audit(PANE_FORMAT, { requireRestored: false });
  const targets = auditedSwitchTargets(audit, target.id);
  const [destination] = targets;
  if (
    targets.length !== 1 ||
    !destination ||
    destination.peer.name !== target.name ||
    destination.pane.name !== target.name ||
    destination.pane.pid !== target.pid ||
    destination.pane.pane !== target.pane
  )
    throw new Error("Cannot verify the Windows client switch destination");
  // psmux can fall back to a prefix when the exact target disappears: https://github.com/psmux/psmux/blob/20aa1d7254ee93f64dafa059ef89341d9767470a/src/server/mod.rs#L7033-L7039
  const conflictingName = audit.panes.find(
    ({ peer }) => !peer.held && peer.name !== target.name && peer.name.startsWith(target.name),
  )?.peer.name;
  if (conflictingName)
    throw new Error(
      `Cannot safely switch to psmux session ${target.name}: ${conflictingName} could be selected instead`,
    );

  const source = audit.panes.find(({ peer }) => !peer.held && peer.name === client.session)?.peer;
  if (!source) throw new Error("Cannot verify the Windows client switch source");
  const process = inspectWindowsProcess(client.pid);
  if (process.state !== "live") throw new Error("Cannot identify the Windows client process");
  const sourceServer = switchPeerIdentity(source);
  const instance = audit.basis.instance;
  const sourceTarget = `=${source.name}`;
  const attached = await tmux(
    config,
    [
      "list-clients",
      "-t",
      sourceTarget,
      "-F",
      "#{client_pid}\t#{client_session}\t#{pid}\t#{server_instance}",
    ],
    true,
  );
  const expected = [client.pid, source.name, sourceServer.pid, instance].join("\t");
  const unverifiedSource = "Cannot verify a single client in the source psmux session";
  if (attached.exitCode !== 0 || attached.stderr || attached.stdout.trimEnd() !== expected)
    throw new Error(unverifiedSource);

  const sourceChanged = "pi-mux-switch-source-changed";
  const sourceGuard = `#{&&:#{==:#{server_instance},${instance}},#{&&:#{==:#{pid},${sourceServer.pid}},#{==:#{client_pid},${client.pid}}}}`;
  // psmux drops -c on the switch path; pin the source with the outer -t: https://github.com/psmux/psmux/blob/20aa1d7254ee93f64dafa059ef89341d9767470a/src/server/connection.rs#L4525-L4534
  const result = await tmux(
    { ...config, timeout: PSMUX_SWITCH_GUARD_TIMEOUT_MS },
    [
      "if-shell",
      "-t",
      sourceTarget,
      "-F",
      sourceGuard,
      `switch-client -t =${destination.peer.name}`,
      `display-message -p ${sourceChanged}`,
    ],
    true,
  );
  const reply = result.stdout.trimEnd();
  if (result.exitCode === 0 && reply === sourceChanged) throw new Error(unverifiedSource);
  if (result.exitCode !== 0 || result.stderr || reply !== "OK") {
    const reason = result.stderr.trim() || reply || "No acknowledgment from psmux";
    throw new Error(`Client switch outcome unknown: ${reason}`);
  }
  await confirmWindowsClientSwitch(config, destination.peer, instance, process.identity);
}

export async function switchWindowsNewClient(
  config: TmuxConfig,
  target: Pane,
  clientPid: number,
  management: WindowsManagement,
  basis: WindowsManagementBasis,
): Promise<void> {
  const audit = await management.audit(PANE_FORMAT);
  const targets = auditedSwitchTargets(audit, target.id);
  const [match] = targets;
  if (
    !launchBasisStillLive(basis, audit.basis) ||
    targets.length !== 1 ||
    !match ||
    match.pane.name !== target.name ||
    match.peer.name !== target.name ||
    match.pane.pid !== target.pid
  )
    throw new Error("Cannot verify the Windows client switch destination");
  const client = await resolveClient(config, clientPid);
  const process = inspectWindowsProcess(client.pid);
  if (process.state !== "live") throw new Error("Cannot identify the Windows client process");
  const source = audit.panes.find(({ peer }) => !peer.held && peer.name === client.session);
  if (!source) throw new Error("Cannot verify the Windows client switch source");
  const routed = {
    ...config,
    env: { ...config.env, TMUX: `${config.socket},${source.peer.port},0` },
  };
  await tmux(routed, ["switch-client", "-c", client.name, "-t", `=${target.name}`]);
  await confirmWindowsClientSwitch(config, match.peer, basis.instance, process.identity);
}

export async function displayedSessions(
  config: TmuxConfig,
  clientPid: number | undefined,
): Promise<DisplayedSession[]> {
  const clients = await tmuxClients(config);
  const matching = clientPid === undefined ? clients : await clientsMatchingPid(clients, clientPid);
  if (clientPid !== undefined && matching.length > 1)
    throw new Error(`Multiple tmux clients match process ${clientPid}`);
  if (matching.length === 0) return [];

  const displayedIn = new Set(matching.map(({ session }) => session));
  const panes = await livePanes(config, { displayedIn });
  const displayBySession = new Map(panes.map((pane) => [pane.name, pane]));
  return matching.flatMap(({ pid, session }) => {
    const pane = displayBySession.get(session);
    if (!pane) return [];
    return [{ clientPid: pid, id: pane.id, cwd: pane.cwd, file: pane.file, target: pane.name }];
  });
}
