import type { TmuxConfig } from "./configuration";
import { livePanes, PANE_FORMAT, parseLivePaneRows } from "./pane-inventory";
import { platform } from "./platform";
import type { Pane, Session } from "./session-model";
import { serverIsAbsent, tmux } from "./tmux";
import { launchBasisStillLive, type WindowsManagementBasis } from "./windows-launch-rights";
import type { WindowsManagement } from "./windows-management";
import { inspectWindowsProcess, observeWindowsIdentity } from "./windows-process";
import { waitForPsmuxClient } from "./windows-psmux";

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
  const client = await resolveClient(config, clientPid);
  await tmux(config, ["switch-client", "-c", client.name, "-t", `=${targets[0]!.name}`]);
}

export async function switchWindowsNewClient(
  config: TmuxConfig,
  target: Pane,
  clientPid: number,
  management: WindowsManagement,
  basis: WindowsManagementBasis,
): Promise<void> {
  const audit = await management.audit(PANE_FORMAT);
  const targets = audit.panes.flatMap(({ peer, rows }) =>
    parseLivePaneRows(rows.join("\n"), "list")
      .filter((pane) => pane.id === target.id)
      .map((pane) => ({ pane, peer })),
  );
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
  const [pid, creationTime] = match.peer.identity.split(":") as [string, string];
  const server = { pid: Number(pid), creationTime };
  const source = audit.panes.find(({ peer }) => !peer.held && peer.name === client.session);
  if (!source) throw new Error("Cannot verify the Windows client switch source");
  const routed = {
    ...config,
    env: { ...config.env, TMUX: `${config.socket},${source.peer.port},0` },
  };
  await tmux(routed, ["switch-client", "-c", client.name, "-t", `=${target.name}`]);
  await waitForPsmuxClient(
    (args, timeout) => tmux({ ...config, timeout }, args, true),
    { clientPid: client.pid, name: target.name, serverPid: server.pid, instance: basis.instance },
    () =>
      [server, process.identity].every(
        (identity) => observeWindowsIdentity(identity, inspectWindowsProcess) === "present",
      ),
  );
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
