import { execFile } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, win32 } from "node:path";
import { promisify } from "node:util";

export type PlatformApi = ReturnType<typeof platformFor>;

function shLiteral(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function powerShellLiteral(value: string): string {
  return "'" + value.replace(/['‘’‚‛]/g, "$&$&") + "'";
}

const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROCESS_QUERY_TIMEOUT_MS = 5_000;
const MAX_WINDOWS_PID = 0xffff_ffff;
const execFileAsync = promisify(execFile);
const windowsPowerShell = win32.join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

async function windowsChildPids(parentPid: number, clientPids: number[]): Promise<number[]> {
  const candidates = clientPids.filter(
    (pid) => Number.isInteger(pid) && pid > 0 && pid <= MAX_WINDOWS_PID,
  );
  if (
    candidates.length === 0 ||
    !Number.isInteger(parentPid) ||
    parentPid <= 0 ||
    parentPid > MAX_WINDOWS_PID
  )
    return [];

  const filter = [parentPid, ...candidates].map((pid) => `ProcessId = ${pid}`).join(" OR ");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$processes = Get-CimInstance Win32_Process -Filter '${filter}'`,
    `$parent = $processes | Where-Object ProcessId -eq ${parentPid}`,
    "if (!$parent) { exit 0 }",
    "foreach ($client in $processes) {",
    `  if ($client.ProcessId -eq ${parentPid} -or $client.ParentProcessId -ne ${parentPid}) { continue }`,
    "  if (!$parent.CreationDate -or !$client.CreationDate -or !$parent.ExecutablePath) { throw 'Cannot verify parent process identity' }",
    "  if ($parent.CreationDate -lt $client.CreationDate -and $parent.ExecutablePath -eq $env:PI_MUX_QUERY_EXE) { [Console]::WriteLine($client.ProcessId) }",
    "}",
  ].join("\n");
  try {
    const { stdout } = await execFileAsync(
      windowsPowerShell,
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(script)],
      {
        env: { ...process.env, PI_MUX_QUERY_EXE: realpathSync(process.execPath) },
        timeout: PROCESS_QUERY_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    const matching = stdout.trim().split(/\r?\n/).filter(Boolean).map(Number);
    if (matching.some((pid) => !candidates.includes(pid))) throw new Error("Invalid process IDs");
    return matching;
  } catch (error) {
    throw new Error(`Cannot verify Windows client parent process ${parentPid}`, { cause: error });
  }
}

export function platformFor(platformName: string) {
  const windows = platformName === "win32";
  const readParentPid = (pid: number): number | undefined => {
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const ppid = /^PPid:\s+(\d+)$/m.exec(status);
      return ppid ? Number(ppid[1]) : undefined;
    } catch {
      return undefined;
    }
  };
  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  };
  const descendsFrom = (pid: number, ancestor: number): boolean => {
    let current = pid;
    while (current > 0) {
      if (current === ancestor) return true;
      let stat: string;
      try {
        stat = readFileSync(`/proc/${current}/stat`, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
      current = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    }
    return false;
  };
  return {
    windows,
    runtimeStateRoot(env: NodeJS.ProcessEnv = process.env): string {
      if (windows) return join(homedir(), ".local", "state");
      const runtime = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid!()}`;
      if (!isAbsolute(runtime)) throw new Error("XDG_RUNTIME_DIR must be absolute");
      return runtime;
    },
    lockAddress(key: string): string {
      return windows ? `\\\\.\\pipe\\pi-mux-${key}` : `\0pi-mux-${process.getuid!()}-${key}`;
    },
    assertDirectorySafety(
      stat: { isDirectory(): boolean; uid: number; mode: number },
      path: string,
    ): void {
      if (
        !stat.isDirectory() ||
        (!windows && (stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0))
      )
        throw new Error(`Unsafe runtime directory: ${path}`);
    },
    ownedFileEntry(stat: { uid: number; mode: number }): boolean {
      if (windows) return true;
      return stat.uid === process.getuid!() && (stat.mode & 0o077) === 0;
    },
    async clientPidsFor(parentPid: number, clientPids: number[]): Promise<number[]> {
      const children = clientPids.filter((pid) => pid !== parentPid);
      const matches = windows
        ? await windowsChildPids(parentPid, children)
        : children.filter((pid) => readParentPid(pid) === parentPid);
      return clientPids.includes(parentPid) ? [parentPid, ...matches] : matches;
    },
    processIsAlive(pid: number): boolean {
      return isAlive(pid);
    },
    processAncestryAvailable: !windows,
    processDescendsFrom(pid: number, ancestor: number): boolean {
      if (windows) return false;
      return descendsFrom(pid, ancestor);
    },
    processEnvironment(pid: number): string[] | undefined {
      if (windows) return undefined;
      return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    },
    processWorkingDirectory(pid: number): string | undefined {
      if (windows) return undefined;
      return realpathSync(`/proc/${pid}/cwd`);
    },
    acceptsTmuxEnvironmentKey(key: string): boolean {
      return !windows || ENVIRONMENT_KEY_PATTERN.test(key);
    },
    quoteCommand(tokens: string[]): string {
      if (windows) return ["&", ...tokens.map(powerShellLiteral)].join(" ");
      return tokens.map(shLiteral).join(" ");
    },
    paneCommand(
      command: string[],
      unsetEnvironment: string[],
      desiredEnvironment: Record<string, string> = {},
    ): string {
      if (windows) {
        const invocation = ["&", ...command.map(powerShellLiteral)].join(" ");
        const removals = unsetEnvironment.map((key) =>
          ENVIRONMENT_KEY_PATTERN.test(key)
            ? `$env:${key}=$null`
            : `[Environment]::SetEnvironmentVariable(${powerShellLiteral(key)}, $null)`,
        );
        const assignments = Object.entries(desiredEnvironment)
          .filter(([key]) => !ENVIRONMENT_KEY_PATTERN.test(key))
          .map(
            ([key, value]) =>
              `[Environment]::SetEnvironmentVariable(${powerShellLiteral(key)}, ${powerShellLiteral(value)})`,
          );
        const setup = [...removals, ...assignments];
        return setup.length === 0 ? invocation : `& { ${[...setup, invocation].join("; ")} }`;
      }
      return ["/usr/bin/env", ...unsetEnvironment.flatMap((key) => ["-u", key]), ...command]
        .map(shLiteral)
        .join(" ");
    },
    tmuxPaneCommand(script: string): string[] {
      if (!windows) return [script];
      return [
        windowsPowerShell,
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encodePowerShell(`${script}; exit $LASTEXITCODE`),
      ];
    },
    hookCommand(invocation: string[], environment: Record<string, string>): string {
      if (windows) {
        const assignments = Object.entries(environment)
          .filter(([key]) => ENVIRONMENT_KEY_PATTERN.test(key))
          .map(([key, value]) => `$env:${key}=${powerShellLiteral(value)}`);
        return `& { ${[...assignments, ["&", ...invocation.map(powerShellLiteral)].join(" ")]
          .filter(Boolean)
          .join("; ")} }`;
      }
      return [
        "/usr/bin/env",
        ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
        ...invocation,
      ]
        .map(shLiteral)
        .join(" ");
    },
  };
}

export const platform = platformFor(process.platform);
