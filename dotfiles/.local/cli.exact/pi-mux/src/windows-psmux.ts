import { readFile, readdir } from "node:fs/promises";
import { join, win32 } from "node:path";
import type { WindowsManagementBasis } from "./windows-launch-rights";

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const SESSION_RECORD = /^(.*)\.(port|pid|held)$/;
const IDENTITY = /^([1-9]\d*):([1-9]\d*)$/;
const POSITIVE_INTEGER = /^[1-9]\d*$/;
const INSTANCE = /^[0-9a-f]{16}$/;
const END_OF_ROW = "pi-mux-audit-end";

export function psmuxNamespace(socketPath: string, registryPath: string): string {
  const socket = normalizedAbsolutePath(socketPath);
  const registry = normalizedAbsolutePath(registryPath);
  if (win32.dirname(socket) === registry) {
    const label = win32.basename(socketPath);
    if (label.toLowerCase() === "default") throw new Error("Expected a dedicated psmux namespace");
    return label;
  }
  // Match psmux's stable -S registry prefix: https://github.com/marlocarlo/psmux/blob/v3.4.0/src/socket_path.rs
  let hash = FNV_OFFSET;
  for (const byte of Buffer.from(socket))
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * FNV_PRIME);
  return `sock-${hash.toString(16).padStart(16, "0")}`;
}

function normalizedAbsolutePath(path: string): string {
  if (!/^[a-z]:[\\/]/i.test(path) || path.includes("\0"))
    throw new Error(`Expected a drive-absolute psmux path: ${path}`);
  return win32
    .normalize(path)
    .replace(/(?<=[^:])\\+$/, "")
    .toLowerCase();
}

export type PsmuxPeer = { name: string; identity: string; port: number; held?: true };
const HELD_NAME = "__warm__";
const SAFE_SESSION_NAME = /^[A-Za-z0-9_-]+$/;

export async function readPsmuxPeers(directory: string, namespace: string): Promise<PsmuxPeer[]> {
  const prefix = `${namespace}__`;
  const prefixKey = prefix.toLowerCase();
  const entries = await readdir(directory, { withFileTypes: true });
  const names = new Set<string>();
  for (const entry of entries) {
    if (!entry.name.toLowerCase().startsWith(prefixKey)) continue;
    const field = SESSION_RECORD.exec(entry.name.slice(prefix.length));
    if (!field) continue;
    const [, name = "", kind] = field;
    if (name === HELD_NAME && kind !== "held" && entry.isFile()) continue;
    if (
      !entry.name.startsWith(prefix) ||
      !entry.isFile() ||
      !SAFE_SESSION_NAME.test(name) ||
      (kind === "held" && name !== HELD_NAME)
    )
      throw new Error(`Invalid or unsupported psmux registry entry: ${entry.name}`);
    names.add(name);
  }
  return await Promise.all(
    [...names].sort().map(async (name): Promise<PsmuxPeer> => {
      const base = join(directory, `${prefix}${name}`);
      const [rawIdentity, rawPort, heldPid] = await Promise.all([
        readFile(`${base}.pid`, "utf8"),
        readFile(`${base}.port`, "utf8"),
        ...(name === HELD_NAME ? [readFile(`${base}.held`, "utf8")] : []),
      ]);
      const identity = rawIdentity!.trim();
      const match = IDENTITY.exec(identity);
      const port = Number(rawPort!.trim());
      if (
        !match ||
        !POSITIVE_INTEGER.test(rawPort!.trim()) ||
        port > 65535 ||
        (heldPid !== undefined && heldPid.trim() !== match[1])
      )
        throw new Error(`Invalid psmux peer registry for ${name}`);
      return { name, identity, port, ...(name === HELD_NAME ? { held: true } : {}) };
    }),
  );
}

export type PsmuxPeerPanes = { peer: PsmuxPeer; rows: string[] };

