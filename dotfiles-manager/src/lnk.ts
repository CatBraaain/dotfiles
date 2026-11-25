import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { isAlias, isMap, isScalar, parseDocument } from "yaml";
import { lstatOrNull } from "./compare.ts";
import { mapSegment, type Platform } from "./path-mapping.ts";

const LINK_NAME_SUFFIX = ".lnk";
const LINK_CLSID = Buffer.from("0114020000000000c000000000000046", "hex");
const LINK_HEADER_SIZE = 0x4c;
const LINK_CLSID_OFFSET = 4;
const LINK_FLAGS_OFFSET = 0x14;
const HAS_TARGET_ID_LIST = 0x01;
const HAS_LINK_INFO = 0x02;
const HAS_RELATIVE_PATH = 0x08;
const HAS_WORKING_DIRECTORY = 0x10;
const HAS_ARGUMENTS = 0x20;
const IS_UNICODE = 0x80;
const REQUIRED_COMPARISON_FLAGS = HAS_TARGET_ID_LIST | HAS_LINK_INFO | IS_UNICODE;
const SUPPORTED_COMPARISON_FLAGS =
  REQUIRED_COMPARISON_FLAGS | HAS_RELATIVE_PATH | HAS_WORKING_DIRECTORY | HAS_ARGUMENTS;
const ICON_INDEX_OFFSET = 0x38;
const SHOW_COMMAND_OFFSET = 0x3c;
const HOTKEY_OFFSET = 0x40;
const TRACKER_BLOCK = 0xa0000003;
const SPECIAL_FOLDER_BLOCK = 0xa0000005;
const PROPERTY_STORE_BLOCK = 0xa0000009;
const KNOWN_FOLDER_BLOCK = 0xa000000b;
const SERIALIZED_PROPERTY_STORAGE_VERSION = 0x53505331;
const LOCAL_LINK_INFO_HEADER_SIZE = 0x1c;
const TEXT_RUN_PATTERN = /(?:[\x20-\x7e]\x00){4,}/g;
const WINDOW_STYLE = { normal: 1, minimized: 7 } as const;
const WINDOWS_POWERSHELL = "System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const WINDOWS_FSUTIL = "System32\\fsutil.exe";
const APP_EXEC_LINK_TAG_HEADER = /^[^:\r\n]+:[ \t]*0x8000001b[ \t]*\r?\n/i;
const REPARSE_DATA_START = /^0000:[ \t]+[0-9a-f]{2}\b/im;
const CREATE_SHORTCUT_SCRIPT = Buffer.from(
  String.raw`
$ErrorActionPreference = 'Stop'
$reader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)
$shortcut = ConvertFrom-Json -InputObject ($reader.ReadToEnd())
$target = $shortcut.target
if ($target -ceq 'powershell') {
  $pwsh = Get-Command pwsh.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pwsh) { $target = $pwsh.Source }
  else { $target = Join-Path $env:SystemRoot '${WINDOWS_POWERSHELL}' }
}
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($shortcut.path)
$link.TargetPath = $target
$link.Arguments = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($shortcut.argumentsBase64))
$link.WindowStyle = $shortcut.windowStyle
$link.Save()
`,
  "utf16le",
).toString("base64");

const READ_SHORTCUT_TARGETS_SCRIPT = Buffer.from(
  String.raw`
$ErrorActionPreference = 'Stop'
$reader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)
$shell = New-Object -ComObject WScript.Shell
$targets = foreach ($path in (ConvertFrom-Json -InputObject ($reader.ReadToEnd()))) {
  $shell.CreateShortcut($path).TargetPath
}
$json = ConvertTo-Json -InputObject @($targets) -Compress
[Console]::Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))
`,
  "utf16le",
).toString("base64");

type ManagedEntry = { distRelPath: string; homeRelPath: string; isLink: boolean };
type LnkDeclaration = { target: string; arguments: string; windowStyle: keyof typeof WINDOW_STYLE };
type PowerShellAliasPair = [defaultAlias: string, packageAlias: string];
type LinkSettings = {
  localTarget: string;
  tracker: Buffer | null;
  args: string;
  workingDirectory: string;
  windowStyle: number;
  relativePath: string;
  extraSettings: Buffer[];
};

