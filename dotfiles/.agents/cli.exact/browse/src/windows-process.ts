import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { dlopen, ptr } from "bun:ffi";

const ERROR_INVALID_PARAMETER = 87;
const FILETIME_EPOCH_OFFSET = 116444736000000000n;
const PROCESS_QUERY_TIMEOUT_MS = 10_000;
const FORCE_STOP_TIMEOUT_MS = 2_000;

const PROCESS_QUERY = `
$ErrorActionPreference = 'Stop'
$exe = $env:BROWSE_QUERY_EXECUTABLE
$script = $env:BROWSE_QUERY_SCRIPT
$image = $env:BROWSE_QUERY_IMAGE
$name = $env:BROWSE_QUERY_IMAGE_NAME
$quote = [char]34
function Get-ArgPattern($value) {
  $escaped = [regex]::Escape($value)
  $quoted = $quote + $escaped + $quote
  if ($value -match '[ \\t]') { return $quoted }
  return '(?:' + $quoted + '|' + $escaped + ')'
}
$argsPattern = '^' + (Get-ArgPattern $exe)
if ($script) { $argsPattern += '\\s+' + (Get-ArgPattern $script) }
$argsPattern += '\\s+' + (Get-ArgPattern $env:BROWSE_QUERY_MODE)
$argsPattern += '\\s+' + (Get-ArgPattern $env:BROWSE_QUERY_PORT) + '[ \\t]*\\z'
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
Get-CimInstance Win32_Process -Filter "Name = '$name'" | ForEach-Object {
  if ($_.ExecutablePath -ceq $image -and $_.CommandLine -cmatch $argsPattern) {
    $processId = $_.ProcessId
    $processOwner = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid
    if ($processOwner.ReturnValue -ne 0) { throw "Cannot identify owner of process $processId" }
    if ($processOwner.Sid -eq $owner) {
      $running = Get-Process -Id $processId -ErrorAction SilentlyContinue
      if ($running) {
        $ticks = $running.StartTime.ToFileTimeUtc()
        $microsecondTicks = [long]10
        if (($ticks - ($ticks % $microsecondTicks)) -eq $_.CreationDate.ToFileTimeUtc()) {
          '{0} {1:x16}' -f $processId, $ticks
        }
      }
    }
  }
}
`;

export function findWindowsServerProcesses(
  argv: readonly string[],
  mode: string,
  port: string,
): { pid: number; identity: string; startedAtMs: number }[] {
  const [executable, script] = argv;
  if (!executable) throw new Error("Missing local Camoufox executable path");
  const image = realpathSync(executable);
  const imageName = basename(image).replace(/'/g, "\\'");
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot)) throw new Error("Cannot locate Windows PowerShell");
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(
    powershell,
    ["-NoProfile", "-NonInteractive", "-Command", PROCESS_QUERY],
    {
      encoding: "utf8",
      timeout: PROCESS_QUERY_TIMEOUT_MS,
      windowsHide: true,
      env: {
        ...process.env,
        BROWSE_QUERY_EXECUTABLE: executable,
        BROWSE_QUERY_SCRIPT: script ?? "",
        BROWSE_QUERY_IMAGE: image,
        BROWSE_QUERY_IMAGE_NAME: imageName,
        BROWSE_QUERY_MODE: mode,
        BROWSE_QUERY_PORT: port,
      },
    },
  );
  if (result.status !== 0) {
    const reason = result.error?.message || result.stderr?.trim() || result.status;
    throw new Error("Cannot find local Camoufox processes: " + reason);
  }
  return result.stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+) ([0-9a-f]{16})$/.exec(line);
      if (!match) throw new Error("Invalid Windows Camoufox process discovery output");
      const identity = match[2]!;
      return {
        pid: Number(match[1]),
        identity,
        startedAtMs: Number((BigInt("0x" + identity) - FILETIME_EPOCH_OFFSET) / 10_000n),
      };
    });
}

const PROCESS_TERMINATE = 0x0001;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const SYNCHRONIZE = 0x00100000;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 258;

function openKernel() {
  return dlopen("kernel32.dll", {
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
    GetProcessTimes: { args: ["ptr", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
    TerminateProcess: { args: ["ptr", "u32"], returns: "i32" },
    WaitForSingleObject: { args: ["ptr", "u32"], returns: "u32" },
    CloseHandle: { args: ["ptr"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
  });
}

type Kernel = ReturnType<typeof openKernel>["symbols"];
type ProcessHandle = NonNullable<ReturnType<Kernel["OpenProcess"]>>;

export function windowsProcessCreatedAt(pid: number): string | undefined {
  const kernel = openKernel();
  try {
    const handle = kernel.symbols.OpenProcess(
      PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
      0,
      pid,
    );
    if (!handle) return undefined;
    try {
      if (!isRunning(kernel.symbols, handle)) return undefined;
      return processCreatedAt(kernel.symbols, handle);
    } finally {
      kernel.symbols.CloseHandle(handle);
    }
  } finally {
    kernel.close();
  }
}

export function stopWindowsProcess(pid: number, createdAt: string, timeoutMs: number): void {
  const kernel = openKernel();
  try {
    const access = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE;
    const handle = kernel.symbols.OpenProcess(access, 0, pid);
    if (!handle) {
      const code = kernel.symbols.GetLastError();
      if (code === ERROR_INVALID_PARAMETER) return;
      throw new Error(`Cannot open the Windows Camoufox server process (Windows error ${code})`);
    }
    try {
      if (!isRunning(kernel.symbols, handle)) return;
      if (processCreatedAt(kernel.symbols, handle) !== createdAt) return;
      terminateWindowsProcess(kernel.symbols, handle);
      if (waitForWindowsExit(kernel.symbols, handle, timeoutMs)) return;
      terminateWindowsProcess(kernel.symbols, handle);
      if (!waitForWindowsExit(kernel.symbols, handle, FORCE_STOP_TIMEOUT_MS)) {
        throw new Error("Could not confirm the Windows Camoufox server exited");
      }
    } finally {
      kernel.symbols.CloseHandle(handle);
    }
  } finally {
    kernel.close();
  }
}

function terminateWindowsProcess(kernel: Kernel, handle: ProcessHandle): void {
  if (!kernel.TerminateProcess(handle, 1) && isRunning(kernel, handle)) {
    throw new Error("Cannot terminate the Windows Camoufox server");
  }
}

function isRunning(kernel: Kernel, handle: ProcessHandle): boolean {
  return !waitForWindowsExit(kernel, handle, 0);
}

function waitForWindowsExit(kernel: Kernel, handle: ProcessHandle, timeoutMs: number): boolean {
  const status = kernel.WaitForSingleObject(handle, timeoutMs);
  if (status === WAIT_OBJECT_0) return true;
  if (status === WAIT_TIMEOUT) return false;
  throw new Error("Cannot confirm the Windows Camoufox process state");
}

function processCreatedAt(kernel: Kernel, handle: ProcessHandle): string {
  const times = new BigUint64Array(4);
  const found = kernel.GetProcessTimes(
    handle,
    ptr(times),
    ptr(times, 8),
    ptr(times, 16),
    ptr(times, 24),
  );
  if (!found) throw new Error("Cannot read the Windows process creation time");
  return times[0]!.toString(16).padStart(16, "0");
}
