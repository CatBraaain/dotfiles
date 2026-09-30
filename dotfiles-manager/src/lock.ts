// Inter-process exclusion for the internal CLI (spec: SPEC.md §コマンド):
// one lockf-held lock file per home, auto-released by the OS on process exit.
import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { dlopen, FFIType } from "bun:ffi";

// lockf(3) commands; values are shared by Linux and macOS.
const F_ULOCK = 0;
const F_LOCK = 1;
const F_TEST = 3;

type Lockf = (fd: number, command: number, length: bigint) => number;
let lockf: Lockf | undefined;

// libc.so is a linker script on glibc; the loadable object is libc.so.6.
const libcName = process.platform === "darwin" ? "libc.dylib" : "libc.so.6";

// Loaded lazily so Windows (no libc) never touches bun:ffi.
function loadLockf(): Lockf {
  lockf ??= dlopen(libcName, {
    lockf: { args: [FFIType.int, FFIType.int, FFIType.i64], returns: FFIType.int },
  }).symbols.lockf;
  return lockf;
}

export type HomeLock = { release(): void };

export function acquireHomeLock(
  homeRoot: string,
  onWait: (holder: number | null) => void,
): HomeLock {
  if (process.platform === "win32") return { release() {} };

  const path = join(homeRoot, ".cache", "dotfiles-manager.lock");
  const lockf = loadLockf();
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a+");
  if (lockf(fd, F_TEST, 0n) !== 0) onWait(readHolderPid(path));
  if (lockf(fd, F_LOCK, 0n) !== 0) throw new Error(`Failed to lock ${path}`);
  writeHolderPid(fd);
  return {
    release() {
      lockf(fd, F_ULOCK, 0n);
      closeSync(fd);
    },
  };
}

function readHolderPid(path: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

function writeHolderPid(fd: number): void {
  ftruncateSync(fd, 0);
  writeSync(fd, String(process.pid));
}
