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

export function preserveMtime(fd: number, original: fs.BigIntStats, path: string): void {
  fs.futimesSync(fd, Number(original.atimeNs) / 1e9, Number(original.mtimeNs) / 1e9);
  if (fs.fstatSync(fd, { bigint: true }).mtimeNs === original.mtimeNs) return;
  const library =
    process.platform === "linux"
      ? "libc.so.6"
      : process.platform === "darwin"
        ? "/usr/lib/libSystem.B.dylib"
        : undefined;
  if (!library) throw new Error(`Cannot preserve mtime precision: ${JSON.stringify(path)}`);
  const native = dlopen(library, { futimens: { args: ["i32", "ptr"], returns: "i32" } });
  try {
    const times = new BigInt64Array([...timespec(original.atimeNs), ...timespec(original.mtimeNs)]);
    if (
      native.symbols.futimens(fd, ptr(times)) !== 0 ||
      fs.fstatSync(fd, { bigint: true }).mtimeNs !== original.mtimeNs
    ) {
      throw new Error(`Cannot preserve mtime precision: ${JSON.stringify(path)}`);
    }
  } finally {
    native.close();
  }
}

function timespec(ns: bigint): [bigint, bigint] {
  const fraction =
    ((ns % NANOSECONDS_PER_SECOND) + NANOSECONDS_PER_SECOND) % NANOSECONDS_PER_SECOND;
  return [(ns - fraction) / NANOSECONDS_PER_SECOND, fraction];
}