export async function convertLnkDeclarations(
  distDir: string,
  platform: Platform,
): Promise<Set<string>> {
  const distRoot = await resolveDistRoot(distDir);
  const entries = await collectManagedEntries(distRoot);
  const generatedLinks = new Set<string>();
  const entriesByHomePath =
    platform === "windows" ? Map.groupBy(entries, windowsHomeKey) : undefined;

  for (const entry of entries) {
    if (!entry.isLink) continue;
    const { distRelPath } = entry;
    try {
      const distPath = await checkedDistLinkPath(distRoot, distRelPath);
      const bytes = await readFile(distPath);
      if (isShellLink(bytes)) continue;
      if (platform !== "windows") {
        await unlink(distPath);
        continue;
      }

      const conflictingEntry = entriesByHomePath
        ?.get(windowsHomeKey(entry))
        ?.find((other) => other !== entry);
      if (conflictingEntry) {
        throw new Error(
          `home path collision with ${conflictingEntry.distRelPath}: ${entry.homeRelPath}`,
        );
      }

      const declaration = parseDeclaration(bytes);
      if (process.platform !== "win32")
        throw new Error("a Windows host is required to generate a shortcut");
      await replaceDistLink(distRoot, distRelPath, (temporaryPath) =>
        createShortcut(temporaryPath, declaration),
      );
      generatedLinks.add(distRelPath);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`lnk ${distRelPath}: ${reason}`, { cause: error });
    }
  }
  return generatedLinks;
}

export async function adoptHomeLnkBytes(
  distDir: string,
  homeRoot: string,
  generatedLinks: ReadonlySet<string>,
): Promise<void> {
  const distRoot = await resolveDistRoot(distDir);
  const entries = await collectManagedEntries(distRoot);
  for (const entry of entries) {
    if (!entry.isLink || generatedLinks.has(entry.distRelPath)) continue;
    const { distRelPath, homeRelPath } = entry;
    const homePath = await findHomeLinkPath(homeRoot, homeRelPath);
    if (homePath === null) continue;
    const distPath = await checkedDistLinkPath(distRoot, distRelPath);
    const [distBytes, homeBytes] = await Promise.all([readFile(distPath), readFile(homePath)]);
    if (distBytes.equals(homeBytes) || !matchesLinkText(distBytes, homeBytes)) continue;
    await replaceDistLink(distRoot, distRelPath, (temporaryPath) =>
      writeFile(temporaryPath, homeBytes, { flag: "wx" }),
    );
  }
}

export function createGeneratedLinkComparison() {
  const aliasPair = powerShellAliasPair();
  let aliasesMatch: boolean | undefined;
  return async function differs(distPath: string, homePath: string): Promise<boolean> {
    const [distBytes, homeBytes] = await Promise.all([readFile(distPath), readFile(homePath)]);
    if (distBytes.equals(homeBytes)) return false;
    const dist = readLinkSettings(distBytes);
    const home = readLinkSettings(homeBytes);
    if (!dist || !home || !sameLinkSettings(dist, home)) return true;

    const targets = readWindowsTargets(distPath, homePath);
    if (!targets) return true;
    const [distTarget, homeTarget] = targets;
    if (
      distTarget !== dist.localTarget ||
      homeTarget !== home.localTarget ||
      !hasNoSeparateRelativeTarget(distPath, dist.relativePath, distTarget) ||
      !hasNoSeparateRelativeTarget(homePath, home.relativePath, homeTarget)
    )
      return true;
    if (Boolean(dist.tracker) !== Boolean(home.tracker)) return true;
    const verifiedAliasPair = aliasPair && arePowerShellAliases(aliasPair, distTarget, homeTarget);
    if (verifiedAliasPair) {
      aliasesMatch ??= sameAppExecLink(aliasPair);
      return !aliasesMatch;
    }
    if (distTarget !== homeTarget) return true;
    if (dist.tracker?.equals(home.tracker!) || !dist.tracker) return false;
    try {
      return !(await stat(distTarget)).isFile();
    } catch {
      return true;
    }
  };
}

function sameLinkSettings(left: LinkSettings, right: LinkSettings): boolean {
  return (
    left.args === right.args &&
    left.workingDirectory === right.workingDirectory &&
    left.windowStyle === right.windowStyle &&
    left.extraSettings.length === right.extraSettings.length &&
    left.extraSettings.every((block, index) => block.equals(right.extraSettings[index]!))
  );
}

function hasNoSeparateRelativeTarget(
  linkPath: string,
  relativePath: string,
  target: string,
): boolean {
  if (relativePath === "") return true;
  return (
    win32.parse(relativePath).root === "" &&
    !relativePath.includes(":") &&
    win32.resolve(win32.dirname(linkPath), relativePath) === target
  );
}

