import { execFileSync } from "node:child_process";
import { posix } from "node:path";

const WSL_PATH = "/usr/bin/wslpath";
const WINDOWS_POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const WINDOWS_ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|[\\/]{2})/;
const PROBE_TIMEOUT_MS = 3_000;
const READ_ENVIRONMENT = Buffer.from(
  `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$values = @{}
foreach ($name in (ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd()))) {
    $values[$name] = [Environment]::GetEnvironmentVariable($name)
}
[Console]::Write((ConvertTo-Json -InputObject $values -Compress))
`,
  "utf16le",
).toString("base64");

export function readWslWindowsEnvironment(names: readonly string[]): ReadonlyMap<string, string> {
  const windowsNames = [...new Set(names.map((name) => name.toUpperCase()))];
  const result: unknown = JSON.parse(
    execFileSync(
      toWslPath(WINDOWS_POWERSHELL),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", READ_ENVIRONMENT],
      {
        env: { ...process.env, WSLENV: "" },
        input: JSON.stringify(windowsNames),
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
        timeout: PROBE_TIMEOUT_MS,
      },
    ),
  );
  const values = new Map<string, string>();
  if (typeof result !== "object" || result === null || Array.isArray(result)) return values;

  for (const name of names) {
    const windowsName = name.toUpperCase();
    const value = Object.hasOwn(result, windowsName)
      ? (result as Record<string, unknown>)[windowsName]
      : undefined;
    if (typeof value !== "string" || !value) continue;
    try {
      values.set(name, WINDOWS_ABSOLUTE_PATH.test(value) ? toWslPath(value) : value);
    } catch {
      continue;
    }
  }
  return values;
}

function toWslPath(windowsPath: string): string {
  const path = execFileSync(WSL_PATH, ["-a", "-u", windowsPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: PROBE_TIMEOUT_MS,
  }).replace(/\r?\n$/, "");
  if (!posix.isAbsolute(path) || path.includes("\uFFFD")) {
    throw new Error("wslpath did not return a usable absolute path");
  }
  return path;
}
