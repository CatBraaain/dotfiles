import * as fs from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { dlopen, ptr } from "bun:ffi";

interface StringSpan {
  start: number;
  end: number;
}

export interface SessionHeader {
  id: string;
  cwd: string;
  parentSession?: string;
  text: string;
  tail: Buffer;
  strings: Map<string, StringSpan>;
}

export function readHeader(
  bytes: Buffer,
  path: string,
  kind: "source" | "existing",
): SessionHeader {
  const newline = bytes.indexOf(10);
  const lineEnd = newline < 0 ? bytes.length : newline;
  const headerEnd =
    lineEnd > 0 && bytes[lineEnd - 1] === 13 && newline >= 0 ? lineEnd - 1 : lineEnd;
  const raw = bytes.subarray(0, headerEnd);
  if (raw[0] === 239 && raw[1] === 187 && raw[2] === 191) {
    throw new Error(`BOM in session header: ${JSON.stringify(path)}`);
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Expected a session header object: ${JSON.stringify(path)}`);
  }
  const fields = parsed as Record<string, unknown>;
  const strings = collectStrings(text, path, kind);
  if (
    fields.type !== "session" ||
    typeof fields.id !== "string" ||
    fields.id.length === 0 ||
    typeof fields.cwd !== "string" ||
    !isAbsolute(fields.cwd)
  ) {
    throw new Error(`Invalid type, id or cwd: ${JSON.stringify(path)}`);
  }
  if (kind === "source") {
    if (typeof fields.timestamp !== "string" || fields.timestamp.length === 0) {
      throw new Error(`Invalid timestamp: ${JSON.stringify(path)}`);
    }
    if (Object.hasOwn(fields, "version") && ![1, 2, 3].includes(fields.version as number)) {
      throw new Error(`Unsupported session version: ${JSON.stringify(path)}`);
    }
    if (
      Object.hasOwn(fields, "parentSession") &&
      (typeof fields.parentSession !== "string" || !isAbsolute(fields.parentSession))
    ) {
      throw new Error(`Invalid parentSession: ${JSON.stringify(path)}`);
    }
  }
  return {
    id: fields.id,
    cwd: fields.cwd,
    parentSession: kind === "source" ? (fields.parentSession as string | undefined) : undefined,
    text,
    tail: bytes.subarray(headerEnd),
    strings,
  };
}

function collectStrings(text: string, path: string, kind: "source" | "existing") {
  const stack: { object: boolean; keys: Set<string>; expectingKey: boolean; key: string }[] = [];
  const strings = new Map<string, StringSpan>();
  for (const token of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\]:,]/g)) {
    const literal = token[0];
    const top = stack.at(-1);
    if (literal === "{" || literal === "[") {
      stack.push({ object: literal === "{", keys: new Set(), expectingKey: true, key: "" });
    } else if (literal === "}" || literal === "]") {
      stack.pop();
    } else if (literal === "," && top?.object) {
      top.expectingKey = true;
    } else if (literal.startsWith('"') && top?.object) {
      if (top.expectingKey) {
        const key: string = JSON.parse(literal);
        const isChecked =
          kind === "source" || (stack.length === 1 && ["type", "id", "cwd"].includes(key));
        if (isChecked && top.keys.has(key)) {
          throw new Error(`Duplicate header key ${JSON.stringify(key)}: ${JSON.stringify(path)}`);
        }
        top.keys.add(key);
        top.key = key;
        top.expectingKey = false;
      } else if (stack.length === 1) {
        strings.set(top.key, { start: token.index, end: token.index + literal.length });
      }
    }
  }
  return strings;
}

export function rewriteSession(
  header: SessionHeader,
  cwd: string,
  mapping: Map<string, string>,
): Buffer {
  const replacements = new Map<string, string>([["cwd", cwd]]);
  if (header.parentSession !== undefined) {
    const destination = mapping.get(resolve(header.parentSession));
    if (destination !== undefined) replacements.set("parentSession", destination);
  }
  const edits = [...replacements]
    .map(([key, replacement]) => {
      const span = header.strings.get(key);
      if (!span) throw new Error(`Missing string span for ${key}`);
      return { ...span, replacement: JSON.stringify(replacement) };
    })
    .sort((left, right) => right.start - left.start);
  let text = header.text;
  for (const edit of edits) {
    text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
  }
  return Buffer.concat([Buffer.from(text), header.tail]);
}

const NANOSECONDS_PER_SECOND = 1_000_000_000n;
const WINDOWS_TICK_NS = 100n;
const WINDOWS_EPOCH_OFFSET_TICKS = 116_444_736_000_000_000n;
const INVALID_HANDLE_VALUE = 0xffff_ffff_ffff_ffffn;
const FILE_WRITE_ATTRIBUTES = 0x100;
const FILE_SHARE_ALL = 0x7;
const OPEN_EXISTING = 3;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x0020_0000;

export function preserveMtime(fd: number, original: fs.BigIntStats, path: string): void {
  fs.futimesSync(fd, Number(original.atimeNs) / 1e9, Number(original.mtimeNs) / 1e9);
  if (hasPreservedMtime(fd, original)) return;
  if (process.platform === "win32") setFileTime(path, original);
  else futimens(fd, original, path);
  if (!hasPreservedMtime(fd, original))
    throw new Error(`Cannot preserve mtime precision: ${JSON.stringify(path)}`);
}

function hasPreservedMtime(fd: number, original: fs.BigIntStats): boolean {
  return fs.fstatSync(fd, { bigint: true }).mtimeNs === original.mtimeNs;
}

function futimens(fd: number, original: fs.BigIntStats, path: string): void {
  const library = process.platform === "linux" ? "libc.so.6" : "/usr/lib/libSystem.B.dylib";
  const native = dlopen(library, { futimens: { args: ["i32", "ptr"], returns: "i32" } });
  try {
    const times = new BigInt64Array([...timespec(original.atimeNs), ...timespec(original.mtimeNs)]);
    if (native.symbols.futimens(fd, ptr(times)) !== 0)
      throw new Error(`futimens failed: ${JSON.stringify(path)}`);
  } finally {
    native.close();
  }
}

function setFileTime(path: string, original: fs.BigIntStats): void {
  const kernel32 = dlopen("kernel32.dll", {
    CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "ptr"], returns: "u64" },
    GetLastError: { args: [], returns: "u32" },
    SetFileTime: { args: ["u64", "ptr", "ptr", "ptr"], returns: "i32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
  });
  try {
    const name = Buffer.from(`${extendedLengthPath(path)}\0`, "utf16le");
    const handle = kernel32.symbols.CreateFileW(
      ptr(name),
      FILE_WRITE_ATTRIBUTES,
      FILE_SHARE_ALL,
      null,
      OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT,
      null,
    );
    if (handle === INVALID_HANDLE_VALUE) {
      const error = kernel32.symbols.GetLastError();
      throw new Error(`CreateFileW failed with Win32 error ${error}: ${JSON.stringify(path)}`);
    }
    try {
      const accessTime = fileTime(original.atimeNs);
      const writeTime = fileTime(original.mtimeNs);
      if (kernel32.symbols.SetFileTime(handle, null, ptr(accessTime), ptr(writeTime)) === 0) {
        const error = kernel32.symbols.GetLastError();
        throw new Error(`SetFileTime failed with Win32 error ${error}: ${JSON.stringify(path)}`);
      }
    } finally {
      kernel32.symbols.CloseHandle(handle);
    }
  } finally {
    kernel32.close();
  }
}

function fileTime(nanoseconds: bigint): Uint32Array {
  const ticks = nanoseconds / WINDOWS_TICK_NS + WINDOWS_EPOCH_OFFSET_TICKS;
  return new Uint32Array([Number(ticks & 0xffff_ffffn), Number(ticks >> 32n)]);
}

function extendedLengthPath(path: string): string {
  const native = path.replace(/\//g, "\\");
  if (native.startsWith("\\\\?\\")) return native;
  if (native.startsWith("\\\\")) return `\\\\?\\UNC\\${native.slice(2)}`;
  return `\\\\?\\${native}`;
}

function timespec(ns: bigint): [bigint, bigint] {
  const fraction =
    ((ns % NANOSECONDS_PER_SECOND) + NANOSECONDS_PER_SECOND) % NANOSECONDS_PER_SECOND;
  return [(ns - fraction) / NANOSECONDS_PER_SECOND, fraction];
}