function readWindowsTargets(distPath: string, homePath: string): [string, string] | null {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !win32.isAbsolute(systemRoot)) return null;
  const result = spawnSync(
    join(systemRoot, WINDOWS_POWERSHELL),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", READ_SHORTCUT_TARGETS_SCRIPT],
    { input: JSON.stringify([distPath, homePath]), windowsHide: true, timeout: 5000 },
  );
  if (result.status !== 0 || result.error) return null;
  try {
    const targets: unknown = JSON.parse(
      Buffer.from(result.stdout.toString("ascii"), "base64").toString("utf8"),
    );
    if (!Array.isArray(targets) || targets.length !== 2) return null;
    const [left, right] = targets as unknown[];
    if (typeof left !== "string" || typeof right !== "string") return null;
    return [left, right];
  } catch {
    return null;
  }
}

function powerShellAliasPair(): PowerShellAliasPair | null {
  const localAppData = process.env.LOCALAPPDATA;
  if (process.platform !== "win32" || !localAppData || !win32.isAbsolute(localAppData)) return null;
  const directory = join(localAppData, "Microsoft", "WindowsApps");
  return [
    join(directory, "pwsh.exe"),
    join(directory, "Microsoft.PowerShell_8wekyb3d8bbwe", "pwsh.exe"),
  ];
}

function arePowerShellAliases(
  [defaultAlias, packageAlias]: PowerShellAliasPair,
  left: string,
  right: string,
) {
  const first = foldWindowsPathCase(left);
  const second = foldWindowsPathCase(right);
  const defaultKey = foldWindowsPathCase(defaultAlias);
  const packageKey = foldWindowsPathCase(packageAlias);
  return (
    (first === defaultKey && second === packageKey) ||
    (first === packageKey && second === defaultKey)
  );
}

function sameAppExecLink([defaultAlias, packageAlias]: PowerShellAliasPair): boolean {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !win32.isAbsolute(systemRoot)) return false;
  const fsutil = join(systemRoot, WINDOWS_FSUTIL);
  const query = (path: string) =>
    spawnSync(fsutil, ["reparsepoint", "query", path], { windowsHide: true, timeout: 3000 });
  const left = query(defaultAlias);
  const right = query(packageAlias);
  if (left.status !== 0 || right.status !== 0 || left.error || right.error) return false;
  const reparseReport = left.stdout.toString("latin1");
  return (
    APP_EXEC_LINK_TAG_HEADER.test(reparseReport) &&
    REPARSE_DATA_START.test(reparseReport) &&
    left.stdout.equals(right.stdout)
  );
}

async function collectManagedEntries(
  directory: string,
  distPrefix = "",
  homePrefix = "",
  entries: ManagedEntry[] = [],
): Promise<ManagedEntry[]> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const mapping = mapSegment(entry.name, entry.isDirectory());
    if (mapping.isExcluded) continue;
    const distRelPath = `${distPrefix}${entry.name}`;
    const homeRelPath = `${homePrefix}${mapping.homeName}`;
    const isLink = entry.isFile() && entry.name.toLowerCase().endsWith(LINK_NAME_SUFFIX);
    entries.push({ distRelPath, homeRelPath, isLink });
    if (entry.isDirectory()) {
      await collectManagedEntries(
        join(directory, entry.name),
        `${distRelPath}/`,
        `${homeRelPath}/`,
        entries,
      );
    }
  }
  return entries;
}

function windowsHomeKey(entry: ManagedEntry): string {
  return win32
    .normalize(entry.homeRelPath)
    .split("\\")
    .map((segment) => foldWindowsPathCase(stripWindowsTrailingDotsAndSpaces(segment)))
    .join("\\");
}

function foldWindowsPathCase(segment: string): string {
  return segment
    .split("")
    .map((unit) => {
      const uppercase = unit.toUpperCase();
      return uppercase.length === 1 ? uppercase : unit;
    })
    .join("");
}

function stripWindowsTrailingDotsAndSpaces(segment: string): string {
  return segment.replace(/[. ]+$/, "");
}

async function findHomeLinkPath(homeRoot: string, homeRelPath: string): Promise<string | null> {
  const segments = homeRelPath.split("/");
  if (
    segments.some((segment) => !stripWindowsTrailingDotsAndSpaces(segment) || /[\\:]/.test(segment))
  ) {
    return null;
  }
  const fileName = segments.pop();
  if (fileName === undefined) return null;

  let directory = homeRoot;
  for (const segment of segments) {
    directory = join(directory, segment);
    if (!(await lstatOrNull(directory))?.isDirectory()) return null;
  }
  const filePath = join(directory, fileName);
  return (await lstatOrNull(filePath))?.isFile() ? filePath : null;
}

