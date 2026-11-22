import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { win32 } from "node:path";
import { SERVER_STOP_TIMEOUT_MS } from "./config";

const QUERY_TIMEOUT_MS = 5_000;
const FORCE_STOP_TIMEOUT_MS = 2_000;
const MAX_PROCESS_ID = 0x7fffffff;
const VERIFIED_STOP_FAILURE = 2;

const encodedStopScript = Buffer.from(
  String.raw`
$ErrorActionPreference = 'Stop'
$target = $null
$verified = $false
try {
    $target = [Diagnostics.Process]::GetProcessById([int]$env:BROWSE_SERVER_PID)
    # Kill reuses this handle instead of reopening the PID: https://github.com/microsoft/referencesource/blob/main/System/services/monitoring/system/diagnosticts/Process.cs
    $null = $target.Handle
    $info = Get-CimInstance Win32_Process -Filter "ProcessId = $($target.Id)"
    if (-not [string]::Equals($info.ExecutablePath, $env:BROWSE_SERVER_IMAGE, [StringComparison]::Ordinal)) { return }
    if (-not [regex]::IsMatch($info.CommandLine, $env:BROWSE_SERVER_COMMAND_PATTERN)) { return }
    $verified = $true
    if ($target.HasExited) { return }
    $target.Kill()
    if (-not $target.WaitForExit([int]$env:BROWSE_SERVER_STOP_TIMEOUT_MS)) {
        $target.Kill()
        if (-not $target.WaitForExit([int]$env:BROWSE_SERVER_FORCE_STOP_TIMEOUT_MS)) {
            exit ${VERIFIED_STOP_FAILURE}
        }
    }
} catch {
    if ($verified -and -not $target.HasExited) { exit ${VERIFIED_STOP_FAILURE} }
} finally {
    if ($null -ne $target) { $target.Dispose() }
}
`,
  "utf16le",
).toString("base64");

function windowsArgumentPattern(argument: string): string {
  const escaped = RegExp.escape(argument);
  const quoted = `"${escaped}"`;
  return /[ \t]/.test(argument) ? quoted : `(?:${escaped}|${quoted})`;
}

export function stopWindowsServer(pid: number, command: readonly [string, ...string[]]): void {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !Number.isSafeInteger(pid) || pid <= 0 || pid > MAX_PROCESS_ID) return;

  let image: string;
  try {
    image = realpathSync(command[0]);
  } catch {
    return;
  }

  const commandLine = command.map(windowsArgumentPattern).join("[ \\t]+");
  const commandPattern = `\\A${commandLine}[ \\t]*\\z`;
  const result = spawnSync(
    win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedStopScript],
    {
      env: {
        ...process.env,
        BROWSE_SERVER_PID: String(pid),
        BROWSE_SERVER_IMAGE: image,
        BROWSE_SERVER_COMMAND_PATTERN: commandPattern,
        BROWSE_SERVER_STOP_TIMEOUT_MS: String(SERVER_STOP_TIMEOUT_MS),
        BROWSE_SERVER_FORCE_STOP_TIMEOUT_MS: String(FORCE_STOP_TIMEOUT_MS),
      },
      stdio: "ignore",
      timeout: QUERY_TIMEOUT_MS + SERVER_STOP_TIMEOUT_MS + FORCE_STOP_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (
    result.status === 0 ||
    (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
  ) {
    return;
  }
  if (result.status === VERIFIED_STOP_FAILURE) {
    throw new Error(`Could not stop the verified Camoufox server (PID ${pid})`);
  }
  throw new Error(`Could not determine the Camoufox server stop result (PID ${pid})`, {
    cause: result.error,
  });
}
