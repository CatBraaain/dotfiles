import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type PlatformApi = ReturnType<typeof platformFor>;

function shLiteral(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function powerShellLiteral(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
    processParentPid(pid: number): number | undefined {
      if (windows) return undefined;
      return readParentPid(pid);
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
    quoteCommand(tokens: string[]): string {
      if (windows) return ["&", ...tokens.map(powerShellLiteral)].join(" ");
      return tokens.map(shLiteral).join(" ");
    },
    paneCommand(command: string[], unsetEnvironment: string[]): string {
      if (windows) {
        const invocation = ["&", ...command.map(powerShellLiteral)].join(" ");
        const removable = unsetEnvironment.filter((key) => ENVIRONMENT_KEY_PATTERN.test(key));
        if (removable.length === 0) return invocation;
        const removals = removable.map((key) => `$env:${key}=$null`).join("; ");
        return `& { ${removals}; ${invocation} }`;
      }
      return ["/usr/bin/env", ...unsetEnvironment.flatMap((key) => ["-u", key]), ...command]
        .map(shLiteral)
        .join(" ");
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