function isShellLink(bytes: Buffer): boolean {
  const clsidEnd = LINK_CLSID_OFFSET + LINK_CLSID.length;
  return (
    bytes.length >= clsidEnd &&
    bytes.readUInt32LE(0) === LINK_HEADER_SIZE &&
    bytes.subarray(LINK_CLSID_OFFSET, clsidEnd).equals(LINK_CLSID)
  );
}

function readLinkSettings(bytes: Buffer): LinkSettings | null {
  if (bytes.length < LINK_HEADER_SIZE + 2 || !isShellLink(bytes)) return null;
  const flags = bytes.readUInt32LE(LINK_FLAGS_OFFSET);
  const windowStyle = bytes.readUInt32LE(SHOW_COMMAND_OFFSET);
  if (
    (flags & REQUIRED_COMPARISON_FLAGS) !== REQUIRED_COMPARISON_FLAGS ||
    (flags & ~SUPPORTED_COMPARISON_FLAGS) !== 0 ||
    bytes.readUInt32LE(ICON_INDEX_OFFSET) !== 0 ||
    bytes.readUInt16LE(HOTKEY_OFFSET) !== 0 ||
    bytes.subarray(HOTKEY_OFFSET + 2, LINK_HEADER_SIZE).some((byte) => byte !== 0) ||
    (windowStyle !== WINDOW_STYLE.normal && windowStyle !== WINDOW_STYLE.minimized)
  )
    return null;

  const targetListStart = LINK_HEADER_SIZE + 2;
  const linkInfo = targetListStart + bytes.readUInt16LE(LINK_HEADER_SIZE);
  if (linkInfo + LOCAL_LINK_INFO_HEADER_SIZE > bytes.length) return null;
  const folder = readTargetListRoot(bytes.subarray(targetListStart, linkInfo));
  if (!folder) return null;
  const linkInfoSize = bytes.readUInt32LE(linkInfo);
  if (linkInfo + linkInfoSize > bytes.length) return null;
  const localTarget = readLocalTarget(bytes.subarray(linkInfo, linkInfo + linkInfoSize));
  if (!localTarget) return null;

  let cursor = linkInfo + linkInfoSize;
  const strings: string[] = [];
  for (const flag of [HAS_RELATIVE_PATH, HAS_WORKING_DIRECTORY, HAS_ARGUMENTS]) {
    if (!(flags & flag)) {
      strings.push("");
      continue;
    }
    if (cursor + 2 > bytes.length) return null;
    const end = cursor + 2 + 2 * bytes.readUInt16LE(cursor);
    if (end > bytes.length) return null;
    const value = bytes.toString("utf16le", cursor + 2, end);
    if (value.includes("\0")) return null;
    strings.push(value);
    cursor = end;
  }
  const [relativePath, workingDirectory, args] = strings as [string, string, string];
  const extras = readExtraSettings(bytes.subarray(cursor), folder);
  if (!extras) return null;
  return { localTarget, args, workingDirectory, windowStyle, relativePath, ...extras };
}

function readTargetListRoot(list: Buffer): { size: number; identity: Buffer | null } | null {
  if (list.length < 5 || list.readUInt16LE(list.length - 2) !== 0) return null;
  const size = list.readUInt16LE(0);
  const rootType = list[2];
  if (rootType !== 0x1f && rootType !== 0x2f) return null;
  if (rootType === 0x1f && size < 20) return null;
  const identity = rootType === 0x1f ? list.subarray(2, 20) : null;
  const end = list.length - 2;
  for (let cursor = 0; cursor < end;) {
    if (cursor + 3 > end) return null;
    const itemSize = list.readUInt16LE(cursor);
    if (itemSize < 3 || cursor + itemSize > end) return null;
    const type = list.readUInt8(cursor + 2);
    if (type === 0x2f) {
      const drive = list.subarray(cursor + 3, cursor + 23);
      if (
        itemSize < 25 ||
        !/^[a-z]:\\$/i.test(drive.toString("latin1", 0, 3)) ||
        drive.subarray(3).some((byte) => byte !== 0)
      )
        return null;
    } else if (cursor !== 0) {
      const isFileItem = (type & 0xf0) === 0x30 && itemSize >= 16;
      const isCfsfItem =
        type === 0x74 &&
        itemSize >= 10 &&
        list.toString("latin1", cursor + 6, cursor + 10) === "CFSF";
      if (!isFileItem && !isCfsfItem) return null;
    }
    cursor += itemSize;
  }
  return { size, identity };
}

