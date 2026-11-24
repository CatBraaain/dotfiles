import { lstat, readFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import {
  inspectWindowsProcess,
  isWindowsProcessIdentity,
  observeWindowsIdentity,
  type InspectWindowsProcess,
  type WindowsProcessIdentity,
} from "./windows-process";
import type { PsmuxObservation, PsmuxPeer } from "./windows-psmux";

const CONTROL_TIMEOUT_MS = 5000;
const RESPONSE_LIMIT = 1024;
const AUTH_KEY = /^[0-9a-f]{16}$/;
const PEER_NAME = /^[A-Za-z0-9_-]+$/;
const NAMESPACE = /^[A-Za-z0-9_.-]+$/;
export const WINDOWS_BOOTSTRAP_PROOF = "PI_MUX_WINDOWS_BOOTSTRAP";
const BOOTSTRAP_ACK = "PI_MUX_BOOTSTRAP_CONFIRMED";

type Scope = { registryDirectory: string; namespace: string };
type BoundPeer = { socket: Socket; peer: PsmuxPeer; identity: WindowsProcessIdentity };

function peerIdentity(peer: PsmuxPeer): WindowsProcessIdentity {
  const [pid, creationTime] = peer.identity.split(":");
  const identity = { pid: Number(pid), creationTime };
  if (!isWindowsProcessIdentity(identity)) throw new Error("Invalid psmux peer process identity");
  return identity;
}

export function captureWindowsProcesses(
  pids: Iterable<number>,
  inspect: InspectWindowsProcess = inspectWindowsProcess,
): WindowsProcessIdentity[] {
  const processes: WindowsProcessIdentity[] = [];
  for (const pid of new Set(pids)) {
    const process = inspect(pid);
    if (process.state === "ended") continue;
    if (
      process.state !== "live" ||
      process.identity.pid !== pid ||
      !isWindowsProcessIdentity(process.identity)
    )
      throw new Error(`Cannot identify Windows pane process ${pid}`);
    processes.push(process.identity);
  }
  return processes;
}

export async function waitForWindowsExit(
  targets: readonly WindowsProcessIdentity[],
  { timeoutMs, pollMs }: { timeoutMs: number; pollMs: number },
  inspect: InspectWindowsProcess = inspectWindowsProcess,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (targets.some((target) => observeWindowsIdentity(target, inspect) !== "ended")) {
    if (Date.now() >= deadline)
      throw new Error("Cannot confirm the old Windows psmux peers and pane processes exited");
    await Bun.sleep(pollMs);
  }
}

export async function stopWindowsPeers(
  scope: Scope,
  { basis, panes }: PsmuxObservation,
  inspect: InspectWindowsProcess = inspectWindowsProcess,
): Promise<WindowsProcessIdentity[]> {
  if (!AUTH_KEY.test(basis.instance) || !NAMESPACE.test(scope.namespace) || panes.length === 0)
    throw new Error("Invalid psmux shutdown scope");
  const peers = panes.map(({ peer }) => ({ peer, identity: peerIdentity(peer) }));
  const identities = peers.map(({ peer }) => peer.identity);
  if (
    new Set(identities).size !== identities.length ||
    new Set(peers.map(({ peer }) => peer.port)).size !== peers.length ||
    JSON.stringify(identities) !== JSON.stringify(basis.witnesses)
  )
    throw new Error("Cannot confirm every psmux shutdown peer");

  const authenticated = await Promise.allSettled(
    peers.map(async ({ peer, identity }) => ({
      socket: await authenticate(scope, peer),
      peer,
      identity,
    })),
  );
  const bound = authenticated.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  try {
    const failure = authenticated.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
    for (const { identity, peer, socket } of bound) {
      if (socket.destroyed || observeWindowsIdentity(identity, inspect) !== "present")
        throw new Error(`psmux peer changed before shutdown: ${peer.name}`);
    }
    const results = await Promise.allSettled(bound.map((peer) => shutdown(peer, basis.instance)));
    const stopFailure = results.find((result) => result.status === "rejected");
    if (stopFailure) throw stopFailure.reason;
    return peers.map(({ identity }) => identity);
  } finally {
    for (const { socket } of bound) socket.destroy();
  }
}

async function authenticate(scope: Scope, peer: PsmuxPeer): Promise<Socket> {
  if (
    !PEER_NAME.test(peer.name) ||
    !Number.isInteger(peer.port) ||
    peer.port < 1 ||
    peer.port > 65535
  )
    throw new Error("Invalid psmux peer endpoint");
  const path = join(scope.registryDirectory, `${scope.namespace}__${peer.name}.key`);
  const file = await lstat(path);
  if (!file.isFile() || file.size > RESPONSE_LIMIT)
    throw new Error(`Invalid psmux control key file for ${peer.name}`);
  const key = (await readFile(path, "utf8")).replace(/\r?\n$/, "");
  if (!AUTH_KEY.test(key)) throw new Error(`Invalid psmux control key for ${peer.name}`);
  const socket = createConnection({ host: "127.0.0.1", port: peer.port });
  socket.setEncoding("utf8");
  socket.on("error", () => {});
  try {
    await exchange(socket, `AUTH ${key}\n`, "auth");
    return socket;
  } catch (error) {
    socket.destroy();
    throw new Error(`Cannot bind to exact psmux peer ${peer.name}`, { cause: error });
  }
}

function peerGuard(peer: PsmuxPeer, pid: number, instance: string): string {
  const name = peer.held ? "" : peer.name;
  return `#{&&:#{==:#{pid},${pid}},#{&&:#{==:#{server_instance},${instance}},#{==:#{session_name},${name}}}}`;
}

function wireArgument(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error("Invalid psmux control argument");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export async function configureWindowsPeer(
  scope: Scope,
  observation: PsmuxObservation,
  { configFile, hookCommand, proof }: { configFile: string; hookCommand: string; proof?: string },
  inspect: InspectWindowsProcess = inspectWindowsProcess,
): Promise<void> {
  const { basis, panes } = observation;
  const peer = (panes.find(({ peer }) => peer.held) ?? panes[0])?.peer;
  if (
    !peer ||
    !AUTH_KEY.test(basis.instance) ||
    !NAMESPACE.test(scope.namespace) ||
    !basis.witnesses.includes(peer.identity) ||
    (proof !== undefined && (!peer.held || panes.length !== 1 || !/^[0-9a-f-]{36}$/.test(proof)))
  )
    throw new Error("Invalid psmux bootstrap scope");
  const identity = peerIdentity(peer);
  const guard = peerGuard(peer, identity.pid, basis.instance);
  const run = async (command: string, expected: string) => {
    const socket = await authenticate(scope, peer);
    try {
      if (observeWindowsIdentity(identity, inspect) !== "present")
        throw new Error(`psmux peer changed before bootstrap: ${peer.name}`);
      await exchange(
        socket,
        `if-shell -F ${wireArgument(guard)} ${wireArgument(command)}\n`,
        "bootstrap",
        expected,
      );
      if (observeWindowsIdentity(identity, inspect) !== "present")
        throw new Error(`psmux peer changed during bootstrap: ${peer.name}`);
    } finally {
      socket.destroy();
    }
  };
  if (proof)
    await run(
      `show-environment -g ${WINDOWS_BOOTSTRAP_PROOF}`,
      `${WINDOWS_BOOTSTRAP_PROOF}=${proof}\n`,
    );
  else await readFile(configFile, "utf8");
  const commands = [
    ...(!proof ? [`source-file ${wireArgument(configFile)}`] : []),
    `set-option -g @pi-mux-snapshot ${wireArgument(hookCommand)}`,
    `display-message -p ${BOOTSTRAP_ACK}`,
  ];
  await run(commands.join(" ; "), `${BOOTSTRAP_ACK}\n`);
}

async function shutdown({ socket, peer, identity }: BoundPeer, instance: string): Promise<void> {
  // A held peer has no session; one-shot kill-server does not fan out: https://github.com/marlocarlo/psmux/blob/v3.4.0/src/server/connection.rs
  const command = peer.held ? "kill-server" : "kill-session";
  try {
    await exchange(
      socket,
      `if-shell -F "${peerGuard(peer, identity.pid, instance)}" "${command}" "display-message -p PI_MUX_STOP_REFUSED"\n`,
      "shutdown",
    );
  } catch (error) {
    throw new Error(`Cannot confirm shutdown command for psmux peer ${peer.name}`, {
      cause: error,
    });
  }
}

function exchange(
  socket: Socket,
  request: string,
  phase: "auth" | "bootstrap" | "shutdown",
  expected?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let response = "";
    const failure = () => finish(new Error(`Unexpected psmux ${phase} response`));
    const onData = (chunk: string) => {
      response += chunk;
      if (response.length > RESPONSE_LIMIT) failure();
      else if (phase === "auth" && response.includes("\n")) {
        if (response === "OK\n") finish();
        else failure();
      }
    };
    const onEnd = () => {
      if ((phase === "shutdown" && !response) || (phase === "bootstrap" && response === expected))
        finish();
      else failure();
    };
    const onError = (error: NodeJS.ErrnoException) => {
      if (phase === "shutdown" && !response && error.code === "ECONNRESET") onEnd();
      else finish(error);
    };
    const timer = setTimeout(failure, CONTROL_TIMEOUT_MS);
    function finish(error?: Error) {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("close", failure);
      socket.off("error", onError);
      if (error) reject(error);
      else resolve();
    }
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("close", failure);
    socket.once("error", onError);
    socket.write(request);
  });
}