export type PsmuxQuery = (
  argv: string[],
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export async function readPsmuxPaneInventory(
  readPeers: () => Promise<PsmuxPeer[]>,
  query: PsmuxQuery,
  instance: string,
  paneFormat: string,
): Promise<PsmuxPeerPanes[]> {
  if (!INSTANCE.test(instance))
    throw new Error("Cannot identify a live psmux management generation");
  const peers = await readPeers();
  if (peers.length === 0)
    throw new Error("No preexisting psmux peers can confirm the pane inventory");
  const panes = await Promise.all(
    peers.map(async (peer) => ({
      peer,
      rows: peer.held
        ? await readHeldPanes(peer, query, instance)
        : await readPsmuxPeerPanes(peer, query, instance, paneFormat),
    })),
  );
  if (JSON.stringify(await readPeers()) !== JSON.stringify(peers))
    throw new Error("psmux registry changed during pane inventory");
  return panes;
}

export type PsmuxObservation = { basis: WindowsManagementBasis; panes: PsmuxPeerPanes[] };

export async function readPsmuxObservation(
  readPeers: () => Promise<PsmuxPeer[]>,
  query: PsmuxQuery,
  observeIdentity: (peer: PsmuxPeer) => "present" | "ended" | "unknown",
  paneFormat?: string,
): Promise<PsmuxObservation | undefined> {
  const registry = await readPeers();
  const identities = registry.map(observeIdentity);
  if (identities.includes("unknown"))
    throw new Error("Cannot identify every registered psmux process");
  const peers = registry.filter((_, index) => identities[index] === "present");
  const instances = await Promise.all(peers.map((peer) => readPsmuxInstance(peer, query)));
  const instance = instances[0];
  if (instances.some((observed) => observed !== instance))
    throw new Error("psmux peers disagree on the management generation");
  const panes =
    instance === undefined || paneFormat === undefined
      ? []
      : await Promise.all(
          peers.map(async (peer) => ({
            peer,
            rows: peer.held ? [] : await readPsmuxPeerPanes(peer, query, instance, paneFormat),
          })),
        );
  if (
    JSON.stringify(await readPeers()) !== JSON.stringify(registry) ||
    registry.some((peer, index) => observeIdentity(peer) !== identities[index])
  )
    throw new Error("psmux process or registry changed during management observation");
  if (instance === undefined) return;
  return { basis: { instance, witnesses: peers.map(({ identity }) => identity) }, panes };
}

async function readHeldPanes(
  peer: PsmuxPeer,
  query: PsmuxQuery,
  instance: string,
): Promise<string[]> {
  if ((await readPsmuxInstance(peer, query)) !== instance)
    throw new Error("psmux held peer changed during pane inventory");
  return [];
}

async function readPsmuxInstance(peer: PsmuxPeer, query: PsmuxQuery): Promise<string> {
  const target = peer.held ? [] : ["-t", `=${peer.name}`];
  const format = `#{pid}\t#{server_instance}\t#{session_name}\t${END_OF_ROW}`;
  const result = await query(["display-message", "-p", ...target, format]);
  const fields = result.stdout.replace(/\r?\n$/, "").split("\t");
  const [pid, instance, name, end] = fields;
  if (
    result.exitCode !== 0 ||
    result.stderr ||
    fields.length !== 4 ||
    pid !== peer.identity.split(":")[0] ||
    !instance ||
    !INSTANCE.test(instance) ||
    name !== (peer.held ? "" : peer.name) ||
    end !== END_OF_ROW
  )
    throw new Error(`Cannot verify exact psmux peer ${peer.name}`);
  return instance;
}

async function readPsmuxPeerPanes(
  peer: PsmuxPeer,
  query: PsmuxQuery,
  instance: string,
  paneFormat: string,
): Promise<string[]> {
  const target = `=${peer.name}`;
  const fields =
    "#{server_instance}\t#{pid}\t#{session_name}\t#{session_id}\t#{session_windows}\t#{window_id}\t#{window_panes}\t#{pane_id}";
  const format = `${fields}\t${paneFormat}\t${END_OF_ROW}`;
  const result = await query(["list-panes", "-s", "-t", target, "-F", format]);
  if (result.exitCode !== 0 || result.stderr || !result.stdout.trim())
    throw new Error(`Cannot read the complete psmux pane inventory for ${peer.name}`);
  const pid = peer.identity.split(":")[0];
  const windows = new Map<string, { expected: string; seen: number }>();
  const seenPanes = new Set<string>();
  const rows: string[] = [];
  let windowCount: string | undefined;
  let sessionId: string | undefined;
  for (const line of result.stdout.replace(/\r?\n$/, "").split(/\r?\n/)) {
    const [observedInstance, observedPid, name, session, total, window, count, pane, ...payload] =
      line.split("\t");
    if (
      observedInstance !== instance ||
      observedPid !== pid ||
      name !== peer.name ||
      !session ||
      !/^\$\d+$/.test(session) ||
      (sessionId !== undefined && session !== sessionId) ||
      !total ||
      !POSITIVE_INTEGER.test(total) ||
      (windowCount !== undefined && total !== windowCount) ||
      !window ||
      !/^@\d+$/.test(window) ||
      !count ||
      !POSITIVE_INTEGER.test(count) ||
      !pane ||
      !/^%\d+$/.test(pane) ||
      seenPanes.has(pane) ||
      payload.length < 2 ||
      payload.at(-1) !== END_OF_ROW
    )
      throw new Error(`Invalid or changed psmux pane inventory for ${peer.name}`);
    sessionId = session;
    windowCount = total;
    seenPanes.add(pane);
    const previouslySeen = windows.get(window);
    if (previouslySeen && previouslySeen.expected !== count)
      throw new Error(`psmux window changed during pane inventory for ${peer.name}`);
    windows.set(window, { expected: count, seen: (previouslySeen?.seen ?? 0) + 1 });
    rows.push(payload.slice(0, -1).join("\t"));
  }
  if (
    windows.size !== Number(windowCount) ||
    [...windows.values()].some(({ seen, expected }) => seen !== Number(expected))
  )
    throw new Error(`Incomplete psmux pane inventory for ${peer.name}`);
  return rows;
}

export async function waitForPsmuxClient(
  query: (args: string[], timeout: number) => ReturnType<PsmuxQuery>,
  target: { clientPid: number; name: string; serverPid: number; instance: string },
  sameProcesses: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  const expected = [target.clientPid, target.name, target.serverPid, target.instance].join("\t");
  const args = [
    "list-clients",
    "-t",
    `=${target.name}`,
    "-F",
    "#{client_pid}\t#{client_session}\t#{pid}\t#{server_instance}",
  ];
  while (performance.now() < deadline) {
    const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
    const result = await query(args, remaining);
    if (!sameProcesses()) break;
    if (
      result.exitCode === 0 &&
      !result.stderr &&
      result.stdout.split(/\r?\n/).includes(expected) &&
      performance.now() < deadline
    )
      return;
    await Bun.sleep(Math.min(50, Math.max(0, deadline - performance.now())));
  }
  throw new Error(
    `Client switch outcome unknown: could not confirm process ${target.clientPid} attached to ${target.name}`,
  );
}