function readLocalTarget(info: Buffer): string | null {
  if (info.length <= LOCAL_LINK_INFO_HEADER_SIZE) return null;
  if (
    info.readUInt32LE(4) !== LOCAL_LINK_INFO_HEADER_SIZE ||
    info.readUInt32LE(8) !== 1 ||
    info.readUInt32LE(20) !== 0
  )
    return null;
  const volume = info.readUInt32LE(12);
  const pathStart = info.readUInt32LE(16);
  const suffix = info.readUInt32LE(24);
  if (
    volume < LOCAL_LINK_INFO_HEADER_SIZE ||
    volume + 16 > pathStart ||
    pathStart >= suffix ||
    suffix !== info.length - 1 ||
    info[suffix] !== 0 ||
    info.readUInt32LE(volume) !== pathStart - volume ||
    info[suffix - 1] !== 0
  )
    return null;
  const path = info.toString("latin1", pathStart, suffix - 1);
  return /^[a-z]:\\[ -~]+$/i.test(path) && !path.slice(2).includes(":") ? path : null;
}

function readExtraSettings(
  bytes: Buffer,
  folder: { size: number; identity: Buffer | null },
): Pick<LinkSettings, "extraSettings" | "tracker"> | null {
  const extraSettings: Buffer[] = [];
  let tracker: Buffer | null = null;
  const seen = new Set<number>();
  for (let cursor = 0; cursor + 4 <= bytes.length;) {
    const size = bytes.readUInt32LE(cursor);
    if (size === 0) return cursor + 4 === bytes.length ? { extraSettings, tracker } : null;
    if (size < 8 || cursor + size > bytes.length) return null;
    const signature = bytes.readUInt32LE(cursor + 4);
    if (seen.has(signature)) return null;
    seen.add(signature);
    const block = bytes.subarray(cursor, cursor + size);
    if (signature === TRACKER_BLOCK) {
      if (size !== 0x60 || block.readUInt32LE(8) !== 0x58 || block.readUInt32LE(12) !== 0)
        return null;
      tracker = block;
    } else if (
      (signature === SPECIAL_FOLDER_BLOCK && size === 0x10) ||
      (signature === KNOWN_FOLDER_BLOCK && size === 0x1c)
    ) {
      if (!folder.identity || block.readUInt32LE(size - 4) !== folder.size) return null;
      extraSettings.push(block, folder.identity);
    } else if (signature === PROPERTY_STORE_BLOCK && isPropertyStore(block.subarray(8))) {
      extraSettings.push(block);
    } else {
      return null;
    }
    cursor += size;
  }
  return null;
}

function isPropertyStore(bytes: Buffer): boolean {
  for (let cursor = 0; cursor + 4 <= bytes.length;) {
    const size = bytes.readUInt32LE(cursor);
    if (size === 0) return cursor + 4 === bytes.length;
    if (
      size < 28 ||
      cursor + size > bytes.length ||
      bytes.readUInt32LE(cursor + 4) !== SERIALIZED_PROPERTY_STORAGE_VERSION ||
      !hasBoundedPropertyValues(bytes.subarray(cursor + 24, cursor + size))
    )
      return false;
    cursor += size;
  }
  return false;
}

function hasBoundedPropertyValues(bytes: Buffer): boolean {
  for (let cursor = 0; cursor + 4 <= bytes.length;) {
    const size = bytes.readUInt32LE(cursor);
    if (size === 0) return cursor + 4 === bytes.length;
    if (size < 13 || cursor + size > bytes.length) return false;
    cursor += size;
  }
  return false;
}

function matchesLinkText(distBytes: Buffer, homeBytes: Buffer): boolean {
  const distText = lnkText(distBytes);
  return distText !== "" && distText === lnkText(homeBytes);
}

export function lnkText(bytes: Uint8Array): string {
  const latin = new TextDecoder("latin1").decode(bytes);
  const runs = latin.match(TEXT_RUN_PATTERN);
  if (!runs) return "";
  return runs
    .map((run) =>
      new TextDecoder("utf-16le").decode(Uint8Array.from(run, (char) => char.charCodeAt(0))),
    )
    .join("\n");
}

