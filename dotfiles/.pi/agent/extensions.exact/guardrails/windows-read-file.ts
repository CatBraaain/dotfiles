import { dlopen, ptr } from "bun:ffi";
import type { BigIntStats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

const MAX_PATH_CODE_UNITS = 32768;
const DRIVE_FILE_PATH = /^[a-z]:\\[^:\0]+$/i;

function loadFileApi() {
  const uv = dlopen(process.execPath, {
    uv_get_osfhandle: { args: ["i32"], returns: "ptr" },
  });
  const kernel = dlopen("kernel32.dll", {
    GetFinalPathNameByHandleW: { args: ["ptr", "ptr", "u32", "u32"], returns: "u32" },
    GetLastError: { args: [], returns: "u32" },
  });
  return { ...uv.symbols, ...kernel.symbols };
}

let fileApi: ReturnType<typeof loadFileApi> | undefined;

function openedFilePath(file: FileHandle): string {
  const api = (fileApi ??= loadFileApi());
  const handle = api.uv_get_osfhandle(file.fd);
  const buffer = Buffer.alloc(MAX_PATH_CODE_UNITS * 2);
  const length = api.GetFinalPathNameByHandleW(handle, ptr(buffer), MAX_PATH_CODE_UNITS, 0);
  if (length === 0)
    throw new Error(`Cannot verify opened file path: Windows error ${api.GetLastError()}`);
  if (length >= MAX_PATH_CODE_UNITS) throw new Error("Opened file path exceeds the limit");
  const nativePath = buffer.toString("utf16le", 0, length * 2);
  const drivePrefix = "\\\\?\\";
  const path = nativePath.startsWith(drivePrefix) ? nativePath.slice(drivePrefix.length) : "";
  if (!DRIVE_FILE_PATH.test(path)) throw new Error("Cannot verify opened Windows drive path");
  return path;
}

function awaitReadAuthorization(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send || !process.connected) {
      reject(new Error("Windows read authorization channel is unavailable"));
      return;
    }
    function fail(error: Error): void {
      cleanup();
      reject(error);
    }
    function onDisconnect(): void {
      fail(new Error("Windows read authorization channel closed"));
    }
    function onDecision(message: unknown): void {
      if (message !== true) return fail(new Error("Invalid Windows read authorization"));
      cleanup();
      process.disconnect?.();
      resolve();
    }
    function cleanup(): void {
      process.off("message", onDecision);
      process.off("disconnect", onDisconnect);
    }
    process.once("disconnect", onDisconnect);
    process.once("message", onDecision);
    process.send(path, (error) => {
      if (error) fail(error);
    });
  });
}

function fileSnapshot(info: BigIntStats): string {
  return `${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

export async function withAuthorizedWindowsReadFile<T>(
  path: string,
  read: (file: FileHandle, size: bigint) => Promise<T>,
): Promise<T> {
  if (process.platform !== "win32" || !DRIVE_FILE_PATH.test(path))
    throw new Error("Windows read requires a verifiable drive-letter path");
  if (!process.connected) throw new Error("Windows read authorization channel is unavailable");
  const file = await open(path, "r");
  try {
    const info = await file.stat({ bigint: true });
    if (!info.isFile()) throw new Error(`Not a regular file: ${path}`);
    const authorizedPath = openedFilePath(file);
    await awaitReadAuthorization(authorizedPath);
    if (
      openedFilePath(file) !== authorizedPath ||
      fileSnapshot(await file.stat({ bigint: true })) !== fileSnapshot(info)
    )
      throw new Error(`File changed before read: ${path}`);
    const result = await read(file, info.size);
    if (fileSnapshot(await file.stat({ bigint: true })) !== fileSnapshot(info))
      throw new Error(`File changed during read: ${path}`);
    return result;
  } finally {
    await file.close();
  }
}
