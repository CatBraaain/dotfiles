import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { basename, join } from "node:path";
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
const PANE_RESPONSE_LIMIT = 1024 * 1024;
const PANE_ID = /^%\d+$/;
const PANE_FIELD = /^(?:[a-z_][a-z_0-9]*|@[a-z_0-9-]+)$/i;
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
  beforeShutdown?: () => Promise<void>,
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
    await beforeShutdown?.();
    const results = await Promise.allSettled(bound.map((peer) => shutdown(peer, basis.instance)));
    const stopFailure = results.find((result) => result.status === "rejected");
    if (stopFailure) throw stopFailure.reason;
    return peers.map(({ identity }) => identity);
  } finally {
    for (const { socket } of bound) socket.destroy();
  }
}

async function authenticate(scope: Scope, peer: PsmuxPeer, signal?: AbortSignal): Promise<Socket> {
  signal?.throwIfAborted();
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
  const key = (await readFile(path, { encoding: "utf8", signal })).replace(/\r?\n$/, "");
  if (!AUTH_KEY.test(key)) throw new Error(`Invalid psmux control key for ${peer.name}`);
  const socket = createConnection({ host: "127.0.0.1", port: peer.port, signal });
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

function auditedPaneIdentity(
  scope: Scope,
  { basis, panes }: PsmuxObservation,
  peer: PsmuxPeer,
  pane: string,
): WindowsProcessIdentity {
  const matches = panes.filter(({ peer: observed }) => observed.identity === peer.identity);
  if (
    !AUTH_KEY.test(basis.instance) ||
    !NAMESPACE.test(scope.namespace) ||
    !basis.witnesses.includes(peer.identity) ||
    matches.length !== 1 ||
    matches[0]!.peer.name !== peer.name ||
    matches[0]!.peer.port !== peer.port ||
    matches[0]!.peer.held ||
    peer.held ||
    !PANE_ID.test(pane)
  )
    throw new Error("Invalid psmux pane scope");
  return peerIdentity(peer);
}

export async function readWindowsPeerPaneFields(
  scope: Scope,
  observation: PsmuxObservation,
  peer: PsmuxPeer,
  pane: string,
  fields: readonly string[],
  inspect: InspectWindowsProcess = inspectWindowsProcess,
  signal?: AbortSignal,
): Promise<string[]> {
  const identity = auditedPaneIdentity(scope, observation, peer, pane);
  if (fields.length === 0 || fields.some((field) => !PANE_FIELD.test(field)))
    throw new Error("Invalid psmux pane read fields");
  const { basis } = observation;
  const fixedFields = ["pid", "server_instance", "session_name", "pane_id"];
  const prefix = [String(identity.pid), basis.instance, peer.name, pane].join("\t") + "\t";
  const format = [...fixedFields, ...fields].map((field) => `#{${field}}`).join("\t");
  const socket = await authenticate(scope, peer, signal);
  try {
    if (observeWindowsIdentity(identity, inspect) !== "present")
      throw new Error(`psmux peer changed before pane read: ${peer.name}`);
    const response = await exchange(
      socket,
      `display-message -p -t ${pane} ${wireArgument(format)}\n`,
      "pane-read",
    );
    if (observeWindowsIdentity(identity, inspect) !== "present")
      throw new Error(`psmux peer changed during pane read: ${peer.name}`);
    const values = response.slice(prefix.length, -1).split("\t");
    if (
      !response.startsWith(prefix) ||
      !response.endsWith("\n") ||
      values.length !== fields.length ||
      values.some((value) => /[\r\n]/.test(value))
    )
      throw new Error(`Cannot verify psmux pane read: ${peer.name} ${pane}`);
    return values;
  } finally {
    socket.destroy();
  }
}

export async function runWindowsPeerPaneCommands(
  scope: Scope,
  observation: PsmuxObservation,
  peer: PsmuxPeer,
  pane: string,
  commands: readonly (readonly string[])[],
): Promise<string> {
  const identity = auditedPaneIdentity(scope, observation, peer, pane);
  if (commands.length === 0) throw new Error("Expected a psmux pane command");
  const request = commands.map((args) => args.map(wireArgument).join(" ")).join(" ; ");
  const socket = await authenticate(scope, peer);
  try {
    if (observeWindowsIdentity(identity, inspectWindowsProcess) !== "present")
      throw new Error(`psmux peer changed before pane command: ${peer.name}`);
    const response = await exchange(socket, `${request}\n`, "pane-read");
    if (observeWindowsIdentity(identity, inspectWindowsProcess) !== "present")
      throw new Error(`psmux peer changed during pane command: ${peer.name}`);
    if (response.split("\n").some((line) => line.startsWith("ERROR: ")))
      throw new Error(`psmux ${commands[0]![0]} failed in ${peer.name} ${pane}`);
    return response;
  } finally {
    socket.destroy();
  }
}

type PaneExpectation = readonly [field: string, value: string];
type PaneMutation = { option: string; value?: string; global?: boolean } | { unsetTemporary: true };

export async function mutateWindowsPeerPane(
  scope: Scope,
  observation: PsmuxObservation,
  peer: PsmuxPeer,
  pane: string,
  {
    expected,
    owner,
    mutations,
    processes,
  }: {
    expected: readonly PaneExpectation[];
    owner?: PaneExpectation;
    mutations: readonly PaneMutation[];
    processes: readonly WindowsProcessIdentity[];
  },
): Promise<"applied" | "owner-changed"> {
  const identity = auditedPaneIdentity(scope, observation, peer, pane);
  const marker = `PI_MUX_STATE_${randomUUID().replaceAll("-", "")}`;
  const variables: string[] = [];
  const matches = ([field, value]: PaneExpectation) => {
    if (!PANE_FIELD.test(field) || /[\0\r\n]/.test(value) || value !== value.trim())
      throw new Error("Invalid psmux pane expectation");
    const name = `${marker}_${variables.length}`;
    variables.push(`%hidden ${name}=${value}`);
    return `#{==:#{${field}},#{${name}}}`;
  };
  const guard = [
    peerGuard(peer, identity.pid, observation.basis.instance),
    ...([["pane_id", pane], ["pane_dead", "0"], ...expected] as const).map(matches),
  ];
  const ownerGuard = owner && matches(owner);
  const postconditions: string[] = [];
  const commands = mutations.map((mutation) => {
    if ("unsetTemporary" in mutation) {
      postconditions.push(matches(["PI_TMUX_TEMPORARY", ""]));
      return "set-environment -u PI_TMUX_TEMPORARY";
    }
    const { option, value, global } = mutation;
    if (!option.startsWith("@") || !PANE_FIELD.test(option) || value?.includes("$"))
      throw new Error("Invalid psmux pane mutation");
    postconditions.push(matches([option, value ?? ""]));
    const flags = global ? "-g" : `-p -t ${pane}`;
    return value === undefined
      ? `set-option -u ${flags} ${option}`
      : `set-option ${flags} ${option} ${wireArgument(value)}`;
  });
  const script = [
    ...variables,
    ...guard.map((condition) => `%if ${condition}`),
    ...(ownerGuard ? [`%if ${ownerGuard}`] : []),
    ...commands,
    ...postconditions.map((condition) => `%if ${condition}`),
    `%hidden ${marker}=applied`,
    ...postconditions.map(() => "%endif"),
    ...(ownerGuard ? ["%else", `%hidden ${marker}=owner-changed`, "%endif"] : []),
    ...guard.map(() => "%endif"),
    ...variables.map((_, index) => `set-environment -ghu ${marker}_${index}`),
  ].join("\n");

  // Targeted RunCommand sources the file in one server request. Its forwarded TCP copy is parse-only, so it cannot reset bindings or run the file on the active pane: https://github.com/psmux/psmux/blob/v3.4.0/src/commands.rs#L2042
  const directory = await mkdtemp(join(homedir(), ".pi-mux-state-"));
  try {
    const file = "publish.conf";
    await writeFile(join(directory, file), script, { flag: "wx", mode: 0o600 });
    const path = `~/${basename(directory)}/${file}`;
    const socket = await authenticate(scope, peer);
    try {
      for (const process of [identity, ...processes]) {
        if (observeWindowsIdentity(process, inspectWindowsProcess) !== "present")
          throw new Error(`psmux peer or Pi process changed before pane mutation: ${peer.name}`);
      }
      const command = [
        `run-command -t ${pane} ${wireArgument(`source-file ${path} -n`)}`,
        `display-message -p ${wireArgument(`#{${marker}}`)}`,
        `set-environment -ghu ${marker}`,
      ].join(" ; ");
      const response = await exchange(socket, `${command}\n`, "pane-read");
      if (observeWindowsIdentity(identity, inspectWindowsProcess) !== "present")
        throw new Error(`psmux peer changed during pane mutation: ${peer.name}`);
      if (response === "OK\napplied\n") return "applied";
      if (response === "OK\nowner-changed\n") return "owner-changed";
      throw new Error(`Cannot confirm guarded psmux pane mutation: ${peer.name} ${pane}`);
    } finally {
      socket.destroy();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function configureWindowsPeer(
  scope: Scope,
  observation: PsmuxObservation,
  {
    configFile,
    hookCommand,
    proof,
    peerName,
  }: { configFile: string; hookCommand: string; proof?: string; peerName?: string },
  inspect: InspectWindowsProcess = inspectWindowsProcess,
): Promise<void> {
  const { basis, panes } = observation;
  const peer = (
    peerName === undefined
      ? (panes.find(({ peer }) => peer.held) ?? panes[0])
      : panes.find(({ peer }) => peer.name === peerName)
  )?.peer;
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
  phase: "auth" | "bootstrap" | "shutdown" | "pane-read",
  expected?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const responseLimit = phase === "pane-read" ? PANE_RESPONSE_LIMIT : RESPONSE_LIMIT;
    let response = "";
    const failure = () => finish(new Error(`Unexpected psmux ${phase} response`));
    const onData = (chunk: string) => {
      response += chunk;
      if (response.length > responseLimit) failure();
      else if (phase === "auth" && response.includes("\n")) {
        if (response === "OK\n") finish();
        else failure();
      }
    };
    const onEnd = () => {
      if (
        phase === "pane-read" ||
        (phase === "shutdown" && !response) ||
        (phase === "bootstrap" && response === expected)
      )
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
      else resolve(response);
    }
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("close", failure);
    socket.once("error", onError);
    socket.write(request);
  });
}