function parseDeclaration(bytes: Buffer): LnkDeclaration {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const document = parseDocument(source, { merge: false });
  const issue = document.errors[0] ?? document.warnings[0];
  if (issue) throw issue;
  if (!isMap(document.contents)) throw new Error("expected a YAML mapping");

  const fields = new Map<string, unknown>();
  for (const pair of document.contents.items) {
    const key = isAlias(pair.key) ? pair.key.resolve(document) : pair.key;
    const name = isScalar(key) ? key.value : undefined;
    if (name !== "target" && name !== "arguments" && name !== "windowStyle") {
      throw new Error(`unknown shortcut key: ${String(name)}`);
    }
    if (fields.has(name)) throw new Error(`duplicate shortcut key: ${name}`);
    const node = isAlias(pair.value) ? pair.value.resolve(document) : pair.value;
    if (!isScalar(node)) throw new Error(`${name} must be a scalar`);
    fields.set(name, node.value);
  }

  const target = fields.get("target");
  const args = fields.has("arguments") ? fields.get("arguments") : "";
  const windowStyle = fields.has("windowStyle") ? fields.get("windowStyle") : "normal";
  if (typeof target !== "string" || !isShortcutTarget(target)) {
    throw new Error("target must be a Windows absolute path or the powershell preset");
  }
  if (typeof args !== "string" || args.includes("\0")) {
    throw new Error("arguments must be a string without NUL characters");
  }
  if (windowStyle !== "normal" && windowStyle !== "minimized") {
    throw new Error("windowStyle must be normal or minimized");
  }
  return { target, arguments: args, windowStyle };
}

function isShortcutTarget(target: string): boolean {
  if (target === "powershell") return true;
  if (target.includes("\0")) return false;
  const { root } = win32.parse(target);
  if (/^[a-z]:[\\/]$/i.test(root)) return true;
  const uncShare = /^[\\/]{2}([^\\/?]+)[\\/][^\\/]+[\\/]?$/.exec(root);
  return uncShare !== null && uncShare[1] !== ".";
}

async function createShortcut(path: string, declaration: LnkDeclaration): Promise<void> {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !win32.isAbsolute(systemRoot))
    throw new Error("SystemRoot is not an absolute path");
  const result = spawnSync(
    join(systemRoot, WINDOWS_POWERSHELL),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", CREATE_SHORTCUT_SCRIPT],
    {
      input: JSON.stringify({
        path,
        target: declaration.target,
        argumentsBase64: Buffer.from(declaration.arguments, "utf8").toString("base64"),
        windowStyle: WINDOW_STYLE[declaration.windowStyle],
      }),
      windowsHide: true,
      encoding: "utf8",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const status = result.signal ?? result.status;
    const details = result.stderr.trim();
    throw new Error(`powershell.exe failed (${status})${details ? `: ${details}` : ""}`);
  }
  const bytes = await readFile(path);
  if (bytes.length < LINK_HEADER_SIZE || !isShellLink(bytes)) {
    throw new Error("powershell.exe did not create a binary shortcut");
  }
}

async function resolveDistRoot(distDir: string): Promise<string> {
  const absoluteDir = resolve(distDir);
  if (!(await lstat(absoluteDir)).isDirectory())
    throw new Error(`dist is not a directory: ${distDir}`);
  return realpath(absoluteDir);
}

async function checkedDistLinkPath(distRoot: string, distRelPath: string): Promise<string> {
  const distPath = join(distRoot, distRelPath);
  const parent = await realpath(dirname(distPath));
  const parentFromRoot = relative(distRoot, parent);
  const insideDist =
    !isAbsolute(parentFromRoot) &&
    parentFromRoot !== ".." &&
    !parentFromRoot.startsWith(`..${sep}`);
  if (!insideDist || !(await lstat(distPath)).isFile()) {
    throw new Error("expected a regular file inside dist");
  }
  return distPath;
}

async function replaceDistLink(
  distRoot: string,
  distRelPath: string,
  prepare: (temporaryPath: string) => Promise<void>,
): Promise<void> {
  const distPath = await checkedDistLinkPath(distRoot, distRelPath);
  const temporaryPath = join(dirname(distPath), `.build-${randomUUID()}.lnk`);
  if (await lstatOrNull(temporaryPath)) throw new Error("temporary shortcut path already exists");
  try {
    await prepare(temporaryPath);
    await rename(temporaryPath, distPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
