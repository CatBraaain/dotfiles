import { dlopen, ptr } from "bun:ffi";
import { realpathSync } from "node:fs";

export type WindowsProcessIdentity = { pid: number; creationTime: string };
type ProcessUnavailable = { state: "ended" } | { state: "unknown" };
type ProcessObservation<T> = { state: "live"; process: T } | ProcessUnavailable;
export type WindowsProcessObservation =
  | { state: "live"; identity: WindowsProcessIdentity }
  | ProcessUnavailable;
type ParentProcess = { creationTime: bigint; matchesExecutable: boolean | undefined };
type ClientProcess = { creationTime: bigint; parentPid: number };
export type InspectWindowsProcess = (pid: number) => WindowsProcessObservation;

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const SYNCHRONIZE = 0x100000;
const ERROR_INVALID_PARAMETER = 87;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 258;
const UINT32_MAX = 0xffffffff;
const UINT64_MAX = 0xffffffffffffffffn;
const PROCESS_BASIC_INFORMATION = 0;
const PROCESS_BASIC_INFORMATION_SIZE = 48;
const INHERITED_FROM_UNIQUE_PROCESS_ID_OFFSET = 40;
const MAX_WINDOWS_PATH_CHARS = 32_768;
const UTF16_CHAR_BYTES = 2;
const CSTR_EQUAL = 2;

