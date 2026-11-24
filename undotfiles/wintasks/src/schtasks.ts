// schtasks invocation and query parsing.

import { dlopen, FFIType } from "bun:ffi";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseXml, textContent, type XNode } from "./xml.ts";

const UTF8_XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';
const UTF16_XML_DECLARATION = '<?xml version="1.0" encoding="UTF-16"?>';

export interface ExistingTask {
  path: string;
  xml: string;
}

export interface Schtasks {
  query(): string;
  create(path: string, xml: string): void;
  delete(path: string): void;
}

export const commandSchtasks: Schtasks = {
  query(): string {
    let output;
    try {
      output = Bun.spawnSync(["schtasks", "/Query", "/XML"]);
    } catch (error) {
      throw new Error(`failed to run schtasks: ${(error as Error).message}`);
    }
    if (!output.success) {
      throw new Error(`schtasks /Query /XML failed: ${decode(output.stderr)}`);
    }
    return decode(output.stdout);
  },

  create(path: string, xml: string): void {
    const file = writeTempXml(xml);
    try {
      const output = Bun.spawnSync(["schtasks", "/Create", "/XML", file, "/TN", path, "/F"]);
      if (!output.success) throw new Error(decode(output.stderr));
    } finally {
      rmSync(file, { force: true });
    }
  },

  delete(path: string): void {
    const output = Bun.spawnSync(["schtasks", "/Delete", "/TN", path, "/F"]);
    if (!output.success) throw new Error(decode(output.stderr));
  },
};

export function decode(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return decodeWindowsCodePage(bytes);
  }
}

type Kernel32 = {
  symbols: {
    GetConsoleOutputCP(): number;
    GetOEMCP(): number;
    MultiByteToWideChar(
      codePage: number,
      flags: number,
      multiByteStr: Uint8Array | null,
      byteCount: number,
      wideCharStr: Uint16Array | null,
      wideCharCount: number,
    ): number;
  };
};

let kernel32: Kernel32 | null | undefined;

function loadKernel32(): Kernel32 | null {
  if (kernel32 !== undefined) return kernel32;
  try {
    const lib = dlopen("kernel32.dll", {
      GetConsoleOutputCP: { args: [], returns: FFIType.u32 },
      GetOEMCP: { args: [], returns: FFIType.u32 },
      MultiByteToWideChar: {
        args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32],
        returns: FFIType.i32,
      },
    });
    kernel32 = lib as unknown as Kernel32;
  } catch {
    kernel32 = null;
  }
  return kernel32 ?? null;
}

export function decodeWithCodePage(bytes: Uint8Array, codePage: number): string | null {
  const lib = loadKernel32();
  if (!lib) return null;
  const byteCount = bytes.byteLength;
  if (byteCount > 2 ** 31 - 1) return null;
  const required = lib.symbols.MultiByteToWideChar(codePage, 0, bytes, byteCount, null, 0);
  if (required <= 0) return null;
  const units = new Uint16Array(required);
  const written = lib.symbols.MultiByteToWideChar(codePage, 0, bytes, byteCount, units, required);
  if (written <= 0) return null;
  let text = "";
  for (let i = 0; i < written; i++) text += String.fromCharCode(units[i]!);
  return text;
}

function decodeWindowsCodePage(bytes: Uint8Array): string {
  if (process.platform === "win32") {
    const decoded = decodeWithCodePage(bytes, outputCodePage());
    if (decoded !== null) return decoded;
  }
  return new TextDecoder("utf-8").decode(bytes);
}

function outputCodePage(): number {
  const lib = loadKernel32();
  if (!lib) return 0;
  const consoleCodePage = lib.symbols.GetConsoleOutputCP();
  return consoleCodePage === 0 ? lib.symbols.GetOEMCP() : consoleCodePage;
}

function writeTempXml(xml: string): string {
  const file = join(tmpdir(), `wintasks-${process.pid}.xml`);
  writeFileSync(file, encodeTaskXml(xml));
  return file;
}

// schtasks requires the XML declaration and bytes to use the same UTF-16 LE encoding.
// Keep the public XML UTF-8 so query normalization and diff output remain unchanged.
export function encodeTaskXml(xml: string): Uint8Array {
  const body = xml.startsWith(UTF8_XML_DECLARATION)
    ? UTF16_XML_DECLARATION + xml.slice(UTF8_XML_DECLARATION.length)
    : xml;
  const bytes = new Uint8Array(2 + body.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let i = 0; i < body.length; i++) {
    const unit = body.charCodeAt(i);
    bytes[2 + i * 2] = unit & 0xff;
    bytes[3 + i * 2] = unit >> 8;
  }
  return bytes;
}

// Parses each Task XML document in the concatenated query output.
export function extractTasks(xmlText: string): ExistingTask[] {
  const tasks: ExistingTask[] = [];
  for (const document of splitXmlDocuments(xmlText)) {
    let root: XNode;
    try {
      root = parseXml(document);
    } catch (error) {
      throw new Error(`failed to parse schtasks query output: ${(error as Error).message}`);
    }
    if (localName(root.name) !== "Task") continue;
    const path = registrationUri(root);
    if (path.length > 0) tasks.push({ path: uriToTaskPath(path), xml: document });
  }
  return tasks;
}

function splitXmlDocuments(xmlText: string): string[] {
  const markup = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g;
  const documents: string[] = [];
  let start = 0;
  for (const match of xmlText.matchAll(markup)) {
    if (!/^<\?xml\s/.test(match[0])) continue;
    const document = xmlText.slice(start, match.index).trim();
    if (document.length > 0) documents.push(document);
    start = match.index;
  }
  const lastDocument = xmlText.slice(start).trim();
  if (lastDocument.length > 0) documents.push(lastDocument);
  return documents;
}

function registrationUri(root: XNode): string {
  let path = "";
  for (const item of root.content) {
    if (item.kind !== "element" || localName(item.node.name) !== "RegistrationInfo") continue;
    for (const child of item.node.content) {
      if (child.kind !== "element" || localName(child.node.name) !== "URI") continue;
      path += textContent(child.node);
    }
  }
  return path;
}

function localName(name: string): string {
  const index = name.lastIndexOf(":");
  return index === -1 ? name : name.slice(index + 1);
}

function uriToTaskPath(uri: string): string {
  return uri.trim().replaceAll("/", "\\");
}
