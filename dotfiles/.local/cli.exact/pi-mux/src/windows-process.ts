import { dlopen, ptr } from "bun:ffi";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { win32 } from "node:path";
import { promisify } from "node:util";
import { isRecord } from "./session-model";

export type WindowsProcessIdentity = { pid: number; creationTime: string };
type ProcessUnavailable = { state: "ended" } | { state: "unknown" };
type ProcessObservation<T> = { state: "live"; process: T } | ProcessUnavailable;
export type WindowsProcessObservation =
  | { state: "live"; identity: WindowsProcessIdentity }
  | ProcessUnavailable;
type ParentProcess = { creationTime: bigint; matchesExecutable: boolean | undefined };
type ClientProcess = { creationTime: bigint; parentPid: number };
export type InspectWindowsProcess = (pid: number) => WindowsProcessObservation;

const PROCESS_QUERY_TIMEOUT_MS = 5000;
const execFileAsync = promisify(execFile);
const PROCESS_TERMINATE = 0x0001;
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
  TerminateProcess: { args: ["ptr", "u32"], returns: "i32" },
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

export function terminateWindowsProcess(expected: WindowsProcessIdentity): void {
  if (process.platform !== "win32" || !isWindowsProcessIdentity(expected))
    throw new Error("Invalid Windows process identity for close");
  const api = (kernel ??= loadKernel());
  const { pid, creationTime } = expected;
  const handle = api.OpenProcess(
    PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
    0,
    pid,
  );
  if (!handle) throw new Error(`Cannot open Windows Pi process ${pid} for close`);
  try {
    const actual = readCreationTime(api, handle);
    if (actual?.toString() !== creationTime || api.WaitForSingleObject(handle, 0) !== WAIT_TIMEOUT)
      throw new Error(`Windows Pi process ${pid} changed before close`);
    if (!api.TerminateProcess(handle, 1)) throw new Error(`Cannot stop Windows Pi process ${pid}`);
  } finally {
    api.CloseHandle(handle);
  }
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

export type WindowsProcessRow = {
  pid: number;
  parent: number;
  executable: string | null;
  command: string | null;
};

export async function readWindowsProcessGroup(
  pids: readonly number[],
): Promise<WindowsProcessRow[]> {
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

export async function assertWindowsPaneAncestor(
  process: WindowsProcessIdentity,
  pane: WindowsProcessIdentity,
): Promise<void> {
  const visited = new Set<number>();
  let child = process;
  while (child.pid !== pane.pid && !visited.has(child.pid)) {
    visited.add(child.pid);
    const rows = await readWindowsProcessGroup([child.pid]);
    const parentPid = rows.find(({ pid }) => pid === child.pid)?.parent;
    const parent = parentPid && inspectWindowsProcess(parentPid);
    if (
      !parent ||
      parent.state !== "live" ||
      BigInt(parent.identity.creationTime) >= BigInt(child.creationTime) ||
      observeWindowsIdentity(child, inspectWindowsProcess) !== "present"
    )
      break;
    child = parent.identity;
  }
  if (
    child.pid !== pane.pid ||
    child.creationTime !== pane.creationTime ||
    observeWindowsIdentity(pane, inspectWindowsProcess) !== "present"
  )
    throw new Error(
      `Cannot verify Windows Pi process ${process.pid} belongs to pane process ${pane.pid}`,
    );
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