const symbols = {
  OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
  CloseHandle: { args: ["ptr"], returns: "i32" },
  GetProcessTimes: { args: ["ptr", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
  WaitForSingleObject: { args: ["ptr", "u32"], returns: "u32" },
  GetLastError: { args: [], returns: "u32" },
  QueryFullProcessImageNameW: { args: ["ptr", "u32", "ptr", "ptr"], returns: "i32" },
  CompareStringOrdinal: { args: ["ptr", "i32", "ptr", "i32", "i32"], returns: "i32" },
} as const;

function loadNt() {
  return dlopen("ntdll.dll", {
    NtQueryInformationProcess: { args: ["ptr", "u32", "ptr", "u32", "ptr"], returns: "i32" },
  }).symbols;
}

function loadKernel() {
  return dlopen("kernel32.dll", symbols).symbols;
}

type Kernel = ReturnType<typeof loadKernel>;
type ProcessHandle = NonNullable<ReturnType<Kernel["OpenProcess"]>>;
let kernel: Kernel | undefined;
let nt: ReturnType<typeof loadNt> | undefined;

export function inspectWindowsProcess(pid: number): WindowsProcessObservation {
  const observation = readLiveProcess(pid, readCreationTime);
  if (observation.state !== "live") return observation;
  return { state: "live", identity: { pid, creationTime: observation.process.toString() } };
}

export function windowsChildPids(parentPid: number, clientPids: number[]): number[] {
  const candidates = clientPids.filter(isWindowsPid);
  if (candidates.length === 0 || !isWindowsPid(parentPid)) return [];

  try {
    const parent = readLiveProcess(parentPid, readParent);
    const matching = selectWindowsChildren(parentPid, parent, candidates, (pid) =>
      readLiveProcess(pid, readClient),
    );
    if (matching.length === 0 || parent.state !== "live") return matching;

    const identity = { pid: parentPid, creationTime: parent.process.creationTime.toString() };
    const state = observeWindowsIdentity(identity, inspectWindowsProcess);
    if (state === "unknown") throw new Error("Cannot recheck the parent process identity");
    return state === "present" ? matching : [];
  } catch (error) {
    throw new Error(`Cannot verify Windows client parent process ${parentPid}`, { cause: error });
  }
}

export function selectWindowsChildren(
  parentPid: number,
  parent: ProcessObservation<ParentProcess>,
  candidates: number[],
  inspectClient: (pid: number) => ProcessObservation<ClientProcess>,
): number[] {
  if (
    parent.state === "ended" ||
    (parent.state === "live" && parent.process.matchesExecutable === false)
  )
    return [];

  return candidates.filter((pid) => {
    const client = inspectClient(pid);
    if (client.state === "ended") return false;
    if (client.state === "unknown") throw new Error(`Cannot inspect client process ${pid}`);
    if (client.process.parentPid !== parentPid) return false;
    if (parent.state === "live" && parent.process.creationTime >= client.process.creationTime)
      return false;
    if (parent.state === "unknown" || parent.process.matchesExecutable === undefined)
      throw new Error("Cannot verify parent process identity");
    return true;
  });
}

function readLiveProcess<T>(
  pid: number,
  read: (api: Kernel, handle: ProcessHandle) => T | undefined,
): ProcessObservation<T> {
  if (process.platform !== "win32" || !isWindowsPid(pid)) return { state: "unknown" };
  const api = (kernel ??= loadKernel());
  const handle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid);
  if (!handle)
    return { state: api.GetLastError() === ERROR_INVALID_PARAMETER ? "ended" : "unknown" };
  try {
    const observation = read(api, handle);
    const state = api.WaitForSingleObject(handle, 0);
    if (state === WAIT_OBJECT_0) return { state: "ended" };
    if (observation === undefined || state !== WAIT_TIMEOUT) return { state: "unknown" };
    return { state: "live", process: observation };
  } finally {
    api.CloseHandle(handle);
  }
}

function readCreationTime(api: Kernel, handle: ProcessHandle): bigint | undefined {
  const times = Buffer.alloc(32);
  const ok = api.GetProcessTimes(handle, ptr(times), ptr(times, 8), ptr(times, 16), ptr(times, 24));
  const creationTime = times.readBigUInt64LE();
  return ok && creationTime > 0n ? creationTime : undefined;
}

function readParent(api: Kernel, handle: ProcessHandle): ParentProcess | undefined {
  const creationTime = readCreationTime(api, handle);
  if (creationTime === undefined) return undefined;
  const image = Buffer.alloc(MAX_WINDOWS_PATH_CHARS * UTF16_CHAR_BYTES);
  const length = new Uint32Array([MAX_WINDOWS_PATH_CHARS]);
  if (!api.QueryFullProcessImageNameW(handle, 0, ptr(image), ptr(length)))
    return { creationTime, matchesExecutable: undefined };
  const imageLength = length[0]!;
  if (imageLength === 0 || imageLength >= MAX_WINDOWS_PATH_CHARS)
    return { creationTime, matchesExecutable: undefined };

  const executable = realpathSync(process.execPath);
  const expectedImage = Buffer.from(executable, "utf16le");
  const comparison = api.CompareStringOrdinal(
    ptr(image),
    imageLength,
    ptr(expectedImage),
    executable.length,
    1,
  );
  return {
    creationTime,
    matchesExecutable: comparison === 0 ? undefined : comparison === CSTR_EQUAL,
  };
}

function readClient(api: Kernel, handle: ProcessHandle): ClientProcess | undefined {
  const creationTime = readCreationTime(api, handle);
  if (creationTime === undefined) return undefined;
  const basic = Buffer.alloc(PROCESS_BASIC_INFORMATION_SIZE);
  const status = (nt ??= loadNt()).NtQueryInformationProcess(
    handle,
    PROCESS_BASIC_INFORMATION,
    ptr(basic),
    basic.length,
    null,
  );
  if (status !== 0) return undefined;
  const parentPid = basic.readBigUInt64LE(INHERITED_FROM_UNIQUE_PROCESS_ID_OFFSET);
  if (parentPid > BigInt(UINT32_MAX)) return undefined;
  return { creationTime, parentPid: Number(parentPid) };
}

export function observeWindowsIdentity(
  expected: WindowsProcessIdentity,
  inspect: InspectWindowsProcess,
): "present" | "ended" | "unknown" {
  if (!isWindowsProcessIdentity(expected)) return "unknown";
  const actual = inspect(expected.pid);
  if (actual.state !== "live") return actual.state;
  if (!isWindowsProcessIdentity(actual.identity) || actual.identity.pid !== expected.pid)
    return "unknown";
  return actual.identity.creationTime === expected.creationTime ? "present" : "ended";
}

function isWindowsPid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= UINT32_MAX;
}

export function isWindowsProcessIdentity(value: unknown): value is WindowsProcessIdentity {
  if (!value || typeof value !== "object") return false;
  const { pid, creationTime } = value as Partial<WindowsProcessIdentity>;
  return (
    isWindowsPid(pid) &&
    typeof creationTime === "string" &&
    /^[1-9]\d{0,19}$/.test(creationTime) &&
    BigInt(creationTime) <= UINT64_MAX
  );
}
