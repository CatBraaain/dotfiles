import { dlopen, ptr } from "bun:ffi";

export type WindowsProcessIdentity = { pid: number; creationTime: string };
export type WindowsProcessObservation =
  | { state: "live"; identity: WindowsProcessIdentity }
  | { state: "ended" }
  | { state: "unknown" };
export type InspectWindowsProcess = (pid: number) => WindowsProcessObservation;

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const SYNCHRONIZE = 0x100000;
const ERROR_INVALID_PARAMETER = 87;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 258;
const UINT32_MAX = 0xffffffff;
const UINT64_MAX = 0xffffffffffffffffn;

const symbols = {
  OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
  CloseHandle: { args: ["ptr"], returns: "i32" },
  GetProcessTimes: { args: ["ptr", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
  WaitForSingleObject: { args: ["ptr", "u32"], returns: "u32" },
  GetLastError: { args: [], returns: "u32" },
} as const;

function loadKernel() {
  return dlopen("kernel32.dll", symbols).symbols;
}

let kernel: ReturnType<typeof loadKernel> | undefined;

export function inspectWindowsProcess(pid: number): WindowsProcessObservation {
  if (process.platform !== "win32" || !isWindowsPid(pid)) return { state: "unknown" };
  const api = (kernel ??= loadKernel());
  const handle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid);
  if (!handle)
    return { state: api.GetLastError() === ERROR_INVALID_PARAMETER ? "ended" : "unknown" };
  try {
    const times = Buffer.alloc(32);
    const ok = api.GetProcessTimes(
      handle,
      ptr(times),
      ptr(times, 8),
      ptr(times, 16),
      ptr(times, 24),
    );
    const state = api.WaitForSingleObject(handle, 0);
    if (state === WAIT_OBJECT_0) return { state: "ended" };
    if (!ok || state !== WAIT_TIMEOUT) return { state: "unknown" };
    const creation = times.readBigUInt64LE();
    if (!creation) return { state: "unknown" };
    return { state: "live", identity: { pid, creationTime: creation.toString() } };
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
